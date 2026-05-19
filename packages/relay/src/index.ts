import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import pino from "pino";
import { TunnelManager } from "./tunnel.js";
import { LarkBot } from "./lark-bot.js";
import { Router } from "./router.js";
import type { AgentToRelay } from "@cc-lark/protocol";

const PORT = parseInt(process.env["RELAY_PORT"] ?? "9000", 10);
const LARK_APP_ID = process.env["LARK_APP_ID"] ?? "";
const LARK_APP_SECRET = process.env["LARK_APP_SECRET"] ?? "";

const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});

async function main() {
  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    logger.error("LARK_APP_ID and LARK_APP_SECRET are required");
    process.exit(1);
  }

  const tunnels = new TunnelManager(logger);
  const larkBot = new LarkBot({ appId: LARK_APP_ID, appSecret: LARK_APP_SECRET }, tunnels, logger);
  const router = new Router(larkBot, tunnels, logger);

  // HTTP server for health check
  const httpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const agents = tunnels.getAllTunnels();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", agents: agents.length }));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  // WebSocket server for agent tunnels
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    let openId: string | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    ws.on("message", (data) => {
      const raw = data.toString();

      // First message must be auth with open_id
      if (!openId) {
        try {
          const msg = JSON.parse(raw) as AgentToRelay;
          if (msg.type === "auth") {
            const id = (msg as unknown as { openId: string }).openId;
            if (!id) {
              ws.send(JSON.stringify({ type: "error", message: "openId required" }));
              ws.close();
              return;
            }
            openId = id;
            tunnels.register(openId, openId, ws);
            ws.send(JSON.stringify({ type: "connected", openId }));

            pingInterval = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "ping" }));
              }
            }, 30000);

            logger.info({ openId }, "Agent connected");
            return;
          }
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid auth message" }));
          ws.close();
          return;
        }
      }

      // Route subsequent messages
      router.handleAgentMessage(openId, raw);
    });

    ws.on("close", () => {
      if (openId) {
        tunnels.remove(openId);
        logger.info({ openId }, "Agent disconnected");
      }
      if (pingInterval) clearInterval(pingInterval);
    });

    ws.on("error", (err) => {
      logger.error({ err, openId }, "WebSocket error");
    });
  });

  // Start Lark bot
  await larkBot.start();

  // Start HTTP + WS server
  httpServer.listen(PORT, () => {
    logger.info({ port: PORT }, "Relay server started");
  });

  process.on("SIGINT", () => { process.exit(0); });
  process.on("SIGTERM", () => { process.exit(0); });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
