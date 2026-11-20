import { query, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../util/logger.js";
import type { RenderEvent, PermissionMode } from "../types.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { QuestionSpec } from "../lark/cards/question-card.js";
import { parseImageDataUri } from "../util/image-mime.js";

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
  /**
   * 新版 CLI 默认不回传 thinking 正文（只给签名）。传 "summarized" 让 CLI 返回
   * 摘要文本，状态卡片才能显示思考过程。只设置 display，不改 thinking 类型。
   */
  thinkingDisplay?: "summarized" | "omitted";
}

export interface QueryHandle {
  events: AsyncIterable<RenderEvent> & { sessionId?: string };
  interrupt: () => Promise<void>;
}

export function createQuery(
  opts: QueryOptions,
  chatId: string,
  broker: PermissionBroker,
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

  // 终端以 --dangerously-skip-permissions 启动、或配置/`/mode` 设为 bypassPermissions 时，
  // 不把 bypassPermissions 传给 SDK：该模式下 SDK 自动放行所有工具、不再调用
  // canUseTool，AskUserQuestion 也就不会被拦截成飞书提问卡片。改为保留
  // canUseTool，在这里自动放行普通工具，提问卡片照常弹出。
  const bypass = opts.permissionMode === "bypassPermissions";

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion") {
      const questions = normalizeQuestions(input);
      if (!questions.length) {
        // 输入格式不对：原样放行。
        // 注意：allow 必须带 updatedInput。新版 CLI 用 Zod 校验 canUseTool 的返回，
        // allow 分支要求 updatedInput 是 record；缺了会抛 ZodError
        // （"expected record, received undefined"），表现为
        // "Tool permission request failed"，而不是普通的拒绝。
        return { behavior: "allow", updatedInput: input };
      }
      const answers = await broker.askQuestions(chatId, questions);
      if (answers === null) {
        return { behavior: "deny", message: "User did not answer (interrupted)" };
      }
      // CLI 从 updatedInput 的 answers（问题文本 -> 答案）合成工具结果。
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }

    // bypassPermissions：用户选择跳过所有权限确认。
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
    prompt: promptInput as Parameters<typeof query>[0]["prompt"],
    options: {
      cwd: opts.cwd,
      model: opts.model || undefined,
      // bypassPermissions 映射为 default，让 SDK 继续调用 canUseTool（AskUserQuestion 需要），
      // 真正的放行由上面的自动 allow 完成。
      permissionMode: bypass ? "default" : opts.permissionMode,
      pathToClaudeCodeExecutable: opts.cliPath,
      abortController: abort,
      env: { ...process.env },
      ...(opts.resumeId ? { resume: opts.resumeId } : {}),
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
            // 尽早记下会话 id：轮次被中断时（拿不到 result）也能继续 resume。
            if (msg.session_id) events.sessionId = msg.session_id;
            // 告知调用方 CLI 已启动，用来区分「CLI 没起来/resume 失败」和「首个 token 慢」。
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
            inputTokens = msg.usage?.input_tokens ?? 0;
            outputTokens = msg.usage?.output_tokens ?? 0;
            if (msg.session_id) {
              events.sessionId = msg.session_id;
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
        outputTokens,
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

interface SDKMessage {
  type: string;
  subtype?: string;
  /** system/init 消息上的实际模型名。 */
  model?: string;
  message?: { content?: readonly SDKContentBlock[] };
  usage?: { input_tokens?: number; output_tokens?: number };
  session_id?: string;
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
