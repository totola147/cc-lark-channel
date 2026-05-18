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
});
