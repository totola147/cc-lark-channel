import type { Logger } from "../util/logger.js";
import type { Transport } from "../transport/interface.js";
import type { StateStore } from "../persistence/store.js";
import { getProjectInfo } from "./project-info.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";

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

const MAX_WORKSPACES = 20;

export class WorkspaceManager {
  constructor(
    private readonly transport: Transport,
    private readonly stateStore: StateStore,
    private readonly logger: Logger,
  ) {}

  async create(path: string, ownerOpenId: string): Promise<WorkspaceRecord | { error: string }> {
    const all = this.list(ownerOpenId);
    if (all.length >= MAX_WORKSPACES) {
      return { error: `Workspace limit reached (max ${MAX_WORKSPACES})` };
    }

    const existing = this.getByPath(path);
    if (existing) {
      return { error: `Workspace already exists for ${path} (group: ${existing.chatId})` };
    }

    const info = getProjectInfo(path);
    const groupName = `CC: ${info.name}`;
    const groupDesc = info.description
      ? `${info.description}\n📂 ${path}`
      : `📂 ${path}`;

    const chatId = await this.transport.createGroup(groupName, groupDesc, ownerOpenId);

    const record: WorkspaceRecord = {
      chatId,
      path,
      name: info.name,
      description: info.description,
      createdAt: new Date().toISOString(),
      ownerOpenId,
    };

    this.stateStore.setWorkspace(chatId, record);
    await this.stateStore.save();
    this.logger.info({ chatId, path, name: info.name }, "Workspace created");
    return record;
  }

  async close(chatId: string): Promise<boolean> {
    const record = this.stateStore.getWorkspace(chatId);
    if (!record) return false;

    try {
      await this.transport.dissolveGroup(chatId);
    } catch (err) {
      this.logger.warn({ err, chatId }, "Failed to dissolve group");
    }

    this.stateStore.deleteWorkspace(chatId);
    this.stateStore.deleteChat(chatId);
    await this.stateStore.save();
    this.logger.info({ chatId }, "Workspace closed");
    return true;
  }

  list(ownerOpenId?: string): WorkspaceRecord[] {
    const all = this.stateStore.getAllWorkspaces();
    if (!ownerOpenId) return Object.values(all);
    return Object.values(all).filter(w => w.ownerOpenId === ownerOpenId);
  }

  getByPath(path: string): WorkspaceRecord | undefined {
    const all = this.stateStore.getAllWorkspaces();
    return Object.values(all).find(w => w.path === path);
  }

  getBySessionId(sessionId: string): WorkspaceRecord | undefined {
    const all = this.stateStore.getAllWorkspaces();
    return Object.values(all).find(w => w.sessionId === sessionId);
  }

  /**
   * Find or create a Feishu group bound to a specific Claude Code session.
   * One session ↔ one group. If a group for the session already exists it is
   * reused (and un-released); otherwise a new group is created.
   */
  async findOrCreateForSession(
    path: string,
    sessionId: string,
    ownerOpenId: string,
  ): Promise<{ record: WorkspaceRecord; created: boolean } | { error: string }> {
    const existing = this.getBySessionId(sessionId);
    if (existing) {
      existing.released = false;
      this.stateStore.setWorkspace(existing.chatId, existing);
      await this.stateStore.save();
      return { record: existing, created: false };
    }

    if (this.list(ownerOpenId).length >= MAX_WORKSPACES) {
      return { error: `Workspace limit reached (max ${MAX_WORKSPACES})` };
    }

    const info = getProjectInfo(path);
    const groupName = `CC: ${info.name}`;
    const groupDesc = info.description ? `${info.description}\n📂 ${path}` : `📂 ${path}`;
    const chatId = await this.transport.createGroup(groupName, groupDesc, ownerOpenId);

    const record: WorkspaceRecord = {
      chatId,
      path,
      name: info.name,
      description: info.description,
      createdAt: new Date().toISOString(),
      ownerOpenId,
      sessionId,
      released: false,
    };
    this.stateStore.setWorkspace(chatId, record);
    await this.stateStore.save();
    this.logger.info({ chatId, path, sessionId, name: info.name }, "Workspace created for session");
    return { record, created: true };
  }

  /** Mark a group as released (handed back to the terminal). */
  async release(chatId: string): Promise<WorkspaceRecord | undefined> {
    const record = this.stateStore.getWorkspace(chatId);
    if (!record) return undefined;
    record.released = true;
    this.stateStore.setWorkspace(chatId, record);
    await this.stateStore.save();
    this.logger.info({ chatId, sessionId: record.sessionId }, "Workspace released to terminal");
    return record;
  }

  isReleased(chatId: string): boolean {
    return !!this.stateStore.getWorkspace(chatId)?.released;
  }

  getByChatId(chatId: string): WorkspaceRecord | undefined {
    return this.stateStore.getWorkspace(chatId);
  }

  isWorkspaceChat(chatId: string): boolean {
    return !!this.stateStore.getWorkspace(chatId);
  }

  getLatestSessionId(path: string): string | undefined {
    const projectsDir = `${homedir()}/.claude/projects`;
    const encoded = path.replace(/\//g, "-");
    const dir = `${projectsDir}/${encoded}`;
    if (!existsSync(dir)) return undefined;

    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
      if (files.length === 0) return undefined;
      // Pick the most recently modified jsonl (filenames are UUIDs, not time-sortable).
      let latest = files[0]!;
      let latestMtime = statSync(`${dir}/${latest}`).mtimeMs;
      for (const f of files.slice(1)) {
        const m = statSync(`${dir}/${f}`).mtimeMs;
        if (m > latestMtime) { latest = f; latestMtime = m; }
      }
      return latest.replace(".jsonl", "");
    } catch {
      return undefined;
    }
  }
}
