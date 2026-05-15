import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "../../src/claude/session-manager.ts";
import { PermissionBroker } from "../../src/claude/permission-broker.ts";
import { StateStore } from "../../src/persistence/store.ts";
import type { LarkClient } from "../../src/lark/client.ts";
import type { AppConfig } from "../../src/config.ts";
import type { IncomingMessage } from "../../src/types.ts";
import pino from "pino";

const logger = pino({ level: "silent" });

vi.mock("../../src/claude/query", () => ({
  createQuery: vi.fn(),
}));

import { createQuery } from "../../src/claude/query.ts";

const mockConfig: AppConfig = {
  lark: { app_id: "test", app_secret: "test" },
  access: { allowed_open_ids: [], unauthorized_behavior: "ignore" },
  claude: {
    cli_path: "claude",
    default_model: "",
    default_cwd: "/tmp",
    permission_mode: "default",
    permission_timeout_seconds: 120,
    max_queue_size: 5,
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
    uploadImage: vi.fn().mockResolvedValue("img-key-1"),
    downloadImage: vi.fn().mockResolvedValue(Buffer.from("fake")),
    sdk: {} as never,
  } as unknown as LarkClient;
}

function mockMsg(text: string): IncomingMessage {
  return {
    messageId: `msg-${Date.now()}`,
    chatId: "chat-1",
    senderOpenId: "user-1",
    text,
    imageKeys: [],
  };
}

describe("E2E: Full message flow", () => {
  let manager: SessionManager;
  let lark: LarkClient;
  let broker: PermissionBroker;
  let stateStore: StateStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    lark = mockLark();
    broker = new PermissionBroker(
      { permission_timeout_seconds: 60 },
      lark,
      logger,
    );
    stateStore = new StateStore("/tmp/clc-e2e-test", logger);
    await stateStore.load();
    manager = new SessionManager(mockConfig, stateStore, broker, lark, logger);
  });

  it("handles a simple text message → Claude response", async () => {
    const events = async function* () {
      yield { type: "text" as const, text: "Hello! How can I help?" };
      yield { type: "turn_end" as const, durationMs: 500, inputTokens: 50, outputTokens: 20 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: "sess-1" }),
      interrupt: vi.fn(),
    });

    await manager.handleMessage(mockMsg("hello"));

    // Wait for turn to complete
    await new Promise((r) => setTimeout(r, 200));

    const session = manager.getSession("chat-1");
    expect(session).toBeDefined();
    expect(session!.getState()).toBe("idle");
    expect(session!.providerSessionId).toBe("sess-1");
    // Status card should have been sent
    expect(lark.sendCard).toHaveBeenCalled();
  });

  it("handles ! prefix interrupt", async () => {
    const interruptFn = vi.fn();
    const events = async function* () {
      await new Promise((r) => setTimeout(r, 5000));
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 0, outputTokens: 0 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: undefined }),
      interrupt: interruptFn,
    });

    await manager.handleMessage(mockMsg("do something long"));

    // Now send interrupt
    const events2 = async function* () {
      yield { type: "text" as const, text: "New response" };
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 10, outputTokens: 5 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events2(), { sessionId: "sess-2" }),
      interrupt: vi.fn(),
    });

    await manager.handleMessage(mockMsg("!do something else"));

    expect(interruptFn).toHaveBeenCalled();
  });

  it("queues messages and notifies user", async () => {
    const events = async function* () {
      await new Promise((r) => setTimeout(r, 1000));
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 0, outputTokens: 0 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: undefined }),
      interrupt: vi.fn(),
    });

    await manager.handleMessage(mockMsg("first"));
    await manager.handleMessage(mockMsg("second"));

    expect(lark.sendText).toHaveBeenCalledWith("chat-1", "📋 Queued (position 1)");
  });

  it("creates new session on /new via newSession", async () => {
    // First create a session
    const events = async function* () {
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 0, outputTokens: 0 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: "sess-old" }),
      interrupt: vi.fn(),
    });
    await manager.handleMessage(mockMsg("hi"));
    await new Promise((r) => setTimeout(r, 100));

    // Now create new session
    manager.newSession("chat-1");
    const session = manager.getSession("chat-1");
    expect(session!.providerSessionId).toBeUndefined();
  });

  it("permission broker integrates with card actions", async () => {
    // Simulate a tool use that triggers permission
    let permissionPromise: Promise<boolean> | undefined;
    const events = async function* () {
      yield { type: "tool_use" as const, id: "t1", name: "Bash", input: { command: "rm -rf /" } };
      // The permission broker will be called via canUseTool in the real flow
      yield { type: "turn_end" as const, durationMs: 100, inputTokens: 0, outputTokens: 0 };
    };
    vi.mocked(createQuery).mockReturnValue({
      events: Object.assign(events(), { sessionId: undefined }),
      interrupt: vi.fn(),
    });

    // Test the broker directly
    permissionPromise = broker.requestPermission("chat-1", "Bash", { command: "rm -rf /" });

    // Simulate button click
    const cardCalls = (lark.sendCard as ReturnType<typeof vi.fn>).mock.calls;
    await new Promise((r) => setTimeout(r, 50)); // let sendCard resolve

    // Extract request_id from the card
    const card = cardCalls[0]?.[1];
    let requestId = "";
    for (const el of card?.body?.elements ?? []) {
      if (el.tag === "column_set") {
        for (const col of el.columns ?? []) {
          for (const btn of col.elements ?? []) {
            if (btn.tag === "button" && btn.value?.request_id) {
              requestId = btn.value.request_id;
              break;
            }
          }
        }
      }
    }

    const result = await broker.handleCardAction({
      senderOpenId: "user-1",
      value: { kind: "permission", request_id: requestId, choice: "allow" },
    });

    expect(await permissionPromise).toBe(true);
    expect(result?.card).toBeDefined();
  });
});
