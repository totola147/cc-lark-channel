import {
  Client as LarkSDKClient,
  WSClient,
  EventDispatcher,
} from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";
import type { FeishuCardV2, CardActionValue } from "@cc-lark/protocol";
import type { TunnelManager } from "./tunnel.js";

export interface LarkBotConfig {
  appId: string;
  appSecret: string;
}

/** 记住最近处理过的 message_id。飞书 WS 在未及时 ack 时会重投同一事件。 */
export class RecentIds {
  private readonly seen = new Set<string>();
  constructor(private readonly max = 2000) {}
  /** 首次出现返回 false 并记录；重复返回 true。 */
  seenBefore(id: string): boolean {
    if (this.seen.has(id)) return true;
    if (this.seen.size >= this.max) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(id);
    return false;
  }
}

/** 解析飞书消息内容：text / image / post（富文本，含文字和图片）。 */
export function parseMessageContent(msgType: string, content: string): { text: string; imageKeys: string[] } {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (msgType === "text") return { text: String(parsed["text"] ?? "").trim(), imageKeys: [] };
    if (msgType === "image") {
      const key = parsed["image_key"];
      return { text: "", imageKeys: typeof key === "string" && key ? [key] : [] };
    }
    if (msgType === "post") return parsePost(parsed);
    return { text: content, imageKeys: [] };
  } catch {
    return { text: content, imageKeys: [] };
  }
}

function parsePost(parsed: Record<string, unknown>): { text: string; imageKeys: string[] } {
  // 接收事件里 post 通常直接是 {title, content}；个别情况下按语言包一层 {zh_cn: {...}}。
  let body: Record<string, unknown> = parsed;
  if (!Array.isArray(body["content"])) {
    const inner = Object.values(parsed).find(
      (v): v is Record<string, unknown> => !!v && typeof v === "object" && Array.isArray((v as Record<string, unknown>)["content"]),
    );
    if (inner) body = inner;
  }
  const lines = Array.isArray(body["content"]) ? (body["content"] as unknown[]) : [];
  const textLines: string[] = [];
  const imageKeys: string[] = [];
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    let text = "";
    for (const node of line as Array<Record<string, unknown>>) {
      if (!node || typeof node !== "object") continue;
      if ((node["tag"] === "text" || node["tag"] === "a") && typeof node["text"] === "string") text += node["text"];
      if (node["tag"] === "code_block" && typeof node["text"] === "string") text += node["text"];
      if (node["tag"] === "img" && typeof node["image_key"] === "string") imageKeys.push(node["image_key"]);
    }
    textLines.push(text);
  }
  const title = typeof body["title"] === "string" && body["title"] ? `${body["title"]}\n` : "";
  return { text: (title + textLines.join("\n")).trim(), imageKeys };
}

export class LarkBot {
  private readonly sdk: LarkSDKClient;
  private readonly wsClient: WSClient;
  private readonly recentMessages = new RecentIds();

  constructor(
    private readonly config: LarkBotConfig,
    private readonly tunnels: TunnelManager,
    private readonly logger: Logger,
  ) {
    this.sdk = new LarkSDKClient({ appId: config.appId, appSecret: config.appSecret });
    this.wsClient = new WSClient({ appId: config.appId, appSecret: config.appSecret, loggerLevel: 2 });
  }

