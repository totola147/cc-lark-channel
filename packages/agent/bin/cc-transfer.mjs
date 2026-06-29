#!/usr/bin/env node
/**
 * cc-transfer — 把当前 cc-session 会话转移到飞书。
 *
 * 两种触发方式，都只是给 wrapper 发 SIGUSR1，wrapper 自己解析当前会话：
 *  1) 在 claude 会话内（环境变量 CC_LARK_WRAPPER_PID 存在）：直接给该 wrapper 发信号。
 *  2) 带外（在另一个终端/tmux 窗格运行）：从 ~/.cc-lark-channel/wrappers/ 发现
 *     正在运行的 wrapper 并发信号。只有一个时直接命中；多个时用 cwd 或 pid 指定。
 *
 * 带外方式完全不经过 claude，不会污染会话历史。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME ?? homedir();
const DISCOVERY_DIR = join(HOME, ".cc-lark-channel", "wrappers");

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

function signal(pid, label) {
  try {
    process.kill(pid, "SIGUSR1");
    console.log(`→ 已通知 wrapper (PID ${pid}${label ? `, ${label}` : ""}) 转移会话至飞书。`);
    process.exit(0);
  } catch (err) {
    console.error(`✘ 无法通知 wrapper (PID ${pid}): ${err.message}`);
    process.exit(1);
  }
}

// 方式 1：在 claude 会话内，环境变量直达
const envPid = process.env.CC_LARK_WRAPPER_PID ? Number(process.env.CC_LARK_WRAPPER_PID) : 0;
if (envPid && isAlive(envPid)) {
  signal(envPid);
}

// 方式 2：带外发现
const arg = process.argv[2]; // 可选：cwd 或 pid，用于多 wrapper 时指定
let wrappers = [];
try {
  wrappers = readdirSync(DISCOVERY_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => { try { return JSON.parse(readFileSync(join(DISCOVERY_DIR, f), "utf-8")); } catch { return null; } })
    .filter(w => w && isAlive(w.pid));
} catch { /* 目录不存在 */ }

if (wrappers.length === 0) {
  console.error("✘ 未发现正在运行的 cc-session 会话。请用 cc-session 启动会话后再转移。");
  process.exit(1);
}

if (arg) {
  const match = wrappers.find(w => String(w.pid) === arg || w.cwd === arg);
  if (!match) {
    console.error(`✘ 未找到匹配 "${arg}" 的会话。当前在跑的：`);
    wrappers.forEach(w => console.error(`    pid=${w.pid}  cwd=${w.cwd}`));
    process.exit(1);
  }
  signal(match.pid, match.cwd);
}

if (wrappers.length === 1) {
  signal(wrappers[0].pid, wrappers[0].cwd);
}

// 多个 wrapper，需指定
console.error("发现多个正在运行的 cc-session 会话，请指定 cwd 或 pid：");
wrappers.forEach(w => console.error(`    cc-transfer ${w.cwd}    (pid=${w.pid})`));
process.exit(1);
