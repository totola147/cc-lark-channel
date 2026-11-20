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

  it("concurrent saves neither fail nor leave temp files, and the file stays valid JSON", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    await store.load();
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 30; i++) {
      store.setSession(`chat-${i}`, {
        id: `s${i}`, cwd: "/w", createdAt: "", lastActiveAt: "", permissionMode: "default", model: "",
      });
      saves.push(store.save());
    }
    await Promise.all(saves);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const data = JSON.parse(await readFile(join(dir, "state.json"), "utf-8"));
    expect(Object.keys(data.chats)).toHaveLength(30);
  });

  it("a failed save does not block later saves", async () => {
    await store.load();
    const s2 = new StateStore(join(dir, "missing-parent-file", "x"), logger);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "missing-parent-file"), "not a dir");
    await expect(s2.save()).rejects.toThrow();
    await expect(store.save()).resolves.toBeUndefined();
    await expect(s2.save()).rejects.toThrow(); // 仍然报错而不是挂起
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

describe("StateStore initial state isolation (B15)", () => {
  it("does not share state between fresh stores", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log } as never;
    const a = mkdtempSync(join(tmpdir(), "st-a-"));
    const b = mkdtempSync(join(tmpdir(), "st-b-"));
    try {
      const s1 = new StateStore(a, log);
      const s2 = new StateStore(b, log);
      await s1.load();
      await s2.load();
      s1.setWorkspace("oc_1", { chatId: "oc_1", path: "/p", name: "p", description: "", createdAt: "", ownerOpenId: "ou" });
      expect(s2.getWorkspace("oc_1")).toBeUndefined();
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
