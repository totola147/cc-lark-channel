import type { Logger } from "../util/logger.js";
import type { LarkClient } from "../lark/client.js";
import type { FeishuCardV2 } from "../lark/cards/types.js";
import type { CardActionPayload, PermissionChoice } from "../types.js";
import { createDeferred, type Deferred } from "../util/deferred.js";
import { buildPermissionCard, buildPermissionCardResolved, buildPermissionCardTimedOut } from "../lark/cards/permission-card.js";

interface PendingRequest {
  toolName: string;
  input: unknown;
  chatId: string;
  messageId: string;
  deferred: Deferred<PermissionChoice>;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private turnApproved = false;
  private sessionApproved = false;
  private readonly timeoutMs: number;

  constructor(
    config: { permission_timeout_seconds: number },
    private readonly larkClient: LarkClient,
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
    const messageId = await this.larkClient.sendCard(chatId, card);

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

  async handleCardAction(action: {
    senderOpenId: string;
    value: CardActionPayload;
  }): Promise<{ card?: FeishuCardV2 } | void> {
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

  private handleTimeout(requestId: string): void {
    const req = this.pending.get(requestId);
    if (!req) return;

    this.pending.delete(requestId);
    req.deferred.resolve("deny");

    const card = buildPermissionCardTimedOut({ toolName: req.toolName });
    this.larkClient.updateCard(req.messageId, card).catch((err) => {
      this.logger.warn({ err }, "Failed to update timed-out permission card");
    });
  }

  cancelAll(): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.deferred.resolve("deny");
      this.pending.delete(id);
    }
  }
}
