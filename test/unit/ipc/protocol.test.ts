import { describe, it, expect } from "vitest";
import { encode, decodeLines, ipcSocketPath } from "../../../src/ipc/protocol.ts";

describe("ipc protocol", () => {
  it("encode appends a newline and round-trips", () => {
    const msg = { type: "register" as const, sessionId: "s1", cwd: "/p", wrapperPid: 42 };
    const line = encode(msg);
    expect(line.endsWith("\n")).toBe(true);
    const [msgs, rest] = decodeLines(line);
    expect(rest).toBe("");
    expect(msgs).toEqual([msg]);
  });

  it("decodeLines splits multiple messages and keeps the remainder", () => {
    const buf =
      encode({ type: "ok" }) +
      encode({ type: "error", message: "boom" }) +
      '{"type":"ok","partial":';
    const [msgs, rest] = decodeLines(buf);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ type: "ok" });
    expect(msgs[1]).toEqual({ type: "error", message: "boom" });
    expect(rest).toBe('{"type":"ok","partial":');
  });

  it("decodeLines skips malformed lines", () => {
    const buf = "not-json\n" + encode({ type: "ok", message: "good" });
    const [msgs] = decodeLines(buf);
    expect(msgs).toEqual([{ type: "ok", message: "good" }]);
  });

  it("decodeLines returns empty on blank input", () => {
    expect(decodeLines("")).toEqual([[], ""]);
    expect(decodeLines("\n\n")).toEqual([[], ""]);
  });

  it("ipcSocketPath honours CC_LARK_IPC_SOCK override", () => {
    const prev = process.env["CC_LARK_IPC_SOCK"];
    process.env["CC_LARK_IPC_SOCK"] = "/tmp/custom.sock";
    expect(ipcSocketPath()).toBe("/tmp/custom.sock");
    if (prev === undefined) delete process.env["CC_LARK_IPC_SOCK"];
    else process.env["CC_LARK_IPC_SOCK"] = prev;
  });
});
