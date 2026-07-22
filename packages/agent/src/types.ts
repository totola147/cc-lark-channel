export interface IncomingMessage {
  messageId: string;
  chatId: string;
  senderOpenId: string;
  text: string;
  imageKeys: string[];
  parentMessageId?: string;
}

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

/** Reasoning effort level, mirrored from the Claude Agent SDK's EffortLevel. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type SessionState = "idle" | "generating" | "awaiting_permission";

export interface SessionStatus {
  state: SessionState;
  permissionMode: PermissionMode;
  model: string;
  effort?: EffortLevel;
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
  | { type: "turn_end"; durationMs: number; inputTokens: number; outputTokens: number; model?: string; contextWindow?: number }
  | { type: "queued"; position: number }
  | { type: "interrupted"; reason: "stop" | "bang_prefix" }
  | { type: "stop_ack" }
  | { type: "permission_request"; requestId: string; toolName: string; input: unknown }
  | { type: "permission_resolved"; requestId: string; choice: PermissionChoice }
  | { type: "error"; message: string };

export type PermissionChoice = "allow" | "deny" | "allow_turn" | "allow_session";

/** Permission approval card action. */
export interface PermissionActionPayload {
  kind: "permission";
  request_id: string;
  choice: PermissionChoice;
}

/**
 * AskUserQuestion — user tapped an option.
 * For single-select this resolves the question immediately.
 * For multi-select this toggles the option's selected state.
 */
export interface QuestionOptionActionPayload {
  kind: "question_option";
  request_id: string;
  /** Question index within the AskUserQuestion input. */
  q: number;
  /** Option index within the question. */
  opt: number;
}

/** AskUserQuestion — user tapped submit on a multi-select question. */
export interface QuestionSubmitActionPayload {
  kind: "question_submit";
  request_id: string;
  q: number;
}

/**
 * AskUserQuestion — user tapped "Other". Switches the question to free-text
 * mode; the next chat message in that chat is consumed as the answer.
 */
export interface QuestionOtherActionPayload {
  kind: "question_other";
  request_id: string;
  q: number;
}

export type CardActionPayload =
  | PermissionActionPayload
  | QuestionOptionActionPayload
  | QuestionSubmitActionPayload
  | QuestionOtherActionPayload;
