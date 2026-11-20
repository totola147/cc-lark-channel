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
const broker = { requestPermission: vi.fn(async () => true), askQuestions: vi.fn(async () => null) } as never;
const base = { prompt: "hi", cwd: "/tmp", model: "", permissionMode: "default" as const, cliPath: "claude" };

type CanUseTool = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

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
  it("emits tool_result from user messages", async () => {
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

  it("passes the image media type through", async () => {
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

  it("emits init and records the session id before result", async () => {
    script = [{ type: "system", subtype: "init", session_id: "s-init", model: "m1" }];
    const h = createQuery(base, "c1", broker, logger);
    const events = await collect(h.events);
    expect(events[0]).toEqual({ type: "init", model: "m1" });
    expect(h.events.sessionId).toBe("s-init");
  });

  it("does not emit turn_end for an interrupted turn", async () => {
    script = [{ type: "system", subtype: "init", session_id: "s1" }, "WAIT", { type: "result", usage: {} }];
    const h = createQuery(base, "c1", broker, logger);
    const run = collect(h.events);
    await new Promise((r) => setTimeout(r, 10));
    await h.interrupt();
    const events = (await run) as Array<{ type: string }>;
    expect(events.some((e) => e.type === "turn_end")).toBe(false);
    expect(h.events.sessionId).toBe("s1");
  });

  it("requests summarized thinking only when asked", async () => {
    script = [{ type: "result", usage: {} }];
    await collect(createQuery({ ...base, thinkingDisplay: "summarized" }, "c1", broker, logger).events);
    await collect(createQuery(base, "c1", broker, logger).events);
    expect(calls[0]!.options["extraArgs"]).toEqual({ "thinking-display": "summarized" });
    expect(calls[1]!.options["extraArgs"]).toBeUndefined();
  });

  it("maps bypassPermissions to default and passes other modes through", async () => {
    script = [{ type: "result", usage: {} }];
    await collect(createQuery({ ...base, permissionMode: "bypassPermissions" }, "c1", broker, logger).events);
    await collect(createQuery({ ...base, permissionMode: "plan" }, "c1", broker, logger).events);
    expect(calls[0]!.options["permissionMode"]).toBe("default");
    expect(calls[1]!.options["permissionMode"]).toBe("plan");
  });

  it("always includes updatedInput in allow responses", async () => {
    script = [{ type: "result", usage: {} }];
    await collect(createQuery(base, "c1", broker, logger).events);
    await collect(createQuery({ ...base, permissionMode: "bypassPermissions" }, "c1", broker, logger).events);
    const input = { command: "ls" };
    for (const c of calls) {
      const canUseTool = c.options["canUseTool"] as CanUseTool;
      expect(await canUseTool("Bash", input)).toEqual({ behavior: "allow", updatedInput: input });
      // 格式不对的 AskUserQuestion 原样放行，同样要带 updatedInput
      expect(await canUseTool("AskUserQuestion", { questions: "bad" })).toEqual({
        behavior: "allow",
        updatedInput: { questions: "bad" },
      });
    }
  });

  it("auto-allows ordinary tools in bypass mode without asking", async () => {
    script = [{ type: "result", usage: {} }];
    const b = { requestPermission: vi.fn(async () => false), askQuestions: vi.fn(async () => null) };
    await collect(createQuery({ ...base, permissionMode: "bypassPermissions" }, "c1", b as never, logger).events);
    const canUseTool = calls[0]!.options["canUseTool"] as CanUseTool;
    expect((await canUseTool("Bash", {})).behavior).toBe("allow");
    expect(b.requestPermission).not.toHaveBeenCalled();
  });
});
