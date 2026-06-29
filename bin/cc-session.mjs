#!/usr/bin/env node
/**
 * cc-session — claude 的生命周期包装器，配合飞书双向交接。
 *
 *  - 像平时一样启动 claude（透传所有参数与 stdio）。
 *  - 在 claude 内运行 cc-transfer 时，cc-transfer 给本进程发 SIGUSR1：
 *    包装器杀掉 claude → 连 agent → 注册控制连接 + 发起 transfer → 等待。
 *  - 飞书群里 /handback 时，agent 经控制连接推送 resume：
 *    包装器重新 `claude --resume <sessionId>`，回到终端。
 *  - claude 正常退出（用户 /exit）则包装器一并退出。
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { readFileSync, existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HOME = process.env.HOME ?? homedir();
const SOCK = process.env.CC_LARK_IPC_SOCK ?? join(HOME, ".cc-lark-channel/agent.sock");
const PENDING = join(HOME, ".cc-lark-channel/pending-transfer.json");
const CLAUDE_BIN = process.env.CC_LARK_CLAUDE_BIN ?? "claude";
const TRANSFER_BIN = join(dirname(fileURLToPath(import.meta.url)), "cc-transfer.mjs");

let child = null;          // 当前 claude 子进程
let intentionalKill = false; // 是否为转移而主动杀
let currentSessionId = ""; // 已知的会话 id（resume 用）
let pendingTransfer = null; // 待发起的转移 {sessionId, cwd}，在 claude 退出后发送

// 解析启动参数：把 --resume <id>（或 -r <id> / --resume=<id>）单独提取出来作为初始恢复会话，
// 其余参数（如 --dangerously-skip-permissions、--model 等）全部原样透传给 claude。
let initialResumeId;
let extraArgs = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resume" || a === "-r") {
      if (argv[i + 1] && !argv[i + 1].startsWith("-")) { initialResumeId = argv[++i]; }
      else { extraArgs.push(a); } // 裸 --resume（交互式选择会话）：原样透传给 claude
    } else if (a.startsWith("--resume=")) {
      initialResumeId = a.slice("--resume=".length);
    } else {
      extraArgs.push(a);
    }
  }
}

function log(msg) { process.stderr.write(`[cc-session] ${msg}\n`); }

function spawnClaude(resumeId) {
  const args = resumeId ? ["--resume", resumeId, ...extraArgs] : [...extraArgs];
  log(resumeId ? `恢复会话 ${resumeId}` : "启动 claude");
  const binDir = dirname(TRANSFER_BIN);
  child = spawn(CLAUDE_BIN, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      CC_LARK_WRAPPER_PID: String(process.pid),
      CC_LARK_IPC_SOCK: SOCK,
      CC_LARK_TRANSFER_BIN: TRANSFER_BIN,
      // 把 bin 目录加入 PATH，使 /transfer 命令体可用裸名 `cc-transfer`（避免 $VAR 触发 simple_expansion）
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
  child.on("exit", (code) => {
    if (intentionalKill) {
      intentionalKill = false; // 转移触发，等待 resume，不退出包装器
      // claude 已退出，置空 child：等待 handback 期间 Ctrl+C 才能让 wrapper 退出
      // （否则信号处理器会去 kill 已死进程，导致卡死）。
      child = null;
      // claude 已真正退出（PID 已死），现在发起 transfer 才能通过 agent 的存活闸门。
      if (pendingTransfer) {
        const { sessionId, cwd } = pendingTransfer;
        pendingTransfer = null;
        // 给 OS 一点时间回收 PID，确保闸门判定为已死。
        setTimeout(() => doTransferAndWait(sessionId, cwd), 300);
      }
      return;
    }
    // 用户正常退出 → 输出本次 sessionID，方便后续 cc-session --resume <id> 再次进入
    const info = resolveChildSession();
    const sid = info?.sessionId || currentSessionId;
    if (sid) {
      process.stderr.write(`\n[cc-session] 本次会话 ID: ${sid}\n`);
      process.stderr.write(`[cc-session] 再次进入:  cc-session --resume ${sid}\n`);
    }
    process.exit(code ?? 0);
  });
}

function readPending() {
  try {
    const data = JSON.parse(readFileSync(PENDING, "utf-8"));
    if (existsSync(PENDING)) unlinkSync(PENDING);
    return data;
  } catch {
    return null;
  }
}

/**
 * 从当前 claude 子进程的会话标记文件解析 sessionId + cwd。
 * Claude Code 为每个交互会话写 ~/.claude/sessions/<pid>.json。
 * 这样任何触发方式只需给 wrapper 发 SIGUSR1，无需传递会话信息。
 */
