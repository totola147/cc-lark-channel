import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeSession } from "../../../src/claude/session.ts";
import type { LarkClient } from "../../../src/lark/client.ts";
import type { PermissionBroker } from "../../../src/claude/permission-broker.ts";
import type { AppConfig } from "../../../src/config.ts";
import pino from "pino";

const logger = pino({ level: "silent" });

vi.mock("../../../src/claude/query", () => ({
  createQuery: vi.fn(),
}));

import { createQuery } from "../../../src/claude/query.ts";

const mockConfig: AppConfig = {
  lark: { app_id: "test", app_secret: "test" },
  access: { allowed_open_ids: [], unauthorized_behavior: "ignore" },
  claude: {
    cli_path: "claude",
    default_model: "",
    default_cwd: "/tmp",
    permission_mode: "default",
    permission_timeout_seconds: 120,
    max_queue_size: 3,
  },
  render: {
    hide_thinking: false,
    show_turn_stats: true,
    inline_max_bytes: 1500,
    card_update_interval_ms: 50,
  },
  persistence: { state_dir: "/tmp" },
  logging: { level: "info" },
};

function mockLark(): LarkClient {
  return {
    sendText: vi.fn().mockResolvedValue("msg-1"),
    sendCard: vi.fn().mockResolvedValue("card-1"),
    updateCard: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue("msg-2"),
  } as unknown as LarkClient;
}

function mockBroker(): PermissionBroker {
  // forSession 返回同一个作用域对象，便于断言
  const scope = {
    resetTurn: vi.fn(),
    resetSession: vi.fn(),
    cancelAll: vi.fn(),
    setRequester: vi.fn(),
    requestPermission: vi.fn().mockResolvedValue(true),
    askQuestions: vi.fn().mockResolvedValue({}),
  };
  return {
    ...scope,
    forSession: vi.fn(() => scope),
    disposeScope: vi.fn(),
  } as unknown as PermissionBroker;
}

