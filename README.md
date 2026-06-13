# WeChat Codex Code Bridge

通过个人微信与本机 Codex CLI 对话。扫码绑定后，微信里会出现一个好友；给它发消息，消息会转发给本机 `codex exec`，最终回复再推送回微信。支持文字、图片、语音转文字、文件收发和常用斜杠命令。

这是基于 `Wechat-ggGitHub/wechat-claude-code` 的 Codex CLI fork。微信登录、消息轮询、文件上传下载沿用原项目思路；模型执行层改为 OpenAI Codex CLI 的非交互模式。

## 特性

| | |
|---|---|
| 微信入口 | 用个人微信向本机 Codex 发任务 |
| 本地执行 | 通过 `codex exec --json` 在本机工作目录运行 |
| 会话续接 | 保存 Codex thread id，下一条消息默认 resume |
| 多会话切换 | 在微信里用 `/chat` 管理多个独立 Codex thread |
| 后台任务 | 用 `/task run` 并发启动多个长任务，完成后自动回推 |
| 文件双向收发 | 微信发来的文件保存到本地，Codex 生成的常见格式文件会自动作为附件推送 |
| Windows 可用 | 内置 Windows 后台进程管理脚本 |
| 并存部署 | 数据目录为 `~/.wechat-codex-code`，不影响 Claude 版 |

## 前置条件

- Node.js >= 18
- 已安装并登录 Codex CLI
- 个人微信账号

检查 Codex CLI：

```powershell
codex --version
codex exec --help
```

本项目使用的 Codex CLI 能力：

- `codex exec` 非交互执行
- `--json` 输出 JSONL 事件
- `-o, --output-last-message` 写入最终回答
- `--skip-git-repo-check` 允许非 Git 目录
- `-C, --cd` 设置工作目录

## 安装

```powershell
cd %USERPROFILE%\.codex\skills\wechat-codex-code
npm install
npm run build
```

## 首次绑定

```powershell
npm run setup
```

程序会打开二维码图片，用微信扫码绑定。绑定成功后按提示选择工作目录，直接回车会使用：

```text
%USERPROFILE%\Documents\CodexCode
```

## 启动服务

```powershell
npm run daemon -- start
npm run daemon -- status
```

如果显示 `Running (PID: xxx)`，就可以在微信里给新好友发消息测试。

## 管理命令

```powershell
npm run daemon -- status
npm run daemon -- logs
npm run daemon -- stop
npm run daemon -- restart
```

## 开机自动恢复

电脑关机后微信桥接进程会停止，这是正常现象。Windows 上可以安装计划任务，让它在你登录电脑后自动启动，并每天中午 12 点保活检查一次：

```powershell
cd %USERPROFILE%\.codex\skills\wechat-codex-code
npm run autostart -- install
npm run autostart -- status
```

安装后会创建两个计划任务：

- 启动文件夹兜底：`Startup\WechatCodexCode.cmd`，登录 Windows 后自动启动
- `WechatCodexCodeKeepAlive`：每天中午 12 点检查启动一次，已运行时不会重复启动

部分 Windows 环境会拒绝创建登录触发计划任务 `WechatCodexCodeDaemon`，这不影响使用；启动文件夹兜底已经能完成登录自启动。

手动触发一次：

```powershell
npm run autostart -- run
```

取消开机自启：

```powershell
npm run autostart -- uninstall
```

自启动日志在：

```text
%USERPROFILE%\.wechat-codex-code\logs\autostart.log
```

Windows 下也可以双击 `scripts` 目录里的辅助脚本：

- `setup-windows.cmd`
- `start-windows.cmd`
- `status-windows.cmd`
- `logs-windows.cmd`
- `stop-windows.cmd`

