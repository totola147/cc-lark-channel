import { describe, it, expect } from "vitest";
import { detectImageMime, parseImageDataUri } from "../../../src/util/image-mime.ts";

describe("detectImageMime (B10)", () => {
  it("detects common formats by magic bytes", () => {
    expect(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImageMime(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(detectImageMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))).toBe("image/webp");
  });
  it("returns undefined for unknown data", () => {
    expect(detectImageMime(Buffer.from("hello world!"))).toBeUndefined();
    expect(detectImageMime(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("parseImageDataUri", () => {
  it("keeps the declared media type", () => {
    expect(parseImageDataUri("data:image/jpeg;base64,AAAA")).toEqual({ mediaType: "image/jpeg", data: "AAAA" });
  });
  it("defaults to png without a prefix", () => {
    expect(parseImageDataUri("AAAA")).toEqual({ mediaType: "image/png", data: "AAAA" });
  });
});
