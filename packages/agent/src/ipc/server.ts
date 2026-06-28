import { createServer, type Socket, type Server } from "node:net";
import { unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../util/logger.js";
import { ipcSocketPath, encode, decodeLines, type IpcRequest, type IpcResponse } from "./protocol.js";

export interface TransferRequest {
  sessionId: string;
  cwd: string;
  hasWrapper: boolean;
}

export interface IpcHandlers {
  /** Take over a session in Feishu. Returns the chatId of the workspace group. */
  onTransfer(req: TransferRequest): Promise<{ chatId: string; message: string }>;
}

interface Wrapper {
  socket: Socket;
  cwd: string;
}

/**
 * Unix-socket server inside the agent. Tracks wrapper control connections by
 * sessionId so the agent can later push a "resume" (hand-back) to the terminal.
 */
export class IpcServer {
  private server: Server | null = null;
  private readonly sockPath: string;
  private readonly wrappers = new Map<string, Wrapper>();

  constructor(
    private readonly handlers: IpcHandlers,
    private readonly logger: Logger,
    sockPath?: string,
  ) {
    this.sockPath = sockPath ?? ipcSocketPath();
  }

  async start(): Promise<void> {
    const dir = dirname(this.sockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(this.sockPath)) {
      try { unlinkSync(this.sockPath); } catch { /* stale socket */ }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on("error", (err) => {
        this.logger.error({ err }, "IPC server error");
        reject(err);
      });
      this.server.listen(this.sockPath, () => {
        this.logger.info({ sock: this.sockPath }, "IPC server listening");
        resolve();
      });
    });
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";
    let registeredSessionId: string | null = null;

    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const [msgs, rest] = decodeLines(buffer);
      buffer = rest;
      for (const msg of msgs) {
        this.dispatch(msg as IpcRequest, socket, (sid) => { registeredSessionId = sid; });
      }
    });

    socket.on("close", () => {
      if (registeredSessionId && this.wrappers.get(registeredSessionId)?.socket === socket) {
        this.wrappers.delete(registeredSessionId);
        this.logger.info({ sessionId: registeredSessionId }, "Wrapper disconnected");
      }
    });
    socket.on("error", () => { /* client gone */ });
  }

  private async dispatch(msg: IpcRequest, socket: Socket, onRegister: (sid: string) => void): Promise<void> {
    try {
      if (msg.type === "register") {
        this.wrappers.set(msg.sessionId, { socket, cwd: msg.cwd });
        onRegister(msg.sessionId);
        this.logger.info({ sessionId: msg.sessionId, wrapperPid: msg.wrapperPid }, "Wrapper registered");
        this.send(socket, { type: "ok", message: "registered" });
        return;
      }

      if (msg.type === "resumed") {
        this.logger.info({ sessionId: msg.sessionId }, "Wrapper resumed claude");
        this.send(socket, { type: "ok" });
        return;
      }

      if (msg.type === "transfer") {
        const result = await this.handlers.onTransfer({
          sessionId: msg.sessionId,
          cwd: msg.cwd,
          hasWrapper: msg.hasWrapper,
        });
        this.send(socket, { type: "ok", message: result.message, chatId: result.chatId });
        return;
      }

      this.send(socket, { type: "error", message: `unknown request: ${(msg as { type: string }).type}` });
    } catch (err) {
      this.send(socket, { type: "error", message: (err as Error).message });
    }
  }

  /** Push a hand-back signal to the wrapper holding this session. Returns true if delivered. */
  pushResume(sessionId: string): boolean {
    const wrapper = this.wrappers.get(sessionId);
    if (!wrapper) return false;
    this.send(wrapper.socket, { type: "resume", sessionId });
    return true;
  }

  hasWrapper(sessionId: string): boolean {
    return this.wrappers.has(sessionId);
  }

  private send(socket: Socket, msg: IpcResponse): void {
    try { socket.write(encode(msg)); } catch { /* socket closed */ }
  }

  async stop(): Promise<void> {
    for (const { socket } of this.wrappers.values()) socket.destroy();
    this.wrappers.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    if (existsSync(this.sockPath)) {
      try { unlinkSync(this.sockPath); } catch { /* ignore */ }
    }
  }
}
