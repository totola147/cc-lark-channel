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
import { WorkspaceManager } from "./workspace/manager.js";

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
    else if (arg === "--install-service") opts["installService"] = "true";
    else if (arg === "--setup") opts["setup"] = "true";
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

async function installService(): Promise<void> {
  const { execSync } = await import("node:child_process");
  const scriptPath = resolve(process.cwd(), "packages/agent/dist/index.cjs");
  const actualScript = (await import("node:fs")).existsSync(scriptPath)
    ? scriptPath
    : resolve(process.cwd(), "dist/index.cjs");

  // Collect Claude Code related env vars
  const ccEnvKeys = Object.keys(process.env).filter(k =>
    k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_") || k === "CLC_CONFIG" || k === "CLC_CLAUDE_CLI_PATH"
  );

  // Always include PATH and HOME for systemd
  if (process.env["PATH"] && !ccEnvKeys.includes("PATH")) {
    ccEnvKeys.push("PATH");
  }
  if (process.env["HOME"] && !ccEnvKeys.includes("HOME")) {
    ccEnvKeys.push("HOME");
  }

  // Auto-detect claude path and add to env if not already set
  const { execSync: execSyncSvc } = await import("node:child_process");
  if (!process.env["CLC_CLAUDE_CLI_PATH"]) {
    try {
      const claudePath = execSyncSvc("which claude", { encoding: "utf-8" }).trim();
      if (claudePath) {
        process.env["CLC_CLAUDE_CLI_PATH"] = claudePath;
        ccEnvKeys.push("CLC_CLAUDE_CLI_PATH");
      }
    } catch {}
  }

  if (ccEnvKeys.length === 0) {
    console.warn("⚠️  未检测到 Claude Code 相关环境变量（ANTHROPIC_*、CLAUDE_*）");
    console.warn("   请确保当前 shell 中已设置认证变量后再执行 --install-service");
    console.warn("   例如: export ANTHROPIC_API_KEY=sk-ant-xxx");
    process.exit(1);
  }

  const envLines = ccEnvKeys
    .map(k => `Environment=${k}=${process.env[k]}`)
    .join("\n");

  console.log("检测到以下环境变量将写入服务：");
  ccEnvKeys.forEach(k => console.log(`  ${k}=${k.includes("KEY") || k.includes("SECRET") ? "***" : process.env[k]}`));

  const unit = `[Unit]
Description=cc-lark-channel agent
After=network.target

[Service]
Type=simple
User=${process.env["USER"] ?? "ubuntu"}
WorkingDirectory=${process.cwd()}
ExecStart=${process.execPath} ${actualScript} --foreground
Restart=always
RestartSec=5
${envLines}

[Install]
WantedBy=multi-user.target
`;
  const servicePath = "/etc/systemd/system/cc-lark-channel.service";
  await writeFile("/tmp/cc-lark-channel.service", unit);
  try {
    execSync(`sudo mv /tmp/cc-lark-channel.service ${servicePath} && sudo systemctl daemon-reload && sudo systemctl enable cc-lark-channel && sudo systemctl start cc-lark-channel`, { stdio: "inherit" });
    console.log("✅ 系统服务已安装并启动");
    console.log("   状态: sudo systemctl status cc-lark-channel");
    console.log("   日志: sudo journalctl -u cc-lark-channel -f");
    console.log("   停止: sudo systemctl stop cc-lark-channel");
  } catch {
    console.error("❌ 安装服务失败（需要 sudo 权限）");
    process.exit(1);
  }
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

  // Install as system service
  if (opts["installService"]) {
    await installService();
    process.exit(0);
  }

  // Auto-update on startup (if running as service / foreground)
  if (opts["foreground"]) {
    try {
      const { execSync: execUpdate } = await import("node:child_process");
      const result = execUpdate("git pull", { cwd: process.cwd(), encoding: "utf-8", timeout: 30000 });
      if (result.includes("Already up to date")) {
        // No update needed
      } else {
        execUpdate("pnpm build", { cwd: process.cwd(), encoding: "utf-8", timeout: 60000 });
        console.log("✅ Auto-updated to latest version");
      }
    } catch {}
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

    // Setup mode: pair + install service, then exit
    if (opts["setup"]) {
      console.log("\n配对完成，正在注册系统服务...\n");
      await installService();
      process.exit(0);
    }

    logger.info({ relayUrl, openId }, "cc-lark-channel starting (relay mode)");
    transport = new RelayTransport({ relayUrl, openId }, logger);
  }

  const permissionBroker = new PermissionBroker(config.claude, transport, logger);
  const workspaceManager = new WorkspaceManager(transport, stateStore, logger);
  const sessionManager = new SessionManager(config, stateStore, permissionBroker, transport, logger);
  const commandRouter = new CommandRouter(sessionManager, transport, config, workspaceManager, logger);

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

  // Notify after update restart
  try {
    const { readFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const flagPath = join(process.cwd(), ".state", "update-restart.json");
    const flag = JSON.parse(readFileSync(flagPath, "utf-8"));
    unlinkSync(flagPath);
    if (flag.chatId) {
      await transport.sendText(flag.chatId, "✅ Update complete, service restarted");
    }
  } catch {}
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
