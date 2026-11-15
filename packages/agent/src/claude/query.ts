import { query, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../util/logger.js";
import type { RenderEvent, PermissionMode, EffortLevel } from "../types.js";
import type { SessionPermissions } from "./permission-broker.js";
import type { QuestionSpec } from "../lark/cards/question-card.js";
import { parseImageDataUri } from "../util/image-mime.js";
import { buildEnv } from "./profile.js";

/** 任务全部结束后，等 CLI 是否又起新一轮的宽限。 */
const BACKGROUND_GRACE_MS = 3000;
/** 出 result 后仍有后台任务时，最长等待时间。 */
const BACKGROUND_MAX_WAIT_MS = 30 * 60 * 1000;

export interface QueryOptions {
  prompt: string;
  imageDataUris?: string[];
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  cliPath: string;
  resumeId?: string;
  effort?: EffortLevel;
  /**
   * 新版 CLI 默认不回传 thinking 正文（只给签名）。传 "summarized" 让 CLI 返回
   * 摘要文本，状态卡片才能显示思考过程。只设置 display，不改 thinking 类型。
   */
  thinkingDisplay?: "summarized" | "omitted";
  /** 运行档解析出的环境变量覆盖；值为 undefined 表示从子进程环境中删除。 */
  envOverrides?: Record<string, string | undefined>;
  /** 等同 claude --settings。 */
  settings?: string;
}

export interface QueryHandle {
  events: AsyncIterable<RenderEvent> & { sessionId?: string };
  interrupt: () => Promise<void>;
}

export function createQuery(
  opts: QueryOptions,
  chatId: string,
  broker: Pick<SessionPermissions, "requestPermission" | "askQuestions">,
  logger: Logger,
): QueryHandle {
  const abort = new AbortController();
  let aborted = false;

  // 输入流必须保持打开，直到本轮的后台任务（run_in_background 的 agent/命令）
  // 全部结束。SDK 对字符串 prompt 当作单轮查询：第一个 result 一到就关闭 CLI
  // 的 stdin，而权限确认（canUseTool）走的正是这条通道。后台任务完成后 CLI 会被
  // task-notification 唤醒开启新一轮，此时通道已关，所有需要确认的工具调用都会
  // 报 "Tool permission request failed: AbortError: Stream closed"。
  // 因此一律用 async generator 作为 prompt，由 closeInput() 决定何时放手。
  let closeInput!: () => void;
  const inputClosed = new Promise<void>((resolve) => { closeInput = resolve; });
  const content: unknown[] = [];
  if (opts.prompt) content.push({ type: "text", text: opts.prompt });
  for (const uri of opts.imageDataUris ?? []) {
    const { mediaType, data } = parseImageDataUri(uri);
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }
  const userMsg = { type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null };
  const promptInput = (async function* () {
    yield userMsg;
    await inputClosed;
  })();

  // 后台任务跟踪：只有「已出 result、没有运行中的任务、CLI 空闲」才关输入。
  const runningTasks = new Set<string>();
  let sawResult = false;
  let cliState: "idle" | "running" | "requires_action" | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTimers = () => {
    if (closeTimer) clearTimeout(closeTimer);
    if (capTimer) clearTimeout(capTimer);
    closeTimer = capTimer = null;
  };
  const closeNow = () => { clearTimers(); closeInput(); };
  const maybeClose = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (!sawResult || runningTasks.size > 0 || cliState === "running") return;
    // 任务刚结束时 CLI 可能马上起新一轮（处理 task-notification），给一点宽限。
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (sawResult && runningTasks.size === 0 && cliState !== "running") closeNow();
    }, BACKGROUND_GRACE_MS);
  };
  abort.signal.addEventListener("abort", closeNow, { once: true });

  // Whether the user launched with --dangerously-skip-permissions (mapped to
  // "bypassPermissions" at transfer time). We do NOT pass bypassPermissions to
  // the SDK: in that mode the SDK auto-resolves every tool and never invokes
  // canUseTool, which would also skip our AskUserQuestion interception (the
  // Feishu question cards). Instead we keep canUseTool and auto-allow ordinary
  // tools here, so nothing prompts while AskUserQuestion still renders cards.
  const bypass = opts.permissionMode === "bypassPermissions";

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion") {
      const questions = normalizeQuestions(input);
      if (!questions.length) {
        // Malformed input — fall back to allowing the tool untouched.
        // NOTE: always echo `updatedInput`. The installed CLI validates the
        // canUseTool response with a Zod schema whose allow variant requires
        // `updatedInput` to be a record; omitting it throws a ZodError
        // ("expected record, received undefined") that surfaces as
        // "Tool permission request failed", not a plain deny.
        return { behavior: "allow", updatedInput: input };
      }
      const answers = await broker.askQuestions(chatId, questions);
      if (answers === null) {
        return { behavior: "deny", message: "User did not answer (interrupted)" };
      }
      // The CLI reads `answers` (question text -> answer string) from the
      // updated input and synthesizes the tool result from it.
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }

    // bypassPermissions: user opted to skip all permission prompts.
    if (bypass) {
      return { behavior: "allow", updatedInput: input };
    }

    const allowed = await broker.requestPermission(chatId, toolName, input);
    if (allowed) {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: "User denied permission" };
  };

  const q = query({
    prompt: promptInput as unknown as Parameters<typeof query>[0]["prompt"],
    options: {
      cwd: opts.cwd,
      model: opts.model || undefined,
      // Map bypassPermissions -> default so the SDK keeps calling canUseTool
      // (needed for AskUserQuestion); the auto-allow above provides the bypass.
      permissionMode: bypass ? "default" : opts.permissionMode,
      pathToClaudeCodeExecutable: opts.cliPath,
      abortController: abort,
      env: buildEnv(process.env, opts.envOverrides),
      ...(opts.settings ? { settings: opts.settings } : {}),
      ...(opts.resumeId ? { resume: opts.resumeId } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.thinkingDisplay ? { extraArgs: { "thinking-display": opts.thinkingDisplay } } : {}),
      canUseTool,
    },
  });

  const trackBackground = (m: Record<string, unknown>) => {
    const id = typeof m.task_id === "string" ? m.task_id : undefined;
    switch (m.subtype) {
      case "task_started":
        if (id && !m.skip_transcript) runningTasks.add(id);
        break;
      case "task_notification":
        if (id) runningTasks.delete(id);
        break;
      case "task_updated": {
        const status = (m.patch as { status?: string } | undefined)?.status;
        if (id && (status === "completed" || status === "failed" || status === "killed")) runningTasks.delete(id);
        break;
      }
      case "session_state_changed":
        cliState = m.state as typeof cliState;
        break;
      default:
        return;
    }
    maybeClose();
  };

  const events: AsyncIterable<RenderEvent> & { sessionId?: string } = {
    sessionId: undefined,
    async *[Symbol.asyncIterator]() {
      const startTime = Date.now();
      let inputTokens = 0;
      let outputTokens = 0;
      let resolvedModel: string | undefined;
      let contextWindow: number | undefined;
      // 最近一次主线程 API 调用的 prompt 大小，即当前上下文占用。
      let contextTokens = 0;

      try {
        for await (const msg of q as AsyncIterable<SDKMessage>) {
          // 工具结果在 SDK 里是 user 消息（tool_result 块），不在 assistant 消息里。
          if (msg.type === "user" && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content) {
              if (block.type === "tool_result") {
                yield {
                  type: "tool_result" as const,
                  toolUseId: block.tool_use_id ?? "",
                  isError: !!block.is_error,
                  text: toolResultText(block.content),
                };
              }
            }
          }
          if (msg.type === "assistant" && !msg.parent_tool_use_id && msg.message?.usage) {
            const t = promptTokens(msg.message.usage);
            if (t > 0) contextTokens = t;
          }
          if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                yield { type: "text" as const, text: block.text };
              }
              if (block.type === "thinking" && block.thinking) {
                yield { type: "thinking" as const, text: block.thinking };
              }
              if (block.type === "tool_use") {
                yield { type: "tool_use" as const, id: block.id ?? "", name: block.name ?? "", input: block.input };
              }
            }
          }
          if (msg.type === "system") {
            trackBackground(msg as unknown as Record<string, unknown>);
          }
          if (msg.type === "system" && msg.subtype === "init") {
            if (msg.model) resolvedModel = msg.model;
            // 尽早记下会话 id：轮次被中断时（拿不到 result）也能继续 resume。
            if (msg.session_id) events.sessionId = msg.session_id;
            // Surface startup so the session can distinguish "CLI never came
            // up / resume failed" from "first token is just slow".
            yield { type: "init" as const, model: msg.model };
          }
          if (msg.type === "result") {
            sawResult = true;
            // 有后台任务时最多再等这么久，防止任务悬挂导致本轮永不结束。
            if (runningTasks.size === 0) {
              closeNow(); // 没有后台任务：与原单轮行为一致，立即放手
            } else if (!capTimer) {
              capTimer = setTimeout(closeNow, BACKGROUND_MAX_WAIT_MS);
            }
            inputTokens = promptTokens(msg.usage);
            outputTokens = msg.usage?.output_tokens ?? 0;
            if (msg.session_id) {
              events.sessionId = msg.session_id;
            }
            if (msg.modelUsage) {
              const usageModel = resolvedModel && msg.modelUsage[resolvedModel]
                ? resolvedModel
                : Object.keys(msg.modelUsage)[0];
              if (usageModel) {
                contextWindow = msg.modelUsage[usageModel]?.contextWindow;
                resolvedModel = resolvedModel ?? usageModel;
              }
            }
          }
        }
      } catch (err) {
        closeNow();
        if (aborted) {
          logger.debug("Query iterator threw after abort — expected");
          return;
        }
        throw err;
      }

      closeNow();

      // 被中断的轮次没有完成，不发 turn_end，免得调用方当成正常结束。
      if (aborted) return;

      yield {
        type: "turn_end" as const,
        durationMs: Date.now() - startTime,
        inputTokens,
        contextTokens: contextTokens || inputTokens,
        outputTokens,
        model: resolvedModel,
        contextWindow,
      };
    },
  };

  const interrupt = async (): Promise<void> => {
    if (aborted) return;
    aborted = true;
    abort.abort();
  };

  return { events, interrupt };
}

