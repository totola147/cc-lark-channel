# cc-lark-channel

通过飞书（Lark）群聊/私聊远程操控 Claude Code，随时随地推进项目开发。

## 特性

- **交互式审批卡片** — 工具调用时发送 4 按钮卡片（允许/拒绝/本轮允许/本会话允许），手机点一下即可
- **流式状态卡片** — 实时展示 thinking、工具调用、输出内容，原地更新不刷屏
- **后台会话** — 长任务放后台继续跑，切到新会话继续工作，完成时收到通知
- **消息队列** — 生成中发送的消息自动排队，空闲后依次执行
- **中断机制** — `!` 前缀中断当前任务并执行新指令，`/stop` 停止生成
- **会话持久化** — 进程重启不丢上下文，自动恢复会话
- **图片支持** — 发截图给 Claude 分析，Claude 生成的图片自动回传
- **零公网 IP** — 使用飞书 WebSocket 长连接，无需域名和反向代理
- **供应链安全** — 仅依赖官方 SDK，无第三方运行时依赖

## 快速开始

### 前置条件

- Node.js >= 20
- Claude Code CLI 已安装并认证（`claude` 命令可用）
- 飞书企业自建应用（[创建指南](./docs/setup-lark.md)）

### 安装

```bash
git clone <repo-url> cc-lark-channel
cd cc-lark-channel
npm install
```

### 配置

```bash
cp config.example.toml config.toml
```

编辑 `config.toml`，填入飞书凭证：

```toml
[lark]
app_id = "cli_axxxxxxxxxxxx"
app_secret = "QhkMpxxxxxxxxxxxxxxxxxxxx"

[claude]
default_cwd = "/path/to/your/project"
```

### 运行

```bash
# 开发模式
npm run dev

# 生产模式
npm run build
npm start

# 使用 pm2 守护进程（推荐）
pm2 start dist/index.js --name cc-lark-channel
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

## 技术栈

| 组件 | 选型 | 来源 |
|------|------|------|
| 飞书 SDK | `@larksuiteoapi/node-sdk` 1.64.0 | 字节跳动官方 |
| Claude SDK | `@anthropic-ai/claude-agent-sdk` 0.3.142 | Anthropic 官方 |
| 配置 | `smol-toml` | 社区标准 |
| 验证 | `zod` | 社区标准 |
| 日志 | `pino` | 社区标准 |
| 构建 | `tsup` | 社区标准 |

## 许可证

MIT