function resolveChildSession() {
  if (!child || !child.pid) return null;
  const marker = join(HOME, ".claude", "sessions", `${child.pid}.json`);
  try {
    const m = JSON.parse(readFileSync(marker, "utf-8"));
    if (m.sessionId) return { sessionId: m.sessionId, cwd: m.cwd || process.cwd() };
  } catch { /* 标记还没写出 */ }
  return null;
}

function triggerTransfer() {
  // 优先用 claude 子进程的实时会话标记；兜底用 pending 文件（旧路径）。
  let info = resolveChildSession() || readPending();
  if (!info || !info.sessionId) {
    log("收到转移信号，但无法确定当前会话（claude 未就绪？），忽略");
    return;
  }
  currentSessionId = info.sessionId;
  log(`转移会话 ${currentSessionId} 至飞书，正在退出 claude...`);
  pendingTransfer = { sessionId: info.sessionId, cwd: info.cwd };
  intentionalKill = true;
  if (child) child.kill("SIGTERM");
  else {
    const { sessionId, cwd } = pendingTransfer;
    pendingTransfer = null;
    doTransferAndWait(sessionId, cwd);
  }
}

// === 转移：收到 SIGUSR1（来自 cc-transfer，无论在 claude 内还是带外终端）===
process.on("SIGUSR1", () => triggerTransfer());

// 透传常见信号
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { removeDiscovery(); if (child) child.kill(sig); else process.exit(0); });
}
process.on("exit", () => removeDiscovery());

// 发布发现文件，供带外的 cc-transfer 找到本 wrapper 并发信号
const DISCOVERY_DIR = join(HOME, ".cc-lark-channel", "wrappers");
const DISCOVERY_FILE = join(DISCOVERY_DIR, `${process.pid}.json`);
function writeDiscovery() {
  try {
    mkdirSync(DISCOVERY_DIR, { recursive: true });
    writeFileSync(DISCOVERY_FILE, JSON.stringify({ pid: process.pid, cwd: process.cwd(), startedAt: Date.now() }));
  } catch { /* 忽略 */ }
}
function removeDiscovery() {
  try { if (existsSync(DISCOVERY_FILE)) unlinkSync(DISCOVERY_FILE); } catch { /* 忽略 */ }
}
writeDiscovery();

// 入口
spawnClaude(initialResumeId);

// === 控制连接：注册 + 发起 transfer，并监听 resume 推送 ===
let ctrl = null;
let ctrlBuf = "";

function ensureControlConnection() {
  if (ctrl) return ctrl;
  ctrl = connect(SOCK);
  ctrl.setEncoding("utf-8");
  ctrl.on("data", (chunk) => {
    ctrlBuf += chunk;
    let idx;
    while ((idx = ctrlBuf.indexOf("\n")) !== -1) {
      const line = ctrlBuf.slice(0, idx).trim();
      ctrlBuf = ctrlBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handleControlMessage(msg);
    }
  });
  ctrl.on("error", (err) => {
    log(`控制连接错误：${err.message}`);
  });
  ctrl.on("close", () => { ctrl = null; });
  return ctrl;
}

function handleControlMessage(msg) {
  if (msg.type === "resume" && msg.sessionId) {
    log(`收到交还，重新激活 cc cli（会话 ${msg.sessionId}）`);
    currentSessionId = msg.sessionId;
    spawnClaude(msg.sessionId);
    try { ctrl?.write(JSON.stringify({ type: "resumed", sessionId: msg.sessionId }) + "\n"); } catch {}
  } else if (msg.type === "ok" && msg.chatId) {
    // transfer 成功响应（带群名）；register 的 ok 无 chatId，忽略。
    const name = msg.groupName ? `「${msg.groupName}」` : "";
    log(`已转移至飞书群${name}，等待该群 /handback 交还...（若群已关闭/不再交还，按 Ctrl+C 退出）`);
  } else if (msg.type === "error") {
    log(`agent 报错：${msg.message}`);
  }
}

function doTransferAndWait(sessionId, cwd) {
  const c = ensureControlConnection();
  const send = () => {
    // 先注册持久控制连接（用于接收 resume），再发起 transfer。
    c.write(JSON.stringify({ type: "register", sessionId, cwd, wrapperPid: process.pid }) + "\n");
    c.write(JSON.stringify({ type: "transfer", sessionId, cwd, hasWrapper: true }) + "\n");
    log(`正在请求转移会话 ${sessionId} 至飞书...`);
  };
  if (c.connecting) c.once("connect", send); else send();
}

