# CLAUDE.md

## 项目概述

cc-lark-channel 是一个飞书（Lark）↔ Claude Code 桥接工具，让用户通过飞书远程操控 Claude Code。v2.0 支持 SaaS 模式（共享 Bot + Relay）和自部署模式（直连飞书）。

## 架构

### v2.0 双模式架构

```
模式 A（共享 Bot — SaaS）:
┌────────────┐     ┌─────────────┐     ┌──────────────┐     ┌────────────┐
│ 飞书用户    │────▶│ Cloud Relay │────▶│ 本地 Agent   │────▶│ Claude Code│
│            │◀────│ (共享 Bot)   │◀────│ (clc --relay)│◀────│ CLI        │
└────────────┘     └─────────────┘     └──────────────┘     └────────────┘
                   WebSocket tunnel

模式 B（自有 Bot — 直连）:
┌────────────┐     ┌──────────────┐     ┌────────────┐
│ 飞书用户    │────▶│ 本地 Agent   │────▶│ Claude Code│
│            │◀────│ (clc --direct)│◀────│ CLI        │
└────────────┘     └──────────────┘     └────────────┘
                   飞书 WebSocket 直连
```

### Monorepo 结构

```
packages/
├── protocol/                     # 共享协议定义
│   └── src/
│       ├── index.ts             # RelayToAgent, AgentToRelay, RelayResponse 类型
│       └── card.ts              # FeishuCardV2 类型
│
├── agent/                        # 本地 Agent（核心）
│   └── src/
│       ├── index.ts             # CLI 入口，解析 --relay / --direct
│       ├── config.ts            # TOML 配置 + 环境变量覆盖
│       ├── types.ts             # 内部类型
│       ├── transport/
│       │   ├── interface.ts     # Transport 抽象接口
│       │   ├── direct.ts        # 直连飞书（WSClient + Lark API）
│       │   └── relay.ts         # 经 Relay 中转（WebSocket tunnel）
│       ├── claude/
│       │   ├── session.ts       # 会话状态机 + 队列 + 中断
│       │   ├── session-manager.ts # 多会话管理（前台/后台）
│       │   ├── query.ts         # Claude Agent SDK 封装
│       │   └── permission-broker.ts # 权限审批
│       ├── commands/
│       │   └── router.ts        # 斜杠命令
│       ├── lark/cards/          # 卡片构建（status/permission）
│       ├── persistence/
│       │   └── store.ts         # JSON 持久化
│       └── util/                # 工具函数
│
├── relay/                        # Cloud Relay 服务
│   └── src/
│       ├── index.ts             # HTTP + WebSocket 服务器
│       ├── lark-bot.ts          # 共享飞书 Bot
│       ├── tunnel.ts            # Agent tunnel 管理
│       ├── pairing.ts           # 配对码生成/验证
│       └── router.ts            # Agent 消息路由到 Lark API
│
└── skill/                        # Claude Code Skill
    ├── .claude-plugin/plugin.json
    └── skills/lark-channel/
        └── lark-channel.md      # 自动化安装配对指令
```

## 设计决策

### Transport 抽象

`Transport` 接口统一了两种模式的 I/O：

```typescript
interface Transport {
  start(): Promise<void>;
  sendText(chatId, text): Promise<string>;
  sendCard(chatId, card): Promise<string>;
  updateCard(messageId, card): Promise<void>;
  sendImage(chatId, imageKey): Promise<string>;
  uploadImage(imageBuffer): Promise<string>;
  downloadImage(messageId, imageKey): Promise<Buffer>;
}
```

- `DirectTransport`：直接调用飞书 API（v1.0 行为）
- `RelayTransport`：通过 WebSocket tunnel 将请求转发给 Relay，Relay 代为调用飞书 API

业务逻辑（session、commands、permission）完全不感知底层传输方式。

### Relay 协议

Agent ↔ Relay 通过 WebSocket 通信，消息格式定义在 `@cc-lark/protocol`：

- **下行**（Relay → Agent）：`message`、`card_action`、`paired`、`ping`、`error`
- **上行**（Agent → Relay）：`auth`、`pong`、`send_text`、`send_card`、`update_card`、`send_image`、`upload_image`、`download_image`
- **响应**（Relay → Agent）：`response`（带 requestId 匹配）

### 配对机制

1. Agent 向 Relay HTTP API 请求配对码（`POST /api/pair`）
2. Relay 返回 6 位码 + token
3. 用户在飞书中发送 6 位码给共享 Bot
4. Relay 将 open_id 与 Agent 关联
5. 后续消息按 open_id 路由到对应 tunnel

### 为什么不用 Docker

Claude Agent SDK 需要 spawn 本地 `claude` CLI 子进程，且 Claude Code 需要直接访问项目文件系统。容器化会增加不必要的复杂度。

### 后台会话

每个 chatId 可有多个并行会话，一个前台 + 多个后台：
- `/bg [name]`：当前会话移到后台继续执行
- `/fg <id>`：切回前台
- 后台完成时通知：`🔔 Background session [name] finished`
- 数据模型：`Map<chatId, { foregroundId, sessions: Map<id, ClaudeSession> }>`

### Lark SDK ESM Bug

Lark SDK 的 WSClient 在 ESM 模式下不触发事件。构建输出为 CJS 格式，依赖标记为 external。

## 核心功能

