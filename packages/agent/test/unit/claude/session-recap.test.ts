import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { buildRecap } from "../../../src/claude/session-recap.ts";

/**
 * buildRecap reads ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
 * We point cwd at a temp dir and write the jsonl into the matching encoded path
 * under the real homedir's .claude/projects, then clean it up.
 */
describe("buildRecap", () => {
  let cwd: string;
  let projDir: string;
  const sid = "test-session-recap";

  function encode(p: string) { return p.replace(/\//g, "-"); }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "recap-cwd-"));
    projDir = join(homedir(), ".claude", "projects", encode(cwd));
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function writeJsonl(lines: object[]) {
    writeFileSync(join(projDir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
  }

  const userTurn = (text: string) => ({ type: "user", message: { content: [{ type: "text", text }] } });
  const asstTurn = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

  it("returns null when no jsonl exists", () => {
    expect(buildRecap(cwd, "missing", 3)).toBeNull();
  });

  it("builds a recap from user/assistant turns", () => {
    writeJsonl([userTurn("暗号是什么"), asstTurn("菠萝啤")]);
    const r = buildRecap(cwd, sid, 3);
    expect(r).toContain("最近对话回顾");
    expect(r).toContain("👤 暗号是什么");
    expect(r).toContain("🤖 菠萝啤");
  });

  it("filters out slash-command / local-command noise", () => {
    writeJsonl([
      userTurn("记住暗号A"),
      asstTurn("好的"),
      userTurn("<command-message>cc-lark-channel:transfer</command-message>"),
      userTurn("立即用 Bash 执行下面这条命令"),
    ]);
    const r = buildRecap(cwd, sid, 3);
    expect(r).toContain("记住暗号A");
    expect(r).not.toContain("command-message");
    expect(r).not.toContain("立即用 Bash");
  });

  it("keeps only the last N rounds", () => {
    writeJsonl([
      userTurn("第一轮"), asstTurn("回1"),
      userTurn("第二轮"), asstTurn("回2"),
      userTurn("第三轮"), asstTurn("回3"),
      userTurn("第四轮"), asstTurn("回4"),
    ]);
    const r = buildRecap(cwd, sid, 3)!;
    expect(r).not.toContain("第一轮");
    expect(r).toContain("第二轮");
    expect(r).toContain("第四轮");
  });

  it("clips overly long turns", () => {
    writeJsonl([userTurn("x".repeat(1000)), asstTurn("ok")]);
    const r = buildRecap(cwd, sid, 3, 50)!;
    expect(r).toContain("…");
    expect(r.length).toBeLessThan(400);
  });

  it("returns null when only noise present", () => {
    writeJsonl([userTurn("<command-name>/x</command-name>")]);
    expect(buildRecap(cwd, sid, 3)).toBeNull();
  });
});
