# WeChat Codex Code Bridge

Chat with the local Codex CLI from personal WeChat.

After QR binding, a new WeChat contact appears. Send it a message and the local daemon forwards that message to `codex exec`; the final Codex response is pushed back to WeChat. Text, images, voice-to-text, and files are supported.

This is a Codex CLI fork of `Wechat-ggGitHub/wechat-claude-code`. The WeChat login, polling, and media flow are based on the original project; the agent provider is replaced with Codex CLI non-interactive mode.

## Requirements

- Node.js >= 18
- Codex CLI installed and logged in
- A personal WeChat account

## Install

```powershell
cd C:\Users\caoxingdang\.codex\skills\wechat-codex-code
npm install
npm run build
```

## Bind WeChat

```powershell
npm run setup
```

Scan the QR code with WeChat. The default working directory is:

```text
C:\Users\caoxingdang\Documents\CodexCode
```

## Start

```powershell
npm run daemon -- start
npm run daemon -- status
```

## Manage

```powershell
npm run daemon -- logs
npm run daemon -- stop
npm run daemon -- restart
```

Runtime data is stored under `~/.wechat-codex-code/`.
