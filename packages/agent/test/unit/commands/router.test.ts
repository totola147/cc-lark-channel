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

  it("handles leading whitespace", () => {
    expect(router.match(mockMsg("  /new"))).toEqual({ command: "/new", args: "" });
  });
});
