import type { Logger } from "../util/logger.js";
import type { LarkClient } from "../lark/client.js";
import type { StateStore } from "../persistence/store.js";
import { getProjectInfo } from "./project-info.js";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

export interface WorkspaceRecord {
  chatId: string;
  path: string;
  name: string;
  description: string;
  createdAt: string;
  ownerOpenId: string;
}

const MAX_WORKSPACES = 20;

export class WorkspaceManager {
  constructor(
    private readonly larkClient: LarkClient,
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

    const chatId = await this.larkClient.createGroup(groupName, groupDesc, ownerOpenId);

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
      await this.larkClient.dissolveGroup(chatId);
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
      // Return most recent by filename (UUID, not sortable by time — just pick last)
      return files[files.length - 1]!.replace(".jsonl", "");
    } catch {
      return undefined;
    }
  }
}
