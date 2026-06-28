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
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME ?? homedir();
const SOCK = process.env.CC_LARK_IPC_SOCK ?? join(HOME, ".cc-lark-channel/agent.sock");
const PENDING = join(HOME, ".cc-lark-channel/pending-transfer.json");
const CLAUDE_BIN = process.env.CC_LARK_CLAUDE_BIN ?? "claude";

let child = null;          // 当前 claude 子进程
let intentionalKill = false; // 是否为转移而主动杀
let currentSessionId = ""; // 已知的会话 id（resume 用）
let pendingTransfer = null; // 待发起的转移 {sessionId, cwd}，在 claude 退出后发送
let extraArgs = process.argv.slice(2); // 透传给 claude 的参数

function log(msg) { process.stderr.write(`[cc-session] ${msg}\n`); }

function spawnClaude(resumeId) {
  const args = resumeId ? ["--resume", resumeId, ...extraArgs] : [...extraArgs];
  log(resumeId ? `恢复会话 ${resumeId}` : "启动 claude");
  child = spawn(CLAUDE_BIN, args, {
    stdio: "inherit",
    env: { ...process.env, CC_LARK_WRAPPER_PID: String(process.pid), CC_LARK_IPC_SOCK: SOCK },
  });
  child.on("exit", (code) => {
    if (intentionalKill) {
      intentionalKill = false; // 转移触发，等待 resume，不退出包装器
      // claude 已真正退出（PID 已死），现在发起 transfer 才能通过 agent 的存活闸门。
      if (pendingTransfer) {
        const { sessionId, cwd } = pendingTransfer;
        pendingTransfer = null;
        // 给 OS 一点时间回收 PID，确保闸门判定为已死。
        setTimeout(() => doTransferAndWait(sessionId, cwd), 300);
      }
      return;
    }
    // 用户正常退出 → 包装器退出
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

// === 转移：收到 cc-transfer 的 SIGUSR1 ===
process.on("SIGUSR1", () => {
  const pending = readPending();
  if (!pending || !pending.sessionId) {
    log("收到转移信号，但未找到 pending-transfer，忽略");
    return;
  }
  currentSessionId = pending.sessionId;
  log(`转移会话 ${currentSessionId} 至飞书，正在退出 claude...`);
  pendingTransfer = { sessionId: pending.sessionId, cwd: pending.cwd };
  intentionalKill = true;
  // transfer 在 child 的 exit 事件里发起（见 spawnClaude）。
  if (child) child.kill("SIGTERM");
  else if (pendingTransfer) {
    const { sessionId, cwd } = pendingTransfer;
    pendingTransfer = null;
    doTransferAndWait(sessionId, cwd);
  }
});

// 透传常见信号
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { if (child) child.kill(sig); else process.exit(0); });
}

// 入口
spawnClaude(undefined);

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
    log(`已请求转移会话 ${sessionId}，等待飞书侧 /handback 交还...`);
  };
  if (c.connecting) c.once("connect", send); else send();
}

