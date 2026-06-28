#!/usr/bin/env node
/**
 * cc-transfer — 在 cc cli 内运行，把当前会话转移到飞书。
 *
 * 两种工作方式：
 *  1) 有 cc-session 包装器（环境变量 CC_LARK_WRAPPER_PID 存在）：
 *     写 pending-transfer.json 并给包装器发 SIGUSR1，由包装器杀掉 claude
 *     后连 agent 发起 transfer。
 *  2) 无包装器：直接连 agent socket 发 transfer。若 claude 仍在运行，agent
 *     的安全闸门会拒绝；此时提示用户先退出 claude 再运行本命令。
 */
import { connect } from "node:net";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME ?? homedir();
const SOCK = process.env.CC_LARK_IPC_SOCK ?? join(HOME, ".cc-lark-channel/agent.sock");
const PENDING = join(HOME, ".cc-lark-channel/pending-transfer.json");

const sessionId = process.argv[2] ?? process.env.CLAUDE_CODE_SESSION_ID ?? "";
const cwd = process.cwd();

if (!sessionId) {
  console.error("✘ 无法确定会话 id。请在 Claude Code 会话中运行，或显式传入：cc-transfer <session-id>");
  process.exit(1);
}

const wrapperPid = process.env.CC_LARK_WRAPPER_PID ? Number(process.env.CC_LARK_WRAPPER_PID) : 0;

if (wrapperPid) {
  // 委托给包装器：它会杀掉 claude 再发起 transfer。
  mkdirSync(dirname(PENDING), { recursive: true });
  writeFileSync(PENDING, JSON.stringify({ sessionId, cwd }), "utf-8");
  try {
    process.kill(wrapperPid, "SIGUSR1");
    console.log(`→ 已通知包装器转移会话 ${sessionId} 至飞书。claude 即将退出。`);
    process.exit(0);
  } catch (err) {
    console.error(`✘ 无法通知包装器 (PID ${wrapperPid}): ${err.message}`);
    process.exit(1);
  }
}

// 无包装器：直接连 agent。
const sock = connect(SOCK);
let buf = "";

sock.on("connect", () => {
  sock.write(JSON.stringify({ type: "transfer", sessionId, cwd, hasWrapper: false }) + "\n");
});
sock.setEncoding("utf-8");
sock.on("data", (chunk) => {
  buf += chunk;
  const idx = buf.indexOf("\n");
  if (idx === -1) return;
  let resp;
  try { resp = JSON.parse(buf.slice(0, idx)); } catch { return; }
  if (resp.type === "ok") {
    console.log(`✓ 会话 ${sessionId} 已转移至飞书群组。请在飞书继续。`);
    process.exit(0);
  } else {
    console.error(`✘ 转移失败：${resp.message ?? "未知错误"}`);
    console.error("  若提示会话仍被终端持有，请先退出 claude，再运行 cc-transfer。");
    process.exit(1);
  }
});
sock.on("error", (err) => {
  console.error(`✘ 无法连接 agent (${SOCK}): ${err.message}`);
  console.error("  请确认 agent 正在运行。");
  process.exit(1);
});
