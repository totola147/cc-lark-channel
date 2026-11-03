import { describe, it, expect } from "vitest";
import { buildReplyCard, buildStatusCard, buildStatusLine, formatModelName, type StatusCardState } from "../../../../src/lark/cards/status-card.ts";

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

  it("marks a failed turn distinctly rather than as a green Done", () => {
    const state: StatusCardState = {
      outputText: "",
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 30_000,
      done: true,
      failure: "启动超时 30s",
    };
    const card = buildStatusCard(state);
    expect(card.header?.title.content).toBe("⚠️ 启动超时 30s");
    expect(card.header?.template).toBe("orange");
    expect(card.header?.title.content).not.toContain("Done");
  });

  it("still shows a green Done for a completed turn", () => {
    const state: StatusCardState = {
      outputText: "answer",
      inputTokens: 5,
      outputTokens: 2,
      elapsedMs: 1200,
      done: true,
    };
    const card = buildStatusCard(state);
    expect(card.header?.title.content).toBe("✅ Done");
    expect(card.header?.template).toBe("green");
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
    const footer = card.body.elements.find((e) => e.tag === "markdown" && (e as { content: string }).content.includes("tok"));
    expect((footer as { content: string }).content).toContain("in: 500");
    expect((footer as { content: string }).content).toContain("out: 200");
    // 完成后的卡片与回复卡片同款，不再带耗时
    expect((footer as { content: string }).content).not.toContain("5.0s");
  });

  it("shows model, context percentage and effort in footer", () => {
    const state: StatusCardState = {
      outputText: "done",
      inputTokens: 5000,
      outputTokens: 200,
      elapsedMs: 5000,
      done: true,
      model: "claude-sonnet-4-5",
      contextWindow: 10000,
      effort: "xhigh",
    };
    const card = buildStatusCard(state);
    const footer = card.body.elements.find((e) => e.tag === "markdown" && (e as { content: string }).content.includes("tok"));
    const content = (footer as { content: string }).content;
    expect(content).toContain("Sonnet 4.5");
    expect(content).toContain("ctx: 50%");
    expect(content).toContain("effort: xhigh");
  });

  it("omits ctx% and effort when not known", () => {
    const state: StatusCardState = {
      outputText: "done",
      inputTokens: 500,
      outputTokens: 200,
      elapsedMs: 5000,
      done: true,
    };
    const card = buildStatusCard(state);
    const footer = card.body.elements.find((e) => e.tag === "markdown" && (e as { content: string }).content.includes("tok"));
    const content = (footer as { content: string }).content;
    expect(content).not.toContain("ctx:");
    expect(content).not.toContain("effort:");
  });
});

describe("formatModelName", () => {
  it.each([
    ["claude-opus-4-5-20251101", "Opus 4.5"],
    ["claude-opus-4-1", "Opus 4.1"],
    ["claude-sonnet-4-20250514", "Sonnet 4"],
    ["claude-sonnet-4-5[1m]", "Sonnet 4.5"],
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["claude-3-haiku-20240307", "Haiku 3"],
    ["opus", "Opus"],
    ["some-custom-model", "some-custom-model"],
  ])("%s -> %s", (input, expected) => {
    expect(formatModelName(input)).toBe(expected);
  });
});

describe("buildStatusLine", () => {
  it("renders model | dir | tok | ctx | effort", () => {
    const line = buildStatusLine({
      model: "claude-opus-4-5-20251101",
      cwd: "/home/u/tmp/",
      inputTokens: 24497,
      outputTokens: 13,
      contextWindow: 200_000,
      effort: "xhigh",
    });
    expect(line).toBe("Opus 4.5 | tmp | in: 24497 out: 13 tok | ctx: 12% | effort: xhigh");
  });

  it("omits unknown fields", () => {
    expect(buildStatusLine({ inputTokens: 1, outputTokens: 2 })).toBe("in: 1 out: 2 tok");
  });
});

describe("buildReplyCard", () => {
  it("puts the status bar below a divider", () => {
    const card = buildReplyCard("hello", "Opus 4.5 | tmp");
    expect(card.header).toBeUndefined();
    expect(card.body.elements.map((e) => e.tag)).toEqual(["markdown", "hr", "markdown"]);
    expect((card.body.elements[2] as { content: string }).content).toContain("Opus 4.5 | tmp");
  });

  it("omits the status bar when not given", () => {
    const card = buildReplyCard("hello");
    expect(card.body.elements).toEqual([{ tag: "markdown", content: "hello" }]);
  });
});

describe("status card footer style", () => {
  const base: StatusCardState = {
    outputText: "answer",
    inputTokens: 24497,
    outputTokens: 13,
    elapsedMs: 3400,
    done: true,
    cwd: "/home/u/tmp",
    model: "claude-opus-4-5-20251101",
    contextWindow: 200_000,
    effort: "xhigh",
    toolCount: 2,
  };
  const footers = (s: StatusCardState) => {
    const els = buildStatusCard(s).body.elements;
    const hr = els.findIndex((e) => e.tag === "hr");
    return els.slice(hr + 1) as { tag: string; content: string }[];
  };

  it("done card has exactly one footer line, same as the reply card, no 📂 line", () => {
    const f = footers(base);
    expect(f).toHaveLength(1);
    expect(f[0]!.content).toBe('<font color="grey">Opus 4.5 | tmp | in: 24497 out: 13 tok | ctx: 12% | effort: xhigh</font>');
    expect(f[0]!.content).not.toContain("📂");
  });

  it("generating card stays single-line with elapsed and tool count appended", () => {
    const f = footers({ ...base, done: false });
    expect(f).toHaveLength(1);
    expect(f[0]!.content).toContain("effort: xhigh | 3.4s | tools: 2");
  });
});

