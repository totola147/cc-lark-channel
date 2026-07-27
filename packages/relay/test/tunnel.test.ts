import { describe, it, expect, vi } from "vitest";
import type { WebSocket } from "ws";
import { TunnelManager } from "../src/tunnel.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger } as never;

/** Minimal open WebSocket stub (readyState 1 = OPEN). */
function fakeWs(): WebSocket {
  return { readyState: 1, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
}

describe("TunnelManager chat routing", () => {
  it("routes a claimed chat to its owning agent, not the most-recent agent", () => {
    const tm = new TunnelManager(logger);
    const user = "ou_user";
    const wsA = fakeWs();
    const wsB = fakeWs();

    // Two agents share one openId (two independent environments).
    tm.register("agentA", user, wsA);
    tm.claimChat("agentA", "chatA");
    tm.register("agentB", user, wsB); // becomes most-recent for the user
    tm.claimChat("agentB", "chatB");

    // chatA must still route to agentA even though agentB registered last.
    const rA = tm.resolveAgentForChat("chatA", user);
    expect(rA?.tunnel.agentId).toBe("agentA");
    expect(rA?.via).toBe("chat");

    const rB = tm.resolveAgentForChat("chatB", user);
    expect(rB?.tunnel.agentId).toBe("agentB");
    expect(rB?.via).toBe("chat");
  });

  it("falls back to the user's most-recent agent for unclaimed chats/DMs", () => {
    const tm = new TunnelManager(logger);
    const user = "ou_user";
    tm.register("agentA", user, fakeWs());
    tm.register("agentB", user, fakeWs());

    const r = tm.resolveAgentForChat("unknown_chat", user);
    expect(r?.tunnel.agentId).toBe("agentB"); // last registered
    expect(r?.via).toBe("user");
  });

  it("falls back to the user route when the chat owner is offline", () => {
    const tm = new TunnelManager(logger);
    const user = "ou_user";
    tm.register("agentA", user, fakeWs());
    tm.claimChat("agentA", "chatA");
    tm.register("agentB", user, fakeWs());

    tm.remove("agentA"); // owner disconnects; its chat claims are dropped

    const r = tm.resolveAgentForChat("chatA", user);
    expect(r?.tunnel.agentId).toBe("agentB");
    expect(r?.via).toBe("user");
  });

  it("returns undefined when no agent is available", () => {
    const tm = new TunnelManager(logger);
    expect(tm.resolveAgentForChat("chatX", "nobody")).toBeUndefined();
  });

  it("removing an agent only clears the user fallback if it still points at it", () => {
    const tm = new TunnelManager(logger);
    const user = "ou_user";
    tm.register("agentA", user, fakeWs());
    tm.register("agentB", user, fakeWs()); // userToAgent -> agentB

    tm.remove("agentA"); // must NOT clear the user fallback (points at agentB)

    const r = tm.resolveAgentForChat("dm", user);
    expect(r?.tunnel.agentId).toBe("agentB");
  });

  it("keeps the chat owner routable after another agent for the same user leaves", () => {
    const tm = new TunnelManager(logger);
    const user = "ou_user";
    tm.register("agentA", user, fakeWs());
    tm.claimChat("agentA", "chatA");
    tm.register("agentB", user, fakeWs()); // userToAgent -> agentB

    tm.remove("agentB"); // fallback pointer for the user is now gone

    // agentA still owns chatA and is online, so the chat stays routable even
    // though the user has no fallback agent anymore.
    const r = tm.resolveAgentForChat("chatA", user);
    expect(r?.tunnel.agentId).toBe("agentA");
    expect(r?.via).toBe("chat");
  });

  it("ignores a late close from a replaced socket for the same agentId", () => {
    const tm = new TunnelManager(logger);
    const user = "ou_user";
    const oldWs = fakeWs();
    const newWs = fakeWs();

    tm.register("agentA", user, oldWs);
    tm.claimChat("agentA", "chatA");
    tm.register("agentA", user, newWs); // reconnect: closes oldWs
    expect(oldWs.close).toHaveBeenCalled();

    // oldWs's close handler fires after the new tunnel is registered.
    tm.remove("agentA", oldWs);

    const r = tm.resolveAgentForChat("chatA", user);
    expect(r?.tunnel.agentId).toBe("agentA");
    expect(r?.tunnel.ws).toBe(newWs);
    expect(tm.getAllTunnels()).toHaveLength(1);
  });

  it("still removes the tunnel when the closing socket is the current one", () => {
    const tm = new TunnelManager(logger);
    const ws = fakeWs();
    tm.register("agentA", "ou_user", ws);
    tm.claimChat("agentA", "chatA");

    tm.remove("agentA", ws);

    expect(tm.getAllTunnels()).toHaveLength(0);
    expect(tm.resolveAgentForChat("chatA", "ou_user")).toBeUndefined();
  });

  it("reassigns chat ownership when another agent claims the same chat", () => {
    const tm = new TunnelManager(logger);
    const user = "ou_user";
    tm.register("agentA", user, fakeWs());
    tm.claimChat("agentA", "chatA");
    tm.register("agentB", user, fakeWs());
    tm.claimChat("agentB", "chatA"); // takeover (e.g. re-transfer)

    const r = tm.resolveAgentForChat("chatA", user);
    expect(r?.tunnel.agentId).toBe("agentB");
    expect(r?.via).toBe("chat");
  });
});
