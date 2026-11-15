export interface IncomingMessage {
  messageId: string;
  chatId: string;
  senderOpenId: string;
  text: string;
  imageKeys: string[];
  parentMessageId?: string;
}

/** 与 Claude Agent SDK 的 PermissionMode 一致。 */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

/**
 * 规范化来自终端/配置/命令的权限模式。CLI 还接受 "manual"（等价于 default）。
 * 不认识的值返回 undefined，由调用方决定忽略还是报错。
 */
export function normalizePermissionMode(raw: string | undefined | null): PermissionMode | undefined {
  if (!raw) return undefined;
  if (raw === "manual") return "default";
  return (PERMISSION_MODES as readonly string[]).includes(raw) ? (raw as PermissionMode) : undefined;
}

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
  /**
   * The CLI launched and (for a resumed session) the resume succeeded. Emitted
   * from the SDK's `system`/`init` message, well before the first token. This
   * is the liveness signal for startup timeouts: gating them on the first
   * text/tool event instead would abort healthy turns whose first token is
   * simply slow (large context, remote proxy, extended thinking).
   */
  | { type: "init"; model?: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { type: "turn_end"; durationMs: number; inputTokens: number; contextTokens?: number; outputTokens: number; model?: string; contextWindow?: number }
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
