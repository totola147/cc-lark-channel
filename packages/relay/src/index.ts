import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import pino from "pino";
import { TunnelManager } from "./tunnel.js";
import { LarkBot } from "./lark-bot.js";
import { Router } from "./router.js";
import { DeviceCodeManager } from "./device-code.js";
import { AuthStore } from "./auth-store.js";
import { authenticateAgent, type AgentAuthMessage } from "./ws-auth.js";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

const PORT = parseInt(process.env["RELAY_PORT"] ?? "9000", 10);
const LARK_APP_ID = process.env["LARK_APP_ID"] ?? "";
const LARK_APP_SECRET = process.env["LARK_APP_SECRET"] ?? "";
const RELAY_BASE_URL = process.env["RELAY_BASE_URL"] ?? "";
const AUTH_STORE_PATH = process.env["RELAY_AUTH_STORE"] ?? joinPath(homedir(), ".cc-lark-relay", "auth.json");
// 过渡开关：允许不带 token 的旧 agent 连接。默认关闭（不带 token 等于谁知道 openId 谁就能冒充）。
const ALLOW_LEGACY_AUTH = process.env["RELAY_ALLOW_LEGACY_AUTH"] === "1";
const OAUTH_COOKIE = "cc_oauth";
const MAX_BODY_BYTES = 16 * 1024;

