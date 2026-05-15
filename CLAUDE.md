# CLAUDE.md

## 项目概述

cc-lark-channel 是一个自研的飞书（Lark）↔ Claude Code 桥接工具，让用户可以通过飞书群聊/私聊远程操控 Claude Code 进行项目开发。

## 架构

```
┌─────────────────────────────────────────────────────┐
│  Lark WebSocket (长连接，无需公网 IP)                  │
│  Events: im.message.receive_v1, card.action.trigger │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────▼────────┐
              │  LarkGateway    │  消息去重、访问控制、事件路由
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │  CommandRouter  │  /new /stop /status /mode /model /cd /help
              └────────┬────────┘
                       │ (普通文本 → session)
              ┌────────▼────────┐
              │ SessionManager  │  按 chatId 管理会话生命周期
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │  ClaudeSession  │  状态机: idle → generating → awaiting_permission
              │                 │  消息队列、中断、turn 执行
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │  Claude Agent   │  @anthropic-ai/claude-agent-sdk query()
              │  SDK            │  流式事件、canUseTool 回调
              └─────────────────┘
```

## 设计决策

### 为什么自研而非使用现有开源方案

- **供应链安全**：现有方案（cc-connect、agent-feishu-channel）均为个人开发者维护，存在投毒风险
- **依赖最小化**：仅使用官方 SDK（字节跳动 @larksuiteoapi/node-sdk + Anthropic @anthropic-ai/claude-agent-sdk）
- **功能聚焦**：只适配飞书一个平台，代码量可控，便于审计

### 为什么选择 TypeScript

- 两个核心 SDK 都是 TypeScript 原生，集成零摩擦
- 类型系统帮助在编译期捕获错误
- 依赖链可通过 npm audit 追踪

### 权限模型

默认每次工具调用都需要用户在飞书点击审批卡片确认，支持三种模式：
- `default`：每次都问
- `acceptEdits`：文件编辑自动通过，shell 命令需确认
- `bypassPermissions`：全部自动通过（危险，仅开发环境使用）

### 流式卡片更新策略

- 使用飞书 Card V2 的 `update_multi: true` 配置
- 通过 PATCH `im.v1.message` 原地更新卡片内容
- 节流控制：最小 500ms 间隔，避免触发飞书 API 限流
- Turn 结束后发送最终状态卡片（绿色 header "✅ Done"）

### 中断机制

- `!` 前缀：中断当前生成 + 清空队列 + 立即执行新输入
- `/stop`：仅中断当前生成，不执行新内容
- 底层通过 AbortController 通知 Claude Agent SDK 停止

### 后台会话

- 每个 chatId 可有多个并行会话，一个前台 + 多个后台
- `/bg [name]`：当前会话移到后台继续执行，创建新前台会话
- `/fg <id>`：将后台会话切到前台
- 后台会话完成时发送通知：`🔔 Background session [name] finished`
- 权限审批卡片跨会话工作（通过 request_id 路由）
- 数据模型：`Map<chatId, { foregroundId, sessions: Map<id, ClaudeSession> }>`

## 代码结构

```
src/
├── index.ts                    # 入口：组装所有模块，启动 gateway
├── config.ts                   # TOML 配置加载 + Zod schema 验证
├── types.ts                    # 共享类型定义（RenderEvent, PermissionChoice 等）
│
├── lark/
│   ├── gateway.ts             # WebSocket 长连接、事件分发、去重、访问控制
│   ├── client.ts              # 飞书 API 封装（发送/更新 文本/卡片/图片）
│   └── cards/
│       ├── types.ts           # Card V2 JSON schema 类型
│       ├── permission-card.ts # 交互式审批卡片（4 按钮）
│       └── status-card.ts     # 流式进度卡片（thinking/tool/output）
│
├── claude/
│   ├── query.ts               # Claude Agent SDK query() 封装 + 事件流迭代
│   ├── session.ts             # 会话状态机 + 消息队列 + turn 执行
│   ├── session-manager.ts     # 按 chatId 注册/恢复/持久化会话
│   └── permission-broker.ts   # canUseTool → 发卡片 → 等按钮点击 → resolve
│
├── commands/
│   └── router.ts             # 斜杠命令解析与分发
│
├── persistence/
│   └── store.ts              # JSON 文件持久化（原子写入）
│
└── util/
    ├── logger.ts             # pino 日志
    ├── deferred.ts           # 可外部 resolve/reject 的 Promise
    ├── mutex.ts              # 异步互斥锁
    └── dedup.ts              # LRU 消息去重
```

## 核心功能

| 功能 | 实现位置 | 说明 |
|------|---------|------|
| 交互式审批卡片 | `permission-broker.ts` + `permission-card.ts` | 4 按钮：允许/拒绝/本轮允许/本会话允许 |
| 流式状态卡片 | `session.ts` + `status-card.ts` | 实时展示 thinking/tool/output，节流更新 |
| 后台会话 | `session-manager.ts` | `/bg` 放后台继续跑，`/fg` 切回，完成时通知 |
| 消息队列 | `session.ts` | 生成中新消息排队，满时拒绝，空闲自动出队 |
| 中断 | `session.ts` | `!` 前缀中断+执行新内容，`/stop` 仅中断 |
| 会话持久化 | `session-manager.ts` + `store.ts` | JSON 原子写入，重启可恢复 |
| 图片支持 | `session-manager.ts` + `client.ts` | 接收飞书图片 → 下载 → 传给 Claude |
| 访问控制 | `gateway.ts` | open_id 白名单，未授权可忽略或拒绝并回显 ID |

## 参考项目

| 项目 | 参考内容 |
|------|---------|
| [cc-connect](https://github.com/chenhg5/cc-connect) (9.2k⭐) | 整体架构思路、多平台桥接模式、config.toml 结构、session 管理 |
| [agent-feishu-channel](https://github.com/Blackman99/agent-feishu-channel) (82⭐) | 精细化 UX：交互式审批卡片、`!` 中断、流式状态卡片、Claude Agent SDK 集成方式 |

## 构建与运行

```bash
npm install          # 安装依赖
npm run typecheck    # 类型检查
npm run build        # tsup 打包 → dist/index.js
npm run dev          # tsx 开发模式
npm run test         # vitest 单元测试
npm start            # 生产运行
```

## 部署

直接在服务器上以 Node.js 进程运行（需要同机安装 Claude Code CLI）：

```bash
git clone → npm ci → npm run build → pm2 start dist/index.js --name cc-lark-channel
```

不使用 Docker，因为 Claude Agent SDK 需要 spawn 本地 `claude` CLI 子进程，
且 Claude Code 需要直接访问项目文件系统。

## 配置文件

配置使用 TOML 格式，路径通过环境变量 `CLC_CONFIG` 指定（默认 `./config.toml`）。
详见 `config.example.toml`。
