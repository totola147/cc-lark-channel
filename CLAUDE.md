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

## 配置文件

Agent 配置使用 TOML 格式，支持环境变量覆盖（`CLC_*` 前缀）。
详见 `config.example.toml`。
