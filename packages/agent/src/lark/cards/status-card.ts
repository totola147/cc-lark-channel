import type { FeishuCardV2 } from "./types.js";

const OUTPUT_TAIL_MAX = 2000;

export interface StatusCardState {
  thinking?: string;
  currentTool?: { name: string; input: unknown };
  outputText: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  done: boolean;
  /**
   * Why the turn ended without completing, if it did. A finished-but-failed
   * turn must not render as "✅ Done" in green: an aborted startup used to look
   * identical to a successful answer, which is how a silently killed turn
   * showed up as a green card with no reply.
   */
  failure?: string;
  cwd?: string;
  model?: string;
  /** Max context window size for the active model, if known (used to compute ctx%). */
  contextWindow?: number;
  effort?: string;
  /** Number of tools invoked so far this turn (shown as a liveness signal). */
  toolCount?: number;
}

export function buildStatusCard(state: StatusCardState): FeishuCardV2 {
  const elements: FeishuCardV2["body"]["elements"] = [];

  if (state.thinking) {
    const thinkingPreview = state.thinking.length > 300
      ? state.thinking.slice(0, 300) + "..."
      : state.thinking;
    elements.push({
      tag: "markdown",
      content: `💭 **Thinking**\n${thinkingPreview}`,
    });
  }

  if (state.currentTool) {
    let inputPreview: string;
    try {
      inputPreview = JSON.stringify(state.currentTool.input, null, 2);
    } catch {
      inputPreview = String(state.currentTool.input);
    }
    if (inputPreview.length > 500) inputPreview = inputPreview.slice(0, 500) + "...";
    const counter = state.toolCount ? ` (#${state.toolCount})` : "";
    elements.push({
      tag: "markdown",
      content: `🔧 **${esc(state.currentTool.name)}**${counter}\n\`\`\`json\n${inputPreview}\n\`\`\``,
    });
  }

  if (state.outputText) {
    const tail = state.outputText.length > OUTPUT_TAIL_MAX
      ? "..." + state.outputText.slice(-OUTPUT_TAIL_MAX)
      : state.outputText;
    elements.push({
      tag: "markdown",
      content: `📝 **Output**\n${tail}`,
    });
  }

  if (elements.length === 0) {
    elements.push({ tag: "markdown", content: "⏳ Processing..." });
  }

  const failed = state.done && !!state.failure;
  const header = failed ? `⚠️ ${state.failure}` : state.done ? "✅ Done" : "🤖 Generating...";
  const template = failed ? "orange" : state.done ? "green" : "blue";

  // 所有卡片统一为单行状态栏（与回复卡片一致），不再单独显示 📂 路径行——
  // 目录已在状态栏中。仅生成中在同一行末尾追加耗时和工具数作为存活信号。
  const parts = [buildStatusLine(state)];
  if (!state.done) {
    parts.push(`${(state.elapsedMs / 1000).toFixed(1)}s`);
    if (state.toolCount) parts.push(`tools: ${state.toolCount}`);
  }
  elements.push({ tag: "hr" });
  elements.push(statusBarElement(parts.join(" | ")));

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: header }, template },
    body: { elements },
  };
}

/** 状态栏所需的统计字段（StatusCardState 的子集）。 */
export type StatusLineState = Pick<
  StatusCardState,
  "model" | "cwd" | "inputTokens" | "outputTokens" | "contextWindow" | "effort"
>;

/**
 * 底部状态栏文本，形如：
 * `Opus 4.5 | tmp | in: 24497 out: 13 tok | ctx: 12% | effort: xhigh`
 * 未知字段（模型、cwd、上下文窗口、effort）直接省略。
 */
export function buildStatusLine(state: StatusLineState): string {
  const parts: string[] = [];
  if (state.model) parts.push(esc(formatModelName(state.model)));
  const dir = state.cwd ? cwdBasename(state.cwd) : "";
  if (dir) parts.push(esc(dir));
  parts.push(`in: ${state.inputTokens} out: ${state.outputTokens} tok`);
  if (state.contextWindow && state.contextWindow > 0) {
    const pct = Math.min(100, Math.round((state.inputTokens / state.contextWindow) * 100));
    parts.push(`ctx: ${pct}%`);
  }
  if (state.effort) parts.push(`effort: ${esc(state.effort)}`);
  return parts.join(" | ");
}

/**
 * 最终回复卡片：正文为回复 markdown，`statusLine` 存在时在底部加分隔线和灰色状态栏。
 * 长回复分片发送时，只有最后一片带状态栏。
 */
export function buildReplyCard(markdown: string, statusLine?: string): FeishuCardV2 {
  const elements: FeishuCardV2["body"]["elements"] = [{ tag: "markdown", content: markdown }];
  if (statusLine) {
    elements.push({ tag: "hr" });
    elements.push(statusBarElement(statusLine));
  }
  return { schema: "2.0", body: { elements } };
}

/**
 * 把 SDK 返回的模型 id 转成简短显示名：
 * `claude-opus-4-5-20251101` → `Opus 4.5`，`claude-3-5-sonnet-20241022` → `Sonnet 3.5`，
 * `opus` → `Opus`。无法识别时原样返回（去掉 `[1m]` 之类的后缀）。
 */
export function formatModelName(model: string): string {
  const id = model.trim().replace(/\[[^\]]*\]$/, "");
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  // 新格式：claude-<family>-<major>[-<minor>][-<date>]
  const modern = /^(?:claude-)?(opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2}))?)?(?=$|-)/i.exec(id);
  if (modern) {
    const [, family, major, minor] = modern;
    const version = major ? (minor ? `${major}.${minor}` : major) : "";
    return version ? `${cap(family!)} ${version}` : cap(family!);
  }
  // 旧格式：claude-<major>[-<minor>]-<family>[-<date>]
  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?=$|-)/i.exec(id);
  if (legacy) {
    const [, major, minor, family] = legacy;
    return `${cap(family!)} ${minor ? `${major}.${minor}` : major}`;
  }
  return id;
}

function cwdBasename(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) return "/";
  const segs = trimmed.split(/[\\/]/);
  return segs[segs.length - 1] || trimmed;
}

function statusBarElement(line: string): FeishuCardV2["body"]["elements"][number] {
  return { tag: "markdown", content: `<font color="grey">${line}</font>` };
}

function esc(text: string): string {
  return text.replace(/[*_`~[\]]/g, "\\$&");
}
