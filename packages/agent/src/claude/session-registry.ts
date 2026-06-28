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
  opts: { sessionsDir?: string; isAlive?: (pid: number) => boolean } = {},
): LiveOwner | null {
  if (!sessionId) return null;
  const dir = opts.sessionsDir ?? defaultSessionsDir();
  const isAlive = opts.isAlive ?? defaultIsAlive;

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
    if (isAlive(marker.pid)) {
      return { pid: marker.pid, cwd: marker.cwd, status: marker.status };
    }
  }
  return null;
}
