import type { Logger } from "../util/logger.js";
import type { Transport } from "../transport/interface.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { AppConfig } from "../config.js";
import type { IncomingMessage, PermissionMode } from "../types.js";
import type { StateStore } from "../persistence/store.js";
import { ClaudeSession } from "./session.js";

interface ChatState {
  foregroundId: string;
  sessions: Map<string, ClaudeSession>;
}

export class SessionManager {
  private readonly chats = new Map<string, ChatState>();

  constructor(
    private readonly config: AppConfig,
    private readonly stateStore: StateStore,
    private readonly broker: PermissionBroker,
    private readonly transport: Transport,
    private readonly logger: Logger,
  ) {
    this.restoreFromState();
  }

  private restoreFromState(): void {
    const chatRecords = this.stateStore.getAllChats();
    for (const [chatId, chatRecord] of Object.entries(chatRecords)) {
      if (!chatRecord.sessions || Object.keys(chatRecord.sessions).length === 0) continue;
      const chat: ChatState = { foregroundId: chatRecord.foregroundId, sessions: new Map() };
      for (const [, rec] of Object.entries(chatRecord.sessions)) {
        const session = new ClaudeSession(
          chatId,
          this.config,
          this.transport,
          this.broker,
          this.logger.child({ chatId }),
          rec.cwd ?? this.config.claude.default_cwd,
          (rec.permissionMode as PermissionMode) ?? this.config.claude.permission_mode,
          rec.model ?? this.config.claude.default_model,
        );
        (session as unknown as { id: string }).id = rec.id;
        session.providerSessionId = rec.providerSessionId;
        if (rec.name) session.name = rec.name;
        this.attachTurnCallback(chatId, session);
        chat.sessions.set(session.id, session);
      }
      if (chat.sessions.size > 0) {
        if (!chat.sessions.has(chat.foregroundId)) {
          chat.foregroundId = chat.sessions.keys().next().value!;
        }
        this.chats.set(chatId, chat);
      }
    }
    if (this.chats.size > 0) {
      this.logger.info({ chats: this.chats.size }, "Restored sessions from state");
    }
  }

  getSession(chatId: string): ClaudeSession | undefined {
    const chat = this.chats.get(chatId);
    if (!chat) return undefined;
    return chat.sessions.get(chat.foregroundId);
  }

  getOrCreateSession(chatId: string): ClaudeSession {
    let chat = this.chats.get(chatId);
    if (!chat) {
      const session = this.createSession(chatId);
      chat = { foregroundId: session.id, sessions: new Map([[session.id, session]]) };
      this.chats.set(chatId, chat);
    }
    return chat.sessions.get(chat.foregroundId)!;
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const session = this.getOrCreateSession(msg.chatId);

    if (msg.text.startsWith("!")) {
      const newText = msg.text.slice(1).trim();
      await session.interrupt(newText || undefined);
      return;
    }

    let imageDataUris: string[] | undefined;
    if (msg.imageKeys.length > 0) {
      imageDataUris = [];
      for (const key of msg.imageKeys) {
        try {
          const buf = await this.transport.downloadImage(msg.messageId, key);
          const base64 = buf.toString("base64");
          imageDataUris.push(`data:image/png;base64,${base64}`);
        } catch (err) {
          this.logger.warn({ err, imageKey: key }, "Failed to download image");
        }
      }
    }

    const prompt = msg.text || (imageDataUris?.length ? "Please analyze this image." : "");
    if (!prompt && !imageDataUris?.length) return;

    const result = await session.submit(prompt, imageDataUris);

    if (result.kind === "queued") {
      await this.transport.sendText(msg.chatId, `📋 Queued (position ${result.position})`);
    } else if (result.kind === "rejected") {
      await this.transport.sendText(msg.chatId, "⚠️ Queue full, please wait");
    }

    this.persistChat(msg.chatId);
  }

  newSession(chatId: string): ClaudeSession {
    const chat = this.chats.get(chatId);
    if (chat) {
      const fg = chat.sessions.get(chat.foregroundId);
      if (fg) fg.interrupt();
    }
    this.broker.resetSession();

    const session = this.createFreshSession(chatId);
    if (chat) {
      chat.sessions.set(session.id, session);
      chat.foregroundId = session.id;
    } else {
      this.chats.set(chatId, { foregroundId: session.id, sessions: new Map([[session.id, session]]) });
    }
    this.stateStore.deleteSession(chatId);
    return session;
  }

