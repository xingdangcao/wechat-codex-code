#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.WCC_DATA_DIR || join(homedir(), '.wechat-codex-code');
const logsDir = join(dataDir, 'logs');
const pidFile = join(dataDir, 'wechat-codex-code.pid');
const metaFile = join(dataDir, 'wechat-codex-code.process.json');

const command = process.argv[2] || '';

function printUsage() {
  console.log('Usage: npm run daemon -- {start|stop|restart|status|logs}');
}

function ensureDataDirs() {
  mkdirSync(logsDir, { recursive: true });
}

function hasBuiltEntry() {
  return existsSync(join(projectDir, 'dist', 'main.js'));
}

function hasAccount() {
  const accountsDir = join(dataDir, 'accounts');
  try {
    return readdirSync(accountsDir).some((file) => file.endsWith('.json'));
  } catch {
    return false;
  }
}

function readPid() {
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function removePidFiles() {
  rmSync(pidFile, { force: true });
  rmSync(metaFile, { force: true });
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tailFile(filePath, maxLines = 80) {
  if (!existsSync(filePath)) return '';
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  return lines.slice(-maxLines).join('\n').trimEnd();
}

function listBridgeLogs() {
  try {
    return readdirSync(logsDir)
      .filter((file) => file.startsWith('bridge-') && file.endsWith('.log'))
      .sort()
      .reverse()
      .map((file) => join(logsDir, file));
  } catch {
    return [];
  }
}

function runShellDaemon() {
  const shellScript = join(projectDir, 'scripts', 'daemon.sh');
  const result = spawnSync('bash', [shellScript, command], {
    cwd: projectDir,
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function status() {
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    console.log(`Running (PID: ${pid})`);
    return true;
  }
  if (pid) {
    removePidFiles();
    console.log('Not running (stale PID file cleaned)');
    return false;
  }
  console.log('Not running');
  return false;
}

function start() {
  ensureDataDirs();

  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    console.log(`Already running (PID: ${pid})`);
    return;
  }
  if (pid) removePidFiles();

  if (!hasBuiltEntry()) {
    console.error('dist/main.js not found. Run `npm run build` first.');
    process.exit(1);
  }

  if (!hasAccount()) {
    console.error('No WeChat account is bound yet. Run `npm run setup` first and scan the QR code with WeChat.');
    process.exit(1);
  }

  const stdoutPath = join(logsDir, 'stdout.log');
  const stderrPath = join(logsDir, 'stderr.log');
  const stdout = openSync(stdoutPath, 'a');
  const stderr = openSync(stderrPath, 'a');

  appendFileSync(stdoutPath, `\n[daemon] starting at ${new Date().toISOString()}\n`);

  const child = spawn(process.execPath, [join(projectDir, 'dist', 'main.js'), 'start'], {
    cwd: projectDir,
    detached: true,
    stdio: ['ignore', stdout, stderr],
    env: process.env,
    windowsHide: true,
  });

  writeFileSync(pidFile, `${child.pid}\n`, 'utf8');
  writeFileSync(metaFile, JSON.stringify({
    pid: child.pid,
    startedAt: new Date().toISOString(),
    projectDir,
    stdoutPath,
    stderrPath,
  }, null, 2) + '\n', 'utf8');

  child.unref();
  closeSync(stdout);
  closeSync(stderr);

  console.log(`Started wechat-codex-code daemon (Windows direct mode, PID: ${child.pid})`);
  console.log(`Logs: ${stdoutPath}`);
}

function stop() {
  const pid = readPid();
  if (!pid) {
    console.log('Not running');
    return;
  }

  if (!isProcessRunning(pid)) {
    removePidFiles();
    console.log('Not running (stale PID file cleaned)');
    return;
  }

  const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'pipe',
    windowsHide: true,
  });

  removePidFiles();

  if (result.status === 0) {
    console.log(`Stopped (PID: ${pid})`);
  } else {
    const stderr = result.stderr?.toString().trim();
    console.log(`Stop requested (PID: ${pid})`);
    if (stderr) console.log(stderr);
  }
}

function logs() {
  const files = [
    ...listBridgeLogs().slice(0, 1),
    join(logsDir, 'stdout.log'),
    join(logsDir, 'stderr.log'),
  ];

  let printed = false;
  for (const file of files) {
    const content = tailFile(file);
    if (!content) continue;
    printed = true;
    console.log(`=== ${file} ===`);
    console.log(content);
    console.log();
  }

  if (!printed) {
    console.log('No logs found');
  }
}

if (process.platform !== 'win32') {
  runShellDaemon();
}

switch (command) {
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    stop();
    start();
    break;
  case 'status':
    status();
    break;
  case 'logs':
    logs();
    break;
  default:
    printUsage();
    process.exit(1);
}
