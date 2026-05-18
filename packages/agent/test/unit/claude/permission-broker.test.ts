import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionBroker } from "../../../src/claude/permission-broker.ts";
import type { LarkClient } from "../../../src/lark/client.ts";

function mockLarkClient(): LarkClient {
  return {
    sendCard: vi.fn().mockResolvedValue("card-msg-1"),
    updateCard: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue("msg-1"),
  } as unknown as LarkClient;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("PermissionBroker", () => {
  let broker: PermissionBroker;
  let lark: LarkClient;

  beforeEach(() => {
    lark = mockLarkClient();
    broker = new PermissionBroker(
      { permission_timeout_seconds: 2 },
      lark,
      { warn: vi.fn(), debug: vi.fn() } as never,
    );
  });

  it("auto-allows when session is approved", async () => {
    const p = broker.requestPermission("chat-1", "Bash", { command: "ls" });
    await tick();
    await broker.handleCardAction({
      senderOpenId: "user-1",
      value: { kind: "permission", request_id: getRequestId(lark), choice: "allow_session" },
    });
    const result = await p;
    expect(result).toBe(true);

    const result2 = await broker.requestPermission("chat-1", "Write", { path: "/tmp/x" });
    expect(result2).toBe(true);
    expect(lark.sendCard).toHaveBeenCalledTimes(1);
  });

  it("auto-allows when turn is approved", async () => {
    const p = broker.requestPermission("chat-1", "Bash", { command: "ls" });
    await tick();
    await broker.handleCardAction({
      senderOpenId: "user-1",
      value: { kind: "permission", request_id: getRequestId(lark), choice: "allow_turn" },
    });
    expect(await p).toBe(true);

    const result2 = await broker.requestPermission("chat-1", "Edit", {});
    expect(result2).toBe(true);
  });

  it("resets turn approval on resetTurn", async () => {
    const p = broker.requestPermission("chat-1", "Bash", {});
    await tick();
    await broker.handleCardAction({
      senderOpenId: "user-1",
      value: { kind: "permission", request_id: getRequestId(lark), choice: "allow_turn" },
    });
    await p;

    broker.resetTurn();

    const p2 = broker.requestPermission("chat-1", "Bash", {});
    await tick();
    await broker.handleCardAction({
      senderOpenId: "user-1",
      value: { kind: "permission", request_id: getRequestId(lark, 1), choice: "allow" },
    });
    expect(await p2).toBe(true);
    expect(lark.sendCard).toHaveBeenCalledTimes(2);
  });

  it("denies on timeout", async () => {
    const result = await broker.requestPermission("chat-1", "Bash", { command: "rm -rf /" });
    expect(result).toBe(false);
    expect(lark.updateCard).toHaveBeenCalled();
  }, 5000);

  it("denies when user clicks deny", async () => {
    const p = broker.requestPermission("chat-1", "Bash", {});
    await tick();
    await broker.handleCardAction({
      senderOpenId: "user-1",
      value: { kind: "permission", request_id: getRequestId(lark), choice: "deny" },
    });
    expect(await p).toBe(false);
  });

  it("cancelAll resolves all pending as deny", async () => {
    const p1 = broker.requestPermission("chat-1", "Bash", {});
    await tick();
    broker.cancelAll();
    expect(await p1).toBe(false);
  });
});

function getRequestId(lark: LarkClient, callIndex = 0): string {
  const calls = (lark.sendCard as ReturnType<typeof vi.fn>).mock.calls;
  const card = calls[callIndex]?.[1];
  const elements = card?.body?.elements ?? [];
  for (const el of elements) {
    if (el.tag === "column_set") {
      for (const col of el.columns ?? []) {
        for (const btn of col.elements ?? []) {
          if (btn.tag === "button" && btn.value?.request_id) {
            return btn.value.request_id;
          }
        }
      }
    }
  }
  throw new Error("Could not find request_id in card");
}
