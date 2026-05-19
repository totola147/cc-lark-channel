import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import pino from "pino";
import { TunnelManager } from "./tunnel.js";
import { LarkBot } from "./lark-bot.js";
import { Router } from "./router.js";
import { DeviceCodeManager } from "./device-code.js";
import type { AgentToRelay } from "@cc-lark/protocol";

const PORT = parseInt(process.env["RELAY_PORT"] ?? "9000", 10);
const LARK_APP_ID = process.env["LARK_APP_ID"] ?? "";
const LARK_APP_SECRET = process.env["LARK_APP_SECRET"] ?? "";
const RELAY_BASE_URL = process.env["RELAY_BASE_URL"] ?? `http://localhost:${PORT}`;

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
  const deviceCodes = new DeviceCodeManager(logger);
  const larkBot = new LarkBot({ appId: LARK_APP_ID, appSecret: LARK_APP_SECRET }, tunnels, logger);
  const router = new Router(larkBot, tunnels, logger);

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", agents: tunnels.getAllTunnels().length }));
      return;
    }

    // OAuth: redirect to Lark
    if (req.method === "GET" && url.pathname === "/auth") {
      const redirectUri = encodeURIComponent(`${RELAY_BASE_URL}/auth/callback`);
      const larkAuthUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${LARK_APP_ID}&redirect_uri=${redirectUri}&response_type=code`;
      res.writeHead(302, { Location: larkAuthUrl });
      res.end();
      return;
    }

    // OAuth callback: exchange code for open_id
    if (req.method === "GET" && url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      if (!code) { res.writeHead(400); res.end("Missing code"); return; }

      try {
        const openId = await exchangeCodeForOpenId(code);
        // Redirect to landing page with open_id
        res.writeHead(302, { Location: `${RELAY_BASE_URL}/#authenticated&open_id=${openId}` });
        res.end();
      } catch (err) {
        logger.error({ err }, "OAuth callback failed");
        res.writeHead(500); res.end("OAuth failed");
      }
      return;
    }

    // API: generate device code (called by CLI)
    if (req.method === "POST" && url.pathname === "/api/device-code") {
      const code = deviceCodes.create();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: code.code, expiresIn: 300 }));
      return;
    }

    // API: bind device code to open_id (called by landing page)
    if (req.method === "POST" && url.pathname === "/api/bind") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { deviceCode, openId } = JSON.parse(body);
          const success = deviceCodes.bind(deviceCode, openId);
          if (success) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Invalid or expired device code" }));
          }
        } catch {
          res.writeHead(400); res.end("Invalid request");
        }
      });
      return;
    }

    // API: poll device code status (called by CLI)
    if (req.method === "GET" && url.pathname === "/api/device-code/status") {
      const code = url.searchParams.get("code");
      if (!code) { res.writeHead(400); res.end("Missing code"); return; }
      const record = deviceCodes.get(code);
      if (!record) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "expired" }));
      } else if (record.openId) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "bound", openId: record.openId }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "pending" }));
      }
      return;
    }

    // Serve landing page
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      try {
        const html = await readFile(join(import.meta.dirname ?? ".", "../docs/index.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404); res.end("Landing page not found");
      }
      return;
    }

    res.writeHead(404); res.end("Not found");
  });

  // WebSocket server for agent tunnels
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    let openId: string | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    ws.on("message", (data) => {
      const raw = data.toString();

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

      router.handleAgentMessage(openId!, raw);
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

  await larkBot.start();

  httpServer.listen(PORT, () => {
    logger.info({ port: PORT, baseUrl: RELAY_BASE_URL }, "Relay server started");
  });

  process.on("SIGINT", () => { process.exit(0); });
  process.on("SIGTERM", () => { process.exit(0); });
}

async function exchangeCodeForOpenId(code: string): Promise<string> {
  // Get app_access_token
  const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }),
  });
  const tokenData = await tokenRes.json() as { app_access_token: string };

  // Exchange code for user info
  const userRes = await fetch("https://open.feishu.cn/open-apis/authen/v1/oidc/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${tokenData.app_access_token}`,
    },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
  const userData = await userRes.json() as { data: { open_id: string } };
  return userData.data.open_id;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
