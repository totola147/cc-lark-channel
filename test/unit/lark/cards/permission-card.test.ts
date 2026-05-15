import { describe, it, expect } from "vitest";
import { buildPermissionCard, buildPermissionCardResolved, buildPermissionCardTimedOut } from "../../../../src/lark/cards/permission-card.ts";

describe("buildPermissionCard", () => {
  it("builds a card with 4 buttons", () => {
    const card = buildPermissionCard({
      requestId: "req-123",
      toolName: "Bash",
      input: { command: "ls -la" },
    });

    expect(card.schema).toBe("2.0");
    expect(card.config?.update_multi).toBe(true);
    expect(card.header?.title.content).toContain("Bash");
    expect(card.header?.template).toBe("yellow");

    const elements = card.body.elements;
    const columnSets = elements.filter((e) => e.tag === "column_set");
    expect(columnSets).toHaveLength(2);

    // Check buttons carry correct values
    const allButtons: Record<string, unknown>[] = [];
    for (const cs of columnSets) {
      if (cs.tag === "column_set") {
        for (const col of cs.columns) {
          for (const el of col.elements) {
            if (el.tag === "button") allButtons.push(el.value);
          }
        }
      }
    }
    expect(allButtons).toHaveLength(4);
    expect(allButtons[0]).toEqual({ kind: "permission", request_id: "req-123", choice: "allow" });
    expect(allButtons[1]).toEqual({ kind: "permission", request_id: "req-123", choice: "deny" });
    expect(allButtons[2]).toEqual({ kind: "permission", request_id: "req-123", choice: "allow_turn" });
    expect(allButtons[3]).toEqual({ kind: "permission", request_id: "req-123", choice: "allow_session" });
  });

  it("truncates long input preview", () => {
    const longInput = { data: "x".repeat(2000) };
    const card = buildPermissionCard({
      requestId: "req-456",
      toolName: "Write",
      input: longInput,
    });

    const mdElements = card.body.elements.filter((e) => e.tag === "markdown");
    const codeBlock = mdElements.find((e) => e.tag === "markdown" && (e as { content: string }).content.includes("```json"));
    expect((codeBlock as { content: string }).content).toContain("(truncated)");
  });
});

describe("buildPermissionCardResolved", () => {
  it("shows allow icon and label", () => {
    const card = buildPermissionCardResolved({ toolName: "Bash", choice: "allow" });
    const content = (card.body.elements[0] as { content: string }).content;
    expect(content).toContain("✅");
    expect(content).toContain("Allowed (once)");
    expect(content).toContain("Bash");
  });

  it("shows deny icon and label", () => {
    const card = buildPermissionCardResolved({ toolName: "Bash", choice: "deny" });
    const content = (card.body.elements[0] as { content: string }).content;
    expect(content).toContain("❌");
    expect(content).toContain("Denied");
  });
});

describe("buildPermissionCardTimedOut", () => {
  it("shows timeout message", () => {
    const card = buildPermissionCardTimedOut({ toolName: "Edit" });
    const content = (card.body.elements[0] as { content: string }).content;
    expect(content).toContain("⏰");
    expect(content).toContain("Edit");
    expect(content).toContain("auto-denied");
  });
});
