import type { Logger } from "../util/logger.js";
import type { Transport } from "../transport/interface.js";
import type { FeishuCardV2 } from "../lark/cards/types.js";
import type { CardActionPayload, PermissionChoice } from "../types.js";
import { createDeferred, type Deferred } from "../util/deferred.js";
import { buildPermissionCard, buildPermissionCardResolved, buildPermissionCardTimedOut } from "../lark/cards/permission-card.js";
import {
  buildQuestionCard,
  buildQuestionResolvedCard,
  buildQuestionTimedOutCard,
  type QuestionSpec,
} from "../lark/cards/question-card.js";

/** 未绑定会话时使用的默认作用域（测试和旧调用方）。 */
const DEFAULT_SCOPE = "_default";

interface PendingRequest {
  scopeId: string;
  /** 本请求允许操作的 openId；空集合表示不限制。 */
  operators: ReadonlySet<string>;
  toolName: string;
  input: unknown;
  chatId: string;
  messageId: string;
  deferred: Deferred<PermissionChoice>;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingQuestion {
  scopeId: string;
  operators: ReadonlySet<string>;
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
  timer: ReturnType<typeof setTimeout> | null;
}

interface ScopeState {
  turnApproved: boolean;
  sessionApproved: boolean;
  /** 发起当前轮次的用户；没有配置批准人时，只有他能操作卡片。 */
  requesterOpenId?: string;
}

export interface BrokerConfig {
  permission_timeout_seconds: number;
  /** AskUserQuestion 卡片无人作答的超时（秒），0 表示不超时。 */
  question_timeout_seconds?: number;
}

export interface BrokerOptions {
  /**
   * 允许操作审批/提问卡片的 openId 列表。relay 模式为配对的 owner，direct
   * 模式为 allowed_open_ids。为空时退回到"只有发起本轮的人"。
   */
  approvers?: () => readonly string[];
}

/**
 * 绑定到单个会话的权限接口。审批状态（本轮/本会话允许）与取消操作都只作用
 * 于这个会话，不会影响同一 chat 的后台会话或其他 chat。
 */
export interface SessionPermissions {
  requestPermission(chatId: string, toolName: string, input: unknown): Promise<boolean>;
  askQuestions(chatId: string, questions: QuestionSpec[]): Promise<Record<string, string> | null>;
  resetTurn(): void;
  resetSession(): void;
  cancelAll(): void;
  setRequester(openId: string | undefined): void;
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingRequest>();
  /** Active AskUserQuestion cards, keyed by requestId. */
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly scopes = new Map<string, ScopeState>();
  private readonly timeoutMs: number;
  private readonly questionTimeoutMs: number;

  constructor(
    config: BrokerConfig,
    private readonly transport: Transport,
    private readonly logger: Logger,
    private readonly options: BrokerOptions = {},
  ) {
    this.timeoutMs = config.permission_timeout_seconds * 1000;
    this.questionTimeoutMs = (config.question_timeout_seconds ?? 0) * 1000;
  }

  /** 为一个会话创建独立作用域。 */
  forSession(scopeId: string): SessionPermissions {
    return {
      requestPermission: (chatId, toolName, input) => this.requestPermission(chatId, toolName, input, scopeId),
      askQuestions: (chatId, questions) => this.askQuestions(chatId, questions, scopeId),
      resetTurn: () => this.resetTurn(scopeId),
      resetSession: () => this.resetSession(scopeId),
      cancelAll: () => this.cancelAll(scopeId),
      setRequester: (openId) => {
        this.scope(scopeId).requesterOpenId = openId;
      },
    };
  }

  /** 会话销毁时释放作用域状态。 */
  disposeScope(scopeId: string): void {
    this.cancelAll(scopeId);
    this.scopes.delete(scopeId);
  }

  private scope(scopeId: string): ScopeState {
    let s = this.scopes.get(scopeId);
    if (!s) {
      s = { turnApproved: false, sessionApproved: false };
      this.scopes.set(scopeId, s);
    }
    return s;
  }

  private operatorsFor(scopeId: string): ReadonlySet<string> {
    const approvers = (this.options.approvers?.() ?? []).filter(Boolean);
    if (approvers.length) return new Set(approvers);
    const requester = this.scopes.get(scopeId)?.requesterOpenId;
    return new Set(requester ? [requester] : []);
  }

  private isAllowedOperator(operators: ReadonlySet<string>, openId: string): boolean {
    return operators.size === 0 || operators.has(openId);
  }

  resetTurn(scopeId: string = DEFAULT_SCOPE): void {
    this.scope(scopeId).turnApproved = false;
  }

  resetSession(scopeId: string = DEFAULT_SCOPE): void {
    const s = this.scope(scopeId);
    s.turnApproved = false;
    s.sessionApproved = false;
  }

