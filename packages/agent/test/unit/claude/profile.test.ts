import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { resolveProfile, buildEnv, ProfileError } from "../../../src/claude/profile.ts";
import { loadConfig } from "../../../src/config.ts";

const cfg = {
  profiles: {
    fermi: {
      base_url: "http://10.0.0.1:80",
      auth_token_env: "FERMI_TOKEN",
      settings: "~/.claude/settings.fermi.json",
      cli_path: "/opt/claude",
      env: { EXTRA: "1" },
    },
    keyed: { api_key_env: "K" },
  },
};

describe("resolveProfile", () => {
  it("returns undefined without a name", () => {
    expect(resolveProfile(undefined, cfg, {})).toBeUndefined();
  });

  it("maps base_url / token / settings and drops the API key", () => {
    const r = resolveProfile("fermi", cfg, { FERMI_TOKEN: "tok" })!;
    expect(r.env).toEqual({
      EXTRA: "1",
      ANTHROPIC_BASE_URL: "http://10.0.0.1:80",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_API_KEY: undefined,
    });
    expect(r.settings).toBe(join(homedir(), ".claude/settings.fermi.json"));
    expect(r.cliPath).toBe("/opt/claude");
  });

  it("api_key_env sets the key and drops the auth token", () => {
    const r = resolveProfile("keyed", cfg, { K: "sk" })!;
    expect(r.env).toEqual({ ANTHROPIC_API_KEY: "sk", ANTHROPIC_AUTH_TOKEN: undefined });
  });

  it("throws for an unknown profile, listing known ones", () => {
    expect(() => resolveProfile("nope", cfg, {})).toThrow(ProfileError);
    expect(() => resolveProfile("nope", cfg, {})).toThrow(/fermi, keyed/);
  });

  it("throws when the referenced env var is missing, without falling back", () => {
    expect(() => resolveProfile("fermi", cfg, {})).toThrow(/FERMI_TOKEN/);
  });
});

describe("buildEnv", () => {
  it("merges overrides and deletes undefined keys", () => {
    const env = buildEnv({ A: "1", ANTHROPIC_API_KEY: "old", U: undefined }, { ANTHROPIC_API_KEY: undefined, B: "2" });
    expect(env).toEqual({ A: "1", B: "2" });
  });
});

describe("config [profiles]", () => {
  it("parses profiles from TOML and rejects unknown keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clc-profile-"));
    try {
      const ok = join(dir, "ok.toml");
      writeFileSync(ok, `[profiles.fermi]\nbase_url = "http://10.0.0.1:80"\nauth_token_env = "FERMI_TOKEN"\n`);
      const c = await loadConfig(ok);
      expect(c.profiles["fermi"]).toEqual({ base_url: "http://10.0.0.1:80", auth_token_env: "FERMI_TOKEN" });

      const bad = join(dir, "bad.toml");
      writeFileSync(bad, `[profiles.fermi]\nauth_token = "secret-in-config"\n`);
      await expect(loadConfig(bad)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to no profiles", async () => {
    const c = await loadConfig(join(tmpdir(), "does-not-exist-clc.toml"));
    expect(c.profiles).toEqual({});
  });
});