  async start(): Promise<void> {
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        await this.handleMessage(data as ReceiveV1Event);
      },
      "card.action.trigger": async (data: unknown) => {
        return this.handleCardAction(data as CardActionEvent);
      },
    });

    this.logger.info("Starting shared Lark Bot WebSocket");
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const res = await this.sdk.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    });
    if (res.code !== 0) throw new Error(`sendText failed: ${res.code}`);
    return res.data?.message_id ?? "";
  }

  async sendCard(chatId: string, card: FeishuCardV2): Promise<string> {
    const res = await this.sdk.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
    });
    if (res.code !== 0) throw new Error(`sendCard failed: ${res.code}`);
    return res.data?.message_id ?? "";
  }

  async updateCard(messageId: string, card: FeishuCardV2): Promise<void> {
    await this.sdk.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  async sendImage(chatId: string, imageKey: string): Promise<string> {
    const res = await this.sdk.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "image", content: JSON.stringify({ image_key: imageKey }) },
    });
    if (res.code !== 0) throw new Error(`sendImage failed: ${res.code}`);
    return res.data?.message_id ?? "";
  }

  async uploadImage(imageBase64: string): Promise<string> {
    const buf = Buffer.from(imageBase64, "base64");
    const res = await this.sdk.im.v1.image.create({
      data: { image_type: "message", image: buf },
    } as Parameters<typeof this.sdk.im.v1.image.create>[0]);
    const result = res as unknown as { code: number; data?: { image_key?: string } };
    if (result.code !== 0) throw new Error(`uploadImage failed: ${result.code}`);
    return result.data?.image_key ?? "";
  }

  async downloadImage(messageId: string, imageKey: string): Promise<string> {
    const res = await this.sdk.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: "image" },
    });
    const chunks: Buffer[] = [];
    const stream = (res as unknown as { getReadableStream(): AsyncIterable<Uint8Array> }).getReadableStream();
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("base64");
  }

  async createGroup(name: string, description: string, ownerOpenId: string): Promise<string> {
    const res = await this.sdk.im.v1.chat.create({
      params: { user_id_type: "open_id" },
      data: { name, description, chat_mode: "group", chat_type: "private", owner_id: ownerOpenId },
    });
    if (res.code !== 0) throw new Error(`createGroup failed: code=${res.code} msg=${res.msg}`);
    return res.data?.chat_id ?? "";
  }

  async dissolveGroup(chatId: string): Promise<void> {
    const res = await this.sdk.im.v1.chat.delete({ path: { chat_id: chatId } });
    if (res.code !== 0) this.logger.warn({ chatId, code: res.code }, "dissolveGroup failed");
  }

  private async handleMessage(event: ReceiveV1Event): Promise<void> {
    const senderOpenId = event.sender.sender_id.open_id;
    const { message } = event;
    const chatId = message.chat_id;

    if (message.message_id && this.recentMessages.seenBefore(message.message_id)) {
      this.logger.debug({ messageId: message.message_id }, "Duplicate message event, ignoring");
      return;
    }

    // Resolve the route FIRST, then use it as the liveness gate. Gating on
    // `isUserOnline` (the per-user fallback pointer) rejected messages in
    // chats whose owning agent was online but was not the user's most-recent
    // agent — e.g. after a second agent for the same openId disconnected and
    // cleared the fallback. The reachable-agent question and the routing
    // question must be answered by the same lookup.
    const route = this.tunnels.resolveAgentForChat(chatId, senderOpenId);
    this.logger.info(
      { chatId, senderOpenId, routedAgentId: route?.tunnel.agentId, via: route?.via, messageId: message.message_id },
      "ROUTE inbound message",
    );

    if (!route) {
      await this.sendText(chatId,
        `⚠️ Agent 未连接\n\n请在本地启动并完成设备码配对:\nclc --relay ws://<relay-ip>:9000`
      );
      return;
    }

    const parsed = parseMessageContent(message.message_type, message.content);

    this.tunnels.send(route.tunnel.agentId, {
      type: "message",
      chatId,
      messageId: message.message_id,
      senderOpenId,
      text: parsed.text,
      imageKeys: parsed.imageKeys,
    });
  }

  private async handleCardAction(event: CardActionEvent): Promise<unknown> {
    const senderOpenId = event.operator.open_id;
    const value = event.action.value;
    const { messageId, chatId } = extractCardActionIds(event);

    // Forward every card_action to the agent regardless of kind. The agent's
    // PermissionBroker dispatches by value.kind (permission vs
    // question_option/question_submit). Gating on kind === "permission" here
    // silently dropped AskUserQuestion card taps, so those cards never got a
    // response.
    if (value && typeof value.kind === "string") {
      // Route by chat ownership first (same rule as inbound messages), so a
      // card tap reaches the agent that owns that group.
      const route = this.tunnels.resolveAgentForChat(chatId, senderOpenId);
      this.logger.info(
        {
          chatId,
          senderOpenId,
          routedAgentId: route?.tunnel.agentId,
          via: route?.via,
          kind: value.kind,
          requestId: (value as { request_id?: string }).request_id,
        },
        "ROUTE inbound card_action",
      );
      if (route) {
        this.tunnels.send(route.tunnel.agentId, {
          type: "card_action",
          senderOpenId,
          messageId,
          value: value as unknown as CardActionValue,
        });
      }
    }
    return {};
  }

}

interface ReceiveV1Event {
  sender: { sender_id: { open_id: string } };
  message: { message_id: string; chat_id: string; message_type: string; content: string };
}

/**
 * Extract the card's message/chat ids from a `card.action.trigger` event.
 * v2 nests them under `context`; older/alternate surfaces (webhook vs WS,
 * older schema) may deliver them at the root. Prefer context, fall back to
 * root, default to empty string. An empty messageId makes `update_card`
 * silently no-op, which previously broke multi-select question cards (their
 * checkbox toggle and submit are entirely redraw-driven).
 */
export function extractCardActionIds(event: CardActionEvent): {
  messageId: string;
  chatId: string;
} {
  return {
    messageId: event.context?.open_message_id ?? event.open_message_id ?? "",
    chatId: event.context?.open_chat_id ?? event.open_chat_id ?? "",
  };
}

export interface CardActionEvent {
  operator: { open_id: string };
  action: { value: Record<string, unknown> };
  /**
   * v2 `card.action.trigger` nests the ids here. `open_message_id` is needed
   * to redraw the card in place; `open_chat_id` drives chat-ownership routing.
   */
  context?: {
    open_message_id?: string;
    open_chat_id?: string;
  };
  /** Root-level fallbacks for older/alternate event surfaces. */
  open_message_id?: string;
  open_chat_id?: string;
}
