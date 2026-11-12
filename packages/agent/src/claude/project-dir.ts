import { existsSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code 截断项目目录名的长度上限（与 CLI 一致）。 */
const MAX_DIR_LEN = 200;

/** CLI 使用的 32 位字符串哈希（Java 风格），用于超长路径的后缀。 */
function cliHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * 把 cwd 编码成 `~/.claude/projects/` 下的目录名，规则与 Claude Code CLI 一致：
 * 所有非字母数字字符替换为 `-`；超过 200 字符时截断并追加原路径哈希。
 * 以前只替换 `/`，路径中带 `_`、`.`、空格等时找不到会话文件。
 */
export function encodeProjectDir(cwd: string): string {
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (enc.length <= MAX_DIR_LEN) return enc;
  return `${enc.slice(0, MAX_DIR_LEN)}-${Math.abs(cliHash(cwd)).toString(36)}`;
}

export function projectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/**
 * 找到 cwd 对应的项目目录。超长路径的哈希后缀在不同运行时可能不同，
 * 找不到精确匹配时按 200 字符前缀回退（CLI 自身也这样做）。
 */
export function resolveProjectDir(cwd: string, root: string = projectsRoot()): string | undefined {
  const exact = join(root, encodeProjectDir(cwd));
  if (existsSync(exact)) return exact;
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (enc.length <= MAX_DIR_LEN || !existsSync(root)) return undefined;
  const prefix = `${enc.slice(0, MAX_DIR_LEN)}-`;
  const hit = readdirSync(root).find((d) => d.startsWith(prefix));
  return hit ? join(root, hit) : undefined;
}

/** 会话 jsonl 的完整路径；找不到返回 undefined。 */
export function findSessionFile(cwd: string, sessionId: string, root: string = projectsRoot()): string | undefined {
  const dir = resolveProjectDir(cwd, root);
  if (!dir) return undefined;
  const f = join(dir, `${sessionId}.jsonl`);
  return existsSync(f) ? f : undefined;
}

/**
 * 在所有项目目录中查找会话，并从 jsonl 记录里读出真实 cwd。
 * 目录名编码有损（`-` 和 `/` 不可区分），不能反解，只能读文件内容。
 */
export function locateSession(sessionId: string, root: string = projectsRoot()): { file: string; cwd?: string } | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId) || !existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return { file, cwd: readCwdFromJsonl(file) };
  }
  return undefined;
}

/** 读 jsonl 头部（最多 256KB），返回第一条带 `cwd` 字段的记录的 cwd。 */
export function readCwdFromJsonl(file: string, maxBytes = 256 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const lines = buf.subarray(0, n).toString("utf-8").split("\n");
    // 最后一行可能被截断，JSON.parse 失败会被跳过
    for (const line of lines) {
      if (!line.includes('"cwd"')) continue;
      try {
        const rec = JSON.parse(line) as { cwd?: unknown };
        if (typeof rec.cwd === "string" && rec.cwd) return rec.cwd;
      } catch { /* 截断或非 JSON 行 */ }
    }
  } catch { /* 文件不可读 */ } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}
