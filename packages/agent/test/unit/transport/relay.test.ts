import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";
import { RelayTransport } from "../../../src/transport/relay.ts";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger } as never;

let server: WebSocketServer | undefined;
let transport: RelayTransport | undefined;
afterEach(async () => {
  // 阻止测试结束后的自动重连
  if (transport) {
    (transport as unknown as { closed: boolean }).closed = true;
    transport["ws"]?.terminate();
  }
  for (const c of server?.clients ?? []) c.terminate();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  transport = undefined;
});

async function setup(onMessage: (sock: WsSocket, msg: Record<string, unknown>) => void) {
  server = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => server!.on("listening", () => r()));
  const sockets: WsSocket[] = [];
  server.on("connection", (sock) => {
    sockets.push(sock);
    sock.on("message", (d) => onMessage(sock, JSON.parse(d.toString())));
  });
  const port = (server.address() as AddressInfo).port;
  transport = new RelayTransport(
    { relayUrl: `ws://127.0.0.1:${port}`, openId: "ou_a", reconnectIntervalMs: 60_000, requestTimeoutMs: 5_000 },
    logger,
  );
  transport.setEvents({ onMessage: async () => {}, onCardAction: async () => {} });
  await transport.start();
  return sockets;
}

describe("RelayTransport (B12)", () => {
  it("round-trips a request", async () => {
    await setup((sock, msg) => {
      if (msg["type"] === "send_text") {
        sock.send(JSON.stringify({ type: "response", requestId: msg["requestId"], success: true, data: { messageId: "om_1" } }));
      }
    });
    await expect(transport!.sendText("oc_1", "hi")).resolves.toBe("om_1");
  });

  it("fails pending requests as soon as the connection closes", async () => {
    const sockets = await setup((sock, msg) => {
      if (msg["type"] === "send_text") sock.terminate(); // 不回响应直接断开
    });
    expect(sockets.length).toBe(1);
    const start = Date.now();
    await expect(transport!.sendText("oc_1", "hi")).rejects.toThrow("relay connection closed");
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("fails immediately while disconnected", async () => {
    const sockets = await setup(() => {});
    await new Promise<void>((r) => {
      transport!["ws"]!.once("close", () => r());
      sockets[0]!.terminate();
    });
    const start = Date.now();
    await expect(transport!.sendText("oc_1", "hi")).rejects.toThrow("relay not connected");
    expect(Date.now() - start).toBeLessThan(100);
  });
});
