import type { Logger } from "../util/logger.js";
import type { LarkClient } from "../lark/client.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { AppConfig } from "../config.js";
import type { IncomingMessage } from "../types.js";
import type { StateStore } from "../persistence/store.js";
import { ClaudeSession } from "./session.js";

export class SessionManager {
  private readonly sessions = new Map<string, ClaudeSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly stateStore: StateStore,
    private readonly broker: PermissionBroker,
    private readonly larkClient: LarkClient,
    private readonly logger: Logger,
  ) {}

  getSession(chatId: string): ClaudeSession | undefined {
    return this.sessions.get(chatId);
  }

  getOrCreateSession(chatId: string): ClaudeSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      const saved = this.stateStore.getSession(chatId);
      session = new ClaudeSession(
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
      this.sessions.set(chatId, session);
    }
    return session;
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const session = this.getOrCreateSession(msg.chatId);

    // Handle ! prefix interrupt
    if (msg.text.startsWith("!")) {
      const newText = msg.text.slice(1).trim();
      await session.interrupt(newText || undefined);
      return;
    }

    // Download images from Lark if present
    let imageDataUris: string[] | undefined;
    if (msg.imageKeys.length > 0) {
      imageDataUris = [];
      for (const key of msg.imageKeys) {
        try {
          const buf = await this.larkClient.downloadImage(msg.messageId, key);
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
      await this.larkClient.sendText(msg.chatId, `📋 Queued (position ${result.position})`);
    } else if (result.kind === "rejected") {
      await this.larkClient.sendText(msg.chatId, "⚠️ Queue full, please wait");
    }

    // Persist session state
    this.persistSession(msg.chatId, session);
  }

  newSession(chatId: string): ClaudeSession {
    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.interrupt();
    }
    this.broker.resetSession();

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
    this.sessions.set(chatId, session);
    this.stateStore.deleteSession(chatId);
    return session;
  }

  private persistSession(chatId: string, session: ClaudeSession): void {
    this.stateStore.setSession(chatId, {
      providerSessionId: session.providerSessionId,
      cwd: session.cwd,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      permissionMode: session.permissionMode,
      model: session.model,
    });
    this.stateStore.save().catch((err) => {
      this.logger.warn({ err }, "Failed to persist state");
    });
  }

  async shutdown(): Promise<void> {
    for (const [chatId, session] of this.sessions) {
      await session.interrupt();
      this.persistSession(chatId, session);
    }
  }
}