  backgroundSession(chatId: string, name?: string): { bgSession: ClaudeSession; fgSession: ClaudeSession } | null {
    const chat = this.chats.get(chatId);
    if (!chat) return null;

    const bgSession = chat.sessions.get(chat.foregroundId);
    if (!bgSession) return null;

    if (name) bgSession.name = name;

    const fgSession = this.createSession(chatId);
    chat.sessions.set(fgSession.id, fgSession);
    chat.foregroundId = fgSession.id;

    this.persistChat(chatId);
    return { bgSession, fgSession };
  }

  foregroundSession(chatId: string, sessionId: string): ClaudeSession | null {
    const chat = this.chats.get(chatId);
    if (!chat) return null;

    const target = chat.sessions.get(sessionId)
      ?? [...chat.sessions.values()].find(s => s.name === sessionId);
    if (!target) return null;

    chat.foregroundId = target.id;
    this.persistChat(chatId);
    return target;
  }

  killSession(chatId: string, sessionId: string): boolean {
    const chat = this.chats.get(chatId);
    if (!chat) return false;

    const target = chat.sessions.get(sessionId)
      ?? [...chat.sessions.values()].find(s => s.name === sessionId);
    if (!target) return false;
    if (target.id === chat.foregroundId) return false;

    target.interrupt();
    chat.sessions.delete(target.id);
    this.persistChat(chatId);
    return true;
  }

  getSessionList(chatId: string): Array<{ id: string; name?: string; state: string; isForeground: boolean; providerSessionId?: string; cwd: string }> {
    const chat = this.chats.get(chatId);
    if (!chat) return [];

    return [...chat.sessions.values()].map(s => ({
      id: s.id,
      name: s.name,
      state: s.getState(),
      isForeground: s.id === chat.foregroundId,
      providerSessionId: s.providerSessionId,
      cwd: s.cwd,
    }));
  }

  async shutdown(): Promise<void> {
    for (const [chatId, chat] of this.chats) {
      for (const session of chat.sessions.values()) {
        await session.interrupt();
      }
      this.persistChat(chatId);
    }
  }

  private createSession(chatId: string): ClaudeSession {
    const saved = this.stateStore.getSession(chatId);
    const session = new ClaudeSession(
      chatId,
      this.config,
      this.transport,
      this.broker,
      this.logger.child({ chatId }),
      saved?.cwd ?? this.config.claude.default_cwd,
      saved?.permissionMode ?? this.config.claude.permission_mode,
      saved?.model ?? this.config.claude.default_model,
    );
    if (saved?.providerSessionId) {
      session.providerSessionId = saved.providerSessionId;
    }
    this.attachTurnCallback(chatId, session);
    return session;
  }

  private createFreshSession(chatId: string): ClaudeSession {
    const session = new ClaudeSession(
      chatId,
      this.config,
      this.transport,
      this.broker,
      this.logger.child({ chatId }),
      this.config.claude.default_cwd,
      this.config.claude.permission_mode,
      this.config.claude.default_model,
    );
    this.attachTurnCallback(chatId, session);
    return session;
  }

  private attachTurnCallback(chatId: string, session: ClaudeSession): void {
    session.onTurnComplete = () => {
      const chat = this.chats.get(chatId);
      if (chat && session.id !== chat.foregroundId) {
        this.transport.sendText(chatId, `🔔 Background session [${session.name || session.id}] finished`).catch(() => {});
      }
      this.persistChat(chatId);
    };
  }

  private persistChat(chatId: string): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const sessions: Record<string, { id: string; providerSessionId?: string; name?: string; cwd: string; createdAt: string; lastActiveAt: string; permissionMode: string; model: string }> = {};
    for (const [id, s] of chat.sessions) {
      sessions[id] = {
        id: s.id,
        providerSessionId: s.providerSessionId,
        name: s.name,
        cwd: s.cwd,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        permissionMode: s.permissionMode,
        model: s.model,
      };
    }
    this.stateStore.setChat(chatId, { foregroundId: chat.foregroundId, sessions });
    this.stateStore.save().catch((err) => {
      this.logger.warn({ err }, "Failed to persist state");
    });
  }
}
