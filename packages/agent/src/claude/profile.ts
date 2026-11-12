import { resolve } from "node:path";
import { homedir } from "node:os";
import type { AppConfig } from "../config.js";

/**
 * 运行档（profile）：让飞书侧会话用与终端相同的网关 / settings 启动 claude。
 * 终端用 `cc-session --lark-profile fermi` 启动，转移时只把档名告诉 agent；
 * 地址、token、settings 都在 agent 的配置里，不经过 IPC，也不写进 state.json。
 */
export interface ProfileConfig {
  /** 覆盖 ANTHROPIC_BASE_URL。 */
  base_url?: string;
  /** 从 agent 进程的哪个环境变量取 token，填入 ANTHROPIC_AUTH_TOKEN。只写变量名，不写 token 本身。 */
  auth_token_env?: string;
  /** 从 agent 进程的哪个环境变量取 key，填入 ANTHROPIC_API_KEY。 */
  api_key_env?: string;
  /** 等同 claude --settings <path>。 */
  settings?: string;
  /** 该档默认模型；会话里显式设置的模型（/model 或终端 --model）优先。 */
  model?: string;
  /** 该档使用的 claude 可执行文件，缺省用 claude.cli_path。 */
  cli_path?: string;
  /** 额外环境变量（非密钥）。 */
  env?: Record<string, string>;
}

export interface ResolvedProfile {
  env: Record<string, string | undefined>;
  settings?: string;
  model?: string;
  cliPath?: string;
}

export class ProfileError extends Error {}

/** 档名只允许简单标识符，避免日志/卡片注入。 */
export const PROFILE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function expandHome(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

/**
 * 把档名解析成启动参数。未设置档名返回 undefined（沿用 agent 默认环境）。
 * 档不存在或引用的环境变量缺失时抛 ProfileError，由调用方报给用户，
 * 不静默回退到默认网关，免得会话换了上游而用户不知道。
 */
export function resolveProfile(
  name: string | undefined,
  config: Partial<Pick<AppConfig, "profiles">>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProfile | undefined {
  if (!name) return undefined;
  const profiles = config.profiles ?? {};
  const p = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (!p) {
    const known = Object.keys(profiles);
    throw new ProfileError(
      `运行档 "${name}" 未在 agent 配置中定义${known.length ? `（可用：${known.join(", ")}）` : "（[profiles] 为空）"}`,
    );
  }
  const out: Record<string, string | undefined> = { ...(p.env ?? {}) };
  if (p.base_url) out["ANTHROPIC_BASE_URL"] = p.base_url;
  if (p.auth_token_env) {
    const v = env[p.auth_token_env];
    if (!v) throw new ProfileError(`运行档 "${name}" 需要环境变量 ${p.auth_token_env}，但 agent 进程中未设置`);
    out["ANTHROPIC_AUTH_TOKEN"] = v;
    // 同时存在 API_KEY 时 CLI 会优先用它，导致请求带错凭据；用 token 的档清掉 key。
    if (!p.api_key_env) out["ANTHROPIC_API_KEY"] = undefined;
  }
  if (p.api_key_env) {
    const v = env[p.api_key_env];
    if (!v) throw new ProfileError(`运行档 "${name}" 需要环境变量 ${p.api_key_env}，但 agent 进程中未设置`);
    out["ANTHROPIC_API_KEY"] = v;
    if (!p.auth_token_env) out["ANTHROPIC_AUTH_TOKEN"] = undefined;
  }
  return {
    env: out,
    settings: p.settings ? expandHome(p.settings) : undefined,
    model: p.model || undefined,
    cliPath: p.cli_path || undefined,
  };
}

/** 合并进程环境与档环境：值为 undefined 的键表示删除。 */
export function buildEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}
