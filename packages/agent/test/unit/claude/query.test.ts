import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
let script: unknown[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return (async function* () {
      for (const m of script) yield m;
    })();
  },
}));

import { createQuery } from "../../../src/claude/query.ts";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger } as never;
const broker = { requestPermission: vi.fn(async () => true), askQuestions: vi.fn(async () => null) };
const base = { prompt: "hi", cwd: "/tmp", model: "", permissionMode: "default" as const, cliPath: "claude" };

async function collect(it: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
}

beforeEach(() => {
  calls.length = 0;
  script = [];
});

describe("createQuery", () => {
  it("emits tool_result from user messages (B9)", async () => {
    script = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "boom" }] }] },
      },
      { type: "result", usage: { input_tokens: 1, output_tokens: 2 }, session_id: "s1" },
    ];
    const h = createQuery(base, "c1", broker, logger);
    const events = await collect(h.events);
    expect(events).toContainEqual({ type: "tool_result", toolUseId: "t1", isError: true, text: "boom" });
    expect(h.events.sessionId).toBe("s1");
  });

  it("passes the image media type through (B10)", async () => {
    script = [{ type: "result", usage: {} }];
    const h = createQuery({ ...base, imageDataUris: ["data:image/jpeg;base64,AAAA"] }, "c1", broker, logger);
    await collect(h.events);
    const prompt = calls[0]!.prompt as AsyncIterable<{ message: { content: Array<Record<string, unknown>> } }>;
    const msgs = await collect(prompt);
    const img = (msgs[0] as { message: { content: Array<{ type: string; source?: { media_type: string } }> } }).message.content.find(
      (c) => c.type === "image",
    );
    expect(img?.source?.media_type).toBe("image/jpeg");
  });

  it("requests summarized thinking only when asked (A2)", async () => {
    script = [{ type: "result", usage: {} }];
    await collect(createQuery({ ...base, thinkingDisplay: "summarized" }, "c1", broker, logger).events);
    await collect(createQuery(base, "c1", broker, logger).events);
    expect(calls[0]!.options["extraArgs"]).toEqual({ "thinking-display": "summarized" });
    expect(calls[1]!.options["extraArgs"]).toBeUndefined();
  });

  it("maps bypassPermissions to default and passes other modes through (A3)", async () => {
    script = [{ type: "result", usage: {} }];
    await collect(createQuery({ ...base, permissionMode: "bypassPermissions" }, "c1", broker, logger).events);
    await collect(createQuery({ ...base, permissionMode: "plan" }, "c1", broker, logger).events);
    expect(calls[0]!.options["permissionMode"]).toBe("default");
    expect(calls[1]!.options["permissionMode"]).toBe("plan");
  });

  it("passes profile env and settings to the SDK", async () => {
    script = [{ type: "result", usage: {} }];
    process.env["CLC_TEST_DROP_ME"] = "x";
    try {
      await collect(createQuery(
        { ...base, envOverrides: { ANTHROPIC_BASE_URL: "http://gw", CLC_TEST_DROP_ME: undefined }, settings: "/s.json" },
        "c1", broker, logger,
      ).events);
    } finally {
      delete process.env["CLC_TEST_DROP_ME"];
    }
    const env = calls[0]!.options["env"] as Record<string, string>;
    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://gw");
    expect("CLC_TEST_DROP_ME" in env).toBe(false);
    expect(calls[0]!.options["settings"]).toBe("/s.json");
  });
});