/** tool_result 的 content 可能是字符串或内容块数组，取出其中的文本。 */
function toolResultText(content: SDKContentBlock["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** Coerce raw AskUserQuestion tool input into validated QuestionSpec[]. */
function normalizeQuestions(input: Record<string, unknown>): QuestionSpec[] {
  const raw = input["questions"];
  if (!Array.isArray(raw)) return [];
  const out: QuestionSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const question = typeof q["question"] === "string" ? q["question"] : "";
    const rawOptions = Array.isArray(q["options"]) ? q["options"] : [];
    const options = rawOptions
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
      .map((o) => ({
        label: typeof o["label"] === "string" ? o["label"] : String(o["label"] ?? ""),
        description: typeof o["description"] === "string" ? o["description"] : undefined,
        preview: typeof o["preview"] === "string" ? o["preview"] : undefined,
      }))
      .filter((o) => o.label.length > 0);
    if (!question || options.length === 0) continue;
    out.push({
      question,
      header: typeof q["header"] === "string" ? q["header"] : undefined,
      options,
      multiSelect: q["multiSelect"] === true,
    });
  }
  return out;
}

/** input_tokens 只含未命中缓存的部分；缓存读写要另加。 */
interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** 一次 API 调用实际送进模型的 prompt 大小（含缓存命中/写入）。 */
export function promptTokens(u: Usage | undefined): number {
  return (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
}

interface SDKMessage {
  type: string;
  subtype?: string;
  message?: { content?: readonly SDKContentBlock[]; usage?: Usage };
  parent_tool_use_id?: string | null;
  usage?: Usage;
  session_id?: string;
  /** Present on 'system'/'init' messages: the resolved model name. */
  model?: string;
  /** Present on 'result' messages: per-model usage, including contextWindow. */
  modelUsage?: Record<string, { contextWindow?: number }>;
}

interface SDKContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | unknown[];
}
