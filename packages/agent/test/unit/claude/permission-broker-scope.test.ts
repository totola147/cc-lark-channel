import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PermissionBroker } from "../../../src/claude/permission-broker.ts";
import type { Transport } from "../../../src/transport/interface.ts";

const tick = () => new Promise((r) => setTimeout(r, 10));
const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never;

function mockTransport(): Transport {
  let n = 0;
  return {
    sendCard: vi.fn().mockImplementation(async () => `card-${n++}`),
    updateCard: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue("msg-1"),
  } as unknown as Transport;
}

/** 取第 i 次 sendCard 的卡片里的 request_id（权限卡片按钮在 column_set 里）。 */
function requestIdOf(t: Transport, i = 0): string {
  const card = (t.sendCard as ReturnType<typeof vi.fn>).mock.calls[i]?.[1];
  const walk = (els: unknown[]): string | undefined => {
    for (const el of els as Array<Record<string, any>>) {
      if (el.value?.request_id) return el.value.request_id;
      for (const c of el.columns ?? []) {
        const r = walk(c.elements ?? []);
        if (r) return r;
      }
    }
    return undefined;
  };
  const id = walk(card?.body?.elements ?? []);
  if (!id) throw new Error("no request_id in card");
  return id;
}

describe("PermissionBroker operator check (B3)", () => {
  let t: Transport;
  beforeEach(() => { t = mockTransport(); });

  it("ignores taps from users outside the approver list", async () => {
    const broker = new PermissionBroker({ permission_timeout_seconds: 60 }, t, logger, { approvers: () => ["ou_owner"] });
    const p = broker.requestPermission("chat-1", "Bash", { command: "rm -rf /" });
    await tick();
    const rid = requestIdOf(t);

    const res = await broker.handleCardAction({ senderOpenId: "ou_stranger", value: { kind: "permission", request_id: rid, choice: "allow_session" } });
    expect(res).toBeUndefined();

    await broker.handleCardAction({ senderOpenId: "ou_owner", value: { kind: "permission", request_id: rid, choice: "deny" } });
    expect(await p).toBe(false);
  });

  it("falls back to the turn requester when no approvers are configured", async () => {
    const broker = new PermissionBroker({ permission_timeout_seconds: 60 }, t, logger);
    const perms = broker.forSession("s1");
    perms.setRequester("ou_alice");
    const p = perms.requestPermission("chat-1", "Bash", {});
    await tick();
    const rid = requestIdOf(t);
    expect(await broker.handleCardAction({ senderOpenId: "ou_bob", value: { kind: "permission", request_id: rid, choice: "allow" } })).toBeUndefined();
    await broker.handleCardAction({ senderOpenId: "ou_alice", value: { kind: "permission", request_id: rid, choice: "allow" } });
    expect(await p).toBe(true);
  });

  it("question cards and free-text answers are also restricted", async () => {
    const broker = new PermissionBroker({ permission_timeout_seconds: 60 }, t, logger, { approvers: () => ["ou_owner"] });
    const p = broker.askQuestions("chat-1", [{ question: "Pick", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }]);
    await tick();
    const rid = requestIdOf(t);
    expect(await broker.handleCardAction({ senderOpenId: "ou_x", value: { kind: "question_option", request_id: rid, q: 0, opt: 0 } })).toBeUndefined();
    await broker.handleCardAction({ senderOpenId: "ou_owner", value: { kind: "question_other", request_id: rid, q: 0 } });
    // 非批准人的消息不会被当作答案
    expect(await broker.consumePendingText("chat-1", "hijack", "ou_x")).toBe(false);
    expect(await broker.consumePendingText("chat-1", "mine", "ou_owner")).toBe(true);
    expect(await p).toEqual({ Pick: "mine" });
  });
});

describe("PermissionBroker per-session scope (B4)", () => {
  let t: Transport;
  let broker: PermissionBroker;
  beforeEach(() => {
    t = mockTransport();
    broker = new PermissionBroker({ permission_timeout_seconds: 60 }, t, logger);
  });

  it("allow_session in one session does not approve another", async () => {
    const a = broker.forSession("a");
    const b = broker.forSession("b");
    const pa = a.requestPermission("chat-1", "Bash", {});
    await tick();
    await broker.handleCardAction({ senderOpenId: "u", value: { kind: "permission", request_id: requestIdOf(t, 0), choice: "allow_session" } });
    expect(await pa).toBe(true);

    // a 已放行，不再发卡片
    expect(await a.requestPermission("chat-1", "Write", {})).toBe(true);
    expect(t.sendCard).toHaveBeenCalledTimes(1);

    // b 仍需审批
    const pb = b.requestPermission("chat-2", "Bash", {});
    await tick();
    expect(t.sendCard).toHaveBeenCalledTimes(2);
    b.cancelAll();
    expect(await pb).toBe(false);
  });

  it("cancelAll only cancels the calling session's pending requests", async () => {
    const a = broker.forSession("a");
    const b = broker.forSession("b");
    const pa = a.requestPermission("chat-1", "Bash", {});
    const qb = b.askQuestions("chat-2", [{ question: "Q", multiSelect: false, options: [{ label: "X" }] }]);
    await tick();
    a.cancelAll();
    expect(await pa).toBe(false);

    // b 的提问仍在等待
    let settled = false;
    void qb.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    await broker.handleCardAction({ senderOpenId: "u", value: { kind: "question_option", request_id: requestIdOf(t, 1), q: 0, opt: 0 } });
    expect(await qb).toEqual({ Q: "X" });
  });

  it("disposeScope denies pending requests and drops approval state", async () => {
    const a = broker.forSession("a");
    const p = a.requestPermission("chat-1", "Bash", {});
    await tick();
    broker.disposeScope("a");
    expect(await p).toBe(false);
  });
});

describe("PermissionBroker question timeout (A6)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("resolves null and redraws the card when nobody answers", async () => {
    const t = mockTransport();
    const broker = new PermissionBroker({ permission_timeout_seconds: 60, question_timeout_seconds: 30 }, t, logger);
    const p = broker.askQuestions("chat-1", [{ question: "Pick", multiSelect: false, options: [{ label: "A" }] }]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await p).toBeNull();
    expect(t.updateCard).toHaveBeenCalledTimes(1);
    const card = (t.updateCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.stringify(card)).toContain("未作答");
  });

  it("0 disables the timeout", async () => {
    const t = mockTransport();
    const broker = new PermissionBroker({ permission_timeout_seconds: 60, question_timeout_seconds: 0 }, t, logger);
    const p = broker.askQuestions("chat-1", [{ question: "Pick", multiSelect: false, options: [{ label: "A" }] }]);
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(settled).toBe(false);
    broker.cancelAll();
    expect(await p).toBeNull();
  });
});
