import type { Logger } from "../util/logger.js";
import type { Transport } from "../transport/interface.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { AppConfig } from "../config.js";
import type { RenderEvent, SessionState, PermissionMode, EffortLevel } from "../types.js";
import { createQuery, type QueryHandle } from "./query.js";
import { buildReplyCard, buildStatusCard, buildStatusLine, type StatusCardState } from "../lark/cards/status-card.js";
import { createDeferred, type Deferred } from "../util/deferred.js";

/**
 * How long to wait for the CLI's `init` event before declaring the turn dead.
 * This bounds process startup only — never generation — so it can stay short.
 */
const STARTUP_TIMEOUT_MS = 30_000;

interface QueuedInput {
  text: string;
  imageDataUris?: string[];
  deferred: Deferred<void>;
}

export class ClaudeSession {
  private state: SessionState = "idle";
  private queue: QueuedInput[] = [];
  private currentHandle: QueryHandle | null = null;
  private statusCardId: string | null = null;
  private cardState: StatusCardState = this.freshCardState();
  private lastCardUpdate = 0;
  private cardUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private turnStartMs = 0;
  private toolCount = 0;
  /**
   * Assistant text emitted after the most recent tool call — i.e. the final
   * reply once the turn ends. Reset whenever a tool runs so tool-interleaved
   * narration doesn't accumulate into the final message.
   */
  private finalReplyText = "";

  private turnCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  providerSessionId?: string;

  readonly id: string;
  name?: string;
  onTurnComplete?: () => void;

  constructor(
    private readonly chatId: string,
    private readonly config: AppConfig,
    private readonly transport: Transport,
    private readonly broker: PermissionBroker,
    private readonly logger: Logger,
    public cwd: string,
    public permissionMode: PermissionMode,
    public model: string,
    public effort?: EffortLevel,
  ) {
    this.id = crypto.randomUUID().slice(0, 8);
  }