  async requestPermission(
    chatId: string,
    toolName: string,
    input: unknown,
    scopeId: string = DEFAULT_SCOPE,
  ): Promise<boolean> {
    const s = this.scope(scopeId);
    if (s.sessionApproved || s.turnApproved) return true;

    const requestId = crypto.randomUUID();
    const card = buildPermissionCard({ requestId, toolName, input });
    const messageId = await this.transport.sendCard(chatId, card);

    const deferred = createDeferred<PermissionChoice>();
    const timer = setTimeout(() => {
      this.handleTimeout(requestId);
    }, this.timeoutMs);

    this.pending.set(requestId, {
      scopeId,
      operators: this.operatorsFor(scopeId),
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
   * if the flow is cancelled (session interrupted) or a question times out.
   */
  async askQuestions(
    chatId: string,
    questions: QuestionSpec[],
    scopeId: string = DEFAULT_SCOPE,
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
      const pending: PendingQuestion = {
        scopeId,
        operators: this.operatorsFor(scopeId),
        requestId,
        chatId,
        messageId,
        qIndex,
        total: questions.length,
        question,
        selected: [],
        awaitingText: false,
        deferred,
        timer: null,
      };
      if (this.questionTimeoutMs > 0) {
        pending.timer = setTimeout(() => this.handleQuestionTimeout(requestId), this.questionTimeoutMs);
      }
      this.pendingQuestions.set(requestId, pending);

      const answer = await deferred.promise;
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingQuestions.delete(requestId);
      if (answer === null) return null; // cancelled or timed out
      answers[question.question] = answer;
    }

    return answers;
  }

  async handleCardAction(action: {
    senderOpenId: string;
    value: CardActionPayload;
  }): Promise<{ card?: FeishuCardV2 } | void> {
    if (action.value.kind !== "permission") {
      return this.handleQuestionAction(action.senderOpenId, action.value);
    }
    const { request_id, choice } = action.value;
    const req = this.pending.get(request_id);
    if (!req) return;
    if (!this.isAllowedOperator(req.operators, action.senderOpenId)) {
      this.logger.warn({ requestId: request_id, senderOpenId: action.senderOpenId }, "Ignoring permission card action from non-approver");
      return;
    }

    clearTimeout(req.timer);
    this.pending.delete(request_id);

    const s = this.scope(req.scopeId);
    if (choice === "allow_turn") s.turnApproved = true;
    if (choice === "allow_session") s.sessionApproved = true;

    req.deferred.resolve(choice);

    const resolvedCard = buildPermissionCardResolved({ toolName: req.toolName, choice });
    return { card: resolvedCard };
  }

  private handleQuestionAction(
    senderOpenId: string,
    value: Exclude<CardActionPayload, { kind: "permission" }>,
  ): { card?: FeishuCardV2 } | void {
    const pending = this.pendingQuestions.get(value.request_id);
    // Ignore stale actions (e.g. taps on an earlier question's card).
    if (!pending || value.q !== pending.qIndex) return;
    if (!this.isAllowedOperator(pending.operators, senderOpenId)) {
      this.logger.warn({ requestId: value.request_id, senderOpenId }, "Ignoring question card action from non-approver");
      return;
    }

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
   *
   * `senderOpenId` 不是批准人时不消费，消息按普通流程处理。
   */
  async consumePendingText(chatId: string, text: string, senderOpenId?: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return false;
    for (const pending of this.pendingQuestions.values()) {
      if (pending.chatId !== chatId || !pending.awaitingText) continue;
      if (senderOpenId !== undefined && !this.isAllowedOperator(pending.operators, senderOpenId)) continue;
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

  private handleQuestionTimeout(requestId: string): void {
    const q = this.pendingQuestions.get(requestId);
    if (!q) return;
    this.pendingQuestions.delete(requestId);
    q.deferred.resolve(null);
    const card = buildQuestionTimedOutCard({
      header: q.question.header,
      question: q.question.question,
      seconds: Math.round(this.questionTimeoutMs / 1000),
    });
    this.transport.updateCard(q.messageId, card).catch((err) => {
      this.logger.warn({ err }, "Failed to update timed-out question card");
    });
  }

  /**
   * 取消挂起的审批与提问。传 scopeId 时只取消该会话的；不传时取消全部
   * （仅用于进程退出）。
   */
  cancelAll(scopeId?: string): void {
    for (const [id, req] of this.pending) {
      if (scopeId !== undefined && req.scopeId !== scopeId) continue;
      clearTimeout(req.timer);
      req.deferred.resolve("deny");
      this.pending.delete(id);
    }
    for (const [id, q] of this.pendingQuestions) {
      if (scopeId !== undefined && q.scopeId !== scopeId) continue;
      if (q.timer) clearTimeout(q.timer);
      q.deferred.resolve(null);
      this.pendingQuestions.delete(id);
    }
  }
}
