import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createLogger } from "./util/logger.js";
import { LarkGateway } from "./lark/gateway.js";
import { LarkClient } from "./lark/client.js";
import { SessionManager } from "./claude/session-manager.js";
import { StateStore } from "./persistence/store.js";
import { CommandRouter } from "./commands/router.js";
import { PermissionBroker } from "./claude/permission-broker.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { IpcServer } from "./ipc/server.js";
import { getLiveSessionOwner } from "./claude/session-registry.js";

const CONFIG_PATH = process.env["CLC_CONFIG"] ?? resolve(process.cwd(), "config.toml");

async function main() {
  // Auto-update on startup
  try {
    const { execSync } = await import("node:child_process");
    const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf-8", timeout: 30000 });
    if (!result.includes("Already up to date")) {
      execSync("npm run build", { cwd: process.cwd(), encoding: "utf-8", timeout: 60000 });
      console.log("✅ Auto-updated to latest version");
    }
  } catch {}

  const config = await loadConfig(CONFIG_PATH);
  const logger = createLogger(config.logging.level);

  logger.info({ configPath: CONFIG_PATH }, "cc-lark-channel starting");

  const stateStore = new StateStore(config.persistence.state_dir, logger);
  await stateStore.load();

  const larkClient = new LarkClient(config.lark, logger);
  const permissionBroker = new PermissionBroker(config.claude, larkClient, logger);
  const sessionManager = new SessionManager(config, stateStore, permissionBroker, larkClient, logger);
  const workspaceManager = new WorkspaceManager(larkClient, stateStore, logger);

  // direct 模式群主取第一个被授权的 open_id
  const ownerOpenId = config.access.allowed_open_ids[0] ?? "";

  // Local IPC: terminal tools (cc-transfer / cc-session) talk to the agent.
  const ipcServer = new IpcServer(
    {
      onTransfer: async ({ sessionId, cwd, hasWrapper }) => {
        const owner = getLiveSessionOwner(sessionId);
        if (owner) {
          throw new Error(
            `会话 ${sessionId} 仍被终端进程持有 (PID ${owner.pid})。请先退出终端会话再转移。`,
          );
        }
        if (!ownerOpenId) {
          throw new Error("无法确定群主 open_id（config.access.allowed_open_ids 为空）");
        }
        const res = await workspaceManager.findOrCreateForSession(cwd, sessionId, ownerOpenId);
        if ("error" in res) throw new Error(res.error);

        const session = sessionManager.getOrCreateSession(res.record.chatId);
        session.cwd = cwd;
        session.providerSessionId = sessionId;

        const note = hasWrapper ? "" : "\n（终端未使用 cc-session 包装器，交还时需手动 claude --resume）";
        await larkClient.sendText(
          res.record.chatId,
          `🔄 会话 ${sessionId} 已转移至该群组，请继续。${note}`,
        );
        return { chatId: res.record.chatId, message: res.created ? "group created" : "group reused" };
      },
    },
    logger,
  );

  const commandRouter = new CommandRouter(
    sessionManager,
    larkClient,
    config,
    workspaceManager,
    logger,
    {
      pushResume: (sessionId: string) => ipcServer.pushResume(sessionId),
      hasWrapper: (sessionId: string) => ipcServer.hasWrapper(sessionId),
    },
  );

  const gateway = new LarkGateway({
    config: config.lark,
    access: config.access,
    logger,
    larkClient,
    onMessage: async (msg) => {
      const cmdResult = commandRouter.match(msg);
      if (cmdResult) {
        await commandRouter.execute(cmdResult, msg);
        return;
      }
      // 交还终端后，飞书不再写入该会话，避免双写。
      if (workspaceManager.isReleased(msg.chatId)) {
        await larkClient.sendText(
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
    await stateStore.save();
    process.exit(0);
  }

  await gateway.start();
  await ipcServer.start().catch((err) => {
    logger.warn({ err }, "IPC server failed to start — terminal transfer/handback unavailable");
  });
  logger.info("cc-lark-channel ready — listening for Lark messages");

  // Notify after update restart
  try {
    const { readFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const flagPath = join(process.cwd(), ".state", "update-restart.json");
    const flag = JSON.parse(readFileSync(flagPath, "utf-8"));
    unlinkSync(flagPath);
    if (flag.chatId) {
      await larkClient.sendText(flag.chatId, "✅ Update complete, service restarted");
    }
  } catch {}
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
