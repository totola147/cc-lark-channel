import type { FeishuCardV2 } from "@cc-lark/protocol";
import type { IncomingMessage, CardActionPayload } from "../types.js";

export type CardActionResult = { card?: FeishuCardV2 } | void;

export interface Transport {
  start(): Promise<void>;

  sendText(chatId: string, text: string): Promise<string>;
  sendCard(chatId: string, card: FeishuCardV2): Promise<string>;
  updateCard(messageId: string, card: FeishuCardV2): Promise<void>;
  sendImage(chatId: string, imageKey: string): Promise<string>;
  uploadImage(imageBuffer: Buffer): Promise<string>;
  downloadImage(messageId: string, imageKey: string): Promise<Buffer>;
  createGroup(name: string, description: string, ownerOpenId: string): Promise<string>;
  dissolveGroup(chatId: string): Promise<void>;
}

export interface TransportEvents {
  onMessage: (msg: IncomingMessage) => Promise<void>;
  onCardAction: (action: { senderOpenId: string; value: CardActionPayload }) => Promise<CardActionResult>;
}
