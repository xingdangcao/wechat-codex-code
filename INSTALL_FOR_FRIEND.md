# WeChat Codex Code 安装说明

这个压缩包用于在另一台 Windows 电脑上安装微信 Codex 桥接。

## 前置条件

先确认电脑上已经安装：

- Node.js 18 或更高版本
- Codex CLI，并且已经登录可用
- 可以扫码登录的个人微信

## 安装方式

1. 解压整个压缩包。
2. 双击 `install-windows.cmd`。
3. 按提示用微信扫码绑定。
4. 安装完成后，微信里给绑定的机器人发消息即可使用。

## 安装后具备的能力

- 微信消息转发给本机 Codex CLI。
- 支持图片和文件。
- 支持 `/chat` 多会话。
- 支持 `/task run` 后台任务。
- Windows 登录后自动启动。
- 每天中午 12 点保活检查一次，异常退出后自动恢复。

## 常用微信命令

```text
/status
/help
/chat list
/chat new 项目A
/chat use 项目A
/task run 帮我检查这个项目并总结问题
/task list
/stop
```

## 本机数据位置

安装后的账号、日志、会话会保存在：

```text
C:\Users\当前用户名\.wechat-codex-code
```

压缩包里不包含原电脑的微信账号、日志、会话或任何 token。
