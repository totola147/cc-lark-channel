import { describe, it, expect } from "vitest";
import { buildStatusCard, type StatusCardState } from "../../../../src/lark/cards/status-card.ts";

describe("buildStatusCard", () => {
  it("shows processing state when empty", () => {
    const state: StatusCardState = {
      outputText: "",
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 0,
      done: false,
    };
    const card = buildStatusCard(state);
    expect(card.header?.title.content).toBe("🤖 Generating...");
    expect(card.header?.template).toBe("blue");
    const md = card.body.elements.find((e) => e.tag === "markdown" && (e as { content: string }).content.includes("Processing"));
    expect(md).toBeDefined();
  });

  it("shows thinking block", () => {
    const state: StatusCardState = {
      thinking: "Let me analyze this...",
      outputText: "",
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 1000,
      done: false,
    };
    const card = buildStatusCard(state);
    const md = card.body.elements.find((e) => e.tag === "markdown" && (e as { content: string }).content.includes("Thinking"));
    expect(md).toBeDefined();
    expect((md as { content: string }).content).toContain("Let me analyze");
  });

  it("shows tool use", () => {
    const state: StatusCardState = {
      currentTool: { name: "Bash", input: { command: "ls" } },
      outputText: "",
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 2000,
      done: false,
    };
    const card = buildStatusCard(state);
    const md = card.body.elements.find((e) => e.tag === "markdown" && (e as { content: string }).content.includes("Bash"));
    expect(md).toBeDefined();
  });

  it("shows done state", () => {
    const state: StatusCardState = {
      outputText: "Hello world",
      inputTokens: 100,
      outputTokens: 50,
      elapsedMs: 3000,
      done: true,
    };
    const card = buildStatusCard(state);
    expect(card.header?.title.content).toBe("✅ Done");
    expect(card.header?.template).toBe("green");
  });

  it("truncates long output", () => {
    const state: StatusCardState = {
      outputText: "x".repeat(3000),
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 1000,
      done: false,
    };
    const card = buildStatusCard(state);
    const md = card.body.elements.find((e) => e.tag === "markdown" && (e as { content: string }).content.includes("Output"));
    expect((md as { content: string }).content).toContain("...");
  });

  it("shows token stats in footer", () => {
    const state: StatusCardState = {
      outputText: "done",
      inputTokens: 500,
      outputTokens: 200,
      elapsedMs: 5000,
      done: true,
    };
    const card = buildStatusCard(state);
    const footer = card.body.elements.find((e) => e.tag === "markdown" && (e as { content: string }).content.includes("Tokens"));
    expect((footer as { content: string }).content).toContain("500 in");
    expect((footer as { content: string }).content).toContain("200 out");
    expect((footer as { content: string }).content).toContain("5.0s");
  });
});
