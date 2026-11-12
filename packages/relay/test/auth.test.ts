import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../src/auth-store.js";
import { DeviceCodeManager } from "../src/device-code.js";
import { authenticateAgent } from "../src/ws-auth.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger } as never;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "relay-auth-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("AuthStore", () => {
  it("verifies a token only for the openId it was issued to", () => {
    const store = new AuthStore(null, logger);
    const t = store.issue("ou_alice");
    expect(store.verify("ou_alice", t)).toBe(true);
    expect(store.verify("ou_bob", t)).toBe(false);
    expect(store.verify("ou_alice", "deadbeef")).toBe(false);
    expect(store.verify("ou_alice", undefined)).toBe(false);
  });

  it("persists hashed tokens with 0600 perms and reloads them", () => {
    const file = join(tmp(), "auth.json");
    const a = new AuthStore(file, logger);
    const t = a.issue("ou_alice");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, "utf-8");
    expect(raw).not.toContain(t); // plaintext never stored
    const b = new AuthStore(file, logger);
    expect(b.verify("ou_alice", t)).toBe(true);
  });

  it("revokeAll removes every token for an openId", () => {
    const store = new AuthStore(null, logger);
    const t1 = store.issue("ou_alice");
    const t2 = store.issue("ou_alice");
    const t3 = store.issue("ou_bob");
    expect(store.revokeAll("ou_alice")).toBe(2);
    expect(store.verify("ou_alice", t1)).toBe(false);
    expect(store.verify("ou_alice", t2)).toBe(false);
    expect(store.verify("ou_bob", t3)).toBe(true);
  });
});

describe("authenticateAgent", () => {
  it("rejects an auth message that only knows the openId", () => {
    const store = new AuthStore(null, logger);
    store.issue("ou_victim");
    const d = authenticateAgent({ type: "auth", openId: "ou_victim" }, store, { allowLegacy: false });
    expect(d.ok).toBe(false);
  });

  it("rejects a token issued to someone else", () => {
    const store = new AuthStore(null, logger);
    const attackerToken = store.issue("ou_attacker");
    const d = authenticateAgent({ type: "auth", openId: "ou_victim", token: attackerToken }, store, { allowLegacy: false });
    expect(d.ok).toBe(false);
  });

  it("accepts a matching token and sanitizes agentId", () => {
    const store = new AuthStore(null, logger);
    const t = store.issue("ou_alice");
    const ok = authenticateAgent({ type: "auth", openId: "ou_alice", token: t, agentId: "abc-123" }, store, { allowLegacy: false });
    expect(ok).toEqual({ ok: true, openId: "ou_alice", agentId: "abc-123", legacy: false });
    const bad = authenticateAgent({ type: "auth", openId: "ou_alice", token: t, agentId: "x\ny" }, store, { allowLegacy: false });
    expect(bad.ok && bad.agentId).toBe("ou_alice");
  });

  it("legacy mode allows tokenless agents but still rejects wrong tokens", () => {
    const store = new AuthStore(null, logger);
    expect(authenticateAgent({ type: "auth", openId: "ou_a" }, store, { allowLegacy: true }).ok).toBe(true);
    expect(authenticateAgent({ type: "auth", openId: "ou_a", token: "nope" }, store, { allowLegacy: true }).ok).toBe(false);
  });

  it("requires a string openId", () => {
    const store = new AuthStore(null, logger);
    expect(authenticateAgent({ type: "auth", openId: 42 }, store, { allowLegacy: true }).ok).toBe(false);
  });
});

describe("DeviceCodeManager", () => {
  it("binds only via a server-side OAuth session, single use", () => {
    const m = new DeviceCodeManager(logger);
    const rec = m.create();
    expect(m.bindWithOAuthSession(rec.code, "forged-session")).toBe(false);
    const sid = m.createOAuthSession("ou_alice");
    expect(m.bindWithOAuthSession(rec.code.toLowerCase(), sid)).toBe(true);
    expect(m.get(rec.code)?.openId).toBe("ou_alice");
    // session consumed; a second code cannot reuse it
    const rec2 = m.create();
    expect(m.bindWithOAuthSession(rec2.code, sid)).toBe(false);
    m.dispose();
  });

  it("does not let a bound code be re-bound to another user", () => {
    const m = new DeviceCodeManager(logger);
    const rec = m.create();
    m.bindWithOAuthSession(rec.code, m.createOAuthSession("ou_alice"));
    expect(m.bindWithOAuthSession(rec.code, m.createOAuthSession("ou_mallory"))).toBe(false);
    expect(m.get(rec.code)?.openId).toBe("ou_alice");
    m.dispose();
  });

  it("only the poller holding pollSecret can read the record", () => {
    const m = new DeviceCodeManager(logger);
    const rec = m.create();
    expect(m.getForPoller(rec.code, null)).toBeUndefined();
    expect(m.getForPoller(rec.code, "wrong")).toBeUndefined();
    expect(m.getForPoller(rec.code, rec.pollSecret)?.code).toBe(rec.code);
    m.consume(rec.code);
    expect(m.getForPoller(rec.code, rec.pollSecret)).toBeUndefined();
    m.dispose();
  });

  it("generates codes from the unambiguous alphabet", () => {
    const m = new DeviceCodeManager(logger);
    for (let i = 0; i < 50; i++) expect(m.create().code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    m.dispose();
  });
});
