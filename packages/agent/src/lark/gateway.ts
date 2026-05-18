import {
  WSClient,
  EventDispatcher,
} from "@larksuiteoapi/node-sdk";
import type { Logger } from "../util/logger.js";
import type { LarkClient } from "./client.js";
import type { IncomingMessage, CardActionPayload } from "../types.js";
import type { FeishuCardV2 } from "./cards/types.js";
import { LruDedup } from "../util/dedup.js";

export interface AccessConfig {
  allowed_open_ids: string[];
  unauthorized_behavior: "ignore" | "reject";
}

export interface LarkGatewayOptions {
  config: { app_id: string; app_secret: string };
  access: AccessConfig;
  logger: Logger;
  larkClient: LarkClient;
  onMessage: (msg: IncomingMessage) => Promise<void>;
  onCardAction: (action: { senderOpenId: string; value: CardActionPayload }) => Promise<{ card?: FeishuCardV2 } | void>;
}

interface ReceiveV1Event {
  sender: { sender_id: { open_id: string } };
  message: {
    message_id: string;
    chat_id: string;
    message_type: string;
    content: string;
    parent_id?: string;
  };
}

interface CardActionEvent {
  operator: { open_id: string };
  action: { value: Record<string, unknown> };
}

export class LarkGateway {
  private readonly wsClient: WSClient;
  private readonly dedup = new LruDedup(1000);
  private readonly logger: Logger;
  private readonly access: AccessConfig;
  private readonly larkClient: LarkClient;
  private readonly onMessage: LarkGatewayOptions["onMessage"];
  private readonly onCardAction: LarkGatewayOptions["onCardAction"];

  constructor(opts: LarkGatewayOptions) {
    this.logger = opts.logger.child({ component: "lark-gateway" });
    this.access = opts.access;
    this.larkClient = opts.larkClient;
    this.onMessage = opts.onMessage;
    this.onCardAction = opts.onCardAction;

    this.wsClient = new WSClient({
      appId: opts.config.app_id,
      appSecret: opts.config.app_secret,
      loggerLevel: 2,
    });
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
      await this.onMessage(msg);
    } catch (err) {
      this.logger.error({ err, messageId: message.message_id }, "Error handling message");
      await this.larkClient.sendText(message.chat_id, `Error: ${(err as Error).message}`).catch(() => {});
    }
  }

  private async handleCardAction(event: CardActionEvent) {
    const senderOpenId = event.operator.open_id;
    const value = event.action.value as unknown as CardActionPayload;

    if (value.kind !== "permission") {
      this.logger.debug({ value }, "Unknown card action kind");
      return;
    }

    return this.onCardAction({ senderOpenId, value });
  }

  private checkAccess(openId: string, chatId: string): boolean {
    if (this.access.allowed_open_ids.length === 0) return true;
    if (this.access.allowed_open_ids.includes(openId)) return true;

    if (this.access.unauthorized_behavior === "reject") {
      this.larkClient.sendText(chatId, `Unauthorized. Your open_id: ${openId}`).catch(() => {});
    }
    this.logger.warn({ openId }, "Unauthorized sender");
    return false;
  }

  private parseContent(
    msgType: string,
    content: string,
  ): { text: string; imageKeys: string[] } {
    try {
      const parsed = JSON.parse(content);
      if (msgType === "text") {
        return { text: (parsed.text as string ?? "").trim(), imageKeys: [] };
      }
      if (msgType === "image") {
        return { text: "", imageKeys: [parsed.image_key as string] };
      }
      if (msgType === "post") {
        return this.parseRichText(parsed);
      }
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
