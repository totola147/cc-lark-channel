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
    heartbeat_interval_ms: 0,
    final_reply_as_message: true,
    final_reply_format: "text",
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
  return {
    resetTurn: vi.fn(),
    resetSession: vi.fn(),
    cancelAll: vi.fn(),
    requestPermission: vi.fn().mockResolvedValue(true),
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

  it("posts the final reply as a new message on natural completion", async () => {
    const events = async function* () {
      yield { type: "text" as const, text: "The answer is " };
      yield { type: "text" as const, text: "42." };
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 10, outputTokens: 5 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: "s1" }),
      interrupt: vi.fn(),
    });

    await session.submit("q");
    await new Promise((r) => setTimeout(r, 200));
    expect(lark.sendText).toHaveBeenCalledWith("chat-1", "The answer is 42.");
  });

  describe("final_reply_format = card", () => {
    const cardConfig: AppConfig = {
      ...mockConfig,
      render: { ...mockConfig.render, final_reply_format: "card" },
    };

    function cardSession() {
      return new ClaudeSession("chat-1", cardConfig, lark, broker, logger, "/home/u/tmp", "default", "", "xhigh");
    }

    function replyEvents() {
      return async function* () {
        yield { type: "init" as const, model: "claude-opus-4-5-20251101" };
        yield { type: "text" as const, text: "The answer is 42." };
        yield {
          type: "turn_end" as const, durationMs: 100, inputTokens: 24497, outputTokens: 13,
          model: "claude-opus-4-5-20251101", contextWindow: 200_000,
        };
      };
    }

    it("posts the final reply as a card with a status bar", async () => {
      const s = cardSession();
      vi.mocked(createQuery).mockReturnValue({
        events: Object.assign(replyEvents()(), { sessionId: "s1" }),
        interrupt: vi.fn(),
      });

      await s.submit("q");
      await new Promise((r) => setTimeout(r, 200));

      const textCalls = vi.mocked(lark.sendText).mock.calls.map((c) => c[1]);
      expect(textCalls).not.toContain("The answer is 42.");
      const replyCard = vi.mocked(lark.sendCard).mock.calls
        .map((c) => c[1] as { header?: unknown; body: { elements: { tag: string; content?: string }[] } })
        .find((c) => c.body.elements[0]?.content === "The answer is 42.");
      expect(replyCard).toBeDefined();
      expect(replyCard!.header).toBeUndefined();
      const last = replyCard!.body.elements.at(-1)!;
      expect(last.content).toContain("Opus 4.5 | tmp | in: 24497 out: 13 tok | ctx: 12% | effort: xhigh");
    });

    it("falls back to text when the reply card is rejected", async () => {
      const s = cardSession();
      // 状态卡片发送成功，回复卡片失败
      vi.mocked(lark.sendCard)
        .mockResolvedValueOnce("card-1")
        .mockRejectedValue(new Error("card rejected"));
      vi.mocked(createQuery).mockReturnValue({
        events: Object.assign(replyEvents()(), { sessionId: "s1" }),
        interrupt: vi.fn(),
      });

      await s.submit("q");
      await new Promise((r) => setTimeout(r, 200));

      const textCalls = vi.mocked(lark.sendText).mock.calls.map((c) => c[1]);
      expect(textCalls).toContain("The answer is 42.");
    });
  });

  it("final reply is only the text after the last tool call", async () => {
    const events = async function* () {
      yield { type: "text" as const, text: "Let me check." };
      yield { type: "tool_use" as const, id: "t1", name: "Read", input: {} };
      yield { type: "tool_result" as const, toolUseId: "t1", isError: false, text: "ok" };
      yield { type: "text" as const, text: "Done: found it." };
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 10, outputTokens: 5 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: "s1" }),
      interrupt: vi.fn(),
    });

    await session.submit("q");
    await new Promise((r) => setTimeout(r, 200));
    const textCalls = vi.mocked(lark.sendText).mock.calls.map((c) => c[1]);
    expect(textCalls).toContain("Done: found it.");
    expect(textCalls).not.toContain("Let me check.");
  });

  it("does not post a final reply when interrupted", async () => {
    const events = async function* () {
      yield { type: "text" as const, text: "partial answer" };
      await new Promise((r) => setTimeout(r, 5000));
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 0, outputTokens: 0 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: undefined }),
      interrupt: vi.fn(),
    });

    await session.submit("q");
    await new Promise((r) => setTimeout(r, 50));
    await session.interrupt();
    await new Promise((r) => setTimeout(r, 50));
    const textCalls = vi.mocked(lark.sendText).mock.calls.map((c) => c[1]);
    expect(textCalls).not.toContain("partial answer");
  });

  it("does not abort a resumed turn whose first token is slow, once init arrived", async () => {
    vi.useFakeTimers();
    try {
      session.providerSessionId = "live-session";

      // init lands fast (CLI is up), but the first token takes 3 minutes —
      // far beyond the startup window. This must NOT be aborted.
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
      const textCalls = vi.mocked(lark.sendText).mock.calls.map((c) => c[1]);
      expect(textCalls).toContain("slow but valid answer");
      expect(textCalls.some((t) => String(t).includes("超时"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed turn on the card instead of a green Done", async () => {
    vi.useFakeTimers();
    try {
      // Fresh turn (no providerSessionId) where the CLI never emits anything.
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

      // No retry for a fresh turn, and the user is told explicitly.
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

      // First attempt: resume hangs, then the abort ends iteration cleanly with
      // zero events — exactly how query.ts swallows the abort error.
      let abortHang: (() => void) | null = null;
      const hanging = async function* () {
        await new Promise<void>((resolve) => {
          abortHang = resolve;
        });
        // returns without yielding anything
      };
      const firstInterrupt = vi.fn(() => {
        abortHang?.();
        return Promise.resolve();
      });

      const secondEvents = async function* () {
        yield { type: "text" as const, text: "fresh answer" };
        yield { type: "turn_end" as const, durationMs: 10, inputTokens: 1, outputTokens: 1 };
      };

      vi.mocked(createQuery)
        .mockReturnValueOnce({
          events: Object.assign(hanging(), { sessionId: undefined }),
          interrupt: firstInterrupt,
        })
        .mockReturnValueOnce({
          events: Object.assign(secondEvents(), { sessionId: "new-session" }),
          interrupt: vi.fn(),
        });

      await session.submit("q");
      expect(vi.mocked(createQuery).mock.calls[0]?.[0].resumeId).toBe("stale-session");

      await vi.advanceTimersByTimeAsync(30_001);
      await vi.runAllTimersAsync();

      // The stalled turn must not be silently dropped: a second attempt runs
      // without a resumeId and its answer reaches the user.
      expect(firstInterrupt).toHaveBeenCalled();
      expect(vi.mocked(createQuery)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(createQuery).mock.calls[1]?.[0].resumeId).toBeUndefined();
      expect(vi.mocked(createQuery).mock.calls[1]?.[0].prompt).toBe("q");

      const textCalls = vi.mocked(lark.sendText).mock.calls.map((c) => c[1]);
      expect(textCalls.some((t) => String(t).includes("启动超时"))).toBe(true);
      expect(textCalls).toContain("fresh answer");
      expect(session.getState()).toBe("idle");
      expect(session.providerSessionId).toBe("new-session");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("chunkText", () => {
  it("returns a single chunk when under the limit", async () => {
    const { chunkText } = await import("../../../src/claude/session.ts");
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });

  it("splits long text on paragraph boundaries and preserves content", async () => {
    const { chunkText } = await import("../../../src/claude/session.ts");
    const para = "x".repeat(60);
    const text = [para, para, para].join("\n\n");
    const chunks = chunkText(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(80);
    // No content lost (ignoring whitespace trimmed at boundaries).
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });
});
