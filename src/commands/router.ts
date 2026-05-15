import type { LarkClient } from "../lark/client.js";
import type { SessionManager } from "../claude/session-manager.js";
import type { AppConfig } from "../config.js";
import type { IncomingMessage, PermissionMode } from "../types.js";
import type { Logger } from "../util/logger.js";

interface CommandMatch {
  command: string;
  args: string;
}

export class CommandRouter {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly larkClient: LarkClient,
    private readonly config: AppConfig,
    _logger: Logger,
  ) {}

  match(msg: IncomingMessage): CommandMatch | null {
    const text = msg.text.trim();
    if (!text.startsWith("/")) return null;

    const spaceIdx = text.indexOf(" ");
    const command = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

    const known = ["/new", "/stop", "/status", "/sessions", "/mode", "/model", "/cd", "/help"];
    if (!known.includes(command)) return null;

    return { command, args };
  }

  async execute(cmd: CommandMatch, msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;

    switch (cmd.command) {
      case "/help":
        await this.larkClient.sendText(chatId, HELP_TEXT);
        break;

      case "/new":
        this.sessionManager.newSession(chatId);
        await this.larkClient.sendText(chatId, "🆕 New session started");
        break;

      case "/stop": {
        const session = this.sessionManager.getSession(chatId);
        if (session) {
          await session.stop();
        } else {
          await this.larkClient.sendText(chatId, "No active session");
        }
        break;
      }

      case "/status": {
        const session = this.sessionManager.getSession(chatId);
        if (!session) {
          await this.larkClient.sendText(chatId, "No active session");
          break;
        }
        const stats = session.getStats();
        const status = [
          `State: ${session.getState()}`,
          `CWD: ${session.cwd}`,
          `Model: ${session.model || "(default)"}`,
          `Permission: ${session.permissionMode}`,
          `Turns: ${stats.turnCount}`,
          `Tokens: ${stats.totalInputTokens} in / ${stats.totalOutputTokens} out`,
          `Queue: ${session.getQueueLength()}`,
        ].join("\n");
        await this.larkClient.sendText(chatId, status);
        break;
      }

      case "/mode": {
        const validModes: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];
        if (!cmd.args || !validModes.includes(cmd.args as PermissionMode)) {
          await this.larkClient.sendText(chatId, `Usage: /mode <${validModes.join("|")}>`);
          break;
        }
        const session = this.sessionManager.getOrCreateSession(chatId);
        session.permissionMode = cmd.args as PermissionMode;
        await this.larkClient.sendText(chatId, `Permission mode: ${cmd.args}`);
        break;
      }

      case "/model": {
        if (!cmd.args) {
          await this.larkClient.sendText(chatId, "Usage: /model <model-name>");
          break;
        }
        const session = this.sessionManager.getOrCreateSession(chatId);
        session.model = cmd.args;
        await this.larkClient.sendText(chatId, `Model: ${cmd.args}`);
        break;
      }

      case "/cd": {
        if (!cmd.args) {
          const session = this.sessionManager.getSession(chatId);
          await this.larkClient.sendText(chatId, `CWD: ${session?.cwd ?? this.config.claude.default_cwd}`);
          break;
        }
        const session = this.sessionManager.getOrCreateSession(chatId);
        session.cwd = cmd.args;
        await this.larkClient.sendText(chatId, `CWD → ${cmd.args}`);
        break;
      }

      case "/sessions": {
        await this.larkClient.sendText(chatId, "Session listing not yet implemented");
        break;
      }
    }
  }
}

const HELP_TEXT = `cc-lark-channel commands:

/new — Start new session
/stop — Stop current generation
/status — Show session info
/mode <mode> — Set permission mode
/model <name> — Switch model
/cd <path> — Change working directory
/help — Show this help

Special inputs:
! <text> — Interrupt + run new prompt
Plain text — Send to Claude (queues if busy)`;
