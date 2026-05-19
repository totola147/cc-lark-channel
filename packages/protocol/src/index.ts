import type { FeishuCardV2 } from "./card.js";

// --- Relay → Agent (downstream) ---

export type RelayToAgent =
  | { type: "message"; chatId: string; messageId: string; senderOpenId: string; text: string; imageKeys: string[] }
  | { type: "card_action"; senderOpenId: string; value: { kind: "permission"; request_id: string; choice: string } }
  | { type: "paired"; userId: string }
  | { type: "ping" }
  | { type: "error"; message: string };

// --- Agent → Relay (upstream) ---

export type AgentToRelay =
  | { type: "auth"; openId: string }
  | { type: "pong" }
  | { type: "send_text"; chatId: string; text: string; requestId: string }
  | { type: "send_card"; chatId: string; card: FeishuCardV2; requestId: string }
  | { type: "update_card"; messageId: string; card: FeishuCardV2; requestId: string }
  | { type: "send_image"; chatId: string; imageKey: string; requestId: string }
  | { type: "upload_image"; imageBase64: string; requestId: string }
  | { type: "download_image"; messageId: string; imageKey: string; requestId: string }
  | { type: "create_group"; name: string; description: string; ownerOpenId: string; requestId: string }
  | { type: "dissolve_group"; chatId: string; requestId: string };

// --- Relay → Agent (response to upstream requests) ---

export type RelayResponse =
  | { type: "response"; requestId: string; success: true; data?: ResponseData }
  | { type: "response"; requestId: string; success: false; error: string };

export interface ResponseData {
  messageId?: string;
  chatId?: string;
  imageKey?: string;
  imageBase64?: string;
}

// --- Pairing API (HTTP) ---

export interface PairRequest {
  agentId: string;
}

export interface PairResponse {
  token: string;
  code: string;
  expiresAt: string;
  relayUrl: string;
}

// --- Card type re-export for shared use ---

export type { FeishuCardV2 } from "./card.js";