  getState(): SessionState {
    return this.state;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getStats() {
    return {
      turnCount: this.turnCount,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
    };
  }

  async submit(text: string, imageDataUris?: string[]): Promise<{ kind: "started" | "queued" | "rejected"; position?: number }> {
    if (this.state === "idle") {
      this.runTurn(text, imageDataUris);
      return { kind: "started" };
    }

    if (this.queue.length >= this.config.claude.max_queue_size) {
      return { kind: "rejected" };
    }

    const deferred = createDeferred<void>();
    this.queue.push({ text, imageDataUris, deferred });
    const position = this.queue.length;
    return { kind: "queued", position };
  }

  async interrupt(newText?: string): Promise<void> {
    if (this.currentHandle) {
      await this.currentHandle.interrupt();
      this.currentHandle = null;
    }
    this.broker.cancelAll();
    this.state = "idle";
    this.stopHeartbeat();
    // Drop any buffered partial answer so it isn't posted as a final reply.
    this.finalReplyText = "";

    // Flush queue — all queued inputs are dropped
    for (const q of this.queue) {
      q.deferred.reject(new Error("interrupted"));
      q.deferred.promise.catch(() => {});
    }
    this.queue = [];

    // Finalize status card if open
    await this.finalizeCard();

    if (newText) {
      this.runTurn(newText);
    }
  }

  async stop(): Promise<void> {
    await this.interrupt();
    await this.transport.sendText(this.chatId, "⏹ Stopped");
  }

  private async runTurn(text: string, imageDataUris?: string[]): Promise<void> {
    this.state = "generating";
    this.turnCount++;
    this.broker.resetTurn();
    this.cardState = this.freshCardState();
    this.statusCardId = null;
    this.turnStartMs = Date.now();
    this.toolCount = 0;
    this.finalReplyText = "";
    this.startHeartbeat();

    const handle = createQuery(
      {
        prompt: text,
        imageDataUris,
        cwd: this.cwd,
        model: this.model,
        permissionMode: this.permissionMode,
        cliPath: this.config.claude.cli_path,
        resumeId: this.providerSessionId,
        effort: this.effort,
      },
      this.chatId,
      this.broker,
      this.logger,
    );
    this.currentHandle = handle;

    let completedNaturally = false;
    let retrying = false;
    let startupTimedOut = false;
    let failure: string | undefined;
    const wasResume = !!this.providerSessionId;
    try {
      let receivedFirstEvent = false;
      let startupTimer: ReturnType<typeof setTimeout> | null = null;

      // Startup watchdog. The CLI emits `init` — now surfaced as a render event
      // — about a second after launching, so a window with *no* event at all
      // means it never came up (bad cli_path, failed spawn, unusable session).
      //
      // This deliberately does NOT measure time-to-first-token. It used to:
      // `init` was swallowed in query.ts, so the first event was the first
      // text/thinking/tool block, and any resumed turn whose first token took
      // longer than the window got aborted — reproducibly, on every turn with a
      // large context or a slow upstream. Arm it for fresh turns too; without
      // it, a CLI that never starts leaves the turn generating forever.
      startupTimer = setTimeout(() => {
        if (!receivedFirstEvent) {
          startupTimedOut = true;
          this.logger.warn(
            { wasResume, timeoutMs: STARTUP_TIMEOUT_MS },
            "Startup timeout — no events from CLI, aborting turn",
          );
          void handle.interrupt();
        }
      }, STARTUP_TIMEOUT_MS);

      try {
        for await (const event of handle.events) {
          if (!receivedFirstEvent) {
            receivedFirstEvent = true;
            if (startupTimer) clearTimeout(startupTimer);
          }
          await this.handleEvent(event);
        }
      } finally {
        // Also clear on the throw path: a timer left armed would abort an
        // already-finished handle and log a bogus resume timeout.
        if (startupTimer) clearTimeout(startupTimer);
      }

      // A timed-out startup does NOT reach the catch below: interrupt() aborts
      // the controller, and the query iterator swallows the resulting abort
      // error and returns cleanly (see query.ts). So the loop just ends with
      // zero events, which used to fall through as a successful turn with an
      // empty reply — the prompt vanished, leaving only a green "✅ Done" card
      // frozen at the last heartbeat tick. Handle it explicitly.
      if (startupTimedOut && !receivedFirstEvent) {
        const seconds = Math.round(STARTUP_TIMEOUT_MS / 1000);
        if (wasResume) {
          // Resume specifically may be at fault, so drop it and try once fresh.
          retrying = true;
          this.providerSessionId = undefined;
          this.currentHandle = null;
          this.state = "idle";
          await this.finalizeCard(`启动超时 ${seconds}s`);
          await this.transport
            .sendText(this.chatId, `⚠️ Claude 启动超时（${seconds} 秒无响应），正在用新会话重试。原对话历史不会带入。`)
            .catch(() => {});
          this.runTurn(text, imageDataUris);
          return;
        }
        // Fresh turn: nothing left to fall back to. Report instead of retrying
        // into the same failure.
        failure = `启动超时 ${seconds}s`;
        await this.transport
          .sendText(this.chatId, `❌ Claude 启动超时（${seconds} 秒无响应），本轮已取消。请重发消息。`)
          .catch(() => {});
        return;
      }

      // Capture session ID if available
      const sessionId = (handle.events as { sessionId?: string }).sessionId;
      if (sessionId) this.providerSessionId = sessionId;
      completedNaturally = true;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // Resume failed — retry without session ID
      if ((msg.includes("No conversation found") || msg.includes("failed to launch") || msg.includes("aborted")) && this.providerSessionId) {
        this.logger.warn("Resume failed, starting fresh session");
        retrying = true;
        this.providerSessionId = undefined;
        this.currentHandle = null;
        this.state = "idle";
        await this.finalizeCard();
        this.runTurn(text, imageDataUris);
        return;
      }
      this.logger.error({ err }, "Turn execution error");
      failure = "执行出错";
      await this.transport.sendText(this.chatId, `❌ Error: ${msg}`).catch(() => {});
    } finally {
      // The resume-retry path re-enters runTurn and owns its own lifecycle;
      // skip finalization here so we don't double-finalize or post twice.
      if (!retrying) {
        this.currentHandle = null;
        this.state = "idle";
        await this.finalizeCard(failure);
        // Post the final reply only on natural completion. On error/abort the
        // buffer is left as-is (interrupt clears it) so no partial is posted.
        if (completedNaturally) await this.postFinalReply();
        this.onTurnComplete?.();
        this.dequeueNext();
      }
    }
  }

  private async handleEvent(event: RenderEvent): Promise<void> {
    switch (event.type) {
      case "init":
        // Proof the CLI is up (see the startup watchdog in runTurn). Also lets
        // the card appear immediately instead of on the first heartbeat.
        if (event.model) this.cardState.model = event.model;
        break;
      case "thinking":
        if (!this.config.render.hide_thinking) {
          this.cardState.thinking = event.text;
        }
        break;
      case "tool_use":
        this.toolCount++;
        this.cardState.toolCount = this.toolCount;
        this.cardState.currentTool = { name: event.name, input: event.input };
        this.cardState.thinking = undefined;
        // A tool call means any text so far was interstitial narration, not the
        // final answer — reset the final-reply accumulator.
        this.finalReplyText = "";
        break;
      case "tool_result":
        this.cardState.currentTool = undefined;
        break;
      case "text":
        this.cardState.outputText += event.text;
        this.finalReplyText += event.text;
        this.cardState.thinking = undefined;
        this.cardState.currentTool = undefined;
        break;
      case "turn_end":
        this.cardState.inputTokens = event.inputTokens;
        this.cardState.outputTokens = event.outputTokens;
        this.cardState.elapsedMs = event.durationMs;
        this.cardState.done = true;
        if (event.model) this.cardState.model = event.model;
        if (event.contextWindow) this.cardState.contextWindow = event.contextWindow;
        this.totalInputTokens += event.inputTokens;
        this.totalOutputTokens += event.outputTokens;
        break;
      default:
        return;
    }

    await this.throttledCardUpdate();
  }

  private async throttledCardUpdate(): Promise<void> {
    const now = Date.now();
    const interval = this.config.render.card_update_interval_ms;

    if (now - this.lastCardUpdate < interval) {
      if (!this.cardUpdateTimer) {
        this.cardUpdateTimer = setTimeout(async () => {
          this.cardUpdateTimer = null;
          await this.flushCardUpdate();
        }, interval - (now - this.lastCardUpdate));
      }
      return;
    }

    await this.flushCardUpdate();
  }

  private async flushCardUpdate(): Promise<void> {
    this.lastCardUpdate = Date.now();
    // While generating, show elapsed time ticking live from the turn start.
    // After turn_end the SDK-reported duration is authoritative, so keep it.
    if (!this.cardState.done && this.turnStartMs) {
      this.cardState.elapsedMs = Date.now() - this.turnStartMs;
    }

    const card = buildStatusCard(this.cardState);

    try {
      if (!this.statusCardId) {
        this.statusCardId = await this.transport.sendCard(this.chatId, card);
      } else {
        await this.transport.updateCard(this.statusCardId, card);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to update status card");
    }
  }

  /**
   * Refresh the status card on a fixed interval while generating, so a long
   * silent tool sequence (WebFetch/Write/Edit with no streamed text) still
   * shows live elapsed time and the current tool — the user can tell it's
   * working, not hung. No-op once the turn is done or if disabled in config.
   */
  private startHeartbeat(): void {
    const interval = this.config.render.heartbeat_interval_ms;
    if (!interval) return;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== "generating" || this.cardState.done) return;
      this.flushCardUpdate().catch(() => {});
    }, interval);
    // Don't keep the process alive just for the heartbeat.
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Close out the status card. `failure` marks the turn as not-completed so the
   * card shows a warning instead of a green "✅ Done".
   *
   * Elapsed is recomputed here unless a `turn_end` already supplied the
   * authoritative duration: otherwise the card froze at the last heartbeat tick
   * (e.g. a turn aborted at 30s displayed 28.0s, the 7th 4s beat).
   */
  private async finalizeCard(failure?: string): Promise<void> {
    this.stopHeartbeat();
    if (failure) this.cardState.failure = failure;
    if (!this.cardState.done && this.turnStartMs) {
      this.cardState.elapsedMs = Date.now() - this.turnStartMs;
    }
    if (this.cardUpdateTimer) {
      clearTimeout(this.cardUpdateTimer);
      this.cardUpdateTimer = null;
    }
    if (this.statusCardId) {
      this.cardState.done = true;
      const card = buildStatusCard(this.cardState);
      await this.transport.updateCard(this.statusCardId, card).catch(() => {});
      this.statusCardId = null;
    }
  }

