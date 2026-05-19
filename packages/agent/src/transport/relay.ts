import WebSocket from "ws";
import type { FeishuCardV2, RelayToAgent, AgentToRelay, RelayResponse } from "@cc-lark/protocol";
import type { Logger } from "../util/logger.js";
import type { IncomingMessage, CardActionPayload } from "../types.js";
import type { Transport, TransportEvents, CardActionResult } from "./interface.js";
import { createDeferred, type Deferred } from "../util/deferred.js";

export interface RelayTransportConfig {
  relayUrl: string;
  openId: string;
  reconnectIntervalMs?: number;
}

export class RelayTransport implements Transport {
  private ws: WebSocket | null = null;
  private readonly logger: Logger;
  private readonly config: RelayTransportConfig;
  private events!: TransportEvents;
  private readonly pending = new Map<string, Deferred<RelayResponse>>();
  private reconnecting = false;
  private closed = false;

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

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.config.relayUrl.endsWith("/ws") ? this.config.relayUrl : `${this.config.relayUrl}/ws`;
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this.logger.info("Connected to relay");
        this.send({ type: "auth", openId: this.config.openId });
        resolve();
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("close", () => {
        this.logger.warn("Relay connection closed");
        if (!this.closed) this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        this.logger.error({ err }, "Relay WebSocket error");
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          reject(err);
        }
      });
    });
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
            this.send({ type: "update_card", messageId: "", card: result.card, requestId: this.newId() });
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
    const deferred = createDeferred<RelayResponse>();
    this.pending.set(msg.requestId, deferred);
    this.send(msg);

    const timeout = setTimeout(() => {
      this.pending.delete(msg.requestId);
      deferred.resolve({ type: "response", requestId: msg.requestId, success: false, error: "timeout" });
    }, 15000);

    const result = await deferred.promise;
    clearTimeout(timeout);
    return result;
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
