import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePermissionMode } from "../../src/types.ts";
import { loadConfig } from "../../src/config.ts";

describe("normalizePermissionMode", () => {
  it("accepts every SDK mode", () => {
    for (const m of ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]) {
      expect(normalizePermissionMode(m)).toBe(m);
    }
  });
  it("maps the CLI alias manual to default", () => {
    expect(normalizePermissionMode("manual")).toBe("default");
  });
  it("rejects unknown values", () => {
    expect(normalizePermissionMode("yolo")).toBeUndefined();
    expect(normalizePermissionMode("")).toBeUndefined();
    expect(normalizePermissionMode(undefined)).toBeUndefined();
  });
});

describe("config permission_mode", () => {
  it("normalizes manual and accepts plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clc-cfg-"));
    // v1 的 lark.app_id/app_secret 是必填项
    const lark = `[lark]\napp_id = "a"\napp_secret = "b"\n`;
    try {
      const p = join(dir, "c.toml");
      writeFileSync(p, `${lark}[claude]\npermission_mode = "manual"\n`);
      expect((await loadConfig(p)).claude.permission_mode).toBe("default");
      writeFileSync(p, `${lark}[claude]\npermission_mode = "plan"\n`);
      expect((await loadConfig(p)).claude.permission_mode).toBe("plan");
      writeFileSync(p, `${lark}[claude]\npermission_mode = "yolo"\n`);
      await expect(loadConfig(p)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
