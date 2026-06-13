import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import { loadJson, saveJson, validateAccountId } from './store.js';

const TASKS_DIR = join(DATA_DIR, 'tasks');

export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface TaskRecord {
  id: string;
  accountId: string;
  profile: string;
  prompt: string;
  cwd: string;
  model?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  sessionId?: string;
  summary?: string;
  error?: string;
  logPath: string;
}

function safeTaskId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid task id: ${id}`);
  }
  return id;
}

function taskPath(accountId: string, taskId: string): string {
  validateAccountId(accountId);
  return join(TASKS_DIR, accountId, `${safeTaskId(taskId)}.json`);
}

export function createTaskId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function getTaskLogPath(accountId: string, taskId: string): string {
  validateAccountId(accountId);
  return join(TASKS_DIR, accountId, `${safeTaskId(taskId)}.log`);
}

export function saveTask(task: TaskRecord): void {
  mkdirSync(join(TASKS_DIR, task.accountId), { recursive: true });
  task.updatedAt = Date.now();
  saveJson(taskPath(task.accountId, task.id), task);
}

export function loadTask(accountId: string, taskId: string): TaskRecord | undefined {
  const file = taskPath(accountId, taskId);
  if (!existsSync(file)) return undefined;
  return loadJson<TaskRecord | undefined>(file, undefined);
}

export function listTasks(accountId: string): TaskRecord[] {
  validateAccountId(accountId);
  const dir = join(TASKS_DIR, accountId);
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => loadJson<TaskRecord | undefined>(join(dir, file), undefined))
      .filter((task): task is TaskRecord => !!task)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export function readTaskLog(task: TaskRecord, maxChars = 3000): string {
  if (!existsSync(task.logPath)) return '';
  const text = readFileSync(task.logPath, 'utf8');
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}
