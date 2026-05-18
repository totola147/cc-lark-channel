import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createLogger } from "./util/logger.js";
import { DirectTransport } from "./transport/direct.js";
import { RelayTransport } from "./transport/relay.js";
import type { Transport, TransportEvents } from "./transport/interface.js";
import { SessionManager } from "./claude/session-manager.js";
import { StateStore } from "./persistence/store.js";
import { CommandRouter } from "./commands/router.js";
import { PermissionBroker } from "./claude/permission-broker.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--relay" && args[i + 1]) opts["relay"] = args[++i]!;
    else if (arg === "--token" && args[i + 1]) opts["token"] = args[++i]!;
    else if (arg === "--config" && args[i + 1]) opts["config"] = args[++i]!;
    else if (arg === "--direct") opts["mode"] = "direct";
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const configPath = opts["config"] ?? process.env["CLC_CONFIG"] ?? resolve(process.cwd(), "config.toml");
  const config = await loadConfig(configPath);
  const logger = createLogger(config.logging.level);

  const isRelayMode = !!opts["relay"];
  logger.info({ mode: isRelayMode ? "relay" : "direct", configPath }, "cc-lark-channel starting");

  const stateStore = new StateStore(config.persistence.state_dir, logger);
  await stateStore.load();

  let transport: Transport & { setEvents(e: TransportEvents): void };

  if (isRelayMode) {
    if (!opts["token"]) {
      console.error("Error: --token required in relay mode");
      process.exit(1);
    }
    transport = new RelayTransport(
      { relayUrl: opts["relay"]!, token: opts["token"]! },
      logger,
    );
  } else {
    transport = new DirectTransport(
      {
        app_id: config.lark.app_id,
        app_secret: config.lark.app_secret,
        allowed_open_ids: config.access.allowed_open_ids,
        unauthorized_behavior: config.access.unauthorized_behavior,
      },
      logger,
    );
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
