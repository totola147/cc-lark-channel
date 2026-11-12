import { describe, it, expect } from "vitest";
import { CommandRouter } from "../../../src/commands/router.ts";
import type { IncomingMessage } from "../../../src/types.ts";

const mockMsg = (text: string): IncomingMessage => ({
  messageId: "msg-1",
  chatId: "chat-1",
  senderOpenId: "user-1",
  text,
  imageKeys: [],
});

describe("CommandRouter.match", () => {
  const router = new CommandRouter(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it("matches known commands", () => {
    expect(router.match(mockMsg("/new"))).toEqual({ command: "/new", args: "" });
    expect(router.match(mockMsg("/stop"))).toEqual({ command: "/stop", args: "" });
    expect(router.match(mockMsg("/status"))).toEqual({ command: "/status", args: "" });
    expect(router.match(mockMsg("/help"))).toEqual({ command: "/help", args: "" });
  });

  it("extracts args from commands", () => {
    expect(router.match(mockMsg("/mode acceptEdits"))).toEqual({ command: "/mode", args: "acceptEdits" });
    expect(router.match(mockMsg("/cd /workspace/project"))).toEqual({ command: "/cd", args: "/workspace/project" });
    expect(router.match(mockMsg("/model claude-sonnet-4-6"))).toEqual({ command: "/model", args: "claude-sonnet-4-6" });
  });

  it("returns null for unknown commands", () => {
    expect(router.match(mockMsg("/unknown"))).toBeNull();
    expect(router.match(mockMsg("/foo bar"))).toBeNull();
  });

  it("returns null for non-command text", () => {
    expect(router.match(mockMsg("hello world"))).toBeNull();
    expect(router.match(mockMsg("!interrupt"))).toBeNull();
    expect(router.match(mockMsg(""))).toBeNull();
  });

  it("resolves /hb to /handback", () => {
    expect(router.match(mockMsg("/handback"))).toEqual({ command: "/handback", args: "" });
    expect(router.match(mockMsg("/hb"))).toEqual({ command: "/handback", args: "" });
  });

  it("handles leading whitespace", () => {
    expect(router.match(mockMsg("  /new"))).toEqual({ command: "/new", args: "" });
  });
});

describe("CommandRouter /handback after an SDK fork (B6)", () => {
  it("looks up the wrapper by the bound id and resumes the forked id", async () => {
    const { vi } = await import("vitest");
    const ws = { chatId: "chat-1", sessionId: "orig-id", path: "/p", name: "p", description: "", createdAt: "", ownerOpenId: "u" };
    const workspaceManager = {
      isWorkspaceChat: () => true,
      isReleased: () => false,
      getByChatId: () => ws,
      release: vi.fn(async (_c: string, sid?: string) => { if (sid) ws.sessionId = sid; return ws; }),
    };
    const session = { getState: () => "idle", providerSessionId: "forked-id", interrupt: vi.fn(async () => {}) };
    const sessionManager = { getSession: () => session };
    const transport = { sendText: vi.fn(async () => "m") };
    const pushResume = vi.fn(() => true);
    const router = new CommandRouter(
      sessionManager as never,
      transport as never,
      {} as never,
      workspaceManager as never,
      {} as never,
      { pushResume, hasWrapper: () => true },
    );
    await router.execute({ command: "/handback", args: "" }, mockMsg("/handback"));
    expect(pushResume).toHaveBeenCalledWith("orig-id", "forked-id");
    expect(workspaceManager.release).toHaveBeenCalledWith("chat-1", "forked-id");
    expect(ws.sessionId).toBe("forked-id");
  });
});

describe("CommandRouter /profile", () => {
  async function setup(state = "idle") {
    const { vi } = await import("vitest");
    const session: { profile?: string; providerSessionId?: string; getState: () => string } = {
      getState: () => state,
      providerSessionId: "p1",
    };
    const sessionManager = { getOrCreateSession: () => session, persist: vi.fn() };
    const sent: string[] = [];
    const transport = { sendText: vi.fn(async (_c: string, t: string) => { sent.push(t); return "m"; }) };
    const config = { profiles: { fermi: { auth_token_env: "CLC_TEST_PROFILE_TOK" }, plain: {} } };
    const router = new CommandRouter(
      sessionManager as never,
      transport as never,
      config as never,
      { isWorkspaceChat: () => false } as never,
      {} as never,
    );
    const run = (args: string) => router.execute({ command: "/profile", args }, mockMsg(`/profile ${args}`));
    return { session, sessionManager, sent, run };
  }

  it("is a known command", () => {
    const router = new CommandRouter({} as never, {} as never, {} as never, {} as never);
    expect(router.match(mockMsg("/profile fermi"))).toEqual({ command: "/profile", args: "fermi" });
  });

  it("lists profiles and marks the current one", async () => {
    const { session, sent, run } = await setup();
    session.profile = "plain";
    await run("");
    expect(sent[0]).toContain("当前运行档：plain");
    expect(sent[0]).toContain("▶ plain");
    expect(sent[0]).toContain("  fermi");
  });

  it("switches to a valid profile and persists", async () => {
    const { session, sessionManager, run } = await setup();
    await run("plain");
    expect(session.profile).toBe("plain");
    expect(sessionManager.persist).toHaveBeenCalledWith("chat-1");
  });

  it("refuses an unknown profile or one with missing credentials", async () => {
    const { session, sent, run } = await setup();
    await run("nope");
    await run("fermi"); // CLC_TEST_PROFILE_TOK 未设置
    expect(session.profile).toBeUndefined();
    expect(sent[0]).toMatch(/未在 agent 配置中定义/);
    expect(sent[1]).toMatch(/CLC_TEST_PROFILE_TOK/);
  });

  it("'default' clears the profile", async () => {
    const { session, run } = await setup();
    session.profile = "plain";
    await run("default");
    expect(session.profile).toBeUndefined();
  });

  it("refuses to switch while a turn is running", async () => {
    const { session, sent, run } = await setup("generating");
    await run("plain");
    expect(session.profile).toBeUndefined();
    expect(sent[0]).toMatch(/正在运行/);
  });
});
