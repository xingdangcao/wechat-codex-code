---
name: wechat-codex-code
description: 微信消息桥接 - 在微信中与本机 Codex CLI 聊天。支持文字对话、图片、文件、Codex skills、斜杠命令和后台守护进程。
---

# WeChat Codex Code Bridge

通过个人微信与本地 Codex CLI 进行对话。

## 前置条件

- Node.js >= 18
- Windows、macOS 或 Linux
- 个人微信账号（需扫码绑定）
- 已安装并登录 Codex CLI

## 触发场景

用户提到“微信 Codex 桥接”、“微信聊天”、“wechat bridge”、“连接微信”、“微信状态”、“停止微信服务”等与微信桥接相关的话题时触发。

## 状态检查流程

被触发时，先探查当前状态，再给出可用操作。

### 1. 检查项目是否完整安装

```bash
test -f ~/.codex/skills/wechat-codex-code/package.json && echo "source_ok" || echo "source_missing"
```

如果 `source_missing`，需要先安装项目源码。

### 2. 检查依赖

```bash
cd ~/.codex/skills/wechat-codex-code && test -d node_modules && echo "deps_ok" || echo "deps_missing"
```

如果 `deps_missing`，执行：

```bash
cd ~/.codex/skills/wechat-codex-code && npm install
```

### 3. 检查 Codex CLI

```bash
codex --version
codex exec --help
```

### 4. 检查是否已绑定微信账号

```bash
ls ~/.wechat-codex-code/accounts/*.json 2>/dev/null | head -1
```

如果没有账号文件，提示用户执行 `npm run setup` 并扫码绑定。

### 5. 检查 daemon 状态

```bash
cd ~/.codex/skills/wechat-codex-code && npm run daemon -- status
```

## 子命令

所有命令的工作目录为 `~/.codex/skills/wechat-codex-code`。

| 命令 | 执行 | 说明 |
|------|------|------|
| setup | `npm run setup` | 首次安装向导：生成 QR 码、微信扫码、配置工作目录 |
| start | `npm run daemon -- start` | 启动后台服务 |
| stop | `npm run daemon -- stop` | 停止后台服务 |
| restart | `npm run daemon -- restart` | 重启后台服务 |
| status | `npm run daemon -- status` | 查看运行状态 |
| logs | `npm run daemon -- logs` | 查看最近日志 |
| autostart install | `npm run autostart -- install` | 安装 Windows 登录自启动和每天 12:00 保活 |
| autostart status | `npm run autostart -- status` | 查看自启动计划任务 |
| autostart uninstall | `npm run autostart -- uninstall` | 取消 Windows 自启动 |

## 微信端命令

```text
/help
/clear
/stop
/model <名称>
/prompt <内容>
/cwd <路径>
/skills
/status
/history [数量]
/chat list
/chat new <名称>
/chat use <名称>
/chat delete <名称>
/task run <任务>
/task list
/task log <ID>
/task stop <ID>
/compact
/reset
/undo [数量]
/send <路径>
```

## 数据目录

```text
~/.wechat-codex-code/
├── accounts/
├── config.json
├── sessions/
├── tasks/
└── logs/
```
