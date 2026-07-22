import { query, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../util/logger.js";
import type { RenderEvent, PermissionMode, EffortLevel } from "../types.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { QuestionSpec } from "../lark/cards/question-card.js";

export interface QueryOptions {
  prompt: string;
  imageDataUris?: string[];
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  cliPath: string;
  resumeId?: string;
  effort?: EffortLevel;
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

  // Build prompt: string for text-only, AsyncIterable<SDKUserMessage> for multimodal
  let promptInput: string | AsyncIterable<{ type: "user"; message: { role: "user"; content: unknown[] }; parent_tool_use_id: null }>;
  if (opts.imageDataUris?.length) {
    const content: unknown[] = [];
    if (opts.prompt) content.push({ type: "text", text: opts.prompt });
    for (const uri of opts.imageDataUris) {
      const data = uri.replace(/^data:image\/\w+;base64,/, "");
      content.push({ type: "image", source: { type: "base64", media_type: "image/png", data } });
    }
    const msg = { type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null };
    promptInput = (async function* () { yield msg; })();
  } else {
    promptInput = opts.prompt;
  }

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
    prompt: promptInput as Parameters<typeof query>[0]["prompt"],
    options: {
      cwd: opts.cwd,
      model: opts.model || undefined,
      // Map bypassPermissions -> default so the SDK keeps calling canUseTool
      // (needed for AskUserQuestion); the auto-allow above provides the bypass.
      permissionMode: bypass ? "default" : opts.permissionMode,
      pathToClaudeCodeExecutable: opts.cliPath,
      abortController: abort,
      env: { ...process.env },
      ...(opts.resumeId ? { resume: opts.resumeId } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      canUseTool,
    },
  });

  const events: AsyncIterable<RenderEvent> & { sessionId?: string } = {
    sessionId: undefined,
    async *[Symbol.asyncIterator]() {
      const startTime = Date.now();
      let inputTokens = 0;
      let outputTokens = 0;
      let resolvedModel: string | undefined;
      let contextWindow: number | undefined;

      try {
        for await (const msg of q as AsyncIterable<SDKMessage>) {
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
              if (block.type === "tool_result") {
                const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
                yield { type: "tool_result" as const, toolUseId: block.tool_use_id ?? "", isError: !!block.is_error, text };
              }
            }
          }
          if (msg.type === "system" && msg.subtype === "init" && msg.model) {
            resolvedModel = msg.model;
          }
          if (msg.type === "result") {
            inputTokens = msg.usage?.input_tokens ?? 0;
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
        if (aborted) {
          logger.debug("Query iterator threw after abort — expected");
          return;
        }
        throw err;
      }

      yield {
        type: "turn_end" as const,
        durationMs: Date.now() - startTime,
        inputTokens,
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
  message?: { content?: readonly SDKContentBlock[] };
  usage?: { input_tokens?: number; output_tokens?: number };
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
