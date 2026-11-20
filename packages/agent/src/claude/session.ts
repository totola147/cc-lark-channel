import type { Logger } from "../util/logger.js";
import type { Transport } from "../transport/interface.js";
import type { PermissionBroker, SessionPermissions } from "./permission-broker.js";
import { effectiveContextWindow } from "./context-window.js";
import { resolveProfile, type ResolvedProfile } from "./profile.js";
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
  senderOpenId?: string;
  deferred: Deferred<void>;
}

/** CLI 报告 resume 目标不可用时的错误文本。只有这些才回退到新会话。 */
const RESUME_FAILURE_PATTERNS = ["No conversation found", "failed to launch"];

export class ClaudeSession {
  private state: SessionState = "idle";
  private queue: QueuedInput[] = [];
  private currentHandle: QueryHandle | null = null;
  private statusCardId: string | null = null;
  /**
   * 首张状态卡片的 sendCard 尚未返回时置位。期间的 flush（心跳、节流定时器、新事件）
   * 等它返回再 update，而不是看到 statusCardId 为空又各自 sendCard——relay 往返慢时
   * 那样会一轮发出多张卡片，只有最后一张被 finalize，其余永远停在 Generating。
   */
  private statusCardPending: Promise<string | null> | null = null;
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
  /** 本会话所用 --settings 文件，用于推算 ctx% 的有效窗口。 */
  private settingsPath?: string;
  private totalOutputTokens = 0;
  providerSessionId?: string;
  /** 运行档名（见 claude/profile.ts）；未设置时用 agent 默认环境。 */
  profile?: string;

  readonly id: string;
  name?: string;
  onTurnComplete?: () => void;

