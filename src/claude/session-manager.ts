import type { Logger } from "../util/logger.js";
import type { LarkClient } from "../lark/client.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { AppConfig } from "../config.js";
import type { IncomingMessage, PermissionMode } from "../types.js";
import type { StateStore, SessionRecord } from "../persistence/store.js";
import { ClaudeSession } from "./session.js";
import { detectImageMime } from "../util/image-mime.js";

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
    private readonly larkClient: LarkClient,
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
          this.larkClient,
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
      await session.interrupt(newText || undefined, msg.senderOpenId);
      return;
    }

    let imageDataUris: string[] | undefined;
    if (msg.imageKeys.length > 0) {
      imageDataUris = [];
      for (const key of msg.imageKeys) {
        try {
          const buf = await this.larkClient.downloadImage(msg.messageId, key);
          const mime = detectImageMime(buf);
          if (!mime) {
            this.logger.warn({ imageKey: key }, "Unsupported image format, skipping");
            continue;
          }
          imageDataUris.push(`data:${mime};base64,${buf.toString("base64")}`);
        } catch (err) {
          this.logger.warn({ err, imageKey: key }, "Failed to download image");
        }
      }
    }

    const prompt = msg.text || (imageDataUris?.length ? "Please analyze this image." : "");
    if (!prompt && !imageDataUris?.length) return;

    const result = await session.submit(prompt, imageDataUris, msg.senderOpenId);

    if (result.kind === "queued") {
      await this.larkClient.sendText(msg.chatId, `📋 Queued (position ${result.position})`);
    } else if (result.kind === "rejected") {
      await this.larkClient.sendText(msg.chatId, "⚠️ Queue full, please wait");
    }

    this.persistChat(msg.chatId);
  }

  /**
   * 用一个全新会话替换前台会话。后台会话保持不变并持久化——以前这里调用
   * stateStore.deleteSession(chatId)（已移除）会删掉整个 chat 记录，重启后后台会话全丢。
   */
  async newSession(chatId: string): Promise<ClaudeSession> {
    const chat = this.chats.get(chatId);
    const old = chat?.sessions.get(chat.foregroundId);
    if (old) {
      await old.interrupt();
      old.dispose();
      chat!.sessions.delete(old.id);
    }

    const session = this.createFreshSession(chatId);
    if (chat) {
      chat.sessions.set(session.id, session);
      chat.foregroundId = session.id;
    } else {
      this.chats.set(chatId, { foregroundId: session.id, sessions: new Map([[session.id, session]]) });
    }
    this.persistChat(chatId);
    return session;
  }

  backgroundSession(chatId: string, name?: string): { bgSession: ClaudeSession; fgSession: ClaudeSession } | null {
    const chat = this.chats.get(chatId);
    if (!chat) return null;

    const bgSession = chat.sessions.get(chat.foregroundId);
    if (!bgSession) return null;

    if (name) bgSession.name = name;

    const fgSession = this.createFreshSession(chatId);
    fgSession.cwd = bgSession.cwd;
    chat.sessions.set(fgSession.id, fgSession);
    chat.foregroundId = fgSession.id;

    this.persistChat(chatId);
    return { bgSession, fgSession };
  }

  foregroundSession(chatId: string, sessionId: string): ClaudeSession | null {
    const chat = this.chats.get(chatId);
    if (!chat) return null;

    const target = this.findSession(chat, sessionId);
    if (!target) return null;

    chat.foregroundId = target.id;
    this.persistChat(chatId);
    return target;
  }

  async killSession(chatId: string, sessionId: string): Promise<boolean> {
    const chat = this.chats.get(chatId);
    if (!chat) return false;

    const target = this.findSession(chat, sessionId);
    if (!target) return false;
    if (target.id === chat.foregroundId) return false;

    chat.sessions.delete(target.id);
    await target.interrupt();
    target.dispose();
    this.persistChat(chatId);
    return true;
  }

  async killAll(chatId: string): Promise<number> {
    const chat = this.chats.get(chatId);
    if (!chat) return 0;
    const victims = [...chat.sessions.values()];
    chat.sessions.clear();
    await Promise.all(victims.map(async (session) => {
      await session.interrupt();
      session.dispose();
    }));
    const count = victims.length;
    const fresh = this.createFreshSession(chatId);
    chat.sessions.set(fresh.id, fresh);
    chat.foregroundId = fresh.id;
    this.persistChat(chatId);
    return count;
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

  private findSession(chat: ChatState, identifier: string): ClaudeSession | undefined {
    return chat.sessions.get(identifier)
      ?? [...chat.sessions.values()].find(s => s.providerSessionId === identifier)
      ?? [...chat.sessions.values()].find(s => s.name === identifier);
  }

  private createSession(chatId: string): ClaudeSession {
    const saved = this.stateStore.getSession(chatId);
    const session = new ClaudeSession(
      chatId,
      this.config,
      this.larkClient,
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
      this.larkClient,
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
        this.larkClient.sendText(chatId, `🔔 Background session [${session.name || session.providerSessionId || session.id}] finished`).catch(() => {});
      }
      this.persistChat(chatId);
    };
  }

  private persistChat(chatId: string): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const sessions: Record<string, SessionRecord> = {};
    const prev = this.stateStore.getChat(chatId)?.sessions ?? {};
    const now = new Date().toISOString();
    for (const [id, s] of chat.sessions) {
      sessions[id] = {
        id: s.id,
        providerSessionId: s.providerSessionId,
        name: s.name,
        cwd: s.cwd,
        // 保留首次创建时间；以前每次持久化都被覆盖成当前时间
        createdAt: prev[id]?.createdAt ?? now,
        lastActiveAt: now,
        permissionMode: s.permissionMode as PermissionMode,
        model: s.model,
      };
    }
    this.stateStore.setChat(chatId, { foregroundId: chat.foregroundId, sessions });
    this.stateStore.save().catch((err) => {
      this.logger.warn({ err }, "Failed to persist state");
    });
  }
}
