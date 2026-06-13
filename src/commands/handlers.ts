import type { CommandContext, CommandResult } from './router.js';
import { scanAllSkills, findSkill, type SkillInfo } from '../codex/skill-scanner.js';
import { loadConfig, saveConfig } from '../config.js';
import { DEFAULT_WORKING_DIR } from '../constants.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { listTasks, loadTask, readTaskLog } from '../task-store.js';

const HELP_TEXT = `可用命令：

会话管理：
  /help             显示帮助
  /stop             停止当前对话并清空排队消息
  /clear            清除当前会话
  /reset            完全重置（包括工作目录等设置）
  /status           查看当前会话状态
  /compact          压缩上下文（开始新 Codex thread，保留历史）
  /history [数量]   查看对话记录（默认最近20条）
  /undo [数量]      撤销最近对话（默认1条）
  /chat list        列出命名会话
  /chat new <名称>  创建并切换会话
  /chat use <名称>  切换会话
  /chat delete <名> 删除会话

文件：
  /send <路径>      发送本地文件（图片直接显示，其他文件作为附件）
  /camera           调用本机摄像头拍照并发送图片

后台任务：
  /task run <任务>  后台并发执行任务
  /task list        查看后台任务
  /task log <ID>    查看任务日志
  /task stop <ID>   停止后台任务

配置：
  /cwd [路径]       查看或切换工作目录
  /model [名称]     查看或切换 Codex 模型
  /prompt [内容]    查看或设置系统提示词（全局生效）

其他：
  /skills [full]    列出已安装的 skill（full 显示描述）
  /version          查看版本信息
  /<skill> [参数]   触发已安装的 skill

直接输入文字即可与 Codex CLI 对话`;

// 缓存 skill 列表，避免每次命令都扫描文件系统
let cachedSkills: SkillInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒

function getSkills(): SkillInfo[] {
  const now = Date.now();
  if (!cachedSkills || now - lastScanTime > CACHE_TTL) {
    cachedSkills = scanAllSkills();
    lastScanTime = now;
  }
  return cachedSkills;
}

/** 清除缓存，用于 /skills 命令强制刷新 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已清除，下次消息将开始新会话。', handled: true };
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `当前工作目录: ${ctx.session.workingDirectory}\n用法: /cwd <路径>`, handled: true };
  }
  ctx.updateSession({ workingDirectory: args });
  return { reply: `✅ 工作目录已切换为: ${args}`, handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /model <模型名称>\n例: /model gpt-5.5', handled: true };
  }
  ctx.updateSession({ model: args });
  return { reply: `✅ 模型已切换为: ${args}`, handled: true };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const lines = [
    '📊 会话状态',
    '',
    `会话: ${s.name ?? 'default'}`,
    `工作目录: ${s.workingDirectory}`,
    `模型: ${s.model ?? '默认'}`,
    `Thread ID: ${s.codexThreadId ?? '无'}`,
    `状态: ${s.state}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

export function handleChat(ctx: CommandContext, args: string): CommandResult {
  const [sub = '', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const name = rest.join(' ');

  if (!sub || sub === 'list') {
    const sessions = ctx.listSessions?.() || [];
    if (sessions.length === 0) {
      return { handled: true, reply: '暂无会话。' };
    }
    const lines = sessions.map(({ name: itemName, active, session }) => {
      const marker = active ? '*' : ' ';
      const thread = session.codexThreadId ? session.codexThreadId.slice(0, 8) : '无';
      return `${marker} ${itemName} | ${session.workingDirectory} | thread:${thread}`;
    });
    return {
      handled: true,
      reply: `会话列表：\n\n${lines.join('\n')}\n\n用法：/chat use <名称>`,
    };
  }

  if (sub === 'new' || sub === 'use') {
    if (!name) {
      return { handled: true, reply: `用法: /chat ${sub} <名称>` };
    }
    if (!ctx.switchSession) {
      return { handled: true, reply: '当前版本未启用多会话切换。' };
    }
    const next = ctx.switchSession(name);
    Object.assign(ctx.session, next);
    return {
      handled: true,
      reply: `✅ 已切换到会话: ${next.name}\n工作目录: ${next.workingDirectory}\nThread ID: ${next.codexThreadId ?? '无'}`,
    };
  }

  if (sub === 'delete' || sub === 'del' || sub === 'rm') {
    if (!name) {
      return { handled: true, reply: '用法: /chat delete <名称>' };
    }
    try {
      ctx.deleteSession?.(name);
      return { handled: true, reply: `✅ 已删除会话: ${name}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { handled: true, reply: `删除失败: ${msg}` };
    }
  }

  return {
    handled: true,
    reply: '用法:\n/chat list\n/chat new <名称>\n/chat use <名称>\n/chat delete <名称>',
  };
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString('zh-CN');
}

export function handleTask(ctx: CommandContext, args: string): CommandResult {
  const trimmed = args.trim();
  const spaceIdx = trimmed.indexOf(' ');
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  if (!sub || sub === 'list') {
    const tasks = listTasks(ctx.accountId).slice(0, 20);
    if (tasks.length === 0) {
      return { handled: true, reply: '暂无后台任务。\n用法: /task run <任务内容>' };
    }
    const lines = tasks.map((task) => {
      const prompt = task.prompt.replace(/\s+/g, ' ').slice(0, 40);
      return `${task.id} | ${task.status} | ${task.profile} | ${formatTime(task.createdAt)}\n  ${prompt}`;
    });
    return { handled: true, reply: `后台任务：\n\n${lines.join('\n')}` };
  }

  if (sub === 'run') {
    if (!rest) {
      return { handled: true, reply: '用法: /task run <任务内容>' };
    }
    return { handled: true, startTaskPrompt: rest };
  }

  if (sub === 'log') {
    if (!rest) {
      return { handled: true, reply: '用法: /task log <任务ID>' };
    }
    const task = loadTask(ctx.accountId, rest);
    if (!task) {
      return { handled: true, reply: `未找到任务: ${rest}` };
    }
    const log = readTaskLog(task);
    const lines = [
      `任务: ${task.id}`,
      `状态: ${task.status}`,
      `会话: ${task.profile}`,
      `工作目录: ${task.cwd}`,
      `创建: ${formatTime(task.createdAt)}`,
      `完成: ${formatTime(task.completedAt)}`,
      task.error ? `错误: ${task.error}` : '',
      '',
      log || task.summary || '暂无日志',
    ].filter(Boolean);
    return { handled: true, reply: lines.join('\n') };
  }

  if (sub === 'stop') {
    if (!rest) {
      return { handled: true, reply: '用法: /task stop <任务ID>' };
    }
    return { handled: true, stopTaskId: rest };
  }

  return {
    handled: true,
    reply: '用法:\n/task run <任务内容>\n/task list\n/task log <任务ID>\n/task stop <任务ID>',
  };
}

export function handleSkills(args: string): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: '未找到已安装的 skill。', handled: true };
  }

  const showFull = args.trim().toLowerCase() === 'full';
  if (showFull) {
    const lines = skills.map(s => `/${s.name}\n   ${s.description}`);
    return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n\n')}`, handled: true };
  }
  const lines = skills.map(s => `/${s.name}`);
  return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n')}\n\n使用 /skills full 查看完整描述`, handled: true };
}

const MAX_HISTORY_LIMIT = 100;

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: '用法: /history [数量]\n例: /history 50（显示最近50条对话）', handled: true };
  }
  const effectiveLimit = Math.min(limit, MAX_HISTORY_LIMIT);

  const historyText = ctx.getChatHistoryText?.(effectiveLimit) || '暂无对话记录';

  return { reply: `📝 对话记录（最近${effectiveLimit}条）:\n\n${historyText}`, handled: true };
}

/** 完全重置会话（包括工作目录等设置） */
export function handleReset(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  newSession.workingDirectory = DEFAULT_WORKING_DIR;
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已完全重置，所有设置恢复默认。', handled: true };
}

