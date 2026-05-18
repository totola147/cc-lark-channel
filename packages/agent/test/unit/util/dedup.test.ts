import { describe, it, expect } from "vitest";
import { LruDedup } from "../../../src/util/dedup.ts";

describe("LruDedup", () => {
  it("returns false on first check", () => {
    const dedup = new LruDedup();
    expect(dedup.check("a")).toBe(false);
  });

  it("returns true on duplicate check", () => {
    const dedup = new LruDedup();
    dedup.check("a");
    expect(dedup.check("a")).toBe(true);
  });

  it("evicts oldest entry when max size reached", () => {
    const dedup = new LruDedup(3);
    dedup.check("a");
    dedup.check("b");
    dedup.check("c");
    dedup.check("d"); // evicts "a"
    expect(dedup.check("b")).toBe(true); // "b" still present
    expect(dedup.check("a")).toBe(false); // "a" was evicted
  });

  it("handles empty string keys", () => {
    const dedup = new LruDedup();
    expect(dedup.check("")).toBe(false);
    expect(dedup.check("")).toBe(true);
  });
});
