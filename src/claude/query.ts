import { query, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../util/logger.js";
import type { RenderEvent, PermissionMode } from "../types.js";
import type { PermissionBroker } from "./permission-broker.js";

export interface QueryOptions {
  prompt: string;
  imageDataUris?: string[];
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  cliPath: string;
  resumeId?: string;
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

  const q = query({
    prompt: promptInput as Parameters<typeof query>[0]["prompt"],
    options: {
      cwd: opts.cwd,
      model: opts.model || undefined,
      permissionMode: opts.permissionMode,
      pathToClaudeCodeExecutable: opts.cliPath,
      abortController: abort,
      env: { ...process.env },
      ...(opts.resumeId ? { resume: opts.resumeId } : {}),
      canUseTool: async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
        const allowed = await broker.requestPermission(chatId, toolName, input);
        if (allowed) {
          return { behavior: "allow" };
        }
        return { behavior: "deny", message: "User denied permission" };
      },
    },
  });

  const events: AsyncIterable<RenderEvent> & { sessionId?: string } = {
    sessionId: undefined,
    async *[Symbol.asyncIterator]() {
      const startTime = Date.now();
      let inputTokens = 0;
      let outputTokens = 0;

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
          if (msg.type === "result") {
            inputTokens = msg.usage?.input_tokens ?? 0;
            outputTokens = msg.usage?.output_tokens ?? 0;
            if (msg.session_id) {
              events.sessionId = msg.session_id;
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

interface SDKMessage {
  type: string;
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
