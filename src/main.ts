import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join, basename, extname, resolve } from 'node:path';
import { appendFileSync, existsSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl, extractFirstFileItem, downloadFile } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { codexQuery, type QueryOptions } from './codex/provider.js';
import { createTaskId, getTaskLogPath, loadTask, saveTask, type TaskRecord } from './task-store.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';
import { capturePhoto, describeCameraResult, isCameraCaptureRequest } from './local-camera.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 4000;

// Extensions eligible for auto-push when detected in Codex's response
const AUTO_PUSH_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tif', '.tiff', '.heic', '.heif',
  // Documents
  '.pdf', '.doc', '.docx', '.rtf', '.odt', '.wps',
  // Presentations
  '.ppt', '.pptx', '.pps', '.ppsx', '.odp', '.key',
  // Spreadsheets and tabular data
  '.csv', '.tsv', '.xls', '.xlsx', '.xlsm', '.ods',
  // Text, markdown, logs, and common source/config files
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml', '.html', '.htm',
  '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs',
  '.php', '.rb', '.sh', '.ps1', '.bat', '.cmd', '.sql',
  // Archives and packages
  '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst',
  // Audio and video
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.mp4', '.mov', '.avi', '.mkv', '.webm',
]);

const AUTO_PUSH_EXT_PATTERN = Array.from(AUTO_PUSH_EXTENSIONS)
  .map(ext => ext.replace('.', '\\.'))
  .sort((a, b) => b.length - a.length)
  .join('|');
