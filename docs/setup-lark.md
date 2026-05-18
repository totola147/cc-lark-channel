# 安装部署指南

## 目录

1. [快速接入（共享 Bot）](#快速接入共享-bot)
2. [环境要求](#环境要求)
3. [自有 Bot 部署](#自有-bot-部署)
4. [Relay 服务部署](#relay-服务部署)
5. [CI/CD 流水线](#cicd-流水线)
6. [配置详解](#配置详解)
7. [验证运行](#验证运行)
8. [常见问题](#常见问题)

---

## 快速接入（共享 Bot）

最简单的接入方式，无需创建飞书应用，扫码即用。

### 前置条件

- Node.js >= 22
- Claude Code CLI 已安装并认证（`claude` 命令可用）

### 方式 A：通过 Claude Code Skill（最省事）

安装 Skill 后，对 Claude Code 说"连接飞书"即可：

```bash
claude plugin install cc-lark-channel
```

然后在 Claude Code 中：
```
帮我连接飞书
```

Claude Code 会自动完成安装、配对，你只需在飞书中扫码或发送配对码。

### 方式 B：手动安装

```bash
# 1. 安装
npm install -g @cc-lark/agent

# 2. 配对（获取 6 位码）
clc pair --relay wss://relay.cc-lark.dev

# 3. 在飞书中搜索并添加 "cc-lark-channel" Bot
#    然后发送 6 位配对码完成绑定

# 4. 启动（配对成功后）
clc --relay wss://relay.cc-lark.dev --token <your-token>
```

### 后台运行

```bash
# 使用 pm2 守护
pm2 start "clc --relay wss://relay.cc-lark.dev --token <token>" --name clc
pm2 save && pm2 startup
```

---

## 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 22 | 运行时 |
| Claude Code CLI | 最新 | `claude` 命令需在 $PATH 中可用 |
| npm / pnpm | >= 10 | 包管理 |

确认 Claude Code 已认证：

```bash
claude --version
# 如未认证，运行：
claude auth login
```

---

## 自有 Bot 部署

> 以下内容适用于选择自有飞书 Bot 的用户（模式 B）。如果使用共享 Bot，跳过此节。

### 飞书应用配置

### 第一步：创建企业自建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/) 并登录
2. 点击右上角「控制台」→「创建企业自建应用」
3. 填写应用信息：
   - 应用名称：`cc-lark-channel`（或自定义）
   - 应用描述：`Claude Code 远程助手`

> 个人用户也可以创建，无需企业认证。

### 第二步：获取凭证

1. 进入应用详情页 →「凭据与基础信息」
2. 记录以下信息：

```
App ID:     cli_axxxxxxxxxxxx
App Secret: QhkMpxxxxxxxxxxxxxxxxxxxx
```

> App Secret 只显示一次，请妥善保存。

### 第三步：启用机器人能力

1. 左侧导航 →「应用能力」→「机器人」
2. 点击「启用机器人」
3. 填写机器人名称和描述

### 第四步：配置权限

左侧导航 →「权限管理」，搜索并添加以下权限：

| 权限名称 | 权限标识 | 用途 |
|---------|---------|------|
| 获取与更新用户基本信息 | `contact:user.base:readonly` | 获取用户信息 |
| 获取群组中用户@机器人消息 | `im:message.group_at_msg:readonly` | 接收群消息 |
| 读取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` | 接收私聊消息 |
| 以应用身份发送群消息 | `im:message:send_as_bot` | 发送回复 |
| 获取与上传图片或文件资源 | `im:resource` | 图片收发 |
| 更新应用发送的消息 | `im:message:update` | 卡片原地更新 |

配置完成后点击「申请发布」。

### 第五步：配置事件订阅（长连接模式）

1. 左侧导航 →「事件与回调」→「事件配置」
2. 订阅方式选择：**使用长连接接收事件**
3. 点击「添加事件」，添加：
   - `im.message.receive_v1`（接收消息）
4. 切换到「回调配置」标签
5. 订阅方式选择：**使用长连接接收事件**
6. 点击「添加事件」，添加：
   - `card.action.trigger`（卡片按钮点击）

### 第六步：发布应用

1. 左侧导航 →「版本管理与发布」
2. 创建版本并提交发布
3. 管理员审批通过后，机器人即可使用

### 第七步：获取你的 open_id（可选）

如果需要配置访问白名单：

1. 在 `config.toml` 中设置：
```toml
[access]
allowed_open_ids = []
unauthorized_behavior = "reject"
```

2. 启动服务后，向机器人发送任意消息
3. 机器人会回复你的 `open_id`
4. 将 `open_id` 添加到 `allowed_open_ids` 列表中

---

### 本地部署

### 安装

```bash
git clone <repo-url> cc-lark-channel
cd cc-lark-channel
npm install
```

### 配置

```bash
cp config.example.toml config.toml
vim config.toml
```

最小配置（只需填飞书凭证）：

```toml
[lark]
app_id = "cli_axxxxxxxxxxxx"
app_secret = "QhkMpxxxxxxxxxxxxxxxxxxxx"

[claude]
default_cwd = "/path/to/your/project"
```

### 开发模式运行

```bash
npm run dev
```

### 生产模式运行

```bash
npm run build
npm start
```

### 使用 pm2 守护进程（推荐）

安装 pm2：

```bash
npm install -g pm2
```

启动服务：

```bash
cd /opt/cc-lark-channel
npm run build
CLC_CONFIG=/opt/cc-lark-channel/config.toml pm2 start dist/index.js --name cc-lark-channel
```

常用命令：

```bash
pm2 logs cc-lark-channel     # 查看日志
pm2 restart cc-lark-channel  # 重启
pm2 stop cc-lark-channel     # 停止
pm2 save                     # 保存进程列表
pm2 startup                  # 设置开机自启
```

### 使用 systemd 守护进程（备选）

创建 `/etc/systemd/system/cc-lark-channel.service`：

```ini
[Unit]
Description=cc-lark-channel
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/cc-lark-channel
Environment=CLC_CONFIG=/opt/cc-lark-channel/config.toml
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable cc-lark-channel
sudo systemctl start cc-lark-channel

# 查看日志
journalctl -u cc-lark-channel -f
```

---

## Relay 服务部署

> 仅当你自己托管共享 Bot 时需要。普通用户使用官方 Relay 无需此步骤。

### 环境变量

| 变量 | 说明 |
|------|------|
| `LARK_APP_ID` | 共享飞书 Bot 的 App ID |
| `LARK_APP_SECRET` | 共享飞书 Bot 的 App Secret |
| `RELAY_PORT` | 监听端口（默认 9000） |
| `LOG_LEVEL` | 日志级别（默认 info） |

### 部署

```bash
cd packages/relay
pnpm install
pnpm build

# 启动
LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx pm2 start dist/index.cjs --name cc-lark-relay
```

### API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/pair` | POST | 创建配对码，body: `{ "agentId": "xxx" }` |
| `/ws` | WebSocket | Agent tunnel 连接端点 |
| `/health` | GET | 健康检查 |

### 配对流程

```
Agent → POST /api/pair → 获取 { token, code }
Agent → WS /ws → 发送 { type: "auth", token }
用户 → 飞书发送 6 位 code → Relay 关联 open_id 与 Agent
后续消息按 open_id 路由到对应 tunnel
```

---

## CI/CD 流水线

项目使用 GitHub Actions 实现自动化 CI/CD，部署到本机通过 self-hosted runner（无需开放入站端口）。

### 整体流程

```
Push → main:  CI (typecheck + test + build) → Deploy (pm2 restart + health check + rollback)
创建 PR:      CI → Auto Merge (CI 通过后自动 squash merge)
Tag v*:       CI → Deploy → Release (生成 changelog + GitHub Release)
```

### Workflow 文件

| 文件 | 触发条件 | 作用 |
|------|---------|------|
| `.github/workflows/ci.yml` | PR / push main / tag | typecheck + test + build |
| `.github/workflows/deploy.yml` | push main / tag | 部署到服务器 + 回滚 |
| `.github/workflows/auto-merge.yml` | CI workflow 完成 | 自动合并 PR |

### CI (`ci.yml`)

在 GitHub 托管的 `ubuntu-latest` runner 上运行：

```
typecheck: npm run typecheck (tsc --noEmit)
test:      npm test (vitest run)
build:     npm run build (tsup)
```

三个 job 并行执行，全部通过才算 CI 成功。

### Deploy (`deploy.yml`)

在 self-hosted runner（本机）上运行：

```
1. checkout 代码
2. npm ci + npm run build
3. rsync 到 /opt/cc-lark-channel（保留 .env 和 config.toml）
4. npm ci --omit=dev
5. source .env + pm2 restart
6. 健康检查（20s 内 pm2 状态变为 online）
7. 失败 → 自动回滚到上一个 commit
```

**回滚机制：** 部署前记录当前 commit SHA，健康检查失败时 `git reset --hard` 到旧 commit 并重新构建启动。

### Auto Merge (`auto-merge.yml`)

触发条件：CI workflow 成功完成且关联的是一个 PR。

行为：找到对应 PR → 确认是仓库 owner 提交的 → squash merge + 删除分支。

### Self-hosted Runner

Runner 安装在部署服务器本机，通过 outbound HTTPS 连接 GitHub（无需开放入站端口）。

- 名称：`cc-lark-runner`
- 安装路径：`/opt/actions-runner`
- 服务：`actions.runner.totola147-cc-lark-channel.cc-lark-runner.service`

常用命令：

```bash
# 查看 runner 状态
sudo systemctl status actions.runner.totola147-cc-lark-channel.cc-lark-runner

# 重启 runner
sudo systemctl restart actions.runner.totola147-cc-lark-channel.cc-lark-runner

# 查看 runner 日志
journalctl -u actions.runner.totola147-cc-lark-channel.cc-lark-runner -f
```

### GitHub Secrets

当前方案不需要任何 GitHub Secrets。敏感配置在服务器 `/opt/cc-lark-channel/.env` 本地维护。

### 敏感配置管理

服务器上的 `.env` 文件（CI 不会覆盖）：

```bash
# /opt/cc-lark-channel/.env
CLC_LARK_APP_ID=cli_axxxxxxxxxxxx
CLC_LARK_APP_SECRET=QhkMpxxxxxxxxxxxxxxxxxxxx
ANTHROPIC_AUTH_TOKEN=sk-ant-xxx  # 如需要
```

环境变量优先级：环境变量 > config.toml。

---

## 配置详解

完整配置参见 `config.example.toml`，以下是各节说明：

### [lark] — 飞书凭证

| 字段 | 必填 | 说明 |
|------|------|------|
| `app_id` | 是 | 飞书应用 App ID |
| `app_secret` | 是 | 飞书应用 App Secret |

### [access] — 访问控制

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `allowed_open_ids` | `[]`（允许所有人） | 允许使用的用户 open_id 列表 |
| `unauthorized_behavior` | `"ignore"` | 未授权用户的处理方式：`ignore` 静默忽略 / `reject` 回复 open_id |

### [claude] — Claude Code 配置

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `cli_path` | `"claude"` | Claude CLI 二进制路径 |
| `default_model` | `""`（使用 CLI 默认） | 默认模型 |
| `default_cwd` | 当前目录 | 默认工作目录 |
| `permission_mode` | `"default"` | 权限模式：`default` / `acceptEdits` / `bypassPermissions` |
| `permission_timeout_seconds` | `120` | 审批超时秒数，超时自动拒绝 |
| `max_queue_size` | `5` | 消息队列最大长度 |

### [render] — 渲染配置

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `hide_thinking` | `false` | 是否隐藏 thinking 内容 |
| `show_turn_stats` | `true` | turn 结束后是否显示 token 统计 |
| `inline_max_bytes` | `1500` | 审批卡片中工具输入预览的最大字节数 |
| `card_update_interval_ms` | `500` | 状态卡片最小更新间隔（毫秒） |

### [persistence] — 持久化

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `state_dir` | `~/.cc-lark-channel` | 状态文件存储目录 |

### [logging] — 日志

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `level` | `"info"` | 日志级别：`trace` / `debug` / `info` / `warn` / `error` |

---

## 验证运行

启动服务后，在飞书中向机器人发送消息进行验证：

1. **基本对话**：发送 `hello`，应收到 Claude 的回复（以流式卡片形式）
2. **权限审批**：发送 `请创建一个 test.txt 文件`，应弹出审批卡片
3. **中断**：发送一个长任务，然后发送 `!换个思路`，应中断并执行新指令
4. **命令**：发送 `/status`，应返回当前会话状态
5. **停止**：发送 `/stop`，应停止当前生成

如果机器人无响应，检查：
- 服务日志是否有错误
- 飞书应用是否已发布
- 事件订阅是否配置正确（长连接模式）
- `allowed_open_ids` 是否包含你的 open_id（或为空允许所有人）

---

## 常见问题

### Q: 启动报错 "lark.app_id is required"

配置文件路径不正确。确认 `CLC_CONFIG` 环境变量指向正确的 `config.toml`，或在项目根目录放置 `config.toml`。

### Q: 飞书收不到消息

1. 确认应用已发布且审批通过
2. 确认事件订阅使用「长连接」模式
3. 确认添加了 `im.message.receive_v1` 事件
4. 查看服务日志中是否有 "Starting Lark WebSocket connection" 输出

### Q: 审批卡片按钮点击无反应

确认「回调配置」中添加了 `card.action.trigger` 事件，且使用长连接模式。

### Q: Claude 报错 "command not found"

确认 `claude` CLI 已安装且在 `$PATH` 中可用：

```bash
which claude
claude --version
```

如果安装在非标准路径，在 `config.toml` 中指定：

```toml
[claude]
cli_path = "/home/ubuntu/.npm-global/bin/claude"
```

### Q: 如何更新 Claude Code 模型

在飞书中发送 `/model claude-sonnet-4-6` 即可切换，无需重启服务。

### Q: 如何同时管理多个项目

在飞书中使用 `/cd /path/to/other/project` 切换工作目录，然后 `/new` 开始新会话。
