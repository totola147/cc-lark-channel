import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code writes a marker file at ~/.claude/sessions/<pid>.json for every
 * live interactive session. We use these markers to detect whether a session
 * is still "owned" by a running terminal process, so we can refuse to resume
 * (take over) a session that is still open elsewhere.
 */
export interface SessionMarker {
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  updatedAt?: number;
  /** "interactive"（终端）或 "sdk"（Agent SDK 拉起的子进程）；旧版 CLI 没有该字段。 */
  kind?: string;
  /** 进程启动时间（/proc/<pid>/stat 第 22 字段，字符串），用于识别 PID 复用。 */
  procStart?: string;
}

export interface LiveOwner {
  pid: number;
  cwd: string;
  status: string;
}

/** Default returns true if the process is alive. Injectable for tests. */
function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs error checking without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 读取 /proc/<pid>/stat 的第 22 字段（starttime）。comm 字段可能含空格和括号，
 * 所以从最后一个 ")" 之后开始切分。非 Linux 或读取失败返回 undefined。
 */
function defaultProcStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // rest[0] 是第 3 字段（state），第 22 字段即 rest[19]
    return rest[19];
  } catch {
    return undefined;
  }
}

function defaultSessionsDir(): string {
  return join(homedir(), ".claude", "sessions");
}

/**
 * Find a live terminal process that currently owns the given Claude Code
 * session id. Returns null if no live owner exists (no marker, or the owning
 * pid is dead) — meaning the session is safe to resume / take over.
 */
export function getLiveSessionOwner(
  sessionId: string,
  opts: {
    sessionsDir?: string;
    isAlive?: (pid: number) => boolean;
    procStart?: (pid: number) => string | undefined;
  } = {},
): LiveOwner | null {
  if (!sessionId) return null;
  const dir = opts.sessionsDir ?? defaultSessionsDir();
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const procStart = opts.procStart ?? defaultProcStart;

  if (!existsSync(dir)) return null;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }

  for (const file of files) {
    let marker: SessionMarker;
    try {
      marker = JSON.parse(readFileSync(join(dir, file), "utf-8")) as SessionMarker;
    } catch {
      continue;
    }
    if (marker.sessionId !== sessionId) continue;
    // SDK 子进程（包括本 agent 自己拉起的）不算终端持有。
    if (marker.kind && marker.kind !== "interactive") continue;
    if (!isAlive(marker.pid)) continue;
    // PID 被复用：marker 记录的启动时间与当前进程不符，说明原进程已退出。
    if (marker.procStart) {
      const actual = procStart(marker.pid);
      if (actual !== undefined && actual !== marker.procStart) continue;
    }
    return { pid: marker.pid, cwd: marker.cwd, status: marker.status };
  }
  return null;
}
