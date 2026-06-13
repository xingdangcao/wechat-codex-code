import type { Session } from '../session.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleCwd, handleModel, handleStatus, handleSkills, handleHistory, handleReset, handleCompact, handleUndo, handleVersion, handlePrompt, handleSend, handleChat, handleTask, handleUnknown } from './handlers.js';

export interface CommandContext {
  accountId: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  switchSession?: (name: string) => Session;
  listSessions?: () => Array<{ name: string; active: boolean; session: Session }>;
  deleteSession?: (name: string) => void;
  getChatHistoryText?: (limit?: number) => string;
  text: string;
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  agentPrompt?: string;
  sendFile?: string; // Absolute path to a file to send to the user
  startTaskPrompt?: string;
  stopTaskId?: string;
  cameraCapture?: boolean;
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /status   - Show current session info
 *   /skills   - List all installed skills
 *   /<skill>  - Invoke a skill by name (args are forwarded to Codex)
 */
export function routeCommand(ctx: CommandContext): CommandResult {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'clear':
      return handleClear(ctx);
    case 'reset':
      return handleReset(ctx);
    case 'cwd':
      return handleCwd(ctx, args);
    case 'model':
      return handleModel(ctx, args);
    case 'prompt':
      return handlePrompt(ctx, args);
    case 'status':
      return handleStatus(ctx);
    case 'skills':
      return handleSkills(args);
    case 'history':
      return handleHistory(ctx, args);
    case 'chat':
      return handleChat(ctx, args);
    case 'task':
      return handleTask(ctx, args);
    case 'undo':
      return handleUndo(ctx, args);
    case 'compact':
      return handleCompact(ctx);
    case 'send':
      return handleSend(ctx, args);
    case 'camera':
    case 'photo':
    case '拍照':
      return { handled: true, cameraCapture: true };
    case 'version':
    case 'v':
      return handleVersion();
    default:
      return handleUnknown(cmd, args);
  }
}
