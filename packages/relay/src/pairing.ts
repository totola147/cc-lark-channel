import type { Logger } from "pino";
import crypto from "node:crypto";

export interface PairingRecord {
  token: string;
  code: string;
  agentId: string;
  userId?: string;
  createdAt: Date;
  expiresAt: Date;
  paired: boolean;
}

export class PairingManager {
  private readonly records = new Map<string, PairingRecord>();
  private readonly codeToToken = new Map<string, string>();
  private readonly agentToToken = new Map<string, string>();

  constructor(private readonly logger: Logger) {}

  create(agentId: string): PairingRecord {
    const existing = this.agentToToken.get(agentId);
    if (existing) this.remove(existing);

    const token = crypto.randomUUID();
    const code = this.generateCode();
    const record: PairingRecord = {
      token,
      code,
      agentId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      paired: false,
    };

    this.records.set(token, record);
    this.codeToToken.set(code, token);
    this.agentToToken.set(agentId, token);
    this.logger.info({ agentId, code }, "Pairing created");
    return record;
  }

  pairByCode(code: string, userId: string): PairingRecord | null {
    const token = this.codeToToken.get(code.toUpperCase());
    if (!token) return null;

    const record = this.records.get(token);
    if (!record) return null;
    if (record.expiresAt < new Date()) {
      this.remove(token);
      return null;
    }

    record.userId = userId;
    record.paired = true;
    this.logger.info({ agentId: record.agentId, userId, code }, "Pairing completed");
    return record;
  }

  getByToken(token: string): PairingRecord | undefined {
    const record = this.records.get(token);
    if (record && record.expiresAt < new Date()) {
      this.remove(token);
      return undefined;
    }
    return record;
  }

  getByAgentId(agentId: string): PairingRecord | undefined {
    const token = this.agentToToken.get(agentId);
    if (!token) return undefined;
    return this.getByToken(token);
  }

  private remove(token: string): void {
    const record = this.records.get(token);
    if (record) {
      this.codeToToken.delete(record.code);
      this.agentToToken.delete(record.agentId);
      this.records.delete(token);
    }
  }

  private generateCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }
}
