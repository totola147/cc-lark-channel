import { describe, it, expect } from "vitest";
import { extractCardActionIds, type CardActionEvent } from "../src/lark-bot.js";

const base: CardActionEvent = {
  operator: { open_id: "ou_1" },
  action: { value: { kind: "question_option" } },
};

describe("extractCardActionIds", () => {
  it("reads ids from context (v2 card.action.trigger shape)", () => {
    const ev: CardActionEvent = {
      ...base,
      context: { open_message_id: "om_ctx", open_chat_id: "oc_ctx" },
    };
    expect(extractCardActionIds(ev)).toEqual({
      messageId: "om_ctx",
      chatId: "oc_ctx",
    });
  });

  it("falls back to root-level ids when context is absent", () => {
    const ev: CardActionEvent = {
      ...base,
      open_message_id: "om_root",
      open_chat_id: "oc_root",
    };
    expect(extractCardActionIds(ev)).toEqual({
      messageId: "om_root",
      chatId: "oc_root",
    });
  });

  it("prefers context over root when both present", () => {
    const ev: CardActionEvent = {
      ...base,
      context: { open_message_id: "om_ctx", open_chat_id: "oc_ctx" },
      open_message_id: "om_root",
      open_chat_id: "oc_root",
    };
    expect(extractCardActionIds(ev)).toEqual({
      messageId: "om_ctx",
      chatId: "oc_ctx",
    });
  });

  it("defaults to empty strings when ids are missing (regression: empty messageId broke multi-select redraws)", () => {
    expect(extractCardActionIds(base)).toEqual({ messageId: "", chatId: "" });
  });
});
