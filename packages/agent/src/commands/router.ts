import type { Transport } from "../transport/interface.js";
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
    private readonly transport: Transport,
    private readonly config: AppConfig,
    _logger: Logger,
  ) {}

  match(msg: IncomingMessage): CommandMatch | null {
    const text = msg.text.trim();
    if (!text.startsWith("/")) return null;

    const spaceIdx = text.indexOf(" ");
    const command = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

    const known = ["/new", "/stop", "/status", "/sessions", "/mode", "/model", "/cd", "/bg", "/fg", "/kill", "/attach", "/help"];
    if (!known.includes(command)) return null;

    return { command, args };
  }

  async execute(cmd: CommandMatch, msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;

    switch (cmd.command) {
      case "/help":
        await this.transport.sendText(chatId, HELP_TEXT);
        break;

      case "/new":
        this.sessionManager.newSession(chatId);
        await this.transport.sendText(chatId, "🆕 New session started");
        break;

      case "/stop": {
        const session = this.sessionManager.getSession(chatId);
        if (session) {
          await session.stop();
        } else {
          await this.transport.sendText(chatId, "No active session");
        }
        break;
      }

      case "/status": {
        const session = this.sessionManager.getSession(chatId);
        if (!session) {
          await this.transport.sendText(chatId, "No active session");
          break;
        }
        const stats = session.getStats();
        const status = [
          `Session: ${session.name || session.providerSessionId || "(new)"}`,
          `State: ${session.getState()}`,
          `CWD: ${session.cwd}`,
          `Model: ${session.model || "(default)"}`,
          `Permission: ${session.permissionMode}`,
          `Turns: ${stats.turnCount}`,
          `Tokens: ${stats.totalInputTokens} in / ${stats.totalOutputTokens} out`,
          `Queue: ${session.getQueueLength()}`,
        ].join("\n");
        await this.transport.sendText(chatId, status);
        break;
      }

      case "/sessions": {
        const list = this.sessionManager.getSessionList(chatId);
        if (list.length === 0) {
          await this.transport.sendText(chatId, "No sessions");
          break;
        }
        const lines = list.map(s => {
          const marker = s.isForeground ? "▶" : " ";
          const displayId = s.providerSessionId ?? `(new) ${s.id}`;
          const name = s.name ? `${s.name}: ` : "";
          return `${marker} ${name}${displayId} — ${s.state}\n   📂 ${s.cwd}`;
        });
        await this.transport.sendText(chatId, lines.join("\n"));
        break;
      }

      case "/bg": {
        const result = this.sessionManager.backgroundSession(chatId, cmd.args || undefined);
        if (!result) {
          await this.transport.sendText(chatId, "No active session to background");
          break;
        }
        const label = result.bgSession.name || result.bgSession.providerSessionId || "(new)";
        await this.transport.sendText(chatId, `⏸ Session [${label}] moved to background\n🆕 New foreground session ready`);
        break;
      }

      case "/fg": {
        if (!cmd.args) {
          await this.transport.sendText(chatId, "Usage: /fg <session-id or name>");
          break;
        }
        const session = this.sessionManager.foregroundSession(chatId, cmd.args);
        if (!session) {
          await this.transport.sendText(chatId, `Session "${cmd.args}" not found`);
          break;
        }
        const label = session.name || session.providerSessionId || "(new)";
        await this.transport.sendText(chatId, `▶ Session [${label}] is now foreground`);
        break;
      }

      case "/kill": {
        if (!cmd.args) {
          await this.transport.sendText(chatId, "Usage: /kill <session-id or name>\n/kill all — kill all sessions");
          break;
        }
        if (cmd.args.toLowerCase() === "all") {
          const count = this.sessionManager.killAll(chatId);
          await this.transport.sendText(chatId, `🗑 Killed ${count} session(s), new foreground session created`);
          break;
        }
        const killed = this.sessionManager.killSession(chatId, cmd.args);
        if (killed) {
          await this.transport.sendText(chatId, `🗑 Session "${cmd.args}" killed`);
        } else {
          await this.transport.sendText(chatId, `Cannot kill "${cmd.args}" (not found or is foreground)`);
        }
        break;
      }

      case "/mode": {
        const validModes: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];
        if (!cmd.args || !validModes.includes(cmd.args as PermissionMode)) {
          await this.transport.sendText(chatId, `Usage: /mode <${validModes.join("|")}>`);
          break;
        }
        const session = this.sessionManager.getOrCreateSession(chatId);
        session.permissionMode = cmd.args as PermissionMode;
        await this.transport.sendText(chatId, `Permission mode: ${cmd.args}`);
        break;
      }

      case "/model": {
        if (!cmd.args) {
          await this.transport.sendText(chatId, "Usage: /model <model-name>");
          break;
        }
        const session = this.sessionManager.getOrCreateSession(chatId);
        session.model = cmd.args;
        await this.transport.sendText(chatId, `Model: ${cmd.args}`);
        break;
      }

      case "/cd": {
        if (!cmd.args) {
          const session = this.sessionManager.getSession(chatId);
          await this.transport.sendText(chatId, `CWD: ${session?.cwd ?? this.config.claude.default_cwd}`);
          break;
        }
        const session = this.sessionManager.getOrCreateSession(chatId);
        const cdPath = cmd.args.replace(/^["']|["']$/g, "");
        session.cwd = cdPath;
        session.providerSessionId = undefined;
        await this.transport.sendText(chatId, `CWD → ${cdPath} (new session will start here)`);
        break;
      }

      case "/attach": {
        if (!cmd.args) {
          await this.transport.sendText(chatId, "Usage: /attach <session-id> [cwd]\nPaste the session ID from your Claude Code CLI to continue that session here.");
          break;
        }
        const parts = cmd.args.trim().split(/\s+/);
        const sessionId = parts[0]!;
        let attachCwd = parts[1]?.replace(/^["']|["']$/g, "");

        // Auto-detect cwd from Claude's session storage if not provided
        if (!attachCwd) {
          const { readdirSync, existsSync } = await import("node:fs");
          const { homedir } = await import("node:os");
          const projectsDir = `${homedir()}/.claude/projects`;
          if (existsSync(projectsDir)) {
            for (const dir of readdirSync(projectsDir)) {
              if (existsSync(`${projectsDir}/${dir}/${sessionId}.jsonl`)) {
                attachCwd = dir.replace(/^-/, "/").replace(/-/g, "/");
                break;
              }
            }
          }
        }

        // Background current session if it has work
        const currentSession = this.sessionManager.getSession(chatId);
        if (currentSession && currentSession.providerSessionId) {
          this.sessionManager.backgroundSession(chatId);
        }

        const attachSession = this.sessionManager.getOrCreateSession(chatId);
        attachSession.providerSessionId = sessionId;
        if (attachCwd) {
          attachSession.cwd = attachCwd;
        }
        const cwdInfo = attachCwd ? `\nCWD: ${attachCwd}` : "";
        await this.transport.sendText(chatId, `🔗 Attached to session: ${sessionId}${cwdInfo}`);
        break;
      }
    }
  }
}

const HELP_TEXT = `cc-lark-channel commands:

/new — Start new session
/stop — Stop current generation
/status — Show session info
/sessions — List all sessions
/bg [name] — Move current session to background
/fg <id> — Bring session to foreground
/kill <id> — Kill a background session
/attach <id> — Attach to an existing CLI session
/mode <mode> — Set permission mode
/model <name> — Switch model
/cd <path> — Change working directory (starts new session)
/help — Show this help

Special inputs:
! <text> — Interrupt + run new prompt
Plain text — Send to Claude (queues if busy)`;