describe("ClaudeSession", () => {
  let session: ClaudeSession;
  let lark: LarkClient;
  let broker: PermissionBroker;

  beforeEach(() => {
    vi.clearAllMocks();
    lark = mockLark();
    broker = mockBroker();
    session = new ClaudeSession(
      "chat-1",
      mockConfig,
      lark,
      broker,
      logger,
      "/tmp",
      "default",
      "",
    );
  });

  it("starts in idle state", () => {
    expect(session.getState()).toBe("idle");
    expect(session.getQueueLength()).toBe(0);
  });

  it("transitions to generating on submit", async () => {
    const events = async function* () {
      yield { type: "text" as const, text: "Hello" };
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 10, outputTokens: 5 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: "sess-1" }),
      interrupt: vi.fn(),
    });

    const result = await session.submit("hi");
    expect(result.kind).toBe("started");

    // Wait for turn to complete
    await new Promise((r) => setTimeout(r, 200));
    expect(session.getState()).toBe("idle");
    expect(session.getStats().turnCount).toBe(1);
    expect(session.getStats().totalInputTokens).toBe(10);
  });

  it("queues messages when generating", async () => {
    let resolveFirst: () => void;
    const blockingPromise = new Promise<void>((r) => { resolveFirst = r; });

    const events = async function* () {
      await blockingPromise;
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 10, outputTokens: 5 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: undefined }),
      interrupt: vi.fn(),
    });

    await session.submit("first");

    // Second message should queue
    const result2 = await session.submit("second");
    expect(result2.kind).toBe("queued");
    expect(result2.position).toBe(1);
    expect(session.getQueueLength()).toBe(1);

    resolveFirst!();
  });

  it("rejects when queue is full", async () => {
    const events = async function* () {
      await new Promise((r) => setTimeout(r, 500));
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 0, outputTokens: 0 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: undefined }),
      interrupt: vi.fn(),
    });

    await session.submit("first"); // starts generating
    await session.submit("q1");
    await session.submit("q2");
    await session.submit("q3");
    const result = await session.submit("q4"); // queue full (max 3)
    expect(result.kind).toBe("rejected");
  });

  it("interrupt stops generation and flushes queue", async () => {
    const interruptFn = vi.fn();
    const events = async function* () {
      await new Promise((r) => setTimeout(r, 5000));
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 0, outputTokens: 0 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: undefined }),
      interrupt: interruptFn,
    });

    await session.submit("first");
    const queued = session.submit("queued");

    await session.interrupt();
    expect(interruptFn).toHaveBeenCalled();
    expect(session.getState()).toBe("idle");
    expect(session.getQueueLength()).toBe(0);
    expect(broker.cancelAll).toHaveBeenCalled();
    // The queued promise rejects on interrupt — suppress unhandled rejection
    await expect(queued).resolves.toBeDefined();
  });

  it("uses its own permission scope, records the requester, and disposes it", async () => {
    const events = async function* () {
      yield { type: "turn_end" as const, durationMs: 1, inputTokens: 0, outputTokens: 0 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: undefined }),
      interrupt: vi.fn(),
    });
    const scope = (broker as unknown as { forSession: ReturnType<typeof vi.fn> }).forSession;
    expect(scope).toHaveBeenCalledTimes(1);
    const scopeId = scope.mock.calls[0]![0];

    await session.submit("hi", undefined, "ou_alice");
    expect((broker as unknown as { setRequester: ReturnType<typeof vi.fn> }).setRequester).toHaveBeenCalledWith("ou_alice");
    // 传给 createQuery 的是会话作用域而不是全局 broker
    expect(vi.mocked(createQuery).mock.calls.at(-1)![2]).toBe(scope.mock.results[0]!.value);

    session.dispose();
    expect((broker as unknown as { disposeScope: ReturnType<typeof vi.fn> }).disposeScope).toHaveBeenCalledWith(scopeId);
  });

  it("stop sends confirmation message", async () => {
    const events = async function* () {
      await new Promise((r) => setTimeout(r, 5000));
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 0, outputTokens: 0 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: undefined }),
      interrupt: vi.fn(),
    });

    await session.submit("first");
    await session.stop();
    expect(lark.sendText).toHaveBeenCalledWith("chat-1", "⏹ Stopped");
  });
});

/** 所有 sendCard/updateCard 里出现过的卡片内容，用于检查回答是否显示在卡片上。 */
function cardTexts(lark: LarkClient): string {
  const send = vi.mocked(lark.sendCard).mock.calls.map((c) => JSON.stringify(c[1]));
  const upd = vi.mocked(lark.updateCard).mock.calls.map((c) => JSON.stringify(c[1]));
  return [...send, ...upd].join("|");
}

