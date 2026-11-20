import WebSocket from "ws";
import type { FeishuCardV2, RelayToAgent, AgentToRelay, RelayResponse } from "@cc-lark/protocol";
import type { Logger } from "../util/logger.js";
import type { IncomingMessage, CardActionPayload } from "../types.js";
import type { Transport, TransportEvents, CardActionResult } from "./interface.js";
import { createDeferred, type Deferred } from "../util/deferred.js";

export interface RelayTransportConfig {
  relayUrl: string;
  openId: string;
  /** Stable per-install id; lets multiple agents share one openId. */
  agentId?: string;
  /** Auth token issued by the relay at pairing time. */
  token?: string;
  /** Returns chatIds this agent owns, re-claimed on every (re)connect. */
  listOwnedChatIds?: () => string[];
  reconnectIntervalMs?: number;
  /** 单个请求等待 relay 响应的上限，默认 15 秒。 */
  requestTimeoutMs?: number;
  /** WebSocket 握手超时，默认 10 秒。避免半开 TCP 让 connect 永远挂起。 */
  handshakeTimeoutMs?: number;
  /** 连续这么久没收到 relay 任何消息（relay 每 30s 发 ping）就判定连接已死并重连，默认 90 秒。 */
  livenessTimeoutMs?: number;
}