const PATH_TRAILING_CHARS = /[\s`"'“”‘’。；;，,、）)\]}>\u300b\u300d\u300f]+$/;

/** Extract local file paths from Codex's response text. */
function extractFilePathsFromText(text: string, cwd: string): string[] {
  const paths = new Set<string>();
  const addCandidate = (raw: string) => {
    const resolved = normalizeCandidatePath(raw, cwd);
    if (resolved && isPushableFilePath(resolved)) paths.add(resolved);
  };

  const wrappedRegex = new RegExp(String.raw`[` + '"' + String.raw`'“”‘’]([^` + '"' + String.raw`'“”‘’\r\n]+?(?:${AUTO_PUSH_EXT_PATTERN}))[` + '"' + String.raw`'“”‘’]`, 'gi');
  const markdownLinkRegex = new RegExp(String.raw`\]\(([^)\r\n]+?(?:${AUTO_PUSH_EXT_PATTERN}))\)`, 'gi');
  const inlineCodeRegex = new RegExp(String.raw`\x60([^` + String.raw`\r\n]+?(?:${AUTO_PUSH_EXT_PATTERN}))\x60`, 'gi');
  const explicitRelativeRegex = new RegExp(String.raw`(?:^|[\s(（])((?:\.{1,2}[\\/])[^` + '"' + String.raw`'“”‘’\r\n]+?(?:${AUTO_PUSH_EXT_PATTERN}))`, 'gim');

  for (const regex of [wrappedRegex, markdownLinkRegex, inlineCodeRegex, explicitRelativeRegex]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) addCandidate(match[1]);
  }

  for (const line of text.split(/\r?\n/)) {
    for (const prefixMatch of line.matchAll(/[A-Za-z]:[\\/]|~[\\/]|\/(?:Users|home|tmp|var|etc)\//g)) {
      const segment = line.slice(prefixMatch.index).replace(/^[`"'“”‘’<(\[]+/, '');
      const extRegex = new RegExp(AUTO_PUSH_EXT_PATTERN, 'gi');
      let extMatch: RegExpExecArray | null;
      while ((extMatch = extRegex.exec(segment)) !== null) {
        addCandidate(segment.slice(0, extMatch.index + extMatch[0].length));
      }
    }
  }

  return Array.from(paths);
}

function normalizeCandidatePath(raw: string, cwd: string): string | undefined {
  let candidate = raw.trim()
    .replace(/^file:\/\//i, '')
    .replace(/^[`"'“”‘’<(\[]+/, '')
    .replace(PATH_TRAILING_CHARS, '');
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // Keep the raw path when it contains a literal percent sign rather than URL encoding.
  }
  if (!candidate) return undefined;
  if (candidate.startsWith('~')) candidate = candidate.replace(/^~/, homedir());
  if (/^\.{1,2}[\\/]/.test(candidate)) candidate = resolve(cwd, candidate);
  return candidate;
}

function isPushableFilePath(filePath: string): boolean {
  try {
    const ext = extname(filePath).toLowerCase();
    return AUTO_PUSH_EXTENSIONS.has(ext) && existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function sanitizeTextForPushedFiles(text: string, pushedFiles: string[]): string {
  if (pushedFiles.length === 0) return text;
  let cleaned = text;
  for (const filePath of pushedFiles) {
    const name = basename(filePath);
    const variants = Array.from(new Set([
      filePath,
      filePath.replace(/\\/g, '/'),
      filePath.replace(/\//g, '\\'),
      `\`${filePath}\``,
      `<${filePath}>`,
    ]));
    for (const variant of variants) {
      cleaned = cleaned.replace(new RegExp(escapeRegExp(variant), 'g'), name);
    }
  }
  cleaned = cleaned
    .replace(/(?:文件路径|保存路径|路径|位置)\s*[:：]\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const names = pushedFiles.map(file => basename(file)).join('、');
  const note = `已作为微信附件发送：${names}`;
  return cleaned.includes(note) ? cleaned : [cleaned, note].filter(Boolean).join('\n\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pushDetectedFiles(
  text: string,
  cwd: string,
  sender: ReturnType<typeof createSender>,
  fromUserId: string,
  contextToken: string,
): Promise<{ pushedFiles: string[]; failedFiles: string[] }> {
  const pushable = extractFilePathsFromText(text, cwd);
  const failedFiles: string[] = [];
  for (const filePath of pushable) {
    try {
      await sender.sendFile(fromUserId, contextToken, filePath);
    } catch {
      failedFiles.push(filePath);
    }
  }
  if (failedFiles.length > 0) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const delay = (attempt + 1) * 15_000;
      logger.warn(`Rate-limited, retrying ${failedFiles.length} file(s) in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
      await new Promise(r => setTimeout(r, delay));
      const stillFailed: string[] = [];
      for (const filePath of failedFiles) {
        try {
          await sender.sendFile(fromUserId, contextToken, filePath);
        } catch {
          stillFailed.push(filePath);
        }
      }
      if (stillFailed.length === 0) {
        failedFiles.length = 0;
        break;
      }
      failedFiles.length = 0;
      failedFiles.push(...stillFailed);
    }
  }
  return {
    pushedFiles: pushable.filter(file => !failedFiles.includes(file)),
    failedFiles,
  };
}

/** Split text into blocks at paragraph boundaries (double newlines). */
function parseBlocks(text: string): string[] {
  return text.split(/\n\n+/).filter(block => block.length > 0);
}

/** Find a safe split point that won't break markdown formatting. */
function findSafeSplitPoint(text: string, maxLen: number): number {
  // Try newline first (preserves list items, paragraphs)
  let idx = text.lastIndexOf('\n', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Try sentence-ending punctuation
  const sentenceEnd = /[。！？.!?]$/;
  for (let i = maxLen; i >= maxLen * 0.5; i--) {
    if (sentenceEnd.test(text.slice(i - 1, i))) return i;
  }

  // Try space (won't split mid-word or mid-markdown)
  idx = text.lastIndexOf(' ', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Last resort: hard cut
  return maxLen;
}

/** Fallback: split a single oversized block at safe boundaries. */
function splitByNewline(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const splitIdx = findSafeSplitPoint(remaining, maxLen);
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

/**
 * Card-aware message splitter.
 * Splits at paragraph boundaries (double newlines) to keep cards intact,
 * falls back to newline-based splitting for oversized single blocks.
 */
function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const blocks = parseBlocks(text);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    // Can this block fit into the current chunk?
    if (current.length === 0) {
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
      }
    } else if (current.length + 2 + block.length <= maxLen) {
      current += '\n\n' + block;
    } else {
      // Current chunk is complete, start a new one
      chunks.push(current);
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendLongText(
  sender: ReturnType<typeof createSender>,
  toUserId: string,
  contextToken: string,
  text: string,
): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await sender.sendText(toUserId, contextToken, chunk);
  }
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    // Linux: try xdg-open
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → display → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux' &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      // Headless Linux: display QR in terminal using qrcode-terminal
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);

      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  // Clean up QR image
  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

  const workingDir = await promptUser('请输入工作目录', join(homedir(), 'Documents', 'CodexCode'));
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  let session: Session = sessionStore.loadActive(account.accountId).session;

  // Fix: backfill session workingDirectory from config if it's still the default process.cwd()
  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, session);
  }

  // Fix: reset stale non-idle state on startup (e.g. after crash)
  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }

  const sender = createSender(api, account.accountId);
  const sharedCtx = { lastContextToken: '' };
  const activeControllers = new Map<string, AbortController>();

  // -- Message queue for serial processing --
  const messageQueue: WeixinMessage[] = [];
  let processingQueue = false;

  async function drainQueue(): Promise<void> {
    if (processingQueue) return;
    processingQueue = true;
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      await handleMessage(
        msg,
        account!,
        () => session,
        (next) => { session = next; },
        sessionStore,
        sender,
        config,
        sharedCtx,
        activeControllers,
        messageQueue,
      );
    }
    processingQueue = false;
  }

  // -- Wire the monitor callbacks --

  /** Handle priority commands (/stop, /clear) immediately, bypassing the serial queue. */
  function handlePriorityCommand(msg: WeixinMessage): boolean {
    if (msg.message_type !== MessageType.USER || !msg.item_list) return false;
    const text = extractTextFromItems(msg.item_list);
    if (!text.startsWith('/stop') && !text.startsWith('/clear')) return false;
    if (session.state !== 'processing') return false;

    const ctrl = activeControllers.get(account!.accountId);
    if (ctrl) { ctrl.abort(); activeControllers.delete(account!.accountId); }
    session.state = 'idle';
    sessionStore.save(account!.accountId, session);

    if (text.startsWith('/stop')) {
      messageQueue.length = 0;
      sender.sendText(msg.from_user_id!, msg.context_token ?? '', '⏹ 已停止当前对话，排队中的消息已清空。').catch(() => {});
    }
    return true;
  }

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      if (handlePriorityCommand(msg)) return;
      messageQueue.push(msg);
      drainQueue();
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  // -- Graceful shutdown --

  function shutdown(): void {
    logger.info('Shutting down...');
    monitor.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);

  await monitor.run();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  getSession: () => Session,
  setSession: (session: Session) => void,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
  activeControllers: Map<string, AbortController>,
  messageQueue: WeixinMessage[],
): Promise<void> {
  // Filter: only user messages with required fields
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;
  if (account.userId && msg.from_user_id !== account.userId) return;
  const session = getSession();

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;

  // Extract text from items
  const userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);
  const fileItem = extractFirstFileItem(msg.item_list);

  // -- Local camera capture shortcut --
  if (isCameraCaptureRequest(userText) && !imageItem && !fileItem) {
    await handleLocalCameraCapture(fromUserId, contextToken, sender);
    return;
  }

  // Drop non-command messages while processing (priority commands already handled upstream)
  if (session.state === 'processing' && !userText.startsWith('/')) {
    return;
  }

  // -- Command routing --

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId, session, session.name),
      switchSession: (name: string) => {
        const next = sessionStore.setActive(account.accountId, name, {
          workingDirectory: session.workingDirectory,
          model: session.model,
          maxHistoryLength: session.maxHistoryLength,
        });
        setSession(next);
        return next;
      },
      listSessions: () => sessionStore.listProfiles(account.accountId),
      deleteSession: (name: string) => {
        sessionStore.deleteProfile(account.accountId, name);
        const next = sessionStore.loadActive(account.accountId).session;
        setSession(next);
      },
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      return;
    }

    if (result.handled && result.agentPrompt) {
      await sendToCodex(
        result.agentPrompt, imageItem, fileItem, fromUserId, contextToken,
        account, session, sessionStore, sender, config, activeControllers,
      );
      return;
    }

    if (result.handled && result.sendFile) {
      await sender.sendFile(fromUserId, contextToken, result.sendFile);
      return;
    }

    if (result.handled && result.cameraCapture) {
      await handleLocalCameraCapture(fromUserId, contextToken, sender);
      return;
    }

    if (result.handled && result.startTaskPrompt) {
      await startBackgroundTask(
        result.startTaskPrompt,
        fromUserId,
        contextToken,
        account,
        { ...getSession(), chatHistory: [...(getSession().chatHistory || [])] },
        sender,
        config,
        activeControllers,
      );
      return;
    }

    if (result.handled && result.stopTaskId) {
      const stopped = stopBackgroundTask(account.accountId, result.stopTaskId, activeControllers);
      await sender.sendText(fromUserId, contextToken, stopped ? `⏹ 已请求停止任务: ${result.stopTaskId}` : `未找到运行中的任务: ${result.stopTaskId}`);
      return;
    }

    if (result.handled) return;

    // Not handled, treat as normal message (fall through)
  }

  // -- Normal message -> Codex --

  if (!userText && !imageItem && !fileItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、语音、图片或文件');
    return;
  }

  await sendToCodex(
    userText, imageItem, fileItem, fromUserId, contextToken,
    account, getSession(), sessionStore, sender, config, activeControllers,
  );
}

const backgroundTaskControllers = new Map<string, AbortController>();

function taskControllerKey(accountId: string, taskId: string): string {
  return `${accountId}:${taskId}`;
}

function stopBackgroundTask(
  accountId: string,
  taskId: string,
  activeControllers: Map<string, AbortController>,
): boolean {
  const key = taskControllerKey(accountId, taskId);
  const ctrl = backgroundTaskControllers.get(key) || activeControllers.get(key);
  if (!ctrl) return false;
  ctrl.abort();
  backgroundTaskControllers.delete(key);
  activeControllers.delete(key);
  const task = loadTask(accountId, taskId);
  if (task && task.status === 'running') {
    task.status = 'stopped';
    task.completedAt = Date.now();
    task.error = '用户请求停止';
    saveTask(task);
  }
  return true;
}

async function startBackgroundTask(
  prompt: string,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  sessionSnapshot: Session,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  const taskId = createTaskId();
  const cwd = (sessionSnapshot.workingDirectory || config.workingDirectory).replace(/^~/, homedir());
  const task: TaskRecord = {
    id: taskId,
    accountId: account.accountId,
    profile: sessionSnapshot.name || 'default',
    prompt,
    cwd,
    model: sessionSnapshot.model,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    logPath: getTaskLogPath(account.accountId, taskId),
  };
  saveTask(task);

  const abortController = new AbortController();
  const key = taskControllerKey(account.accountId, taskId);
  backgroundTaskControllers.set(key, abortController);
  activeControllers.set(key, abortController);

  await sender.sendText(
    fromUserId,
    contextToken,
    `✅ 后台任务已启动\nID: ${taskId}\n会话: ${task.profile}\n工作目录: ${task.cwd}\n\n查看: /task log ${taskId}\n停止: /task stop ${taskId}`,
  );

  void (async () => {
    try {
      appendFileSync(task.logPath, `[${new Date().toLocaleString('zh-CN')}] started\n${prompt}\n\n`, 'utf8');
      const result = await codexQuery({
        prompt,
        cwd,
        model: sessionSnapshot.model,
        systemPrompt: [
          '你正在通过微信后台任务运行。请在最终回复中简洁说明完成情况和验证结果。如果生成了文件，请用一行“附件: <绝对路径>”标记，桥接程序会把文件本身发送到微信并隐藏本机路径。',
          config.systemPrompt,
        ].filter(Boolean).join('\n'),
        abortController,
        onText: (delta) => {
          appendFileSync(task.logPath, delta + '\n\n', 'utf8');
        },
      });

      if (abortController.signal.aborted) {
        task.status = 'stopped';
        task.error = '用户请求停止';
        task.completedAt = Date.now();
        saveTask(task);
        await sender.sendText(fromUserId, contextToken, `⏹ 后台任务已停止\nID: ${task.id}`);
        return;
      }

      task.sessionId = result.sessionId || sessionSnapshot.codexThreadId;
      task.summary = result.text || '';
      task.error = result.error;
      task.status = result.error && !result.text ? 'failed' : 'completed';
      task.completedAt = Date.now();
      saveTask(task);

      const title = task.status === 'completed' ? '✅ 后台任务完成' : '⚠️ 后台任务失败';
      const taskResultText = result.text || '没有返回内容';
      const pushed = result.text
        ? await pushDetectedFiles(result.text, cwd, sender, fromUserId, contextToken)
        : { pushedFiles: [], failedFiles: [] };
      if (pushed.failedFiles.length > 0) {
        logger.error('Background task file delivery failed after all retries', { taskId: task.id, files: pushed.failedFiles });
      }
      const visibleTaskText = sanitizeTextForPushedFiles(taskResultText, pushed.pushedFiles);
      const body = [
        `${title}`,
        `ID: ${task.id}`,
        `会话: ${task.profile}`,
        task.error ? `错误: ${task.error}` : '',
        pushed.failedFiles.length > 0 ? `附件推送失败: ${pushed.failedFiles.map(file => basename(file)).join('、')}` : '',
        '',
        visibleTaskText,
      ].filter(Boolean).join('\n');
      await sendLongText(sender, fromUserId, contextToken, body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      task.status = abortController.signal.aborted ? 'stopped' : 'failed';
      task.error = abortController.signal.aborted ? '用户请求停止' : msg;
      task.completedAt = Date.now();
      saveTask(task);
      appendFileSync(task.logPath, `\n[${new Date().toLocaleString('zh-CN')}] ${task.status}: ${task.error}\n`, 'utf8');
      await sender.sendText(fromUserId, contextToken, `⚠️ 后台任务${task.status === 'stopped' ? '已停止' : '失败'}\nID: ${task.id}\n${task.error}`);
    } finally {
      backgroundTaskControllers.delete(key);
      activeControllers.delete(key);
    }
  })();
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

async function handleLocalCameraCapture(
  fromUserId: string,
  contextToken: string,
  sender: ReturnType<typeof createSender>,
): Promise<void> {
  const stopTyping = sender.startTyping(fromUserId, contextToken);
  try {
    const result = capturePhoto();
    await sender.sendFile(fromUserId, contextToken, result.filePath);
    await sender.sendText(fromUserId, contextToken, describeCameraResult(result));
    logger.info('Local camera photo sent', { filePath: result.filePath, deviceName: result.deviceName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Local camera capture failed', { error: message });
    await sender.sendText(fromUserId, contextToken, `拍照失败: ${message}`);
  } finally {
    stopTyping();
  }
}

async function sendToCodex(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fileItem: ReturnType<typeof extractFirstFileItem>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  // Create abort controller for this query so it can be cancelled by new messages
  const abortController = new AbortController();
  activeControllers.set(account.accountId, abortController);

  // Flush timer for streaming text to WeChat during query (declared here for finally cleanup)
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  // Record user message in chat history
  sessionStore.addChatMessage(session, 'user', userText || '(图片)');

  // Start typing indicator (keepalive until stopTyping is called)
  const stopTyping = sender.startTyping(fromUserId, contextToken);

  try {
    // Download image if present
    let images: QueryOptions['images'];
    if (imageItem) {
      const base64DataUri = await downloadImage(imageItem);
      if (base64DataUri) {
        const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          images = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: matches[1],
                data: matches[2],
              },
            },
          ];
        }
      }
    }

    // Download file if present
    let prompt = userText || '请分析这张图片';
    if (fileItem) {
      const filePath = await downloadFile(fileItem);
      if (filePath) {
        const fileName = fileItem.file_item?.file_name || basename(filePath);
        prompt = userText
          ? `${userText}\n\n用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请先读取这个文件再回答。`
          : `用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请读取这个文件并总结其内容。`;
      }
    }

    let textBuffer = '';
    let anySent = false;
    let lastSentTime = Date.now();

    const MIN_BATCH_FLUSH_LEN = 30;
    const SOFT_FLUSH_LIMIT = 3800;

    /** Check if buffer ends at a structural boundary (double newline or horizontal rule). */
    function endsWithStructuralBoundary(text: string): boolean {
      return /\n\n\s*$/.test(text) || /\n[-*_]{3,}\s*$/.test(text);
    }

    // Serial promise chain — each flushText() appends to the chain, no flags needed
    let flushChain: Promise<void> = Promise.resolve();

    function flushText(): Promise<void> {
      // Capture and clear synchronously to prevent race condition:
      // new deltas can arrive while the chain awaits sendText,
      // causing the async callback to clear content it never captured.
      const captured = textBuffer.trim();
      textBuffer = '';
      if (!captured) return flushChain;

      flushChain = flushChain.then(async () => {
        const chunks = splitMessage(captured);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
        anySent = true;
        lastSentTime = Date.now();
      }).catch((err) => {
        logger.error('flushText send failed', { error: err instanceof Error ? err.message : String(err) });
      });
      return flushChain;
    }

    // Safety net: send keepalive if nothing was sent for 5 minutes
    const SILENCE_WARNING_MS = 5 * 60 * 1000;
    const SILENCE_MESSAGES = [
      '我还在处理中，这个问题有点复杂，请再稍等一下',
      '正在努力干活中，马上就有结果了，请稍等片刻',
      '有点复杂正在处理，再给我一点时间，很快就好',
      '快好了别着急，正在收尾阶段，马上给你回复',
      '还在跑呢，任务量比较大，不过马上就能出结果了',
      '任务比想象的复杂一些，再等等我，正在全力处理',
      '正在处理中，进展顺利，再等一会儿就好',
      '还没完不过已经快了，再给我一分钟就能搞定',
      '我在认真思考这个问题，请再稍等一会儿',
      '稍微有点棘手，不过已经快解决了，再等我一下',
    ];
    flushTimer = setInterval(() => {
      if (Date.now() - lastSentTime > SILENCE_WARNING_MS) {
        const msg = SILENCE_MESSAGES[Math.floor(Math.random() * SILENCE_MESSAGES.length)];
        sender.sendText(fromUserId, contextToken, msg).catch(() => {});
        lastSentTime = Date.now();
      }
    }, 2000);

    const queryOptions: QueryOptions = {
      prompt,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      resume: session.codexThreadId,
      model: session.model,
      systemPrompt: [
        '你正在通过微信与用户对话，不是在终端里。不要让用户去终端操作。如果用户需要文件，请创建实际文件，并在最终回复里用一行“附件: <绝对路径>”标记给桥接程序识别。桥接程序会把文件本身发送到微信，最终给用户看的回复会隐藏本机路径。',
        config.systemPrompt,
      ].filter(Boolean).join('\n'),
      abortController,
      images,
      onText: async (delta: string) => {
        textBuffer += delta;
      },
      onBlockEnd: () => {
        // Defer final text until file paths can be sanitized and attachments can be sent first.
      },
    };

    let result = await codexQuery(queryOptions);

    // If resume failed (e.g. corrupted session), retry without resume
    if (result.error && !result.text && queryOptions.resume) {
      logger.warn('Resume failed, retrying without resume', { error: result.error, sessionId: queryOptions.resume });
      queryOptions.resume = undefined;
      session.codexThreadId = undefined;
      sessionStore.save(account.accountId, session);
      const retryResult = await codexQuery(queryOptions);
      Object.assign(result, retryResult);
    }

    // Stop periodic keepalive. Text is sent after file paths are sanitized.
    clearInterval(flushTimer);

    // Send result back to WeChat
    if (result.text) {
      if (result.error) {
        logger.warn('Codex query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      const cwd = (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir());
      const pushed = await pushDetectedFiles(result.text, cwd, sender, fromUserId, contextToken);
      if (pushed.failedFiles.length > 0) {
        logger.error('File delivery failed after all retries', { files: pushed.failedFiles });
        await sender.sendText(
          fromUserId,
          contextToken,
          `部分附件推送失败（可能是服务端限频或文件过大）：${pushed.failedFiles.map(file => basename(file)).join('、')}`,
        ).catch(() => {});
      }
      const visibleText = sanitizeTextForPushedFiles(result.text, pushed.pushedFiles);
      if (!anySent || visibleText) {
        const chunks = splitMessage(visibleText);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
      logger.error('Codex query error', { error: result.error });
      await sender.sendText(fromUserId, contextToken, 'Codex 处理请求时出错，请稍后重试。');
    } else if (!anySent) {
      await sender.sendText(fromUserId, contextToken, 'Codex 无返回内容（可能因权限被拒而终止）');
    }

    // Update session with new Codex thread ID
    session.codexThreadId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(account.accountId, session);

    textBuffer = '';
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      // Query was cancelled by a new incoming message — exit silently
      logger.info('Codex query aborted by new message');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToCodex', { error: errorMsg });
      await sender.sendText(fromUserId, contextToken, '处理消息时出错，请稍后重试。');
    }
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } finally {
    clearInterval(flushTimer);
    stopTyping();
    // Clean up the abort controller if it's still ours
    if (activeControllers.get(account.accountId) === abortController) {
      activeControllers.delete(account.accountId);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  // 'start' or no argument
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