describe("ClaudeSession startup watchdog", () => {
  let session: ClaudeSession;
  let lark: LarkClient;

  beforeEach(() => {
    vi.clearAllMocks();
    lark = mockLark();
    session = new ClaudeSession("chat-1", mockConfig, lark, mockBroker(), logger, "/tmp", "default", "");
  });

  it("does not abort a resumed turn whose first token is slow, once init arrived", async () => {
    vi.useFakeTimers();
    try {
      session.providerSessionId = "live-session";
      // init 很快到达（CLI 已启动），但首个 token 要 3 分钟，远超启动窗口，不能被中止。
      const events = async function* () {
        yield { type: "init" as const, model: "sonnet" };
        await new Promise<void>((r) => setTimeout(r, 180_000));
        yield { type: "text" as const, text: "slow but valid answer" };
        yield { type: "turn_end" as const, durationMs: 180_000, inputTokens: 9, outputTokens: 3 };
      };
      const interrupt = vi.fn().mockResolvedValue(undefined);
      vi.mocked(createQuery).mockReturnValue({
        events: Object.assign(events(), { sessionId: "live-session" }),
        interrupt,
      });

      await session.submit("q");
      await vi.advanceTimersByTimeAsync(200_000);
      await vi.runAllTimersAsync();

      expect(interrupt).not.toHaveBeenCalled();
      expect(vi.mocked(createQuery)).toHaveBeenCalledTimes(1);
      expect(cardTexts(lark)).toContain("slow but valid answer");
      const textCalls = vi.mocked(lark.sendText).mock.calls.map((c) => String(c[1]));
      expect(textCalls.some((t) => t.includes("超时"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed fresh turn instead of a silent green Done", async () => {
    vi.useFakeTimers();
    try {
      // 新会话（无 providerSessionId），CLI 一个事件都不发
      let release: (() => void) | null = null;
      const hanging = async function* () {
        await new Promise<void>((r) => { release = r; });
      };
      vi.mocked(createQuery).mockReturnValue({
        events: Object.assign(hanging(), { sessionId: undefined }),
        interrupt: vi.fn(() => { release?.(); return Promise.resolve(); }),
      });

      await session.submit("q");
      await vi.advanceTimersByTimeAsync(30_001);
      await vi.runAllTimersAsync();

      // 新会话不重试，并明确告知用户
      expect(vi.mocked(createQuery)).toHaveBeenCalledTimes(1);
      const textCalls = vi.mocked(lark.sendText).mock.calls.map((c) => String(c[1]));
      expect(textCalls.some((t) => t.includes("启动超时"))).toBe(true);
      expect(session.getState()).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries fresh when a resumed CLI never starts within 30s", async () => {
    vi.useFakeTimers();
    try {
      session.providerSessionId = "stale-session";
      // 第一次 resume 挂住，abort 后零事件正常结束（与 query.ts 吞掉 abort 的行为一致）
      let abortHang: (() => void) | null = null;
      const hanging = async function* () {
        await new Promise<void>((resolve) => { abortHang = resolve; });
      };
      const firstInterrupt = vi.fn(() => { abortHang?.(); return Promise.resolve(); });
      const secondEvents = async function* () {
        yield { type: "text" as const, text: "fresh answer" };
        yield { type: "turn_end" as const, durationMs: 10, inputTokens: 1, outputTokens: 1 };
      };
      vi.mocked(createQuery)
        .mockReturnValueOnce({ events: Object.assign(hanging(), { sessionId: undefined }), interrupt: firstInterrupt })
        .mockReturnValueOnce({ events: Object.assign(secondEvents(), { sessionId: "new-session" }), interrupt: vi.fn() });

      await session.submit("q");
      expect(vi.mocked(createQuery).mock.calls[0]?.[0].resumeId).toBe("stale-session");

      await vi.advanceTimersByTimeAsync(30_001);
      await vi.runAllTimersAsync();

      expect(firstInterrupt).toHaveBeenCalled();
      expect(vi.mocked(createQuery)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(createQuery).mock.calls[1]?.[0].resumeId).toBeUndefined();
      expect(vi.mocked(createQuery).mock.calls[1]?.[0].prompt).toBe("q");
      const textCalls = vi.mocked(lark.sendText).mock.calls.map((c) => String(c[1]));
      expect(textCalls.some((t) => t.includes("启动超时"))).toBe(true);
      expect(cardTexts(lark)).toContain("fresh answer");
      expect(session.getState()).toBe("idle");
      expect(session.providerSessionId).toBe("new-session");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ClaudeSession interrupt race", () => {
  /** 一个在 abort 前一直挂起、abort 后正常结束（模拟 query.ts 吞掉 abort）的事件流。 */
  function abortable(first: Array<Record<string, unknown>>) {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const events = async function* () {
      for (const e of first) yield e as never;
      await gate;
      // abort 之后旧迭代器可能还会吐出残余事件
      yield { type: "text" as const, text: "stale tail" };
    };
    const interrupt = vi.fn(async () => { release(); });
    return { handle: { events: Object.assign(events(), { sessionId: undefined as string | undefined }), interrupt }, release };
  }

  let lark: LarkClient;
  let session: ClaudeSession;
  beforeEach(() => {
    vi.clearAllMocks();
    lark = mockLark();
    session = new ClaudeSession("chat-1", mockConfig, lark, mockBroker(), logger, "/tmp", "default", "");
  });

  it("an interrupted turn's cleanup does not clobber the replacement turn", async () => {
    const first = abortable([{ type: "init", model: "m" }, { type: "text", text: "old partial" }]);
    let finishSecond: () => void = () => {};
    const secondGate = new Promise<void>((r) => { finishSecond = r; });
    const second = async function* () {
      yield { type: "init" as const, model: "m" };
      await secondGate;
      yield { type: "text" as const, text: "new answer" };
      yield { type: "turn_end" as const, durationMs: 1, inputTokens: 1, outputTokens: 1 };
    };
    const onTurnComplete = vi.fn();
    session.onTurnComplete = onTurnComplete;
    vi.mocked(createQuery)
      .mockReturnValueOnce(first.handle)
      .mockReturnValueOnce({ events: Object.assign(second(), { sessionId: "s2" }), interrupt: vi.fn() });

    await session.submit("one");
    await new Promise((r) => setTimeout(r, 20));
    await session.interrupt("two");
    await new Promise((r) => setTimeout(r, 20));

    // 旧轮次 finally 已经跑过，但新轮次仍在生成，且没有触发 onTurnComplete
    expect(session.getState()).toBe("generating");
    expect(onTurnComplete).not.toHaveBeenCalled();

    // 等新轮次的状态卡片发出（节流间隔 50ms），之后只看它的更新
    await new Promise((r) => setTimeout(r, 80));
    vi.mocked(lark.sendCard).mockClear();
    vi.mocked(lark.updateCard).mockClear();
    finishSecond();
    await new Promise((r) => setTimeout(r, 100));
    expect(session.getState()).toBe("idle");
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    const after = cardTexts(lark);
    expect(after).toContain("new answer");
    expect(after).not.toContain("stale tail");
  });

  it("a user abort on a resumed turn keeps the session id (no resume fallback)", async () => {
    session.providerSessionId = "keep-me";
    vi.mocked(createQuery).mockReturnValueOnce({
      events: Object.assign((async function* () {
        yield { type: "init" as const, model: "m" };
        throw new Error("Claude Code process aborted by user");
      })(), { sessionId: "keep-me" }),
      interrupt: vi.fn(),
    });
    await session.submit("q");
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(createQuery)).toHaveBeenCalledTimes(1);
    expect(session.providerSessionId).toBe("keep-me");
  });

  it("interrupt keeps the session id learned from init", async () => {
    const first = abortable([{ type: "init", model: "m" }]);
    first.handle.events.sessionId = "from-init";
    vi.mocked(createQuery).mockReturnValueOnce(first.handle);
    await session.submit("q");
    await new Promise((r) => setTimeout(r, 20));
    await session.interrupt();
    expect(session.providerSessionId).toBe("from-init");
  });

  it("tells the user when a failed resume drops history", async () => {
    session.providerSessionId = "gone";
    vi.mocked(createQuery)
      .mockReturnValueOnce({
        events: Object.assign((async function* () {
          throw new Error("No conversation found with session ID: gone");
        })(), { sessionId: undefined }),
        interrupt: vi.fn(),
      })
      .mockReturnValueOnce({
        events: Object.assign((async function* () {
          yield { type: "text" as const, text: "ok" };
          yield { type: "turn_end" as const, durationMs: 1, inputTokens: 1, outputTokens: 1 };
        })(), { sessionId: "fresh" }),
        interrupt: vi.fn(),
      });
    await session.submit("q");
    await new Promise((r) => setTimeout(r, 50));
    const texts = vi.mocked(lark.sendText).mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => t.includes("无法恢复之前的会话"))).toBe(true);
    expect(session.providerSessionId).toBe("fresh");
  });
});
