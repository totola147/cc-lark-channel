import { resolve } from "node:path";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { createLogger } from "./util/logger.js";
import { randomUUID } from "node:crypto";
import { DirectTransport } from "./transport/direct.js";
import { RelayTransport } from "./transport/relay.js";
import type { Transport, TransportEvents } from "./transport/interface.js";
import { SessionManager } from "./claude/session-manager.js";
import { StateStore } from "./persistence/store.js";
import { CommandRouter } from "./commands/router.js";
import { PermissionBroker } from "./claude/permission-broker.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { IpcServer } from "./ipc/server.js";
import { getLiveSessionOwner } from "./claude/session-registry.js";
import { buildRecap } from "./claude/session-recap.js";
import { resolveProfile, PROFILE_NAME_RE } from "./claude/profile.js";
import type { EffortLevel } from "./types.js";
import { normalizePermissionMode } from "./types.js";

const VALID_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

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
    else if (arg === "--repair") opts["repair"] = "true";
  }
  return opts;
}

interface SavedRelay { relayUrl: string; openId: string; agentId?: string; token?: string }

async function loadSavedRelay(): Promise<SavedRelay | null> {
  try {
    const raw = await readFile(TOKEN_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (data.relayUrl && data.openId) return data;
  } catch {}
  return null;
}

async function saveRelay(data: SavedRelay): Promise<void> {
  await mkdir(resolve(homedir(), ".cc-lark-channel"), { recursive: true, mode: 0o700 });
  // 含鉴权 token，仅属主可读写
  await writeFile(TOKEN_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600).catch(() => {});
}

async function installService(): Promise<void> {
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

  console.log("检测到以下环境变量将写入服务：");
  ccEnvKeys.forEach(k => console.log(`  ${k}=${/KEY|SECRET|TOKEN|PASSWORD|AUTH/i.test(k) ? "***" : process.env[k]}`));

  // 密钥不写进 /etc/systemd/system 下的 unit（默认 0644，所有本地用户可读），
  // 而是写到属主专属的 EnvironmentFile（0600），unit 只引用它。
  const envDir = resolve(homedir(), ".cc-lark-channel");
  const envPath = resolve(envDir, "service.env");
  await mkdir(envDir, { recursive: true, mode: 0o700 });
  await writeFile(envPath, ccEnvKeys.map(k => `${k}=${quoteSystemdEnv(process.env[k] ?? "")}`).join("\n") + "\n", { mode: 0o600 });
  await chmod(envPath, 0o600);

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
EnvironmentFile=${envPath}

[Install]
WantedBy=multi-user.target
`;
  const servicePath = "/etc/systemd/system/cc-lark-channel.service";
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const tmpDir = await mkdtemp(resolve(tmpdir(), "cc-lark-svc-"));
  const tmpUnit = resolve(tmpDir, "cc-lark-channel.service");
  await writeFile(tmpUnit, unit, { mode: 0o600 });
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("sudo", ["install", "-m", "0644", "-o", "root", "-g", "root", tmpUnit, servicePath], { stdio: "inherit" });
    execFileSync("sudo", ["systemctl", "daemon-reload"], { stdio: "inherit" });
    execFileSync("sudo", ["systemctl", "enable", "cc-lark-channel"], { stdio: "inherit" });
    execFileSync("sudo", ["systemctl", "restart", "cc-lark-channel"], { stdio: "inherit" });
    console.log("✅ 系统服务已安装并启动");
    console.log(`   环境变量文件: ${envPath}（0600）`);
    console.log("   状态: sudo systemctl status cc-lark-channel");
    console.log("   日志: sudo journalctl -u cc-lark-channel -f");
    console.log("   停止: sudo systemctl stop cc-lark-channel");
  } catch {
    console.error("❌ 安装服务失败（需要 sudo 权限）");
    process.exit(1);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** systemd EnvironmentFile 值：双引号包裹，转义 \\ " ` $（systemd 在双引号内识别的转义集）。 */
function quoteSystemdEnv(v: string): string {
  return `"${v.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;
}

async function deviceCodeFlow(relayUrl: string): Promise<{ openId: string; token?: string }> {
  const httpBase = relayUrl.replace(/^ws/, "http").replace(/\/ws$/, "");

  // Request device code
  const res = await fetch(`${httpBase}/api/device-code`, { method: "POST" });
  const { code, pollSecret } = await res.json() as { code: string; pollSecret?: string };

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
    const qs = new URLSearchParams({ code, ...(pollSecret ? { secret: pollSecret } : {}) });
    const statusRes = await fetch(`${httpBase}/api/device-code/status?${qs}`);
    const status = await statusRes.json() as { status: string; openId?: string; token?: string };
    if (status.status === "bound" && status.openId) {
      console.log(`✅ 配对成功 (open_id: ${status.openId})`);
      return { openId: status.openId, token: status.token };
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

  // 启动时自动 git pull + build 需显式开启（CLC_AUTO_UPDATE=1）。默认关闭：
  // 每次服务重启都静默拉取并执行远端代码，风险过高，也会让版本难以追溯。
  if (opts["foreground"] && process.env["CLC_AUTO_UPDATE"] === "1") {
    try {
      const { execFileSync } = await import("node:child_process");
      const cwd = process.cwd();
      const result = execFileSync("git", ["-c", `safe.directory=${cwd}`, "pull", "--ff-only"], { cwd, encoding: "utf-8", timeout: 30000 });
      if (!result.includes("Already up to date")) {
        execFileSync("pnpm", ["build"], { cwd, encoding: "utf-8", timeout: 60000 });
        console.log("✅ Auto-updated to latest version");
      }
    } catch (err) {
      console.warn(`⚠️  Auto-update failed: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  const configPath = opts["config"] ?? process.env["CLC_CONFIG"] ?? resolve(process.cwd(), "config.toml");
  const config = await loadConfig(configPath);
  const logger = createLogger(config.logging.level);

  const stateStore = new StateStore(config.persistence.state_dir, logger);
  await stateStore.load();

  let transport: Transport & { setEvents(e: TransportEvents): void };
  let ownerOpenId = "";
  let agentId = "";

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
    let relayToken = process.env["CLC_RELAY_TOKEN"] ?? "";

    // Use saved config
    if (savedRelay) {
      relayUrl = relayUrl || savedRelay.relayUrl;
      openId = openId || savedRelay.openId;
      // 只有 openId 与已保存的一致时才沿用其 token
      if (!relayToken && savedRelay.token && openId === savedRelay.openId) relayToken = savedRelay.token;
    }
    // Stable per-install agent id: lets multiple agents share one openId
    // without evicting each other on the relay. Generated once, then persisted.
    agentId = savedRelay?.agentId || randomUUID();

    if (!relayUrl) {
      console.error("Error: --relay <url> required, or configure in ~/.cc-lark-channel/relay.json");
      process.exit(1);
    }

    // 没有 open_id 或显式 --repair 时走设备码配对。
    // 旧版配对只有 openId 没有 token：照常连接（旧 relay / RELAY_ALLOW_LEGACY_AUTH=1 仍接受），
    // 不在这里强制配对——以服务方式运行时没人扫码，会卡死在轮询里反复重启。
    if (openId && !relayToken && !opts["repair"]) {
      logger.warn("已保存的配对没有鉴权 token（旧版配对）。若 relay 已升级并拒绝连接，请执行 clc --relay <url> --repair 重新配对");
    }
    if (!openId || opts["repair"]) {
      const paired = await deviceCodeFlow(relayUrl);
      openId = paired.openId;
      relayToken = paired.token ?? "";
      if (!relayToken) {
        console.warn("⚠️  relay 未下发 token（旧版 relay？），将以无 token 方式连接。");
      }
    }

    // Save for next time (persist the stable agentId too)
    await saveRelay({ relayUrl, openId, agentId, ...(relayToken ? { token: relayToken } : {}) });

    // Setup mode: pair + install service, then exit
    if (opts["setup"]) {
      console.log("\n配对完成，正在注册系统服务...\n");
      await installService();
      process.exit(0);
    }

    logger.info({ relayUrl, openId, agentId }, "cc-lark-channel starting (relay mode)");
    ownerOpenId = openId;
    // onConnect: re-assert ownership of our workspace chats so the relay can
    // rebuild chat->agent routing after a reconnect or relay restart.
    transport = new RelayTransport(
      {
        relayUrl,
        openId,
        agentId,
        token: relayToken || undefined,
        listOwnedChatIds: () => Object.keys(stateStore.getAllWorkspaces()),
      },
      logger,
    );
  }

  // 审批/提问卡片只允许这些人操作：relay 模式为配对的 owner，direct 模式为
  // allowed_open_ids。两者都为空时由 broker 退回到"只有发起本轮的人"。
  const approverIds = isDirectMode ? config.access.allowed_open_ids : [ownerOpenId].filter(Boolean);
  const permissionBroker = new PermissionBroker(config.claude, transport, logger, {
    approvers: () => approverIds,
  });
  const workspaceManager = new WorkspaceManager(transport, stateStore, logger);
  const sessionManager = new SessionManager(config, stateStore, permissionBroker, transport, logger);

  // Local IPC: terminal tools (cc-transfer / cc-session) talk to the agent.
  const ipcServer = new IpcServer(
    {
      onTransfer: async ({ sessionId, cwd, hasWrapper, permissionMode, model, effort, profile }) => {
        // 先校验运行档，失败时 wrapper 会在终端原地恢复 claude，不会建群。
        if (profile !== undefined) {
          if (!PROFILE_NAME_RE.test(profile)) throw new Error(`运行档名不合法：${JSON.stringify(profile).slice(0, 80)}`);
          resolveProfile(profile, config);
        }
        // Safety gate: do not take over a session still held by a live terminal.
        // The wrapper kills claude before transferring, so by now it should be dead.
        const owner = getLiveSessionOwner(sessionId);
        if (owner) {
          throw new Error(
            `会话 ${sessionId} 仍被终端进程持有 (PID ${owner.pid})。请先退出终端会话再转移。`,
          );
        }
        if (!ownerOpenId) {
          throw new Error("无法确定群主 open_id（relay 模式未配对？）");
        }
        const res = await workspaceManager.findOrCreateForSession(cwd, sessionId, ownerOpenId);
        if ("error" in res) throw new Error(res.error);

        // Bind the agent session to this group + resume the same Claude session.
        const session = sessionManager.getOrCreateSession(res.record.chatId);
        session.cwd = cwd;
        session.providerSessionId = sessionId;

        // Carry over the terminal's launch-time permission mode / model so the
        // Feishu-side session behaves the same (e.g. --dangerously-skip-permissions
        // → bypassPermissions), instead of falling back to the agent's config default.
        if (permissionMode) {
          const mode = normalizePermissionMode(permissionMode);
          if (mode) {
            session.permissionMode = mode;
          } else {
            logger.warn({ sessionId, permissionMode }, "Unsupported permission mode from terminal, ignoring");
          }
        }
        if (model) {
          session.model = model;
        }
        // 每次转移都以终端的档为准；终端没指定时用 default_profile（未配置则为 agent 默认环境）。
        session.profile = profile ?? config.claude.default_profile;
        if (effort) {
          if (VALID_EFFORT_LEVELS.includes(effort as EffortLevel)) {
            session.effort = effort as EffortLevel;
          } else {
            logger.warn({ sessionId, effort }, "Unsupported effort level from terminal, ignoring");
          }
        }

        const note = (hasWrapper ? "" : "\n（终端未使用 cc-session 包装器，交还时需手动 claude --resume）")
          + (profile ? `\n运行档：${profile}` : "");
        await transport.sendText(
          res.record.chatId,
          `🔄 会话 ${sessionId} 已转移至该群组，请继续。${note}`,
        );

        // 贴出最近几轮对话，让飞书侧立刻看到之前聊到哪。
        try {
          const recap = buildRecap(cwd, sessionId, 3);
          if (recap) await transport.sendText(res.record.chatId, recap);
        } catch (err) {
          logger.warn({ err, sessionId }, "Failed to build recap");
        }

        return { chatId: res.record.chatId, message: res.created ? "group created" : "group reused", groupName: res.record.name };
      },
    },
    logger,
  );

  const commandRouter = new CommandRouter(
    sessionManager,
    transport,
    config,
    workspaceManager,
    logger,
    {
      pushResume: (lookupId: string, resumeId?: string) => ipcServer.pushResume(lookupId, resumeId),
      hasWrapper: (sessionId: string) => ipcServer.hasWrapper(sessionId),
    },
  );

  transport.setEvents({
    onMessage: async (msg) => {
      const cmdResult = commandRouter.match(msg);
      if (cmdResult) {
        await commandRouter.execute(cmdResult, msg);
        return;
      }
      // If the group was handed back to the terminal, refuse to write to the
      // session until it is re-transferred (avoids two writers on one session).
      if (workspaceManager.isReleased(msg.chatId)) {
        await transport.sendText(
          msg.chatId,
          "⏸ 该会话已交还终端 (cc cli)。如需在飞书继续，请在终端重新执行 cc-transfer 转移。",
        );
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
    await ipcServer.stop().catch(() => {});
    await sessionManager.shutdown();
    await stateStore.save().catch((err) => {
      logger.warn({ err }, "Failed to persist state during shutdown");
    });
    process.exit(0);
  }

  await transport.start();
  await ipcServer.start().catch((err) => {
    logger.warn({ err }, "IPC server failed to start — terminal transfer/handback unavailable");
  });
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