## 微信端命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除当前会话 |
| `/stop` | 停止当前任务 |
| `/model <名称>` | 切换 Codex 模型 |
| `/prompt <内容>` | 设置系统提示词 |
| `/cwd <路径>` | 切换工作目录 |
| `/skills` | 查看已安装的 Codex skills |
| `/status` | 查看当前会话状态 |
| `/history [数量]` | 查看最近对话记录 |
| `/chat list` | 列出命名会话 |
| `/chat new <名称>` | 创建并切换到新会话 |
| `/chat use <名称>` | 切换到已有会话 |
| `/chat delete <名称>` | 删除会话，`default` 不能删除 |
| `/task run <任务>` | 后台并发执行任务 |
| `/task list` | 查看最近后台任务 |
| `/task log <ID>` | 查看后台任务日志和结果 |
| `/task stop <ID>` | 停止后台任务 |
| `/compact` | 清除当前 Codex thread，下一条消息开启新 thread |
| `/reset` | 完全重置 |
| `/undo [数量]` | 撤销最近几条对话 |
| `/send <路径>` | 从本机发送文件到微信 |

### 多会话示例

```text
/chat new 项目A
/cwd %USERPROFILE%\Desktop\project-a
帮我检查并修复这个项目

/chat new 小说
/cwd D:\your-data\novel-studio
继续审查最新章节

/chat list
/chat use 项目A
/status
```

每个会话都会独立保存工作目录、模型、Codex thread id 和历史记录。

### 后台并发任务示例

```text
/task run 在当前项目中运行测试，修复失败项，并总结改动
/task run 扫描 README 和源码，整理一份使用说明
/task list
/task log 20260612110530-abcd
/task stop 20260612110530-abcd
```

后台任务使用启动时所在的会话、工作目录和模型。它不会占用主聊天，你可以继续切换会话或发普通消息。后台任务完成后会自动把结果发回微信。

### 文件附件自动发送

当 Codex 生成文件并在回复中标记 `附件: <绝对路径>`，桥接会优先把文件本身作为微信附件发送，再发送隐藏了本机路径的文字说明。普通聊天和后台任务都支持。

支持的常见格式包括：

- 图片：`png`、`jpg`、`jpeg`、`gif`、`webp`、`bmp`、`svg`、`ico`、`tif`、`tiff`、`heic`、`heif`
- 文档：`pdf`、`doc`、`docx`、`rtf`、`odt`、`wps`
- 演示文稿：`ppt`、`pptx`、`pps`、`ppsx`、`odp`、`key`
- 表格：`xls`、`xlsx`、`xlsm`、`csv`、`tsv`、`ods`
- 文本/代码：`txt`、`md`、`markdown`、`log`、`json`、`yaml`、`xml`、`html`、常见源码文件等
- 压缩包：`zip`、`7z`、`rar`、`tar`、`gz`、`tgz`、`bz2`、`xz`、`zst`
- 音视频：`mp3`、`wav`、`m4a`、`mp4`、`mov`、`avi`、`mkv`、`webm`

微信上传仍受服务端大小限制，当前单文件最大约 25MB。

## 当前能力边界

微信桥接当前接入的是 Codex CLI，因此擅长本机命令行任务：读写文件、改代码、运行测试、查看日志、处理本地项目、收发文件。它还没有接入 Codex 桌面端的内置浏览器、屏幕视觉和鼠标键盘控制；需要网页或桌面 UI 操作时，建议让它用命令启动服务并输出地址，或者后续再扩展本机浏览器/桌面自动化工具。

## 数据目录

所有运行数据存储在：

```text
~/.wechat-codex-code/
├── accounts/
├── config.json
├── sessions/
├── tasks/
└── logs/
```

## 工作原理

```text
微信（手机） ←→ ilink Bot API ←→ Node.js 守护进程 ←→ Codex CLI（本机）
```

守护进程长轮询微信消息，把用户输入转成 `codex exec` 调用，并解析 JSONL 事件与最终回答文件。Codex 生成的本地文件如果在回复中被标记为附件，会自动作为文件推送回微信，用户侧不会只收到本机文件路径。
