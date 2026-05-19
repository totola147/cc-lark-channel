import { Client as LarkSDKClient } from "@larksuiteoapi/node-sdk";
import type { FeishuCardV2 } from "./cards/types.js";
import type { Logger } from "../util/logger.js";

export interface LarkConfig {
  app_id: string;
  app_secret: string;
}

export class LarkClient {
  readonly sdk: LarkSDKClient;

  constructor(
    config: LarkConfig,
    private readonly logger: Logger,
  ) {
    this.sdk = new LarkSDKClient({
      appId: config.app_id,
      appSecret: config.app_secret,
    });
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const res = await this.sdk.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    if (res.code !== 0) {
      throw new Error(`Lark sendText failed: code=${res.code} msg=${res.msg}`);
    }
    return res.data?.message_id ?? "";
  }

  async sendCard(chatId: string, card: FeishuCardV2): Promise<string> {
    const res = await this.sdk.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    if (res.code !== 0) {
      throw new Error(`Lark sendCard failed: code=${res.code} msg=${res.msg}`);
    }
    return res.data?.message_id ?? "";
  }

  async updateCard(messageId: string, card: FeishuCardV2): Promise<void> {
    const res = await this.sdk.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    if (res.code !== 0) {
      this.logger.warn({ messageId, code: res.code }, "Lark updateCard failed");
    }
  }

  async sendImage(chatId: string, imageKey: string): Promise<string> {
    const res = await this.sdk.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
    if (res.code !== 0) {
      throw new Error(`Lark sendImage failed: code=${res.code} msg=${res.msg}`);
    }
    return res.data?.message_id ?? "";
  }

  async uploadImage(imageBuffer: Buffer): Promise<string> {
    const res = await this.sdk.im.v1.image.create({
      data: {
        image_type: "message",
        image: imageBuffer,
      },
    } as Parameters<typeof this.sdk.im.v1.image.create>[0]);
    const result = res as unknown as { code: number; msg?: string; data?: { image_key?: string } };
    if (result.code !== 0) {
      throw new Error(`Lark uploadImage failed: code=${result.code} msg=${result.msg}`);
    }
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

  async createGroup(name: string, description: string, ownerOpenId: string): Promise<string> {
    const res = await this.sdk.im.v1.chat.create({
      params: { user_id_type: "open_id" },
      data: {
        name,
        description,
        chat_mode: "group",
        chat_type: "private",
        owner_id: ownerOpenId,
      },
    });
    if (res.code !== 0) {
      throw new Error(`Lark createGroup failed: code=${res.code} msg=${res.msg}`);
    }
    return res.data?.chat_id ?? "";
  }

  async dissolveGroup(chatId: string): Promise<void> {
    const res = await this.sdk.im.v1.chat.delete({
      path: { chat_id: chatId },
    });
    if (res.code !== 0) {
      this.logger.warn({ chatId, code: res.code }, "Lark dissolveGroup failed");
    }
  }
}
