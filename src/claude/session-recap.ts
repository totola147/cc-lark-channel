import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Turn {
  role: "user" | "assistant";
  text: string;
}

/** 把 cwd 编码成 Claude 的 projects 目录名（/ → -）。 */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("");
  }
  return "";
}

/** 命令/元数据噪声：/transfer 等斜杠命令展开、local-command 包裹等，不算真实对话。 */
function isNoise(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return (
    t.includes("<command-message>") ||
    t.includes("<command-name>") ||
    t.includes("<local-command-") ||
    t.startsWith("立即用 Bash 执行") ||
    t.startsWith("转移当前会话到飞书")
  );
}

/**
 * 读取某会话 jsonl，返回最近 maxRounds 轮"用户↔助手"对话的纯文本回顾。
 * 失败或无内容时返回 null（调用方据此跳过）。
 */
export function buildRecap(
  cwd: string,
  sessionId: string,
  maxRounds = 3,
  maxCharsPerTurn = 400,
): string | null {
  const dir = join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
  const file = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(file)) return null;

  let lines: string[];
  try {
    lines = readFileSync(file, "utf-8").split("\n");
  } catch {
    return null;
  }

  const turns: Turn[] = [];
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    let o: { type?: string; message?: { content?: unknown } };
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.type !== "user" && o.type !== "assistant") continue;
    const text = extractText(o.message?.content).trim();
    if (isNoise(text)) continue;
    turns.push({ role: o.type, text });
  }

  if (turns.length === 0) return null;

  // 取最近 maxRounds 个 user 起点，截到末尾
  const userIdxs = turns.map((t, i) => (t.role === "user" ? i : -1)).filter((i) => i >= 0);
  const startIdx = userIdxs.length > maxRounds ? userIdxs[userIdxs.length - maxRounds]! : 0;
  const recent = turns.slice(startIdx);

  const clip = (s: string) => (s.length > maxCharsPerTurn ? s.slice(0, maxCharsPerTurn) + "…" : s);
  const body = recent
    .map((t) => (t.role === "user" ? `👤 ${clip(t.text)}` : `🤖 ${clip(t.text)}`))
    .join("\n\n");

  return `📋 最近对话回顾：\n\n${body}`;
}
