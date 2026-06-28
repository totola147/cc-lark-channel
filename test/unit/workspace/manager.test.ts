import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { WorkspaceManager } from "../../../src/workspace/manager.ts";
import { StateStore } from "../../../src/persistence/store.ts";

const logger = pino({ level: "silent" });

function makeTransport() {
  let counter = 0;
  return {
    createGroup: vi.fn(async () => `chat-${++counter}`),
    dissolveGroup: vi.fn(async () => {}),
  } as any;
}

describe("WorkspaceManager session binding", () => {
  let dir: string;
  let store: StateStore;
  let transport: ReturnType<typeof makeTransport>;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "clc-ws-"));
    store = new StateStore(dir, logger);
    await store.load();
    transport = makeTransport();
    mgr = new WorkspaceManager(transport, store, logger);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a group bound to a session", async () => {
    const res = await mgr.findOrCreateForSession(dir, "sess-1", "owner-1");
    expect("record" in res).toBe(true);
    if (!("record" in res)) return;
    expect(res.created).toBe(true);
    expect(res.record.sessionId).toBe("sess-1");
    expect(res.record.released).toBe(false);
    expect(transport.createGroup).toHaveBeenCalledTimes(1);
  });

  it("reuses the existing group for the same session", async () => {
    const first = await mgr.findOrCreateForSession(dir, "sess-2", "owner-1");
    const second = await mgr.findOrCreateForSession(dir, "sess-2", "owner-1");
    if (!("record" in first) || !("record" in second)) throw new Error("unexpected error");
    expect(second.created).toBe(false);
    expect(second.record.chatId).toBe(first.record.chatId);
    expect(transport.createGroup).toHaveBeenCalledTimes(1);
  });

  it("getBySessionId finds the bound group", async () => {
    const res = await mgr.findOrCreateForSession(dir, "sess-3", "owner-1");
    if (!("record" in res)) throw new Error("unexpected");
    const found = mgr.getBySessionId("sess-3");
    expect(found?.chatId).toBe(res.record.chatId);
    expect(mgr.getBySessionId("missing")).toBeUndefined();
  });

  it("release marks the group released, re-transfer clears it", async () => {
    const res = await mgr.findOrCreateForSession(dir, "sess-4", "owner-1");
    if (!("record" in res)) throw new Error("unexpected");
    const chatId = res.record.chatId;

    expect(mgr.isReleased(chatId)).toBe(false);
    await mgr.release(chatId);
    expect(mgr.isReleased(chatId)).toBe(true);

    // re-transfer the same session reuses the group and clears released
    const again = await mgr.findOrCreateForSession(dir, "sess-4", "owner-1");
    if (!("record" in again)) throw new Error("unexpected");
    expect(again.created).toBe(false);
    expect(mgr.isReleased(chatId)).toBe(false);
  });

  it("persists the binding across reloads", async () => {
    const res = await mgr.findOrCreateForSession(dir, "sess-5", "owner-1");
    if (!("record" in res)) throw new Error("unexpected");

    const store2 = new StateStore(dir, logger);
    await store2.load();
    const mgr2 = new WorkspaceManager(transport, store2, logger);
    expect(mgr2.getBySessionId("sess-5")?.chatId).toBe(res.record.chatId);
  });
});
