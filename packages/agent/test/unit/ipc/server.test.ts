import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { IpcServer, type TransferRequest } from "../../../src/ipc/server.ts";

const logger = pino({ level: "silent" });

/** Open a client connection; collect parsed messages; expose a sender. */
function client(sockPath: string) {
  const sock: Socket = connect(sockPath);
  const messages: any[] = [];
  let buf = "";
  const waiters: Array<(m: any) => void> = [];
  sock.setEncoding("utf-8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else messages.push(msg);
    }
  });
  return {
    sock,
    send: (obj: unknown) => sock.write(JSON.stringify(obj) + "\n"),
    next: () =>
      new Promise<any>((resolve) => {
        if (messages.length) resolve(messages.shift());
        else waiters.push(resolve);
      }),
    close: () => sock.destroy(),
  };
}

describe("IpcServer", () => {
  let dir: string;
  let sockPath: string;
  let server: IpcServer;
  let transfers: TransferRequest[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "clc-ipc-"));
    sockPath = join(dir, "agent.sock");
    transfers = [];
    server = new IpcServer(
      {
        onTransfer: async (req) => {
          transfers.push(req);
          if (req.sessionId === "boom") throw new Error("rejected by handler");
          return { chatId: "chat-for-" + req.sessionId, message: "ok" };
        },
      },
      logger,
      sockPath,
    );
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("acknowledges register", async () => {
    const c = client(sockPath);
    c.send({ type: "register", sessionId: "s1", cwd: "/p", wrapperPid: 1 });
    const resp = await c.next();
    expect(resp).toEqual({ type: "ok", message: "registered" });
    c.close();
  });

  it("handles transfer and returns chatId", async () => {
    const c = client(sockPath);
    c.send({ type: "transfer", sessionId: "s2", cwd: "/proj", hasWrapper: false });
    const resp = await c.next();
    expect(resp.type).toBe("ok");
    expect(resp.chatId).toBe("chat-for-s2");
    expect(transfers[0]).toMatchObject({ sessionId: "s2", cwd: "/proj", hasWrapper: false });
    c.close();
  });

  it("returns error when handler throws", async () => {
    const c = client(sockPath);
    c.send({ type: "transfer", sessionId: "boom", cwd: "/x", hasWrapper: true });
    const resp = await c.next();
    expect(resp).toEqual({ type: "error", message: "rejected by handler" });
    c.close();
  });

  it("pushResume delivers to a registered wrapper", async () => {
    const c = client(sockPath);
    c.send({ type: "register", sessionId: "s3", cwd: "/p", wrapperPid: 2 });
    await c.next(); // ok
    expect(server.hasWrapper("s3")).toBe(true);
    const delivered = server.pushResume("s3");
    expect(delivered).toBe(true);
    const resume = await c.next();
    expect(resume).toEqual({ type: "resume", sessionId: "s3" });
    c.close();
  });

  it("pushResume sends the forked resumeId while looking up by registered id", async () => {
    const c = client(sockPath);
    // wrapper registered with the original transfer id
    c.send({ type: "register", sessionId: "orig", cwd: "/p", wrapperPid: 9 });
    await c.next(); // ok
    // SDK forked a new id during Feishu turns; hand back should resume the new one
    const delivered = server.pushResume("orig", "forked-id");
    expect(delivered).toBe(true);
    const resume = await c.next();
    expect(resume).toEqual({ type: "resume", sessionId: "forked-id" });
    c.close();
  });

  it("pushResume returns false when no wrapper registered", () => {
    expect(server.pushResume("nope")).toBe(false);
    expect(server.hasWrapper("nope")).toBe(false);
  });

  it("drops wrapper registration on disconnect", async () => {
    const c = client(sockPath);
    c.send({ type: "register", sessionId: "s4", cwd: "/p", wrapperPid: 3 });
    await c.next();
    expect(server.hasWrapper("s4")).toBe(true);
    c.close();
    // allow close event to propagate
    await new Promise((r) => setTimeout(r, 50));
    expect(server.hasWrapper("s4")).toBe(false);
  });
});
