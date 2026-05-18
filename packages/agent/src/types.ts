export interface IncomingMessage {
  messageId: string;
  chatId: string;
  senderOpenId: string;
  text: string;
  imageKeys: string[];
  parentMessageId?: string;
}

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export type SessionState = "idle" | "generating" | "awaiting_permission";

export interface SessionStatus {
  state: SessionState;
  permissionMode: PermissionMode;
  model: string;
  cwd: string;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  queueLength: number;
  providerSessionId?: string;
  createdAt: string;
  lastActiveAt: string;
}

export type RenderEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { type: "turn_end"; durationMs: number; inputTokens: number; outputTokens: number }
  | { type: "queued"; position: number }
  | { type: "interrupted"; reason: "stop" | "bang_prefix" }
  | { type: "stop_ack" }
  | { type: "permission_request"; requestId: string; toolName: string; input: unknown }
  | { type: "permission_resolved"; requestId: string; choice: PermissionChoice }
  | { type: "error"; message: string };

export type PermissionChoice = "allow" | "deny" | "allow_turn" | "allow_session";

export interface CardActionPayload {
  kind: "permission";
  request_id: string;
  choice: PermissionChoice;
}
