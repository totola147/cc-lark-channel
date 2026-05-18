import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import pino from "pino";
import { TunnelManager } from "./tunnel.js";
import { PairingManager } from "./pairing.js";
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
  const pairing = new PairingManager(logger);
  const larkBot = new LarkBot({ appId: LARK_APP_ID, appSecret: LARK_APP_SECRET }, tunnels, pairing, logger);
  const router = new Router(larkBot, tunnels, logger);

  // HTTP server for pairing API
  const httpServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/pair") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { agentId } = JSON.parse(body);
          const record = pairing.create(agentId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            token: record.token,
            code: record.code,
            expiresAt: record.expiresAt.toISOString(),
            relayUrl: `ws://localhost:${PORT}/ws`,
          }));
        } catch {
          res.writeHead(400);
          res.end("Invalid request");
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200);
      res.end("ok");
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  // WebSocket server for agent tunnels
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    let agentId: string | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    ws.on("message", (data) => {
      const raw = data.toString();

      // First message must be auth
      if (!agentId) {
        try {
          const msg: AgentToRelay = JSON.parse(raw);
          if (msg.type === "auth") {
            const record = pairing.getByToken(msg.token);
            if (!record) {
              ws.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }));
              ws.close();
              return;
            }
            agentId = record.agentId;
            const userId = record.userId;
            if (userId) {
              tunnels.register(agentId, userId, ws);
              ws.send(JSON.stringify({ type: "paired", userId }));
            } else {
              tunnels.register(agentId, `pending:${agentId}`, ws);
              ws.send(JSON.stringify({ type: "error", message: "Waiting for user to pair via code: " + record.code }));
            }

            // Start ping interval
            pingInterval = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "ping" }));
              }
            }, 30000);

            logger.info({ agentId }, "Agent connected");
            return;
          }
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid auth message" }));
          ws.close();
          return;
        }
      }

      // Route subsequent messages
      router.handleAgentMessage(agentId, raw);
    });

    ws.on("close", () => {
      if (agentId) {
        tunnels.remove(agentId);
        logger.info({ agentId }, "Agent disconnected");
      }
      if (pingInterval) clearInterval(pingInterval);
    });

    ws.on("error", (err) => {
      logger.error({ err, agentId }, "WebSocket error");
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
