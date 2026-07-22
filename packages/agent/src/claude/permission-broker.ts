import type { Logger } from "../util/logger.js";
import type { Transport } from "../transport/interface.js";
import type { FeishuCardV2 } from "../lark/cards/types.js";
import type { CardActionPayload, PermissionChoice } from "../types.js";
import { createDeferred, type Deferred } from "../util/deferred.js";
import { buildPermissionCard, buildPermissionCardResolved, buildPermissionCardTimedOut } from "../lark/cards/permission-card.js";
import {
  buildQuestionCard,
  buildQuestionResolvedCard,
  type QuestionSpec,
} from "../lark/cards/question-card.js";

interface PendingRequest {
  toolName: string;
  input: unknown;
  chatId: string;
  messageId: string;
  deferred: Deferred<PermissionChoice>;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingQuestion {
  requestId: string;
  chatId: string;
  messageId: string;
  qIndex: number;
  total: number;
  question: QuestionSpec;
  /** Selected option indexes (multi-select accumulates here). */
  selected: number[];
  /** True after the user tapped "Other": next chat message is the answer. */
  awaitingText: boolean;
  deferred: Deferred<string | null>;
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingRequest>();
  /** Active AskUserQuestion cards, keyed by requestId. */
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private turnApproved = false;
  private sessionApproved = false;
  private readonly timeoutMs: number;

  constructor(
    config: { permission_timeout_seconds: number },
    private readonly transport: Transport,
    private readonly logger: Logger,
  ) {
    this.timeoutMs = config.permission_timeout_seconds * 1000;
  }

  resetTurn(): void {
    this.turnApproved = false;
  }

  resetSession(): void {
    this.turnApproved = false;
    this.sessionApproved = false;
  }

  async requestPermission(
    chatId: string,
    toolName: string,
    input: unknown,
  ): Promise<boolean> {
    if (this.sessionApproved || this.turnApproved) return true;

    const requestId = crypto.randomUUID();
    const card = buildPermissionCard({ requestId, toolName, input });
    const messageId = await this.transport.sendCard(chatId, card);

    const deferred = createDeferred<PermissionChoice>();
    const timer = setTimeout(() => {
      this.handleTimeout(requestId);
    }, this.timeoutMs);

    this.pending.set(requestId, {
      toolName,
      input,
      chatId,
      messageId,
      deferred,
      timer,
    });

    const choice = await deferred.promise;
    return choice !== "deny";
  }

  /**
   * Handle an AskUserQuestion tool call: present each question as its own
   * Feishu card in sequence and collect the answers. Returns a map of
   * question text -> answer (multi-select answers are comma-joined), matching
   * the shape the Claude CLI expects in `updatedInput.answers`. Returns null
   * if the flow is cancelled (e.g. session interrupted) before completion.
   */
  async askQuestions(
    chatId: string,
    questions: QuestionSpec[],
  ): Promise<Record<string, string> | null> {
    const requestId = crypto.randomUUID();
    const answers: Record<string, string> = {};

    for (let qIndex = 0; qIndex < questions.length; qIndex++) {
      const question = questions[qIndex]!;
      const card = buildQuestionCard({
        requestId,
        qIndex,
        total: questions.length,
        question,
        selected: [],
      });
      const messageId = await this.transport.sendCard(chatId, card);

      const deferred = createDeferred<string | null>();
      this.pendingQuestions.set(requestId, {
        requestId,
        chatId,
        messageId,
        qIndex,
        total: questions.length,
        question,
        selected: [],
        awaitingText: false,
        deferred,
      });

      const answer = await deferred.promise;
      this.pendingQuestions.delete(requestId);
      if (answer === null) return null; // cancelled
      answers[question.question] = answer;
    }

    return answers;
  }

  async handleCardAction(action: {
    senderOpenId: string;
    value: CardActionPayload;
  }): Promise<{ card?: FeishuCardV2 } | void> {
    if (action.value.kind !== "permission") {
      return this.handleQuestionAction(action.value);
    }
    const { request_id, choice } = action.value;
    const req = this.pending.get(request_id);
    if (!req) return;

    clearTimeout(req.timer);
    this.pending.delete(request_id);

    if (choice === "allow_turn") this.turnApproved = true;
    if (choice === "allow_session") this.sessionApproved = true;

    req.deferred.resolve(choice);

    const resolvedCard = buildPermissionCardResolved({ toolName: req.toolName, choice });
    return { card: resolvedCard };
  }

  private handleQuestionAction(
    value: Exclude<CardActionPayload, { kind: "permission" }>,
  ): { card?: FeishuCardV2 } | void {
    const pending = this.pendingQuestions.get(value.request_id);
    // Ignore stale actions (e.g. taps on an earlier question's card).
    if (!pending || value.q !== pending.qIndex) return;

    const { question } = pending;

    if (value.kind === "question_option") {
      const opt = question.options[value.opt];
      if (!opt) return;

      if (!question.multiSelect) {
        // Single-select: resolve immediately with this option's label.
        pending.deferred.resolve(opt.label);
        return {
          card: buildQuestionResolvedCard({
            header: question.header,
            question: question.question,
            answer: opt.label,
          }),
        };
      }

      // Multi-select: toggle and redraw the card in place.
      const idx = pending.selected.indexOf(value.opt);
      if (idx >= 0) pending.selected.splice(idx, 1);
      else pending.selected.push(value.opt);

      return {
        card: buildQuestionCard({
          requestId: pending.requestId,
          qIndex: pending.qIndex,
          total: pending.total,
          question,
          selected: [...pending.selected].sort((a, b) => a - b),
        }),
      };
    }

    if (value.kind === "question_other") {
      // Switch to free-text mode: the next chat message (consumePendingText)
      // becomes the answer. Redraw the card with a hint.
      pending.awaitingText = true;
      return {
        card: buildQuestionCard({
          requestId: pending.requestId,
          qIndex: pending.qIndex,
          total: pending.total,
          question,
          selected: pending.selected,
          awaitingText: true,
        }),
      };
    }

    // question_submit (multi-select only)
    const labels = [...pending.selected]
      .sort((a, b) => a - b)
      .map((i) => question.options[i]?.label)
      .filter((l): l is string => !!l);
    // Ignore empty submit — keep the card interactive.
    if (labels.length === 0) return;

    const answer = labels.join(", ");
    pending.deferred.resolve(answer);
    return {
      card: buildQuestionResolvedCard({
        header: question.header,
        question: question.question,
        answer,
      }),
    };
  }

  /**
   * If a question in `chatId` is waiting for a free-text answer (user tapped
   * "Other"), consume `text` as the answer, redraw the card as resolved, and
   * return true so the caller does NOT forward the message to Claude. Returns
   * false when no question is awaiting text (normal message flow).
   */
  async consumePendingText(chatId: string, text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return false;
    for (const pending of this.pendingQuestions.values()) {
      if (pending.chatId !== chatId || !pending.awaitingText) continue;
      pending.deferred.resolve(trimmed);
      const card = buildQuestionResolvedCard({
        header: pending.question.header,
        question: pending.question.question,
        answer: trimmed,
      });
      await this.transport.updateCard(pending.messageId, card).catch((err) => {
        this.logger.warn({ err }, "Failed to update resolved question card");
      });
      return true;
    }
    return false;
  }

  private handleTimeout(requestId: string): void {
    const req = this.pending.get(requestId);
    if (!req) return;

    this.pending.delete(requestId);
    req.deferred.resolve("deny");

    const card = buildPermissionCardTimedOut({ toolName: req.toolName });
    this.transport.updateCard(req.messageId, card).catch((err) => {
      this.logger.warn({ err }, "Failed to update timed-out permission card");
    });
  }

  cancelAll(): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.deferred.resolve("deny");
      this.pending.delete(id);
    }
    for (const [id, q] of this.pendingQuestions) {
      q.deferred.resolve(null);
      this.pendingQuestions.delete(id);
    }
  }
}
