import {
  Client as LarkSDKClient,
  WSClient,
  EventDispatcher,
} from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";
import type { FeishuCardV2 } from "@cc-lark/protocol";
import type { TunnelManager } from "./tunnel.js";

export interface LarkBotConfig {
  appId: string;
  appSecret: string;
}

export class LarkBot {
  private readonly sdk: LarkSDKClient;
  private readonly wsClient: WSClient;

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

  private async handleMessage(event: ReceiveV1Event): Promise<void> {
    const senderOpenId = event.sender.sender_id.open_id;
    const { message } = event;
    const chatId = message.chat_id;

    if (!this.tunnels.isUserOnline(senderOpenId)) {
      await this.sendText(chatId,
        `⚠️ Agent 未连接\n\n你的 open_id:\n${senderOpenId}\n\n请在本地启动:\nnode dist/index.cjs --relay ws://<relay-ip>:9000 --open-id ${senderOpenId}`
      );
      return;
    }

    const parsed = this.parseContent(message.message_type, message.content);

    this.tunnels.sendToUser(senderOpenId, {
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

    if (value.kind === "permission") {
      this.tunnels.sendToUser(senderOpenId, {
        type: "card_action",
        senderOpenId,
        value: value as { kind: "permission"; request_id: string; choice: string },
      });
    }
    return {};
  }

  private parseContent(msgType: string, content: string): { text: string; imageKeys: string[] } {
    try {
      const parsed = JSON.parse(content);
      if (msgType === "text") return { text: (parsed.text as string ?? "").trim(), imageKeys: [] };
      if (msgType === "image") return { text: "", imageKeys: [parsed.image_key as string] };
      return { text: content, imageKeys: [] };
    } catch {
      return { text: content, imageKeys: [] };
    }
  }
}

interface ReceiveV1Event {
  sender: { sender_id: { open_id: string } };
  message: { message_id: string; chat_id: string; message_type: string; content: string };
}

interface CardActionEvent {
  operator: { open_id: string };
  action: { value: Record<string, unknown> };
}
