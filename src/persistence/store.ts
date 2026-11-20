import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  sessionId?: string;
  released?: boolean;
}

/** 每次返回新对象：共享同一个常量会让多个 StateStore 互相污染。 */
function initialState(): StateData {
  return { version: 2, chats: {} };
}

export class StateStore {
  private state: StateData = initialState();
  private readonly filePath: string;
  /** 保存串行化：前一次写完再写下一次。 */
  private saveChain: Promise<void> = Promise.resolve();
  private saveSeq = 0;

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
        this.state = initialState();
      }
      this.logger.info({ chats: Object.keys(this.state.chats).length }, "State loaded");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = initialState();
        this.logger.info("No existing state file, starting fresh");
      } else {
        throw err;
      }
    }
  }

  /**
   * 原子写入 state.json。多个会话会并发调用（例如关机时每个会话各存一次），
   * 以前共用同一个 .tmp：一个先 rename 走，其余 rename 报 ENOENT；两次写入
   * 还可能在同一 tmp 里交错，生成损坏的 JSON。现在串行执行，且每次用独立 tmp。
   */
  save(): Promise<void> {
    const run = this.saveChain.then(() => this.writeNow());
    this.saveChain = run.catch(() => {});
    return run;
  }

  private async writeNow(): Promise<void> {
    // 目录可能被并发删除（如关机竞态），先确保存在
    await mkdir(this.stateDir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${++this.saveSeq}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(this.state, null, 2));
      await rename(tmp, this.filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
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

  // Workspace methods
  getWorkspace(chatId: string): WorkspaceRecord | undefined {
    return this.state.workspaces?.[chatId];
  }

  setWorkspace(chatId: string, record: WorkspaceRecord): void {
    if (!this.state.workspaces) this.state.workspaces = {};
    this.state.workspaces[chatId] = record;
  }

  deleteWorkspace(chatId: string): void {
    if (this.state.workspaces) {
      delete this.state.workspaces[chatId];
    }
  }

  getAllWorkspaces(): Record<string, WorkspaceRecord> {
    return { ...(this.state.workspaces ?? {}) };
  }
}