function readCookie(req: import("node:http").IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function isHttps(req: import("node:http").IncomingMessage): boolean {
  if (RELAY_BASE_URL) return RELAY_BASE_URL.startsWith("https:");
  return req.headers["x-forwarded-proto"] === "https";
}

function getBaseUrl(req: import("node:http").IncomingMessage): string {
  if (RELAY_BASE_URL) return RELAY_BASE_URL;
  const host = req.headers.host ?? `localhost:${PORT}`;
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  return `${proto}://${host}`;
}

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
  const authStore = new AuthStore(AUTH_STORE_PATH, logger);
  if (ALLOW_LEGACY_AUTH) {
    logger.warn("RELAY_ALLOW_LEGACY_AUTH=1: agents may connect without a token (insecure, transition only)");
  }
  const larkBot = new LarkBot({ appId: LARK_APP_ID, appSecret: LARK_APP_SECRET }, tunnels, logger);
  const router = new Router(larkBot, tunnels, logger);

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    // 不再返回 Access-Control-Allow-Origin: *。落地页与 API 同源，CLI 不受 CORS 约束；
    // 去掉通配可阻止第三方页面借用户浏览器调用 /api/bind。
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", agents: tunnels.getAllTunnels().length }));
      return;
    }

    // OAuth: redirect to Lark
    if (req.method === "GET" && url.pathname === "/auth") {
      const baseUrl = getBaseUrl(req);
      const redirectUri = encodeURIComponent(`${baseUrl}/auth/callback`);
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
        // open_id 不再放进 URL（会进浏览器历史/Referer/代理日志），而是存入服务端短期会话，
        // 用 HttpOnly cookie 引用；/api/bind 从 cookie 解析身份，不接受客户端提交的 openId。
        const sid = deviceCodes.createOAuthSession(openId);
        const cookie = [
          `${OAUTH_COOKIE}=${encodeURIComponent(sid)}`,
          "Path=/",
          "HttpOnly",
          "SameSite=Lax",
          "Max-Age=600",
          ...(isHttps(req) ? ["Secure"] : []),
        ].join("; ");
        res.writeHead(302, { Location: `${getBaseUrl(req)}/#authenticated`, "Set-Cookie": cookie });
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
      res.end(JSON.stringify({ code: code.code, pollSecret: code.pollSecret, expiresIn: 300 }));
      return;
    }

    // API: bind device code to open_id (called by landing page)
    if (req.method === "POST" && url.pathname === "/api/bind") {
      const ctype = String(req.headers["content-type"] ?? "");
      if (!ctype.startsWith("application/json")) { res.writeHead(415); res.end("Content-Type must be application/json"); return; }
      const oauthSid = readCookie(req, OAUTH_COOKIE);
      if (!deviceCodes.resolveOAuthSession(oauthSid)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "请先完成飞书认证" }));
        return;
      }
      let body = "";
      let tooLarge = false;
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) { tooLarge = true; req.destroy(); }
      });
      req.on("end", () => {
        if (tooLarge) return;
        try {
          const { deviceCode } = JSON.parse(body) as { deviceCode?: unknown };
          const success = typeof deviceCode === "string" && deviceCodes.bindWithOAuthSession(deviceCode, oauthSid!);
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
      // 必须出示创建设备码时下发的 pollSecret，否则旁人猜到/看到 6 位码就能领走 token。
      const record = deviceCodes.getForPoller(code, url.searchParams.get("secret"));
      if (!record) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "expired" }));
      } else if (record.openId) {
        const token = authStore.issue(record.openId);
        deviceCodes.consume(record.code);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "bound", openId: record.openId, token }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "pending" }));
      }
      return;
    }

    // 落地页查询当前浏览器是否已完成 OAuth（不回显 openId 全文）
    if (req.method === "GET" && url.pathname === "/api/oauth/status") {
      const openId = deviceCodes.resolveOAuthSession(readCookie(req, OAUTH_COOKIE));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openId ? { authenticated: true, openIdHint: `${openId.slice(0, 6)}…${openId.slice(-4)}` } : { authenticated: false }));
      return;
    }

    // Serve landing page
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      try {
        const html = await readFile(join(__dirname, "../docs/index.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404); res.end("Landing page not found");
      }
      return;
    }

    // Serve docs page
    if (req.method === "GET" && url.pathname === "/docs.html") {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      try {
        const html = await readFile(join(__dirname, "../docs/docs.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404); res.end("Docs not found");
      }
      return;
    }

    res.writeHead(404); res.end("Not found");
  });

  // WebSocket server for agent tunnels
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    let openId: string | null = null;
    let agentId: string | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    ws.on("message", (data) => {
      const raw = data.toString();

      if (!openId) {
        let msg: AgentAuthMessage;
        try {
          msg = JSON.parse(raw) as AgentAuthMessage;
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid auth message" }));
          ws.close();
          return;
        }
        if (msg.type !== "auth") {
          // 未鉴权前不处理任何业务消息
          ws.send(JSON.stringify({ type: "error", message: "auth required" }));
          ws.close();
          return;
        }
        const decision = authenticateAgent(msg, authStore, { allowLegacy: ALLOW_LEGACY_AUTH });
        if (!decision.ok) {
          logger.warn({ openId: msg.openId, error: decision.error }, "Agent auth rejected");
          ws.send(JSON.stringify({ type: "error", message: decision.error }));
          ws.close();
          return;
        }
        openId = decision.openId;
        // agentId defaults to openId (legacy single-agent behavior). A
        // distinct agentId lets multiple agents share one openId without
        // evicting each other; routing then uses chat ownership.
        agentId = decision.agentId;
        tunnels.register(agentId, openId, ws);
        ws.send(JSON.stringify({ type: "connected", openId }));

        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 30000);

        logger.info({ openId, agentId, legacy: decision.legacy }, "Agent connected");
        return;
      }

      router.handleAgentMessage(agentId!, raw);
    });

    ws.on("close", () => {
      if (agentId) {
        // Pass this socket so a replaced connection's late close event cannot
        // evict the agent's current tunnel.
        tunnels.remove(agentId, ws);
        logger.info({ openId, agentId }, "Agent disconnected");
      }
      if (pingInterval) clearInterval(pingInterval);
    });

    ws.on("error", (err) => {
      logger.error({ err, openId }, "WebSocket error");
    });
  });

  await larkBot.start();

  httpServer.listen(PORT, () => {
    logger.info({ port: PORT, baseUrl: RELAY_BASE_URL || "(dynamic from Host header)" }, "Relay server started");
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
  // 不记录 token 本身
  logger.debug({ hasToken: !!tokenData.app_access_token }, "Got app_access_token");

  // Exchange code for user access token
  const userRes = await fetch("https://open.feishu.cn/open-apis/authen/v1/oidc/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${tokenData.app_access_token}`,
    },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
  const userData = await userRes.json() as { data: { access_token: string } };
  const userAccessToken = userData.data?.access_token;
  if (!userAccessToken) {
    throw new Error(`Failed to get user access_token (code=${(userData as { code?: unknown }).code ?? "?"})`);
  }

  // Get user info with user access token
  const infoRes = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
    method: "GET",
    headers: { "Authorization": `Bearer ${userAccessToken}` },
  });
  const infoData = await infoRes.json() as { data: { open_id: string; tenant_key: string } };
  logger.info({ openId: infoData.data?.open_id, tenantKey: infoData.data?.tenant_key }, "OAuth got user info");

  // Org filter
  const ALLOWED_TENANT_KEY = process.env["ALLOWED_TENANT_KEY"] ?? "";
  if (ALLOWED_TENANT_KEY && infoData.data?.tenant_key !== ALLOWED_TENANT_KEY) {
    throw new Error(`Unauthorized organization (tenant_key: ${infoData.data?.tenant_key})`);
  }

  const openId = infoData.data?.open_id;
  if (!openId) {
    throw new Error(`Failed to get open_id: ${JSON.stringify(infoData)}`);
  }
  return openId;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
