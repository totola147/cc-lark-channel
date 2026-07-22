import type { FeishuCardV2, FeishuElement } from "./types.js";

const PREVIEW_MAX = 800;
const DESC_MAX = 300;

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface QuestionSpec {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface BuildQuestionArgs {
  requestId: string;
  /** Index of this question. */
  qIndex: number;
  /** Total number of questions in this AskUserQuestion call. */
  total: number;
  question: QuestionSpec;
  /** Currently selected option indexes (used for multi-select redraws). */
  selected: number[];
  /**
   * When true, the user tapped "Other" and the card is waiting for a free-text
   * reply in chat. Renders a hint instead of resolving via buttons.
   */
  awaitingText?: boolean;
}

/**
 * Build a card for a single question. Single-select renders one button per
 * option (tap = resolve). Multi-select renders toggle buttons plus a submit
 * button; selected options are marked and the card is redrawn in place.
 */
export function buildQuestionCard(args: BuildQuestionArgs): FeishuCardV2 {
  const { requestId, qIndex, total, question, selected, awaitingText } = args;
  const counter = total > 1 ? ` (${qIndex + 1}/${total})` : "";
  const headerText = question.header
    ? `❓ ${esc(question.header)}${counter}`
    : `❓ Question${counter}`;

  const elements: FeishuElement[] = [
    { tag: "markdown", content: `**${esc(question.question)}**` },
  ];

  // Waiting for a free-text reply (user tapped "Other"): show a hint and stop
  // rendering the interactive buttons.
  if (awaitingText) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content: `<font color="grey">✏️ 请在对话中直接输入你的答案，下一条消息将作为回答。</font>`,
    });
    return {
      schema: "2.0",
      config: { update_multi: true },
      header: { title: { tag: "plain_text", content: headerText }, template: "blue" },
      body: { elements },
    };
  }

  if (question.multiSelect) {
    elements.push({ tag: "markdown", content: `<font color="grey">可多选，选好后点“提交”</font>` });
  }

  question.options.forEach((opt, optIndex) => {
    const isSelected = selected.includes(optIndex);
    const mark = question.multiSelect ? (isSelected ? "☑ " : "⬜ ") : "";
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: `${mark}${opt.label}` },
      type: isSelected ? "primary" : "default",
      width: "fill",
      value: { kind: "question_option", request_id: requestId, q: qIndex, opt: optIndex },
    });
    if (opt.description) {
      elements.push({ tag: "markdown", content: `<font color="grey">${esc(truncate(opt.description, DESC_MAX))}</font>` });
    }
    if (opt.preview) {
      elements.push({ tag: "markdown", content: "```\n" + truncate(opt.preview, PREVIEW_MAX) + "\n```" });
    }
  });

  if (question.multiSelect) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "✅ 提交" },
      type: "primary",
      width: "fill",
      value: { kind: "question_submit", request_id: requestId, q: qIndex },
    });
  }

  // "Other" — let the user type a custom answer in chat instead of picking an
  // option. Mirrors AskUserQuestion's built-in free-text escape hatch.
  elements.push({
    tag: "button",
    text: { tag: "plain_text", content: "✏️ 其他（自定义输入）" },
    type: "default",
    width: "fill",
    value: { kind: "question_other", request_id: requestId, q: qIndex },
  });

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: headerText },
      template: "blue",
    },
    body: { elements },
  };
}

export function buildQuestionResolvedCard(args: {
  header?: string;
  question: string;
  answer: string;
}): FeishuCardV2 {
  const title = args.header ? esc(args.header) : "Question";
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        { tag: "markdown", content: `✅ **${esc(title)}**` },
        { tag: "markdown", content: `${esc(args.question)}` },
        { tag: "markdown", content: `→ **${esc(args.answer)}**` },
      ],
    },
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function esc(text: string): string {
  return text.replace(/[*_`~[\]]/g, "\\$&");
}
