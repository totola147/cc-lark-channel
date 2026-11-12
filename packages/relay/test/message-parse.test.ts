import { describe, it, expect } from "vitest";
import { parseMessageContent, RecentIds } from "../src/lark-bot.js";

describe("parseMessageContent (B11)", () => {
  it("parses text and image", () => {
    expect(parseMessageContent("text", JSON.stringify({ text: " hi " }))).toEqual({ text: "hi", imageKeys: [] });
    expect(parseMessageContent("image", JSON.stringify({ image_key: "img_1" }))).toEqual({ text: "", imageKeys: ["img_1"] });
  });

  it("parses post with text, links and images", () => {
    const post = {
      title: "",
      content: [
        [{ tag: "text", text: "看下" }, { tag: "a", text: "这个", href: "https://x" }],
        [{ tag: "img", image_key: "img_2" }],
        [{ tag: "text", text: "第二行" }],
      ],
    };
    expect(parseMessageContent("post", JSON.stringify(post))).toEqual({ text: "看下这个\n\n第二行", imageKeys: ["img_2"] });
  });

  it("parses locale-wrapped post", () => {
    const post = { zh_cn: { title: "标题", content: [[{ tag: "text", text: "正文" }]] } };
    expect(parseMessageContent("post", JSON.stringify(post))).toEqual({ text: "标题\n正文", imageKeys: [] });
  });

  it("falls back to raw content on bad JSON", () => {
    expect(parseMessageContent("text", "not json")).toEqual({ text: "not json", imageKeys: [] });
  });
});

describe("RecentIds", () => {
  it("flags duplicates and evicts the oldest", () => {
    const r = new RecentIds(2);
    expect(r.seenBefore("a")).toBe(false);
    expect(r.seenBefore("a")).toBe(true);
    r.seenBefore("b");
    r.seenBefore("c"); // evicts a
    expect(r.seenBefore("a")).toBe(false);
  });
});