  private async postFinalReply(): Promise<void> {
    if (!this.config.render.final_reply_as_message) return;
    const reply = this.finalReplyText.trim();
    this.finalReplyText = "";
    if (!reply) return;
    // Feishu text messages cap around 30k bytes; chunk conservatively on
    // paragraph boundaries to stay well under the limit.
    const chunks = chunkText(reply, 3000);
    const asCard = this.config.render.final_reply_format !== "text";
    const statusLine = asCard ? buildStatusLine(this.cardState) : undefined;
    for (const [i, chunk] of chunks.entries()) {
      if (asCard) {
        // 状态栏只挂在最后一片上，避免长回复每片都重复
        const card = buildReplyCard(chunk, i === chunks.length - 1 ? statusLine : undefined);
        try {
          await this.transport.sendCard(this.chatId, card);
          continue;
        } catch (err) {
          // 卡片被拒（如 markdown 不兼容）时回退纯文本，保证回复一定送达
          this.logger.warn({ err }, "Failed to post final reply card, falling back to text");
        }
      }
      await this.transport.sendText(this.chatId, chunk).catch((err) => {
        this.logger.warn({ err }, "Failed to post final reply message");
      });
    }
  }

  private dequeueNext(): void {
    const next = this.queue.shift();
    if (next) {
      this.runTurn(next.text, next.imageDataUris).then(
        () => next.deferred.resolve(),
        (err) => next.deferred.reject(err),
      );
    }
  }

  private freshCardState(): StatusCardState {
    return {
      outputText: "",
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 0,
      done: false,
      cwd: this.cwd,
      model: this.model || undefined,
      effort: this.effort,
      toolCount: 0,
    };
  }
}

/**
 * Split text into chunks no larger than `max` characters, preferring to break
 * on paragraph then line then hard boundaries so messages stay readable.
 */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
