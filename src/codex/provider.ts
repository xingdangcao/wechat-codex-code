import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { logger } from '../logger.js';

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  systemPrompt?: string;
  images?: Array<{
    type: 'image';
    source: { type: 'base64'; media_type: string; data: string };
  }>;
  onText?: (text: string) => Promise<void> | void;
  onBlockEnd?: () => Promise<void> | void;
  abortController?: AbortController;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
}

const TEMP_DIR = join(tmpdir(), 'wechat-codex-code');

interface CodexCommand {
  command: string;
  argsPrefix: string[];
  shell: boolean;
  display: string;
}

function resolveCodexCommand(): CodexCommand {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    join(homedir(), 'AppData', 'Local', 'npm-global', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(homedir(), 'AppData', 'Local', 'npm-global', 'codex.cmd'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_global', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_global', 'codex.cmd'),
  ].filter((candidate): candidate is string => !!candidate?.trim());

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;

    const lower = candidate.toLowerCase();
    if (lower.endsWith('.js')) {
      return {
        command: process.execPath,
        argsPrefix: [candidate],
        shell: false,
        display: `${process.execPath} ${candidate}`,
      };
    }

    return {
      command: candidate,
      argsPrefix: [],
      shell: process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat')),
      display: candidate,
    };
  }

  return {
    command: process.env.CODEX_CLI_COMMAND || 'codex',
    argsPrefix: [],
    shell: process.platform === 'win32',
    display: process.env.CODEX_CLI_COMMAND || 'codex',
  };
}

function saveImageTemp(images: NonNullable<QueryOptions['images']>): string[] {
  mkdirSync(TEMP_DIR, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const ext = img.source.media_type.split('/')[1] || 'png';
    const fileName = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = join(TEMP_DIR, fileName);
    writeFileSync(filePath, Buffer.from(img.source.data, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

function buildPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) return prompt;
  return [
    '<system>',
    systemPrompt,
    '</system>',
    '',
    '<user>',
    prompt,
    '</user>',
  ].join('\n');
}

function buildArgs(options: QueryOptions, finalOutputPath: string, imagePaths: string[]): string[] {
  const common: string[] = [
    '--json',
    '--skip-git-repo-check',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="danger-full-access"',
    '-o', finalOutputPath,
  ];

  if (options.model) {
    common.push('-m', options.model);
  }

  for (const imagePath of imagePaths) {
    common.push('-i', imagePath);
  }

  if (options.resume) {
    return ['exec', 'resume', ...common, options.resume, '-'];
  }

  return ['exec', ...common, '-C', options.cwd, '-'];
}

export async function codexQuery(options: QueryOptions): Promise<QueryResult> {
  const { prompt, cwd, resume, model, systemPrompt, images, onText, onBlockEnd, abortController } = options;

  logger.info('Starting Codex CLI query', {
    cwd,
    model,
    resume: !!resume,
    hasImages: !!images?.length,
  });

  mkdirSync(TEMP_DIR, { recursive: true });
  const tempImagePaths = images?.length ? saveImageTemp(images) : [];
  const finalOutputPath = join(TEMP_DIR, `last-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const args = buildArgs(options, finalOutputPath, tempImagePaths);
  const fullPrompt = buildPrompt(prompt, systemPrompt);
  const codexCommand = resolveCodexCommand();

  let sessionId = resume ?? '';
  const textParts: string[] = [];
  let errorMessage: string | undefined;
  let child: ChildProcess | undefined;
  let settled = false;
  const QUERY_TIMEOUT_MS = 60 * 60 * 1000;

  return new Promise<QueryResult>((resolve) => {
    const finish = (result: QueryResult) => {
      if (settled) return;
      settled = true;
      cleanupTempFiles(tempImagePaths);
      try { unlinkSync(finalOutputPath); } catch { /* ignore */ }
      resolve(result);
    };

    try {
      logger.info('Spawning Codex CLI', { command: codexCommand.display });
      child = spawn(codexCommand.command, [...codexCommand.argsPrefix, ...args], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        shell: codexCommand.shell,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ text: '', sessionId: '', error: `Failed to spawn codex: ${msg}` });
      return;
    }

    child.stdin!.write(fullPrompt);
    child.stdin!.end();

    const timeoutId = setTimeout(() => {
      logger.warn('Codex CLI query timed out, killing process');
      child!.kill('SIGTERM');
      const partialText = textParts.join('\n').trim();
      finish({
        text: partialText,
        sessionId,
        error: partialText ? undefined : 'Codex query timed out after 60 minutes',
      });
    }, QUERY_TIMEOUT_MS);

    const onAbort = () => {
      logger.info('Codex CLI query aborted');
      child!.kill('SIGTERM');
      const partialText = textParts.join('\n').trim();
      finish({ text: partialText, sessionId });
    };
    abortController?.signal.addEventListener('abort', onAbort, { once: true });

    const stderrParts: string[] = [];
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderrParts.push(chunk);
    });

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }

      if (obj.type === 'thread.started' && obj.thread_id) {
        sessionId = obj.thread_id;
        return;
      }

      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
        const text = String(obj.item.text ?? '').trim();
        if (text) {
          textParts.push(text);
          if (onText) Promise.resolve(onText(text)).catch(() => {});
          if (onBlockEnd) Promise.resolve(onBlockEnd()).catch(() => {});
        }
        return;
      }

      if (obj.type === 'turn.failed' || obj.type === 'error') {
        errorMessage = obj.message || obj.error || JSON.stringify(obj);
        logger.error('Codex CLI returned error event', obj);
      }
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);

      if (code !== 0 && code !== null && !textParts.length && !errorMessage) {
        const stderr = stderrParts.join('').trim();
        errorMessage = stderr || `codex exited with code ${code}`;
        logger.error('Codex CLI exited with error', { code, stderr: stderr.slice(0, 1000) });
      }

      let fullText = textParts.join('\n\n').trim();
      if (existsSync(finalOutputPath)) {
        const finalText = readFileSync(finalOutputPath, 'utf8').trim();
        if (finalText) fullText = finalText;
      }

      if (!fullText && !errorMessage) {
        errorMessage = 'Codex returned an empty response.';
      }

      logger.info('Codex CLI query completed', {
        sessionId,
        textLength: fullText.length,
        hasError: !!errorMessage,
      });

      finish({ text: fullText, sessionId, error: errorMessage });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);
      finish({ text: '', sessionId, error: `Failed to spawn codex: ${err.message}` });
    });
  });
}
