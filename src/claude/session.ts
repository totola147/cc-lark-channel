import type { Logger } from "../util/logger.js";
import type { LarkClient } from "../lark/client.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { AppConfig } from "../config.js";
import type { RenderEvent, SessionState, PermissionMode } from "../types.js";
import { createQuery, type QueryHandle } from "./query.js";
import { buildStatusCard, type StatusCardState } from "../lark/cards/status-card.js";
import { createDeferred, type Deferred } from "../util/deferred.js";

/**
 * 等待 CLI 的 init 事件的时长，超时视为本轮未能启动。
 * 只限制进程启动，不限制生成，所以可以很短。
 */
const STARTUP_TIMEOUT_MS = 30_000;

/** CLI 报告 resume 目标不可用时的错误文本。只有这些才回退到新会话。 */
const RESUME_FAILURE_PATTERNS = ["No conversation found", "failed to launch"];

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

  private turnCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  providerSessionId?: string;

  readonly id: string;
  name?: string;
  onTurnComplete?: () => void;

  /**
   * 轮次代号。每次开新轮次或中断时递增；旧轮次在 await 返回后发现代号已变，
   * 就不再改动会话状态（state/currentHandle/状态卡片/出队）。
   */
  private generation = 0;

  constructor(
    private readonly chatId: string,
    private readonly config: AppConfig,
    private readonly larkClient: LarkClient,
    private readonly broker: PermissionBroker,
    private readonly logger: Logger,
    public cwd: string,
    public permissionMode: PermissionMode,
    public model: string,
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
    this.broker.cancelAll();
    this.state = "idle";

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
    await this.larkClient.sendText(this.chatId, "⏹ Stopped");
  }

  private async runTurn(text: string, imageDataUris?: string[]): Promise<void> {
    const gen = ++this.generation;
    const isCurrent = () => gen === this.generation;
    this.state = "generating";
    this.turnCount++;
    this.broker.resetTurn();
    this.cardState = this.freshCardState();
    this.statusCardId = null;

    const handle = createQuery(
      {
        prompt: text,
        imageDataUris,
        cwd: this.cwd,
        model: this.model,
        permissionMode: this.permissionMode,
        cliPath: this.config.claude.cli_path,
        resumeId: this.providerSessionId,
        thinkingDisplay: this.config.render.hide_thinking ? undefined : "summarized",
      },
      this.chatId,
      this.broker,
      this.logger,
    );
    this.currentHandle = handle;

    let startupTimedOut = false;
    let failure: string | undefined;
    const wasResume = !!this.providerSessionId;
    try {
      let receivedFirstEvent = false;

      // 启动看门狗：CLI 启动后约一秒就会发出 init（query.ts 已把它转成事件），
      // 所以窗口内一个事件都没有说明 CLI 根本没起来（cli_path 错、spawn 失败、会话不可用）。
      // 这里刻意不衡量首个 token 的耗时：以前只在 resume 时计时且以首个 text/tool
      // 为准，上下文大或上游慢时 resume 的轮次会被误杀。新会话也要计时，
      // 否则 CLI 起不来时本轮会一直停在 generating。
      const startupTimer = setTimeout(() => {
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
            clearTimeout(startupTimer);
          }
          await this.handleEvent(event);
        }
      } finally {
        // 抛错路径也要清掉，否则计时器会去 abort 一个已结束的 handle
        clearTimeout(startupTimer);
      }

      if (!isCurrent()) return;

      // 启动超时不会走到下面的 catch：interrupt() 触发 abort，query.ts 吞掉 abort
      // 错误后正常返回，循环以零事件结束。不单独处理的话会被当成成功的空回复。
      if (startupTimedOut && !receivedFirstEvent) {
        const seconds = Math.round(STARTUP_TIMEOUT_MS / 1000);
        if (wasResume) {
          // resume 可能是原因：丢掉会话 id，用新会话重试一次
          this.logger.warn({ droppedSessionId: this.providerSessionId }, "Resume startup timed out, dropping session history");
          this.providerSessionId = undefined;
          this.currentHandle = null;
          this.state = "idle";
          await this.finalizeCard(`启动超时 ${seconds}s`);
          await this.larkClient
            .sendText(this.chatId, `⚠️ Claude 启动超时（${seconds} 秒无响应），正在用新会话重试。原对话历史不会带入。`)
            .catch(() => {});
          // runTurn 同步递增 generation，本轮 finally 随之失效
          if (isCurrent()) this.runTurn(text, imageDataUris);
          return;
        }
        // 新会话已无可回退：报错而不是重试进同一个失败
        failure = `启动超时 ${seconds}s`;
        await this.larkClient
          .sendText(this.chatId, `❌ Claude 启动超时（${seconds} 秒无响应），本轮已取消。请重发消息。`)
          .catch(() => {});
        return;
      }

      // Capture session ID if available
      const sessionId = (handle.events as { sessionId?: string }).sessionId;
      if (sessionId) this.providerSessionId = sessionId;
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
        await this.larkClient
          .sendText(this.chatId, "⚠️ 无法恢复之前的会话，已改用新会话继续。原对话历史不会带入。")
          .catch(() => {});
        if (isCurrent()) this.runTurn(text, imageDataUris);
        return;
      }
      this.logger.error({ err }, "Turn execution error");
      failure = "执行出错";
      await this.larkClient.sendText(this.chatId, `❌ Error: ${msg}`).catch(() => {});
    } finally {
      // 已被中断或被 resume 重试接管：新轮次自己负责收尾，这里什么都不做，
      // 否则会重置新轮次的 state/currentHandle、关掉它的卡片、重复出队。
      if (isCurrent()) {
        this.currentHandle = null;
        this.state = "idle";
        await this.finalizeCard(failure);
        this.onTurnComplete?.();
        this.dequeueNext();
      }
    }
  }

  private async handleEvent(event: RenderEvent): Promise<void> {
    switch (event.type) {
      case "init":
        // CLI 已启动（见 runTurn 的启动看门狗）；顺带让状态卡片立即出现
        break;
      case "thinking":
        if (!this.config.render.hide_thinking) {
          this.cardState.thinking = event.text;
        }
        break;
      case "tool_use":
        this.cardState.currentTool = { name: event.name, input: event.input };
        this.cardState.thinking = undefined;
        break;
      case "tool_result":
        this.cardState.currentTool = undefined;
        break;
      case "text":
        this.cardState.outputText += event.text;
        this.cardState.thinking = undefined;
        this.cardState.currentTool = undefined;
        break;
      case "turn_end":
        this.cardState.inputTokens = event.inputTokens;
        this.cardState.outputTokens = event.outputTokens;
        this.cardState.elapsedMs = event.durationMs;
        this.cardState.done = true;
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
    if (this.cardState.elapsedMs === 0) {
      this.cardState.elapsedMs = Date.now() - (Date.now() - 100);
    }

    const card = buildStatusCard(this.cardState);

    try {
      if (!this.statusCardId) {
        this.statusCardId = await this.larkClient.sendCard(this.chatId, card);
      } else {
        await this.larkClient.updateCard(this.statusCardId, card);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to update status card");
    }
  }

  private async finalizeCard(failure?: string): Promise<void> {
    if (failure) this.cardState.failure = failure;
    if (this.cardUpdateTimer) {
      clearTimeout(this.cardUpdateTimer);
      this.cardUpdateTimer = null;
    }
    if (this.statusCardId) {
      this.cardState.done = true;
      const card = buildStatusCard(this.cardState);
      await this.larkClient.updateCard(this.statusCardId, card).catch(() => {});
      this.statusCardId = null;
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
    };
  }
}