/** 压缩上下文 — 清除 Codex thread ID，开始新上下文但保留聊天历史 */
export function handleCompact(ctx: CommandContext): CommandResult {
  const currentSessionId = ctx.session.codexThreadId;
  if (!currentSessionId) {
    return { reply: 'ℹ️ 当前没有活动的 Codex thread，无需压缩。', handled: true };
  }
  ctx.updateSession({
    previousCodexThreadId: currentSessionId,
    codexThreadId: undefined,
  });
  return {
    reply: '✅ 上下文已压缩\n\n下次消息将开始新的 Codex thread\n聊天历史已保留，可用 /history 查看',
    handled: true,
  };
}

/** 撤销最近 N 条对话 */
export function handleUndo(ctx: CommandContext, args: string): CommandResult {
  const count = args ? parseInt(args, 10) : 1;
  if (isNaN(count) || count <= 0) {
    return { reply: '用法: /undo [数量]\n例: /undo 2（撤销最近2条对话）', handled: true };
  }
  const history = ctx.session.chatHistory || [];
  if (history.length === 0) {
    return { reply: '⚠️ 没有对话记录可撤销', handled: true };
  }
  const actualCount = Math.min(count, history.length);
  ctx.session.chatHistory = history.slice(0, -actualCount);
  ctx.updateSession({ chatHistory: ctx.session.chatHistory });
  return { reply: `✅ 已撤销最近 ${actualCount} 条对话`, handled: true };
}

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const version = pkg.version || 'unknown';
    return { reply: `wechat-codex-code v${version}`, handled: true };
  } catch {
    return { reply: 'wechat-codex-code (version unknown)', handled: true };
  }
}

export function handlePrompt(_ctx: CommandContext, args: string): CommandResult {
  const config = loadConfig();
  if (!args) {
    const current = config.systemPrompt;
    if (current) {
      return { reply: `📝 当前系统提示词:\n${current}\n\n用法:\n/prompt <提示词>  — 设置\n/prompt clear   — 清除`, handled: true };
    }
    return { reply: '📝 暂无系统提示词\n\n用法: /prompt <提示词>\n例: /prompt 用中文回答我', handled: true };
  }
  if (args.trim().toLowerCase() === 'clear') {
    config.systemPrompt = undefined;
    saveConfig(config);
    return { reply: '✅ 系统提示词已清除', handled: true };
  }
  config.systemPrompt = args.trim();
  saveConfig(config);
  return { reply: `✅ 系统提示词已设置:\n${config.systemPrompt}`, handled: true };
}

export function handleSend(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /send <文件路径>\n例: /send ~/Documents/report.pdf\n     /send ./chart.png', handled: true };
  }

  const resolved = args.startsWith('/')
    ? args
    : resolve(ctx.session.workingDirectory, args.replace(/^~/, homedir()));
  if (!existsSync(resolved)) {
    return { reply: `文件不存在: ${resolved}`, handled: true };
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return { reply: `这是一个目录，请指定文件: ${resolved}`, handled: true };
  }

  if (stat.size > 25 * 1024 * 1024) {
    return { reply: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 25MB`, handled: true };
  }

  return { handled: true, sendFile: resolved };
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const skills = getSkills();
  const skill = findSkill(skills, cmd);

  if (skill) {
    const prompt = args ? `Use the $${skill.name} skill: ${args}` : `Use the $${skill.name} skill`;
    return { handled: true, agentPrompt: prompt };
  }

  return {
    handled: true,
    reply: `未找到 skill: ${cmd}\n输入 /skills 查看可用列表`,
  };
}
