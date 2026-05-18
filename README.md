# cc-lark-channel

通过飞书（Lark）群聊/私聊远程操控 Claude Code，随时随地推进项目开发。

## 特性

- **双模式接入** — 共享 Bot（扫码即用）或自有 Bot（企业私有化）
- **Claude Code Skill** — 对 Claude Code 说"连接飞书"，自动完成安装配对
- **交互式审批卡片** — 工具调用时发送 4 按钮卡片，手机点一下即可
- **流式状态卡片** — 实时展示 thinking、工具调用、输出内容，原地更新不刷屏
- **后台会话** — 长任务放后台继续跑，切到新会话继续工作，完成时收到通知
- **消息队列** — 生成中发送的消息自动排队，空闲后依次执行
- **中断机制** — `!` 前缀中断当前任务并执行新指令，`/stop` 停止生成
- **图片支持** — 发截图给 Claude 分析
- **零公网 IP** — 无需域名和反向代理
- **供应链安全** — 仅依赖官方 SDK，无第三方运行时依赖

## 快速开始

### 方式一：共享 Bot（推荐，最省事）

对你的 Claude Code 说：

```
帮我连接飞书
```

Claude Code 会自动安装、配对，你只需在飞书中扫码。

或者手动：

```bash
# 安装
npm install -g @cc-lark/agent

# 配对（获取 6 位码，在飞书中发送给 Bot）
clc pair --relay wss://relay.cc-lark.dev

# 启动
clc --relay wss://relay.cc-lark.dev --token <your-token>
```

### 方式二：自有 Bot（企业/隐私需求）

需要自己创建飞书应用（[创建指南](./docs/setup-lark.md)）。

```bash
# 安装
npm install -g @cc-lark/agent

# 配置
cat > ~/.cc-lark-channel/config.toml << EOF
[lark]
app_id = "cli_axxxxxxxxxxxx"
app_secret = "QhkMpxxxxxxxxxxxxxxxxxxxx"

[claude]
cli_path = "$(which claude)"
default_cwd = "$(pwd)"
EOF

# 启动
clc --direct --config ~/.cc-lark-channel/config.toml
```

## 架构

```
方式一（共享 Bot）:
  飞书用户 → 共享 Bot → Cloud Relay → WebSocket tunnel → 本地 clc → Claude Code

方式二（自有 Bot）:
  飞书用户 → 自有 Bot → 本地 clc → Claude Code（直连，不经过 Relay）
```

## 命令

| 命令 | 说明 |
|------|------|
| `/new` | 开始新会话 |
| `/stop` | 停止当前生成 |
| `/status` | 查看会话状态 |
| `/sessions` | 列出所有会话（前台/后台状态） |
| `/bg [name]` | 将当前会话移到后台继续执行 |
| `/fg <id>` | 将后台会话切到前台 |
| `/kill <id>` | 终止后台会话 |
| `/mode <mode>` | 切换权限模式（default/acceptEdits/bypassPermissions） |
| `/model <name>` | 切换模型 |
| `/cd <path>` | 切换工作目录 |
| `/help` | 显示帮助 |

**特殊输入：**

| 输入 | 效果 |
|------|------|
| `!<text>` | 中断当前生成，立即执行新指令 |
| 普通文本 | 发送给 Claude（忙时自动排队） |

## 项目结构（Monorepo）

```
packages/
├── protocol/   共享消息类型定义（Relay ↔ Agent 协议）
├── agent/      本地 agent（双模式 CLI：--direct / --relay）
├── relay/      Cloud Relay 服务（共享 Bot + tunnel 路由 + 配对）
└── skill/      Claude Code Skill（用户说"连飞书"自动安装配对）
```

## 技术栈

| 组件 | 选型 | 来源 |
|------|------|------|
| 飞书 SDK | `@larksuiteoapi/node-sdk` 1.64.0 | 字节跳动官方 |
| Claude SDK | `@anthropic-ai/claude-agent-sdk` 0.3.142 | Anthropic 官方 |
| WebSocket | `ws` | 社区标准 |
| 配置 | `smol-toml` + `zod` | 社区标准 |
| 日志 | `pino` | 社区标准 |
| 构建 | `tsup` | 社区标准 |
| Monorepo | `pnpm workspace` | 社区标准 |

## 开发

```bash
pnpm install        # 安装依赖
pnpm build          # 构建所有包
pnpm test           # 运行测试
pnpm typecheck      # 类型检查
pnpm dev            # 开发模式（agent）
```

## 许可证

MIT
