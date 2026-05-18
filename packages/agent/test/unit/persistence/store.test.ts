import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "../../../src/persistence/store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";

const logger = pino({ level: "silent" });

describe("StateStore", () => {
  let dir: string;
  let store: StateStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "clc-test-"));
    store = new StateStore(dir, logger);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads fresh state when no file exists", async () => {
    await store.load();
    expect(store.getSession("chat-1")).toBeUndefined();
  });

  it("saves and loads sessions", async () => {
    await store.load();
    store.setSession("chat-1", {
      providerSessionId: "sess-abc",
      cwd: "/workspace",
      createdAt: "2026-01-01T00:00:00Z",
      lastActiveAt: "2026-01-01T01:00:00Z",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
    });
    await store.save();

    const store2 = new StateStore(dir, logger);
    await store2.load();
    const session = store2.getSession("chat-1");
    expect(session).toBeDefined();
    expect(session!.providerSessionId).toBe("sess-abc");
    expect(session!.cwd).toBe("/workspace");
    expect(session!.model).toBe("claude-sonnet-4-6");
  });

  it("deletes sessions", async () => {
    await store.load();
    store.setSession("chat-1", {
      cwd: "/tmp",
      createdAt: "2026-01-01T00:00:00Z",
      lastActiveAt: "2026-01-01T00:00:00Z",
      permissionMode: "default",
      model: "",
    });
    store.deleteSession("chat-1");
    expect(store.getSession("chat-1")).toBeUndefined();
  });

  it("getAllSessions returns a copy", async () => {
    await store.load();
    store.setSession("chat-1", {
      cwd: "/a",
      createdAt: "2026-01-01T00:00:00Z",
      lastActiveAt: "2026-01-01T00:00:00Z",
      permissionMode: "default",
      model: "",
    });
    store.setSession("chat-2", {
      cwd: "/b",
      createdAt: "2026-01-01T00:00:00Z",
      lastActiveAt: "2026-01-01T00:00:00Z",
      permissionMode: "acceptEdits",
      model: "",
    });
    const all = store.getAllSessions();
    expect(Object.keys(all)).toHaveLength(2);
    // Mutating the copy should not affect the store
    delete all["chat-1"];
    expect(store.getSession("chat-1")).toBeDefined();
  });
});
