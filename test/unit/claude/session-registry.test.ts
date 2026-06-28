import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLiveSessionOwner } from "../../../src/claude/session-registry.ts";

describe("getLiveSessionOwner", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-sessions-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMarker(pid: number, sessionId: string, status = "busy") {
    writeFileSync(
      join(dir, `${pid}.json`),
      JSON.stringify({ pid, sessionId, cwd: "/proj", status }),
    );
  }

  it("returns null when no marker matches", () => {
    writeMarker(111, "other-session");
    const owner = getLiveSessionOwner("target", { sessionsDir: dir, isAlive: () => true });
    expect(owner).toBeNull();
  });

  it("returns owner when a matching session is held by a live pid", () => {
    writeMarker(222, "target", "busy");
    const owner = getLiveSessionOwner("target", { sessionsDir: dir, isAlive: () => true });
    expect(owner).toEqual({ pid: 222, cwd: "/proj", status: "busy" });
  });

  it("returns null when matching pid is dead (safe to resume)", () => {
    writeMarker(333, "target");
    const owner = getLiveSessionOwner("target", { sessionsDir: dir, isAlive: () => false });
    expect(owner).toBeNull();
  });

  it("returns null for empty session id", () => {
    expect(getLiveSessionOwner("", { sessionsDir: dir, isAlive: () => true })).toBeNull();
  });

  it("returns null when sessions dir does not exist", () => {
    expect(
      getLiveSessionOwner("target", { sessionsDir: join(dir, "nope"), isAlive: () => true }),
    ).toBeNull();
  });

  it("skips malformed marker files", () => {
    writeFileSync(join(dir, "bad.json"), "{not json");
    writeMarker(444, "target");
    const owner = getLiveSessionOwner("target", { sessionsDir: dir, isAlive: () => true });
    expect(owner?.pid).toBe(444);
  });

  it("picks the live owner even if a dead marker for the same session exists", () => {
    writeMarker(555, "target"); // will be treated dead
    writeMarker(556, "target"); // will be treated alive
    const owner = getLiveSessionOwner("target", {
      sessionsDir: dir,
      isAlive: (pid) => pid === 556,
    });
    expect(owner?.pid).toBe(556);
  });
});
