/**
 * Local IPC between the terminal-side tools (cc-session wrapper, cc-transfer)
 * and the running agent. Transport is a Unix domain socket; messages are
 * newline-delimited JSON.
 *
 * Two kinds of clients connect:
 *  - cc-session wrapper: opens a PERSISTENT control connection, registers its
 *    session, and listens for "resume" pushes (hand-back from Feishu).
 *  - cc-transfer (fallback, no wrapper): opens a one-shot connection, asks the
 *    agent to take over a session, then disconnects.
 */

/** Default socket path. Override with CC_LARK_IPC_SOCK. */
export function ipcSocketPath(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  return process.env["CC_LARK_IPC_SOCK"] ?? `${home}/.cc-lark-channel/agent.sock`;
}

/** Client (terminal tools) -> Agent */
export type IpcRequest =
  // wrapper registers a persistent control channel for a session
  | { type: "register"; sessionId: string; cwd: string; wrapperPid: number }
  // ask agent to take over a session in Feishu (create/associate group + bind)
  | { type: "transfer"; sessionId: string; cwd: string; hasWrapper: boolean }
  // wrapper acknowledges it has relaunched claude after a resume push
  | { type: "resumed"; sessionId: string };

/** Agent -> Client */
export type IpcResponse =
  | { type: "ok"; message?: string; chatId?: string; groupName?: string }
  | { type: "error"; message: string }
  // pushed to a registered wrapper to tell it to relaunch claude --resume
  | { type: "resume"; sessionId: string };

export function encode(msg: IpcRequest | IpcResponse): string {
  return JSON.stringify(msg) + "\n";
}

/** Split a buffered stream into complete JSON lines. Returns [messages, rest]. */
export function decodeLines(buffer: string): [Array<IpcRequest | IpcResponse>, string] {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const msgs: Array<IpcRequest | IpcResponse> = [];
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      msgs.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line
    }
  }
  return [msgs, rest];
}
