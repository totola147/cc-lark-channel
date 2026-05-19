import { resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { createLogger } from "./util/logger.js";
import { DirectTransport } from "./transport/direct.js";
import { RelayTransport } from "./transport/relay.js";
import type { Transport, TransportEvents } from "./transport/interface.js";
import { SessionManager } from "./claude/session-manager.js";
import { StateStore } from "./persistence/store.js";
import { CommandRouter } from "./commands/router.js";
import { PermissionBroker } from "./claude/permission-broker.js";

const TOKEN_PATH = resolve(homedir(), ".cc-lark-channel/relay.json");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--relay" && args[i + 1]) opts["relay"] = args[++i]!;
    else if (arg === "--open-id" && args[i + 1]) opts["openId"] = args[++i]!;
    else if (arg === "--config" && args[i + 1]) opts["config"] = args[++i]!;
    else if (arg === "--direct") opts["mode"] = "direct";
    else if (arg === "--daemon") opts["daemon"] = "true";
    else if (arg === "--foreground") opts["foreground"] = "true";
  }
  return opts;
}

async function loadSavedRelay(): Promise<{ relayUrl: string; openId: string } | null> {
  try {
    const raw = await readFile(TOKEN_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (data.relayUrl && data.openId) return data;
  } catch {}
  return null;
}

async function saveRelay(relayUrl: string, openId: string): Promise<void> {
  await mkdir(resolve(homedir(), ".cc-lark-channel"), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify({ relayUrl, openId }, null, 2));
}

async function deviceCodeFlow(relayUrl: string): Promise<string> {
  const httpBase = relayUrl.replace(/^ws/, "http").replace(/\/ws$/, "");

  // Request device code
  const res = await fetch(`${httpBase}/api/device-code`, { method: "POST" });
  const { code } = await res.json() as { code: string };

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  设备认证");
  console.log("");
  console.log(`  请访问: ${httpBase}`);
  console.log(`  设备码: ${code}`);
  console.log("");
  console.log("  完成飞书 OAuth 认证后输入设备码即可配对");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log("等待配对...");

  // Poll for bind
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(`${httpBase}/api/device-code/status?code=${code}`);
    const status = await statusRes.json() as { status: string; openId?: string };
    if (status.status === "bound" && status.openId) {
      console.log(`✅ 配对成功 (open_id: ${status.openId})`);
      return status.openId;
    }
    if (status.status === "expired") {
      throw new Error("设备码已过期，请重新启动");
    }
  }
  throw new Error("配对超时");
}

async function main() {
  const opts = parseArgs();

  // Daemon mode: fork to background and exit parent
  if (opts["daemon"] && !opts["foreground"]) {
    const { spawn } = await import("node:child_process");
    const args = process.argv.slice(1).filter(a => a !== "--daemon").concat("--foreground");
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    const pidFile = resolve(homedir(), ".cc-lark-channel/daemon.pid");
    await mkdir(resolve(homedir(), ".cc-lark-channel"), { recursive: true });
    await writeFile(pidFile, String(child.pid));
    console.log(`✅ Agent 已在后台启动 (PID: ${child.pid})`);
    console.log(`   停止: kill $(cat ~/.cc-lark-channel/daemon.pid)`);
    process.exit(0);
  }

  const configPath = opts["config"] ?? process.env["CLC_CONFIG"] ?? resolve(process.cwd(), "config.toml");
  const config = await loadConfig(configPath);
  const logger = createLogger(config.logging.level);

  const stateStore = new StateStore(config.persistence.state_dir, logger);
  await stateStore.load();

  let transport: Transport & { setEvents(e: TransportEvents): void };

  // Determine mode: check saved relay config if no explicit args
  const savedRelay = await loadSavedRelay();
  const hasRelayArg = !!opts["relay"];
  const hasRelayConfig = !!savedRelay;
  const isDirectMode = opts["mode"] === "direct" || (!hasRelayArg && !hasRelayConfig && config.lark.app_id);

  if (isDirectMode) {
    logger.info({ configPath }, "cc-lark-channel starting (direct mode)");
    transport = new DirectTransport(
      {
        app_id: config.lark.app_id,
        app_secret: config.lark.app_secret,
        allowed_open_ids: config.access.allowed_open_ids,
        unauthorized_behavior: config.access.unauthorized_behavior,
      },
      logger,
    );
  } else {
    // Relay mode: resolve open_id
    let relayUrl = opts["relay"] ?? "";
    let openId = opts["openId"] ?? "";

    // Use saved config
    if (savedRelay) {
      relayUrl = relayUrl || savedRelay.relayUrl;
      openId = openId || savedRelay.openId;
    }

    if (!relayUrl) {
      console.error("Error: --relay <url> required, or configure in ~/.cc-lark-channel/relay.json");
      process.exit(1);
    }

    // Device code flow if no open_id
    if (!openId) {
      openId = await deviceCodeFlow(relayUrl);
    }

    // Save for next time
    await saveRelay(relayUrl, openId);

    logger.info({ relayUrl, openId }, "cc-lark-channel starting (relay mode)");
    transport = new RelayTransport({ relayUrl, openId }, logger);
  }

  const permissionBroker = new PermissionBroker(config.claude, transport, logger);
  const sessionManager = new SessionManager(config, stateStore, permissionBroker, transport, logger);
  const commandRouter = new CommandRouter(sessionManager, transport, config, logger);

  transport.setEvents({
    onMessage: async (msg) => {
      const cmdResult = commandRouter.match(msg);
      if (cmdResult) {
        await commandRouter.execute(cmdResult, msg);
        return;
      }
      await sessionManager.handleMessage(msg);
    },
    onCardAction: async (action) => {
      return permissionBroker.handleCardAction(action);
    },
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  async function shutdown(signal: string) {
    logger.info({ signal }, "Shutting down");
    await sessionManager.shutdown();
    await stateStore.save();
    process.exit(0);
  }

  await transport.start();
  logger.info("cc-lark-channel ready — listening for messages");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
