---
name: lark-channel
description: 连接飞书，通过飞书群聊/私聊和 Claude Code 对话。支持共享 Bot（零配置扫码）和自有 Bot 两种模式。
triggers:
  - 连接飞书
  - connect lark
  - 帮我接飞书
  - lark channel
---

# 飞书通道连接

当用户要求连接飞书时，按以下步骤执行：

## 步骤 1：检查是否已安装

运行以下命令检查 cc-lark-channel 是否已安装：

```bash
which clc || npm list -g @cc-lark/agent 2>/dev/null | grep @cc-lark/agent
```

如果未安装，执行：

```bash
npm install -g @cc-lark/agent
```

## 步骤 2：检查是否已配对

检查配对信息文件：

```bash
cat ~/.cc-lark-channel/pairing.json 2>/dev/null
```

如果文件存在且 `paired: true`，跳到步骤 4。

## 步骤 3：选择模式并配对

询问用户选择哪种模式：

**模式 A：共享 Bot（推荐，零配置）**

1. 向 Relay 申请配对码：
```bash
clc pair --relay wss://relay.cc-lark.dev
```

2. 将返回的 6 位配对码告诉用户
3. 指导用户：在飞书中搜索并添加 "cc-lark-channel" Bot，然后发送配对码
4. 等待配对确认

**模式 B：自有 Bot（需要飞书开发者账号）**

1. 询问用户提供 App ID 和 App Secret
2. 写入配置文件：
```bash
mkdir -p ~/.cc-lark-channel
cat > ~/.cc-lark-channel/config.toml << EOF
[lark]
app_id = "<用户提供的 app_id>"
app_secret = "<用户提供的 app_secret>"

[claude]
cli_path = "$(which claude)"
default_cwd = "$(pwd)"
EOF
```

## 步骤 4：启动连接

根据模式启动：

**共享 Bot 模式：**
```bash
clc --relay wss://relay.cc-lark.dev --token "$(cat ~/.cc-lark-channel/pairing.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')" &
```

**自有 Bot 模式：**
```bash
clc --direct --config ~/.cc-lark-channel/config.toml &
```

## 步骤 5：确认连接

等待几秒后检查进程是否在运行：

```bash
pgrep -f "clc" && echo "✅ 飞书通道已连接"
```

告诉用户：
- 现在可以通过飞书和 Claude Code 对话了
- 发送 `/help` 查看可用命令
- 发送 `/bg` 可以把长任务放到后台