  /**
   * 轮次代号。每次开新轮次或中断时递增；旧轮次在 await 返回后发现代号已变，
   * 就不再改动会话状态（state/currentHandle/状态卡片/最终回复/出队）。
   */
  private generation = 0;
  /** 本会话独立的审批作用域：本轮/本会话允许、取消都只影响自己。 */
  private readonly perms: SessionPermissions;
  private readonly permScopeId = crypto.randomUUID();

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
    this.perms = broker.forSession(this.permScopeId);
  }

  /** 会话被丢弃时释放其审批作用域（挂起的卡片按拒绝处理）。 */
  dispose(): void {
    this.broker.disposeScope(this.permScopeId);
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

  async submit(
    text: string,
    imageDataUris?: string[],
    senderOpenId?: string,
  ): Promise<{ kind: "started" | "queued" | "rejected"; position?: number }> {
    if (this.state === "idle") {
      this.runTurn(text, imageDataUris, senderOpenId);
      return { kind: "started" };
    }

    if (this.queue.length >= this.config.claude.max_queue_size) {
      return { kind: "rejected" };
    }

    const deferred = createDeferred<void>();
    this.queue.push({ text, imageDataUris, senderOpenId, deferred });
    const position = this.queue.length;
    return { kind: "queued", position };
  }

  async interrupt(newText?: string, senderOpenId?: string): Promise<void> {
    // 先让正在跑的轮次失效，它在 abort 之后到达的事件和 finally 都会被忽略。
    this.generation++;
    const handle = this.currentHandle;
    this.currentHandle = null;
    if (handle) {
      await handle.interrupt();
      // init 时已拿到会话 id：保留下来，下一轮 resume 而不是丢掉被中断的上下文。
      const sid = handle.events.sessionId;
      if (sid) this.providerSessionId = sid;
    }
    this.perms.cancelAll();
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
      this.runTurn(newText, undefined, senderOpenId);
    }
  }

  async stop(): Promise<void> {
    await this.interrupt();
    await this.transport.sendText(this.chatId, "⏹ Stopped");
  }

  private async runTurn(text: string, imageDataUris?: string[], senderOpenId?: string): Promise<void> {
    const gen = ++this.generation;
    const isCurrent = () => gen === this.generation;
    this.state = "generating";
    this.turnCount++;
    this.perms.resetTurn();
    if (senderOpenId) this.perms.setRequester(senderOpenId);
    this.cardState = this.freshCardState();
    this.statusCardId = null;
    this.statusCardPending = null;
    this.turnStartMs = Date.now();
    this.toolCount = 0;
    this.finalReplyText = "";
    this.startHeartbeat();

    let resolved: ResolvedProfile | undefined;
    try {
      resolved = resolveProfile(this.profile, this.config);
    } catch (err) {
      // 档缺失/凭据缺失：不回退到默认网关（会悄悄换上游），直接报错结束本轮。
      this.logger.error({ err, profile: this.profile }, "Profile resolution failed");
      this.state = "idle";
      this.stopHeartbeat();
      await this.transport.sendText(this.chatId, `❌ ${(err as Error).message}`).catch(() => {});
      if (isCurrent()) {
        this.onTurnComplete?.();
        this.dequeueNext();
      }
      return;
    }

    const handle = createQuery(
      {
        prompt: text,
        imageDataUris,
        cwd: this.cwd,
        model: this.model || resolved?.model || "",
        permissionMode: this.permissionMode,
        cliPath: resolved?.cliPath ?? this.config.claude.cli_path,
        envOverrides: resolved?.env,
        settings: resolved?.settings,
        resumeId: this.providerSessionId,
        effort: this.effort,
        thinkingDisplay: this.config.render.hide_thinking ? undefined : "summarized",
      },
      this.chatId,
      this.perms,
      this.logger,
    );
    this.currentHandle = handle;
    this.settingsPath = resolved?.settings;

    let completedNaturally = false;
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
          // 已被中断：丢弃旧轮次的残余事件，不碰新轮次的状态卡片
          if (!isCurrent()) break;
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
      if (!isCurrent()) return;

      if (startupTimedOut && !receivedFirstEvent) {
        const seconds = Math.round(STARTUP_TIMEOUT_MS / 1000);
        if (wasResume) {
          // Resume specifically may be at fault, so drop it and try once fresh.
          this.logger.warn({ droppedSessionId: this.providerSessionId }, "Resume startup timed out, dropping session history");
          this.providerSessionId = undefined;
          this.currentHandle = null;
          this.state = "idle";
          await this.finalizeCard(`启动超时 ${seconds}s`);
          await this.transport
            .sendText(this.chatId, `⚠️ Claude 启动超时（${seconds} 秒无响应），正在用新会话重试。原对话历史不会带入。`)
            .catch(() => {});
          // runTurn 同步递增 generation，本轮 finally 随之失效
          if (isCurrent()) this.runTurn(text, imageDataUris, senderOpenId);
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
      // 被中断的轮次抛出的错误（通常是 abort）不报给用户，也不触发 resume 回退
      if (!isCurrent()) return;
      const msg = (err as Error).message ?? "";
      // Resume failed — retry without session ID. 只认 CLI 明确的错误文本；
      // 以前还匹配 "aborted"，用户主动停止时也会误判并丢掉历史。
      if (wasResume && this.providerSessionId && RESUME_FAILURE_PATTERNS.some((p) => msg.includes(p))) {
        this.logger.warn({ err, droppedSessionId: this.providerSessionId }, "Resume failed, starting fresh session");
        this.providerSessionId = undefined;
        this.currentHandle = null;
        this.state = "idle";
        await this.finalizeCard("恢复会话失败");
        await this.transport
          .sendText(this.chatId, "⚠️ 无法恢复之前的会话，已改用新会话继续。原对话历史不会带入。")
          .catch(() => {});
        if (isCurrent()) this.runTurn(text, imageDataUris, senderOpenId);
        return;
      }
      this.logger.error({ err }, "Turn execution error");
      failure = "执行出错";
      await this.transport.sendText(this.chatId, `❌ Error: ${msg}`).catch(() => {});
    } finally {
      // 已被中断或被 resume 重试接管：新轮次自己负责收尾，这里什么都不做，
      // 否则会重置新轮次的 state/currentHandle、关掉它的卡片、重复出队。
      if (isCurrent()) {
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
        // 状态栏显示当前上下文占用（最近一次调用的 prompt 大小），ctx% 才有意义
        this.cardState.inputTokens = event.contextTokens ?? event.inputTokens;
        this.cardState.outputTokens = event.outputTokens;
        this.cardState.elapsedMs = event.durationMs;
        this.cardState.done = true;
        if (event.model) this.cardState.model = event.model;
        if (event.contextWindow) {
          this.cardState.contextWindow = effectiveContextWindow(event.contextWindow, this.settingsPath);
        }
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
      if (this.statusCardId) {
        await this.transport.updateCard(this.statusCardId, card);
        return;
      }
      if (this.statusCardPending) {
        // 首张卡片正在创建：等它返回后用最新状态 update，不再另发一张
        const id = await this.statusCardPending;
        if (id && id === this.statusCardId) {
          await this.transport.updateCard(id, buildStatusCard(this.cardState));
        }
        return;
      }
      const pending = this.transport.sendCard(this.chatId, card).then(
        (id) => id || null,
        (err) => { this.logger.warn({ err }, "Failed to send status card"); return null; },
      );
      this.statusCardPending = pending;
      const id = await pending;
      // 仍是本轮的创建请求才记下 id（期间可能已开新轮次或已 finalize）
      if (this.statusCardPending === pending) {
        this.statusCardPending = null;
        this.statusCardId = id;
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
    if (!this.statusCardId && this.statusCardPending) {
      // 卡片还在创建中就收尾了：等它落地再更新为最终状态，否则它会停在 Generating
      const pending = this.statusCardPending;
      const id = await pending;
      if (this.statusCardPending === pending) {
        this.statusCardPending = null;
        this.statusCardId = id;
      }
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
      this.runTurn(next.text, next.imageDataUris, next.senderOpenId).then(
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
