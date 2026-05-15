import { describe, it, expect } from "vitest";
import { createDeferred } from "../../../src/util/deferred.ts";

describe("createDeferred", () => {
  it("resolves with value", async () => {
    const d = createDeferred<number>();
    d.resolve(42);
    expect(await d.promise).toBe(42);
  });

  it("rejects with error", async () => {
    const d = createDeferred<string>();
    d.reject(new Error("fail"));
    await expect(d.promise).rejects.toThrow("fail");
  });

  it("only first resolve takes effect", async () => {
    const d = createDeferred<string>();
    d.resolve("first");
    d.resolve("second");
    expect(await d.promise).toBe("first");
  });
});