| 功能 | 实现位置 | 说明 |
|------|---------|------|
| 双模式接入 | `transport/direct.ts` + `transport/relay.ts` | 共享 Bot 或自有 Bot |
| 交互式审批卡片 | `permission-broker.ts` + `permission-card.ts` | 4 按钮 |
| 流式状态卡片 | `session.ts` + `status-card.ts` | 实时更新 + cwd 显示 |
| 后台会话 | `session-manager.ts` | `/bg` `/fg` `/sessions` `/kill` |
| 消息队列 | `session.ts` | 排队、满拒绝、自动出队 |
| 中断 | `session.ts` | `!` 前缀 + `/stop` |
| 图片支持 | `session-manager.ts` + transport | 下载 → base64 → Claude |
| 配对 | `relay/pairing.ts` | 6 位码 + token |
| Claude Code Skill | `skill/lark-channel.md` | 说"连飞书"自动完成 |
| 双向会话交接 | `bin/cc-session.mjs` + `ipc/` + `claude/session-registry.ts` | 终端 ↔ 飞书，详见下节 |
| 转移快捷键 | `~/.claude/keybindings.json` + `skill/commands/transfer.md` | claude 内按 `Ctrl+K` 触发 |
| 对话回顾 | `claude/session-recap.ts` | 转移时贴出最近 3 轮对话 |

## 双向会话交接（终端 ↔ 飞书）

让同一个 Claude Code 会话在终端和飞书之间来回接管。核心：会话 id 稳定（resume 不 fork），两端共享同一份 `~/.claude/projects/<编码cwd>/<sessionId>.jsonl` 历史。

**组件**
- `bin/cc-session.mjs` — claude 生命周期包装器（代替直接 `claude`）。注入 PATH/环境、写发现文件 `~/.cc-lark-channel/wrappers/<pid>.json`、收 SIGUSR1 触发转移、收 relay 的 resume 推送时重启 claude。透传所有 claude 参数；单独解析 `--resume <id>` 避免与交还冲突；正常退出时打印 sessionID。
- `bin/cc-transfer.mjs` — 触发转移：在 claude 内（环境变量 `CC_LARK_WRAPPER_PID`）直接发信号；带外则从发现文件找到 wrapper 发信号。
- `ipc/`（protocol + server）— agent 在 `~/.cc-lark-channel/agent.sock` 监听本地 Unix socket，处理终端工具的 register/transfer，并向 wrapper 推送 resume。
- `claude/session-registry.ts` — 读 `~/.claude/sessions/<pid>.json` 判断会话是否仍被活终端持有，作为接管闸门。

**终端 → 飞书**：`cc-session` 起会话 → 按 `Ctrl+K`（或带外 `cc-transfer`）→ agent 建/复用 workspace 群、绑定会话、贴最近 3 轮回顾 → claude 退出、wrapper 等待。

**飞书 → 终端**：群里发 `/handback` → agent 解绑并经 socket 推 resume → wrapper 在原终端 `claude --resume` 恢复。无 wrapper 时提示手动 `claude --resume <id>`。

**安全**：`/workspace`/transfer 前用 session-registry 闸门拒绝接管仍被活终端持有的会话；交还后 `released` 守卫阻止飞书侧再写入，避免双写。

**注意**：同一飞书 openId 在 relay 端是单连接模型（后连接踢掉先连接，消息只发最后注册者）。多个 agent 共用同一 openId 会串台。

## 参考项目

| 项目 | 参考内容 |
|------|---------|
| [cc-connect](https://github.com/chenhg5/cc-connect) | 整体架构、config 结构、session 管理 |
| [agent-feishu-channel](https://github.com/Blackman99/agent-feishu-channel) | 审批卡片 UX、中断机制、Claude Agent SDK 集成 |

## 构建与运行

```bash
pnpm install          # 安装依赖
pnpm build            # 构建所有包
pnpm test             # 运行测试
pnpm typecheck        # 类型检查
pnpm dev              # 开发模式（agent）
```

## 部署

**Agent（用户本地）：**
```bash
npm install -g @cc-lark/agent
clc --relay wss://relay.cc-lark.dev --token <token>
# 或
clc --direct --config config.toml
```

**Relay（SaaS 服务器）：**
```bash
cd packages/relay
LARK_APP_ID=xxx LARK_APP_SECRET=xxx pm2 start dist/index.cjs --name cc-lark-relay
```

### 运维注意事项

- **同一飞书 openId 单连接**：relay 端 `userToAgent` 是 `openId → 单个 agentId` 映射，后连接踢掉先连接，飞书消息只发最后注册者。**多个 agent 共用同一 openId 会串台**（曾导致"飞书消息被错误 agent 处理、cwd/历史不对"）。排查此类问题先确认同一 openId 是否有多个 agent 在线（本机 + 远端 `/opt`）。
- **部署会拉起 direct agent**：`deploy.yml`（push 到 main 触发）会在服务器 `pm2 start cc-lark-channel`（`/opt/cc-lark-channel` 的直连 agent）。若该 direct agent 与共享 relay 用同一 openId，部署后会重新出现串台。需要时 `pm2 stop cc-lark-channel` 停掉。
- **转移等待态退出**：cc-session 转移到飞书后若群被关闭、不再 `/handback`，按 Ctrl+C 退出等待态（claude 退出时已置 `child = null`，信号处理器走 `process.exit`）。

## 配置文件

Agent 配置使用 TOML 格式，支持环境变量覆盖（`CLC_*` 前缀）。
详见 `config.example.toml`。
