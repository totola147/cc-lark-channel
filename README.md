# cc-lark-channel

通过飞书（Lark）群聊/私聊远程操控 Claude Code，随时随地推进项目开发。

## 特性

- **双模式接入** — 公共 Bot（零配置扫码）或自有 Bot（企业私有化）
- **OAuth 认证 + 设备码配对** — 安全便捷的接入流程
- **交互式审批卡片** — 工具调用时发送 4 按钮卡片，手机点一下即可
- **流式状态卡片** — 实时展示 thinking、工具调用、输出内容，原地更新不刷屏
- **后台会话** — 长任务放后台继续跑，切到新会话继续工作，完成时收到通知
- **消息队列** — 生成中发送的消息自动排队，空闲后依次执行
- **中断机制** — `!` 前缀中断当前任务并执行新指令，`/stop` 停止生成
- **会话接管** — `/attach` 接管已有 CLI 会话，飞书继续工作
- **图片支持** — 发截图给 Claude 分析
- **零公网 IP** — 用户侧无需开放端口
- **系统服务** — `--install-service` 一键注册 systemd，开机自启

## 快速开始

### 方式一：公共 Bot（推荐）

在你的 Claude Code 所在机器上执行：

```bash
# 1. 克隆并构建
git clone -b v2 https://github.com/totola147/cc-lark-channel.git
cd cc-lark-channel && pnpm install && pnpm build

# 2. 首次启动（显示设备码，在 landing page 完成 OAuth 配对）
node packages/agent/dist/index.cjs --relay ws://43.153.201.61:9000

# 3. 配对成功后，注册为系统服务（需要 Claude 环境变量已加载）
node packages/agent/dist/index.cjs --install-service
```

配对流程：
1. 访问 http://43.153.201.61:9000
2. 点击「飞书 OAuth 登录」完成认证
3. 输入终端显示的 6 位设备码
4. 完成

之后开机自启，无需手动管理。

### 方式二：自有 Bot（企业/隐私需求）

需要自己创建飞书应用（[创建指南](./docs/setup-lark.md)）。

```bash
git clone -b v2 https://github.com/totola147/cc-lark-channel.git
cd cc-lark-channel && pnpm install && pnpm build

# 配置
cp config.example.toml config.toml
# 编辑 config.toml 填入 app_id/app_secret

# 启动
node packages/agent/dist/index.cjs --direct --config config.toml

# 注册服务
node packages/agent/dist/index.cjs --install-service
```

## 架构

```
公共 Bot 模式:
  飞书用户 → 公共 Bot → Cloud Relay (ws://IP:9000) → 用户本地 Agent → Claude Code

自有 Bot 模式:
  飞书用户 → 自有 Bot → 用户本地 Agent → Claude Code（直连）
```

## 命令

| 命令 | 说明 |
|------|------|
| `/new` | 开始新会话 |
| `/stop` | 停止当前生成 |
| `/status` | 查看会话状态 |
| `/sessions` | 列出所有会话 |
| `/bg [name]` | 将当前会话移到后台继续执行 |
| `/fg <id>` | 将后台会话切到前台 |
| `/kill <id>` | 终止后台会话 |
| `/attach <id>` | 接管已有 CLI 会话 |
| `/cd <path>` | 切换工作目录（启动新会话） |
| `/mode <mode>` | 切换权限模式 |
| `/model <name>` | 切换模型 |
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
├── agent/      本地 Agent（双模式 CLI：--direct / --relay）
├── relay/      Cloud Relay 服务（公共 Bot + 路由 + OAuth + 设备码）
└── skill/      Claude Code Skill（自动化安装指引）
```

## 开发

```bash
pnpm install        # 安装依赖
pnpm build          # 构建所有包
pnpm test           # 运行测试
pnpm typecheck      # 类型检查
```

## 许可证

MIT
