import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../util/logger.js";
import type { PermissionMode } from "../types.js";

export interface SessionRecord {
  providerSessionId?: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  permissionMode: PermissionMode;
  model: string;
}

export interface StateData {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

const INITIAL_STATE: StateData = { version: 1, sessions: {} };

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
      this.state = JSON.parse(raw) as StateData;
      this.logger.info({ sessions: Object.keys(this.state.sessions).length }, "State loaded");
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

  getSession(chatId: string): SessionRecord | undefined {
    return this.state.sessions[chatId];
  }

  setSession(chatId: string, record: SessionRecord): void {
    this.state.sessions[chatId] = record;
  }

  deleteSession(chatId: string): void {
    delete this.state.sessions[chatId];
  }

  getAllSessions(): Record<string, SessionRecord> {
    return { ...this.state.sessions };
  }
}
