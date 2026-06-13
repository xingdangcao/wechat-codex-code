#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.WCC_DATA_DIR || join(homedir(), '.wechat-codex-code');
const logsDir = join(dataDir, 'logs');
const taskName = 'WechatCodexCodeDaemon';
const keepAliveTaskName = 'WechatCodexCodeKeepAlive';
const launcherPath = join(dataDir, 'start-wechat-codex-code.cmd');
const startupLauncherName = 'WechatCodexCode.cmd';

const command = process.argv[2] || 'status';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: projectDir,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function printResult(result) {
  const stdout = result.stdout?.trim();
  const stderr = result.stderr?.trim();
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}

function ensureLauncher() {
  mkdirSync(logsDir, { recursive: true });
  const content = [
    '@echo off',
    `cd /d "${projectDir}"`,
    `"${process.execPath}" "${join(projectDir, 'scripts', 'daemon.mjs')}" start >> "${join(logsDir, 'autostart.log')}" 2>&1`,
    '',
  ].join('\r\n');
  writeFileSync(launcherPath, content, 'utf8');
}

function getStartupDir() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function installStartupLauncher() {
  const startupDir = getStartupDir();
  mkdirSync(startupDir, { recursive: true });
  copyFileSync(launcherPath, join(startupDir, startupLauncherName));
}

function queryTask(name) {
  return run('schtasks.exe', ['/Query', '/TN', name, '/FO', 'LIST']);
}

function deleteTask(name) {
  const result = run('schtasks.exe', ['/Delete', '/TN', name, '/F']);
  return result.status === 0;
}

function install() {
  if (process.platform !== 'win32') {
    console.error('Windows autostart is only supported on Windows.');
    process.exit(1);
  }
  ensureLauncher();
  deleteTask(taskName);
  deleteTask(keepAliveTaskName);

  const onLogon = run('schtasks.exe', [
    '/Create',
    '/TN', taskName,
    '/TR', `"${launcherPath}"`,
    '/SC', 'ONLOGON',
    '/DELAY', '0001:00',
    '/RL', 'LIMITED',
    '/F',
  ]);

  const keepAlive = run('schtasks.exe', [
    '/Create',
    '/TN', keepAliveTaskName,
    '/TR', `"${launcherPath}"`,
    '/SC', 'DAILY',
    '/ST', '12:00',
    '/RL', 'LIMITED',
    '/F',
  ]);

  if (onLogon.status !== 0 || keepAlive.status !== 0) {
    if (keepAlive.status !== 0) printResult(keepAlive);
    if (onLogon.status !== 0) {
      console.warn(`Warning: failed to create ${taskName}; Startup folder fallback will be used.`);
      printResult(onLogon);
    }
    if (keepAlive.status !== 0) process.exit(1);
  }

  installStartupLauncher();
  console.log(`Installed Windows autostart fallback: ${join(getStartupDir(), startupLauncherName)}`);
  console.log(`Installed Windows keepalive task: ${keepAliveTaskName} (daily 12:00)`);
  if (onLogon.status === 0) console.log(`Installed Windows logon task: ${taskName}`);
  console.log(`Launcher: ${launcherPath}`);
}

function uninstall() {
  const removedMain = deleteTask(taskName);
  const removedKeepAlive = deleteTask(keepAliveTaskName);
  rmSync(join(getStartupDir(), startupLauncherName), { force: true });
  console.log(`Removed ${taskName}: ${removedMain ? 'yes' : 'not found'}`);
  console.log(`Removed ${keepAliveTaskName}: ${removedKeepAlive ? 'yes' : 'not found'}`);
  console.log(`Removed Startup fallback: ${join(getStartupDir(), startupLauncherName)}`);
}

function status() {
  for (const name of [taskName, keepAliveTaskName]) {
    const result = queryTask(name);
    console.log(`=== ${name} ===`);
    if (result.status === 0) {
      printResult(result);
    } else {
      console.log('Not installed');
    }
  }
  console.log(`Launcher: ${existsSync(launcherPath) ? launcherPath : 'not created'}`);
  const startupPath = join(getStartupDir(), startupLauncherName);
  console.log(`Startup fallback: ${existsSync(startupPath) ? startupPath : 'not installed'}`);
}

function runNow() {
  ensureLauncher();
  const result = run(launcherPath, [], { shell: true });
  printResult(result);
  process.exit(result.status ?? 0);
}

switch (command) {
  case 'install':
    install();
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'status':
    status();
    break;
  case 'run':
    runNow();
    break;
  default:
    console.log('Usage: npm run autostart -- {install|uninstall|status|run}');
    process.exit(1);
}
