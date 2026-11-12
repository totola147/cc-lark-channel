import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";

export interface DeviceCodeRecord {
  code: string;
  /** 只有发起配对的 CLI 持有；轮询取 token 时必须出示，防止他人截获 token。 */
  pollSecret: string;
  openId?: string;
  createdAt: Date;
  expiresAt: Date;
}

const CODE_TTL_MS = 5 * 60 * 1000;
const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class DeviceCodeManager {
  private readonly records = new Map<string, DeviceCodeRecord>();
  /** OAuth 回调后的短期会话：sessionId -> openId。避免把 open_id 放进 URL 再由客户端回传。 */
  private readonly oauthSessions = new Map<string, { openId: string; expiresAt: number }>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly logger: Logger) {
    this.timer = setInterval(() => this.cleanup(), 60000);
    this.timer.unref?.();
  }

  create(): DeviceCodeRecord {
    let code = this.generateCode();
    while (this.records.has(code)) code = this.generateCode();
    const record: DeviceCodeRecord = {
      code,
      pollSecret: randomBytes(24).toString("hex"),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    };
    this.records.set(code, record);
    this.logger.info({ code }, "Device code created");
    return record;
  }

  get(code: string): DeviceCodeRecord | undefined {
    const key = code.toUpperCase();
    const record = this.records.get(key);
    if (record && record.expiresAt < new Date()) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  /** 轮询：校验 pollSecret，未通过视同不存在。 */
  getForPoller(code: string, pollSecret: string | null | undefined): DeviceCodeRecord | undefined {
    const record = this.get(code);
    if (!record || !pollSecret || !safeEqual(record.pollSecret, pollSecret)) return undefined;
    return record;
  }

  /** 绑定只接受服务端 OAuth 会话解析出的 openId，不接受客户端直接提交的 openId。 */
  bindWithOAuthSession(code: string, oauthSessionId: string): boolean {
    const openId = this.resolveOAuthSession(oauthSessionId);
    if (!openId) return false;
    const record = this.get(code);
    if (!record || record.openId) return false;
    record.openId = openId;
    // 会话一次性使用
    this.oauthSessions.delete(oauthSessionId);
    this.logger.info({ code, openId }, "Device code bound");
    return true;
  }

  /** 配对完成、token 已下发后作废设备码，避免重复领取。 */
  consume(code: string): void {
    this.records.delete(code.toUpperCase());
  }

  createOAuthSession(openId: string): string {
    const id = randomBytes(24).toString("hex");
    this.oauthSessions.set(id, { openId, expiresAt: Date.now() + OAUTH_SESSION_TTL_MS });
    return id;
  }

  resolveOAuthSession(id: string | null | undefined): string | undefined {
    if (!id) return undefined;
    const s = this.oauthSessions.get(id);
    if (!s) return undefined;
    if (s.expiresAt < Date.now()) {
      this.oauthSessions.delete(id);
      return undefined;
    }
    return s.openId;
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  private cleanup(): void {
    const now = new Date();
    for (const [code, record] of this.records) {
      if (record.expiresAt < now) this.records.delete(code);
    }
    const t = Date.now();
    for (const [id, s] of this.oauthSessions) {
      if (s.expiresAt < t) this.oauthSessions.delete(id);
    }
  }

  private generateCode(): string {
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    }
    return code;
  }
}
