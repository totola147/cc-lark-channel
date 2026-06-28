import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../util/logger.js";
import type { PermissionMode } from "../types.js";

export interface SessionRecord {
  id: string;
  providerSessionId?: string;
  name?: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  permissionMode: PermissionMode;
  model: string;
}

export interface ChatRecord {
  foregroundId: string;
  sessions: Record<string, SessionRecord>;
}

export interface StateData {
  version: 2;
  chats: Record<string, ChatRecord>;
  workspaces?: Record<string, WorkspaceRecord>;
}

export interface WorkspaceRecord {
  chatId: string;
  path: string;
  name: string;
  description: string;
  createdAt: string;
  ownerOpenId: string;
  /** Claude Code session id bound to this group (one session ↔ one group). */
  sessionId?: string;
  /** True after a hand-back to the terminal: Feishu must not write until re-transfer. */
  released?: boolean;
}

const INITIAL_STATE: StateData = { version: 2, chats: {} };

export class StateStore {
  private state: StateData = INITIAL_STATE;
  private readonly filePath: string;

  constructor(
    private readonly stateDir: string,
    private readonly logger: Logger,
  ) {
    this.filePath = join(stateDir, "state.json");
  }

  async load(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data = JSON.parse(raw);
      if (data.version === 2) {
        this.state = data as StateData;
      } else {
        // Migrate v1 format
        this.state = INITIAL_STATE;
      }
      this.logger.info({ chats: Object.keys(this.state.chats).length }, "State loaded");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = INITIAL_STATE;
        this.logger.info("No existing state file, starting fresh");
      } else {
        throw err;
      }
    }
  }

  async save(): Promise<void> {
    const tmp = this.filePath + ".tmp";
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.filePath);
  }

  getChat(chatId: string): ChatRecord | undefined {
    return this.state.chats[chatId];
  }

  setChat(chatId: string, record: ChatRecord): void {
    this.state.chats[chatId] = record;
  }

  deleteChat(chatId: string): void {
    delete this.state.chats[chatId];
  }

  // Legacy compat
  getSession(chatId: string): SessionRecord | undefined {
    const chat = this.state.chats[chatId];
    if (!chat) return undefined;
    return chat.sessions[chat.foregroundId];
  }

  setSession(chatId: string, record: SessionRecord): void {
    if (!this.state.chats[chatId]) {
      this.state.chats[chatId] = { foregroundId: record.id, sessions: {} };
    }
    this.state.chats[chatId]!.sessions[record.id] = record;
  }

  deleteSession(chatId: string): void {
    delete this.state.chats[chatId];
  }

  getAllChats(): Record<string, ChatRecord> {
    return { ...this.state.chats };
  }

  /** Shallow copy of each chat's foreground session, keyed by chatId. */
  getAllSessions(): Record<string, SessionRecord> {
    const out: Record<string, SessionRecord> = {};
    for (const [chatId, chat] of Object.entries(this.state.chats)) {
      const fg = chat.sessions[chat.foregroundId];
      if (fg) out[chatId] = fg;
    }
    return out;
  }

  getWorkspace(chatId: string): WorkspaceRecord | undefined {
    return this.state.workspaces?.[chatId];
  }

  setWorkspace(chatId: string, record: WorkspaceRecord): void {
    if (!this.state.workspaces) this.state.workspaces = {};
    this.state.workspaces[chatId] = record;
  }

  deleteWorkspace(chatId: string): void {
    if (this.state.workspaces) delete this.state.workspaces[chatId];
  }

  getAllWorkspaces(): Record<string, WorkspaceRecord> {
    return { ...(this.state.workspaces ?? {}) };
  }
}
