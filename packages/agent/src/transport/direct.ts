import {
  Client as LarkSDKClient,
  WSClient,
  EventDispatcher,
} from "@larksuiteoapi/node-sdk";
import type { FeishuCardV2 } from "@cc-lark/protocol";
import type { Logger } from "../util/logger.js";
import type { IncomingMessage, CardActionPayload } from "../types.js";
import type { Transport, TransportEvents, CardActionResult } from "./interface.js";
import { LruDedup } from "../util/dedup.js";

export interface DirectTransportConfig {
  app_id: string;
  app_secret: string;
  allowed_open_ids: string[];
  unauthorized_behavior: "ignore" | "reject";
}

export class DirectTransport implements Transport {
  private readonly sdk: LarkSDKClient;
  private readonly wsClient: WSClient;
  private readonly dedup = new LruDedup(1000);
  private readonly logger: Logger;
  private readonly config: DirectTransportConfig;
  private events!: TransportEvents;

  constructor(config: DirectTransportConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: "direct-transport" });
    this.sdk = new LarkSDKClient({ appId: config.app_id, appSecret: config.app_secret });
    this.wsClient = new WSClient({ appId: config.app_id, appSecret: config.app_secret, loggerLevel: 2 });
  }

  setEvents(events: TransportEvents): void {
    this.events = events;
  }

  async start(): Promise<void> {
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        await this.handleMessage(data as ReceiveV1Event);
      },
      "card.action.trigger": async (data: unknown) => {
        const result = await this.handleCardAction(data as CardActionEvent);
        if (result && result.card) {
          return { card: { type: "raw", data: result.card } };
        }
        return {};
      },
    });

    this.logger.info("Starting Lark WebSocket connection");
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const res = await this.sdk.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    });
    if (res.code !== 0) throw new Error(`Lark sendText failed: code=${res.code} msg=${res.msg}`);
    return res.data?.message_id ?? "";
  }

  async sendCard(chatId: string, card: FeishuCardV2): Promise<string> {
    const res = await this.sdk.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
    });
    if (res.code !== 0) throw new Error(`Lark sendCard failed: code=${res.code} msg=${res.msg}`);
    return res.data?.message_id ?? "";
  }

  async updateCard(messageId: string, card: FeishuCardV2): Promise<void> {
    const res = await this.sdk.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    if (res.code !== 0) this.logger.warn({ messageId, code: res.code }, "Lark updateCard failed");
  }

  async sendImage(chatId: string, imageKey: string): Promise<string> {
    const res = await this.sdk.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "image", content: JSON.stringify({ image_key: imageKey }) },
    });
    if (res.code !== 0) throw new Error(`Lark sendImage failed: code=${res.code} msg=${res.msg}`);
    return res.data?.message_id ?? "";
  }

  async uploadImage(imageBuffer: Buffer): Promise<string> {
    const res = await this.sdk.im.v1.image.create({
      data: { image_type: "message", image: imageBuffer },
    } as Parameters<typeof this.sdk.im.v1.image.create>[0]);
    const result = res as unknown as { code: number; msg?: string; data?: { image_key?: string } };
    if (result.code !== 0) throw new Error(`Lark uploadImage failed: code=${result.code}`);
    return result.data?.image_key ?? "";
  }

  async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    const res = await this.sdk.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: "image" },
    });
    const chunks: Buffer[] = [];
    const stream = (res as unknown as { getReadableStream(): AsyncIterable<Uint8Array> }).getReadableStream();
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private async handleMessage(event: ReceiveV1Event): Promise<void> {
    const { message, sender } = event;
    const senderOpenId = sender.sender_id.open_id;

    if (this.dedup.check(message.message_id)) return;
    if (!this.checkAccess(senderOpenId, message.chat_id)) return;

    const parsed = this.parseContent(message.message_type, message.content);
    const msg: IncomingMessage = {
      messageId: message.message_id,
      chatId: message.chat_id,
      senderOpenId,
      text: parsed.text,
      imageKeys: parsed.imageKeys,
      parentMessageId: message.parent_id,
    };

    try {
      await this.events.onMessage(msg);
    } catch (err) {
      this.logger.error({ err, messageId: message.message_id }, "Error handling message");
      await this.sendText(message.chat_id, `Error: ${(err as Error).message}`).catch(() => {});
    }
  }

  private async handleCardAction(event: CardActionEvent): Promise<CardActionResult> {
    const senderOpenId = event.operator.open_id;
    const value = event.action.value as unknown as CardActionPayload;
    if (value.kind !== "permission") return;
    return this.events.onCardAction({ senderOpenId, value });
  }

  private checkAccess(openId: string, chatId: string): boolean {
    if (this.config.allowed_open_ids.length === 0) return true;
    if (this.config.allowed_open_ids.includes(openId)) return true;
    if (this.config.unauthorized_behavior === "reject") {
      this.sendText(chatId, `Unauthorized. Your open_id: ${openId}`).catch(() => {});
    }
    return false;
  }

  private parseContent(msgType: string, content: string): { text: string; imageKeys: string[] } {
    try {
      const parsed = JSON.parse(content);
      if (msgType === "text") return { text: (parsed.text as string ?? "").trim(), imageKeys: [] };
      if (msgType === "image") return { text: "", imageKeys: [parsed.image_key as string] };
      if (msgType === "post") return this.parseRichText(parsed);
      return { text: content, imageKeys: [] };
    } catch {
      return { text: content, imageKeys: [] };
    }
  }

  private parseRichText(parsed: Record<string, unknown>): { text: string; imageKeys: string[] } {
    const texts: string[] = [];
    const imageKeys: string[] = [];
    const content = (parsed.content as Array<Array<Record<string, unknown>>>) ?? [];
    for (const line of content) {
      for (const node of line) {
        if (node.tag === "text") texts.push(node.text as string);
        if (node.tag === "img") imageKeys.push(node.image_key as string);
      }
    }
    return { text: texts.join("").trim(), imageKeys };
  }
}

interface ReceiveV1Event {
  sender: { sender_id: { open_id: string } };
  message: { message_id: string; chat_id: string; message_type: string; content: string; parent_id?: string };
}

interface CardActionEvent {
  operator: { open_id: string };
  action: { value: Record<string, unknown> };
}
