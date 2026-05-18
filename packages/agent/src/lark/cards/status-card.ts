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
  cwd?: string;
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
    elements.push({
      tag: "markdown",
      content: `🔧 **${esc(state.currentTool.name)}**\n\`\`\`json\n${inputPreview}\n\`\`\``,
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

  const header = state.done ? "✅ Done" : "🤖 Generating...";
  const template = state.done ? "green" : "blue";

  const footer = `Tokens: ${state.inputTokens} in / ${state.outputTokens} out · ${(state.elapsedMs / 1000).toFixed(1)}s`;
  elements.push({ tag: "hr" });
  elements.push({ tag: "markdown", content: `<font color="grey">${footer}</font>` });

  if (state.cwd) {
    elements.push({ tag: "markdown", content: `<font color="grey">📂 ${esc(state.cwd)}</font>` });
  }

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: header }, template },
    body: { elements },
  };
}

function esc(text: string): string {
  return text.replace(/[*_`~[\]]/g, "\\$&");
}
