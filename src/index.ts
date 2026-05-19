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
  const commandRouter = new CommandRouter(sessionManager, larkClient, config, workspaceManager, logger);

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

  await gateway.start();
  logger.info("cc-lark-channel ready — listening for Lark messages");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
