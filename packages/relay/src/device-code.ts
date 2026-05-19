import type { Logger } from "pino";

export interface DeviceCodeRecord {
  code: string;
  openId?: string;
  createdAt: Date;
  expiresAt: Date;
}

export class DeviceCodeManager {
  private readonly records = new Map<string, DeviceCodeRecord>();

  constructor(private readonly logger: Logger) {
    // Clean expired codes every 60s
    setInterval(() => this.cleanup(), 60000);
  }

  create(): DeviceCodeRecord {
    const code = this.generateCode();
    const record: DeviceCodeRecord = {
      code,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    };
    this.records.set(code, record);
    this.logger.info({ code }, "Device code created");
    return record;
  }

  get(code: string): DeviceCodeRecord | undefined {
    const record = this.records.get(code.toUpperCase());
    if (record && record.expiresAt < new Date()) {
      this.records.delete(code.toUpperCase());
      return undefined;
    }
    return record;
  }

  bind(code: string, openId: string): boolean {
    const record = this.get(code.toUpperCase());
    if (!record) return false;
    record.openId = openId;
    this.logger.info({ code, openId }, "Device code bound");
    return true;
  }

  private cleanup(): void {
    const now = new Date();
    for (const [code, record] of this.records) {
      if (record.expiresAt < now) this.records.delete(code);
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
