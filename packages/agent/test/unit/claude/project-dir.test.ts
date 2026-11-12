import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir, resolveProjectDir, locateSession, readCwdFromJsonl } from "../../../src/claude/project-dir.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "projdir-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("encodeProjectDir (A4)", () => {
  it("replaces every non-alphanumeric character like the CLI", () => {
    expect(encodeProjectDir("/datastorage/projects/Q3_plan")).toBe("-datastorage-projects-Q3-plan");
    expect(encodeProjectDir("/home/u/my.app v2")).toBe("-home-u-my-app-v2");
    expect(encodeProjectDir("/a/b-c")).toBe("-a-b-c");
  });

  it("truncates long paths to 200 chars plus a base36 hash, matching the CLI", () => {
    const long = "/" + "x".repeat(250);
    const enc = encodeProjectDir(long);
    expect(enc.startsWith("-" + "x".repeat(199) + "-")).toBe(true);
    // CLI: Math.abs(h).toString(36) with h = (h<<5)-h+c |0
    let h = 0;
    for (let i = 0; i < long.length; i++) h = ((h << 5) - h + long.charCodeAt(i)) | 0;
    expect(enc).toBe(`${"-" + "x".repeat(199)}-${Math.abs(h).toString(36)}`);
  });
});

describe("resolveProjectDir / locateSession", () => {
  it("falls back to the 200-char prefix when the hash suffix differs", () => {
    const root = tmp();
    const long = "/" + "y".repeat(250);
    const dir = join(root, "-" + "y".repeat(199) + "-otherhash");
    mkdirSync(dir);
    expect(resolveProjectDir(long, root)).toBe(dir);
  });

  it("reads the real cwd from jsonl instead of decoding the dir name", () => {
    const root = tmp();
    const cwd = "/srv/my-app/sub_dir";
    const dir = join(root, encodeProjectDir(cwd));
    mkdirSync(dir);
    const sid = "0e3c1d2a-aaaa-bbbb-cccc-123456789abc";
    writeFileSync(join(dir, `${sid}.jsonl`), [
      JSON.stringify({ type: "summary", summary: "x" }),
      JSON.stringify({ type: "user", cwd, message: { content: "hi" } }),
    ].join("\n"));
    expect(locateSession(sid, root)).toEqual({ file: join(dir, `${sid}.jsonl`), cwd });
    expect(locateSession("../etc", root)).toBeUndefined();
  });

  it("readCwdFromJsonl tolerates garbage lines", () => {
    const f = join(tmp(), "s.jsonl");
    writeFileSync(f, 'not json "cwd"\n{"cwd":"/ok"}\n');
    expect(readCwdFromJsonl(f)).toBe("/ok");
  });
});
