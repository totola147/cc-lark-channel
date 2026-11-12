import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "pino";

/**
 * Agent 鉴权 token 存储。
 *
 * 配对成功时为 openId 签发一个随机 token，只持久化其 sha256，明文只在
 * 设备码轮询结果里下发一次。WS auth 必须携带与 openId 匹配的 token，
 * 否则任何知道 openId 的人都能冒充 agent 接收消息和审批卡片。
 */
interface TokenRecord {
  openId: string;
  createdAt: string;
}

interface StoreFile {
  version: 1;
  tokens: Record<string, TokenRecord>; // sha256(token) -> record
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthStore {
  private data: StoreFile = { version: 1, tokens: {} };

  constructor(
    private readonly filePath: string | null,
    private readonly logger: Logger,
  ) {
    this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as StoreFile;
      if (raw && raw.version === 1 && raw.tokens && typeof raw.tokens === "object") {
        this.data = raw;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err, file: this.filePath }, "Failed to load auth store, starting empty");
      }
    }
  }

  private save(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
    try { chmodSync(this.filePath, 0o600); } catch { /* best effort */ }
  }

  /** 为 openId 签发新 token，返回明文（仅此一次可见）。 */
  issue(openId: string): string {
    const token = randomBytes(32).toString("hex");
    this.data.tokens[hashToken(token)] = { openId, createdAt: new Date().toISOString() };
    this.save();
    return token;
  }

  /** token 是否属于 openId。常量时间比较哈希，避免时序侧信道。 */
  verify(openId: string, token: string | undefined): boolean {
    if (!openId || !token) return false;
    const h = hashToken(token);
    const rec = this.data.tokens[h];
    if (!rec) return false;
    const a = Buffer.from(rec.openId);
    const b = Buffer.from(openId);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** 吊销某 openId 的全部 token。 */
  revokeAll(openId: string): number {
    let n = 0;
    for (const [h, rec] of Object.entries(this.data.tokens)) {
      if (rec.openId === openId) {
        delete this.data.tokens[h];
        n++;
      }
    }
    if (n) this.save();
    return n;
  }
}
