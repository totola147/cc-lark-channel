import type { AuthStore } from "./auth-store.js";

export interface AgentAuthMessage {
  type: "auth";
  openId?: unknown;
  agentId?: unknown;
  token?: unknown;
}

export type AuthDecision =
  | { ok: true; openId: string; agentId: string; legacy: boolean }
  | { ok: false; error: string };

/**
 * 校验 agent 的 WS auth 消息。
 *
 * 必须同时提供 openId 和与之匹配的 token（配对时签发）。只有显式开启
 * allowLegacy 时才接受不带 token 的旧客户端，用于过渡期。
 */
export function authenticateAgent(
  msg: AgentAuthMessage,
  store: AuthStore,
  opts: { allowLegacy: boolean },
): AuthDecision {
  const openId = typeof msg.openId === "string" ? msg.openId.trim() : "";
  if (!openId) return { ok: false, error: "openId required" };
  const rawAgentId = typeof msg.agentId === "string" ? msg.agentId.trim() : "";
  // agentId 只用于同一 openId 下多 agent 区分，限制长度/字符避免日志注入。
  const agentId = rawAgentId && /^[A-Za-z0-9._-]{1,64}$/.test(rawAgentId) ? rawAgentId : openId;
  const token = typeof msg.token === "string" ? msg.token : undefined;

  if (token) {
    if (store.verify(openId, token)) return { ok: true, openId, agentId, legacy: false };
    return { ok: false, error: "invalid token" };
  }
  if (opts.allowLegacy) return { ok: true, openId, agentId, legacy: true };
  return { ok: false, error: "token required: re-pair this agent (clc --relay <url> --repair)" };
}
