import type { Logger } from "../util/logger.js";
import type { LarkClient } from "../lark/client.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { AppConfig } from "../config.js";
import type { RenderEvent, SessionState, PermissionMode } from "../types.js";
import { createQuery, type QueryHandle } from "./query.js";
import { buildStatusCard, type StatusCardState } from "../lark/cards/status-card.js";
import { createDeferred, type Deferred } from "../util/deferred.js";

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

  constructor(
    private readonly chatId: string,
    private readonly config: AppConfig,
    private readonly larkClient: LarkClient,
    private readonly broker: PermissionBroker,
    private readonly logger: Logger,
    public cwd: string,
    public permissionMode: PermissionMode,
    public model: string,
  ) {}

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
      },
      this.chatId,
      this.broker,
      this.logger,
    );
    this.currentHandle = handle;

    try {
      for await (const event of handle.events) {
        await this.handleEvent(event);
      }
      // Capture session ID if available
      const sessionId = (handle.events as { sessionId?: string }).sessionId;
      if (sessionId) this.providerSessionId = sessionId;
    } catch (err) {
      this.logger.error({ err }, "Turn execution error");
      await this.larkClient.sendText(this.chatId, `❌ Error: ${(err as Error).message}`).catch(() => {});
    } finally {
      this.currentHandle = null;
      this.state = "idle";
      await this.finalizeCard();
      this.dequeueNext();
    }
  }

  private async handleEvent(event: RenderEvent): Promise<void> {
    switch (event.type) {
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

  private async finalizeCard(): Promise<void> {
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
    };
  }
}
