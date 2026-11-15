import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
let script: unknown[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return (async function* () {
      for (const m of script) {
        if (m === "WAIT") { await new Promise((r) => setTimeout(r, 50)); continue; }
        yield m;
      }
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

  it("keeps the input stream open while background tasks run, closes after they finish", async () => {
    script = [
      { type: "system", subtype: "task_started", task_id: "a1" },
      { type: "result", usage: {} },
      "WAIT",
      { type: "system", subtype: "task_notification", task_id: "a1", status: "completed" },
      { type: "result", usage: {} },
    ];
    const h = createQuery(base, "c1", broker, logger);
    const prompt = calls[0]!.prompt as AsyncIterable<unknown>;
    const it = prompt[Symbol.asyncIterator]();
    await it.next(); // 用户消息
    let closed = false;
    void it.next().then(() => { closed = true; });
    const run = collect(h.events);
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false); // result 已到但后台任务未结束
    await run;
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(true);
  });

  it("closes the input stream right after result when no background task", async () => {
    script = [{ type: "result", usage: {} }];
    const h = createQuery(base, "c1", broker, logger);
    const it = (calls[0]!.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    await it.next();
    const second = it.next();
    await collect(h.events);
    expect((await second).done).toBe(true);
  });

  it("counts cached prompt tokens in input and context size", async () => {
    script = [
      { type: "assistant", message: { content: [], usage: { input_tokens: 1, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500 } } },
      { type: "assistant", parent_tool_use_id: "sub", message: { content: [], usage: { input_tokens: 1, cache_read_input_tokens: 999999 } } },
      { type: "assistant", message: { content: [], usage: { input_tokens: 2, cache_read_input_tokens: 21000, cache_creation_input_tokens: 300 } } },
      { type: "result", usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 41000, cache_creation_input_tokens: 800 } },
    ];
    const events = (await collect(createQuery(base, "c1", broker, logger).events)) as Array<Record<string, unknown>>;
    const end = events.find((e) => e.type === "turn_end")!;
    expect(end.inputTokens).toBe(41803);
    expect(end.contextTokens).toBe(21302);
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