export class RelayTransport implements Transport {
  private ws: WebSocket | null = null;
  private readonly logger: Logger;
  private readonly config: RelayTransportConfig;
  private events!: TransportEvents;
  private readonly pending = new Map<string, Deferred<RelayResponse>>();
  private reconnecting = false;
  private closed = false;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: RelayTransportConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: "relay-transport" });
  }

  setEvents(events: TransportEvents): void {
    this.events = events;
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const res = await this.request({ type: "send_text", chatId, text, requestId: this.newId() });
    if (!res.success) throw new Error(res.error);
    return res.data?.messageId ?? "";
  }

  async sendCard(chatId: string, card: FeishuCardV2): Promise<string> {
    const res = await this.request({ type: "send_card", chatId, card, requestId: this.newId() });
    if (!res.success) throw new Error(res.error);
    return res.data?.messageId ?? "";
  }

  async updateCard(messageId: string, card: FeishuCardV2): Promise<void> {
    const res = await this.request({ type: "update_card", messageId, card, requestId: this.newId() });
    if (!res.success) this.logger.warn({ error: res.error }, "updateCard failed");
  }

  async sendImage(chatId: string, imageKey: string): Promise<string> {
    const res = await this.request({ type: "send_image", chatId, imageKey, requestId: this.newId() });
    if (!res.success) throw new Error(res.error);
    return res.data?.messageId ?? "";
  }

  async uploadImage(imageBuffer: Buffer): Promise<string> {
    const res = await this.request({ type: "upload_image", imageBase64: imageBuffer.toString("base64"), requestId: this.newId() });
    if (!res.success) throw new Error(res.error);
    return res.data?.imageKey ?? "";
  }

  async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    const res = await this.request({ type: "download_image", messageId, imageKey, requestId: this.newId() });
    if (!res.success) throw new Error(res.error);
    return Buffer.from(res.data?.imageBase64 ?? "", "base64");
  }

  async createGroup(name: string, description: string, ownerOpenId: string): Promise<string> {
    const res = await this.request({ type: "create_group", chatId: "", name, description, ownerOpenId, requestId: this.newId() } as never);
    if (!res.success) throw new Error(res.error);
    return res.data?.chatId ?? "";
  }

  async dissolveGroup(chatId: string): Promise<void> {
    const res = await this.request({ type: "dissolve_group", chatId, requestId: this.newId() } as never);
    if (!res.success) throw new Error(res.error);
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.config.relayUrl.endsWith("/ws") ? this.config.relayUrl : `${this.config.relayUrl}/ws`;
      const ws = new WebSocket(wsUrl, { handshakeTimeout: this.config.handshakeTimeoutMs ?? 10000 });
      this.ws = ws;

      ws.on("open", () => {
        this.logger.info("Connected to relay");
        this.armLiveness(ws);
        this.send({ type: "auth", openId: this.config.openId, agentId: this.config.agentId, ...(this.config.token ? { token: this.config.token } : {}) });
        // Re-assert chat ownership so the relay rebuilds chat->agent routing
        // (its map is in-memory and lost across restarts/reconnects).
        const chatIds = this.config.listOwnedChatIds?.() ?? [];
        if (chatIds.length) {
          this.send({ type: "claim_chats", chatIds });
        }
        resolve();
      });

      ws.on("message", (data) => {
        this.armLiveness(ws);
        this.handleMessage(data.toString());
      });

      ws.on("close", () => {
        if (this.ws !== ws) return; // 已被新连接取代的旧 socket
        this.clearLiveness();
        this.logger.warn("Relay connection closed");
        // 已发出的请求不会再收到响应（relay 侧按连接配对），立即失败而不是干等 15 秒。
        this.failPending("relay connection closed");
        if (!this.closed) this.scheduleReconnect();
      });

      ws.on("error", (err) => {
        this.logger.error({ err }, "Relay WebSocket error");
        if (ws.readyState !== WebSocket.OPEN) {
          reject(err);
        }
      });
    });
  }

  private armLiveness(ws: WebSocket): void {
    this.clearLiveness();
    this.livenessTimer = setTimeout(() => {
      this.logger.warn("Relay silent too long, terminating connection");
      ws.terminate(); // 触发 close → 重连
    }, this.config.livenessTimeoutMs ?? 90000);
  }

  private clearLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = null;
  }

  private handleMessage(raw: string): void {
    let msg: RelayToAgent | RelayResponse;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.logger.warn({ raw: raw.slice(0, 100) }, "Invalid JSON from relay");
      return;
    }

    if ("requestId" in msg && msg.type === "response") {
      const pending = this.pending.get(msg.requestId);
      if (pending) {
        this.pending.delete(msg.requestId);
        pending.resolve(msg as RelayResponse);
      }
      return;
    }

    const downstream = msg as RelayToAgent;
    switch (downstream.type) {
      case "message":
        this.events.onMessage({
          messageId: downstream.messageId,
          chatId: downstream.chatId,
          senderOpenId: downstream.senderOpenId,
          text: downstream.text,
          imageKeys: downstream.imageKeys,
        }).catch((err) => this.logger.error({ err }, "Error handling relay message"));
        break;

      case "card_action":
        this.events.onCardAction({
          senderOpenId: downstream.senderOpenId,
          value: downstream.value as unknown as CardActionPayload,
        }).then((result) => {
          if (result && result.card) {
            this.send({ type: "update_card", messageId: downstream.messageId, card: result.card, requestId: this.newId() });
          }
        }).catch((err) => this.logger.error({ err }, "Error handling card action"));
        break;

      case "ping":
        this.send({ type: "pong" });
        break;

      case "paired":
        this.logger.info({ userId: downstream.userId }, "Paired with user");
        break;

      case "error":
        this.logger.error({ message: downstream.message }, "Relay error");
        break;
    }
  }

  private async request(msg: AgentToRelay & { requestId: string }): Promise<RelayResponse> {
    // 未连接时 send() 会静默丢弃，直接返回失败，避免调用方卡满超时。
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return { type: "response", requestId: msg.requestId, success: false, error: "relay not connected" };
    }
    const deferred = createDeferred<RelayResponse>();
    this.pending.set(msg.requestId, deferred);
    this.send(msg);

    const timeout = setTimeout(() => {
      this.pending.delete(msg.requestId);
      deferred.resolve({ type: "response", requestId: msg.requestId, success: false, error: "timeout" });
    }, this.config.requestTimeoutMs ?? 15000);

    const result = await deferred.promise;
    clearTimeout(timeout);
    return result;
  }

  private failPending(error: string): void {
    for (const [requestId, d] of this.pending) {
      d.resolve({ type: "response", requestId, success: false, error });
    }
    this.pending.clear();
  }

  private send(msg: AgentToRelay): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    const interval = this.config.reconnectIntervalMs ?? 5000;
    this.logger.info({ interval }, "Reconnecting in...");
    setTimeout(async () => {
      this.reconnecting = false;
      try {
        await this.connect();
      } catch (err) {
        this.logger.error({ err }, "Reconnect failed");
        this.scheduleReconnect();
      }
    }, interval);
  }

  private newId(): string {
    return crypto.randomUUID().slice(0, 8);
  }
}
