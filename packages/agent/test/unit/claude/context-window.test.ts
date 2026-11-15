import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveContextWindow } from "../../../src/claude/context-window.ts";

function home(settings?: object) {
  const h = mkdtempSync(join(tmpdir(), "cw-"));
  if (settings) {
    mkdirSync(join(h, ".claude"));
    writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify(settings));
  }
  return h;
}

describe("effectiveContextWindow", () => {
  it("uses autoCompactWindow when smaller than native", () => {
    expect(effectiveContextWindow(1_000_000, undefined, home({ autoCompactWindow: 190000 }))).toBe(190000);
  });
  it("keeps native window when autoCompactWindow is larger", () => {
    expect(effectiveContextWindow(200000, undefined, home({ autoCompactWindow: 500000 }))).toBe(200000);
  });
  it("falls back to native when unset or file missing", () => {
    expect(effectiveContextWindow(1_000_000, undefined, home({}))).toBe(1_000_000);
    expect(effectiveContextWindow(1_000_000, undefined, home())).toBe(1_000_000);
  });
  it("--settings file overrides the user settings", () => {
    const h = home({ autoCompactWindow: 190000 });
    const f = join(h, "s.json");
    writeFileSync(f, JSON.stringify({ autoCompactWindow: 100000 }));
    expect(effectiveContextWindow(1_000_000, f, h)).toBe(100000);
  });
});
