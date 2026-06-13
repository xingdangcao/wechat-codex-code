import { loadJson, saveJson, validateAccountId } from './store.js';
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { DATA_DIR, DEFAULT_WORKING_DIR } from './constants.js';
import { join } from 'node:path';
import { logger } from './logger.js';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const DEFAULT_PROFILE = 'default';

export type SessionState = 'idle' | 'processing';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Session {
  name?: string;
  codexThreadId?: string;
  previousCodexThreadId?: string;
  workingDirectory: string;
  model?: string;
  state: SessionState;
  chatHistory: ChatMessage[];
  maxHistoryLength?: number;
}

export interface SessionIndex {
  active: string;
  profiles: string[];
}

const DEFAULT_MAX_HISTORY = 100;

function normalizeProfileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return DEFAULT_PROFILE;
  const normalized = trimmed.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_PROFILE;
}

export function createSessionStore() {
  function getLegacySessionPath(accountId: string): string {
    validateAccountId(accountId);
    return join(SESSIONS_DIR, `${accountId}.json`);
  }

  function getIndexPath(accountId: string): string {
    validateAccountId(accountId);
    return join(SESSIONS_DIR, `${accountId}.index.json`);
  }

  function getSessionPath(accountId: string, profileName = DEFAULT_PROFILE): string {
    validateAccountId(accountId);
    const safeName = normalizeProfileName(profileName);
    return join(SESSIONS_DIR, `${accountId}.${safeName}.json`);
  }

  function createEmptySession(profileName = DEFAULT_PROFILE, base?: Partial<Session>): Session {
    return {
      name: normalizeProfileName(profileName),
      codexThreadId: undefined,
      previousCodexThreadId: undefined,
      workingDirectory: base?.workingDirectory ?? DEFAULT_WORKING_DIR,
      model: base?.model,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: base?.maxHistoryLength || DEFAULT_MAX_HISTORY,
    };
  }

  function normalizeSession(session: Session & { sdkSessionId?: string; previousSdkSessionId?: string }, profileName: string): Session {
    if (!session.codexThreadId && session.sdkSessionId) {
      session.codexThreadId = session.sdkSessionId;
    }
    if (!session.previousCodexThreadId && session.previousSdkSessionId) {
      session.previousCodexThreadId = session.previousSdkSessionId;
    }
    delete session.sdkSessionId;
    delete session.previousSdkSessionId;

    session.name = normalizeProfileName(session.name || profileName);
    if (!session.workingDirectory) session.workingDirectory = DEFAULT_WORKING_DIR;
    if (!session.state) session.state = 'idle';
    if (!session.chatHistory) session.chatHistory = [];
    if (!session.maxHistoryLength) session.maxHistoryLength = DEFAULT_MAX_HISTORY;
    return session;
  }

  function loadIndex(accountId: string): SessionIndex {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const legacyPath = getLegacySessionPath(accountId);
    const defaultPath = getSessionPath(accountId, DEFAULT_PROFILE);
    if (!existsSync(defaultPath) && existsSync(legacyPath)) {
      try {
        renameSync(legacyPath, defaultPath);
      } catch (err) {
        logger.warn('Failed to migrate legacy session file', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const index = loadJson<SessionIndex>(getIndexPath(accountId), {
      active: DEFAULT_PROFILE,
      profiles: [DEFAULT_PROFILE],
    });
    const profiles = new Set<string>([DEFAULT_PROFILE, ...(index.profiles || []).map(normalizeProfileName)]);
    try {
      for (const file of readdirSync(SESSIONS_DIR)) {
        const prefix = `${accountId}.`;
        if (!file.startsWith(prefix) || !file.endsWith('.json') || file.endsWith('.index.json')) continue;
        const profile = file.slice(prefix.length, -'.json'.length);
        profiles.add(normalizeProfileName(profile));
      }
    } catch {
      // ignore directory scan errors
    }
    const active = profiles.has(normalizeProfileName(index.active)) ? normalizeProfileName(index.active) : DEFAULT_PROFILE;
    const normalized = { active, profiles: Array.from(profiles).sort() };
    saveJson(getIndexPath(accountId), normalized);
    return normalized;
  }

  function saveIndex(accountId: string, index: SessionIndex): void {
    const profiles = Array.from(new Set(index.profiles.map(normalizeProfileName))).sort();
    const active = profiles.includes(normalizeProfileName(index.active)) ? normalizeProfileName(index.active) : DEFAULT_PROFILE;
    saveJson(getIndexPath(accountId), { active, profiles });
  }

  function load(accountId: string, profileName?: string): Session {
    const index = loadIndex(accountId);
    const profile = normalizeProfileName(profileName || index.active);
    const session = loadJson<Session & { sdkSessionId?: string; previousSdkSessionId?: string }>(getSessionPath(accountId, profile), {
      ...createEmptySession(profile),
    });

    return normalizeSession(session, profile);
  }

  function save(accountId: string, session: Session, profileName?: string): void {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const profile = normalizeProfileName(profileName || session.name || loadIndex(accountId).active);
    session.name = profile;

    const index = loadIndex(accountId);
    if (!index.profiles.includes(profile)) index.profiles.push(profile);
    saveIndex(accountId, { active: index.active || profile, profiles: index.profiles });

    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }

    saveJson(getSessionPath(accountId, profile), session);
  }

  function loadActive(accountId: string): { profile: string; session: Session; index: SessionIndex } {
    const index = loadIndex(accountId);
    const session = load(accountId, index.active);
    return { profile: index.active, session, index };
  }

  function setActive(accountId: string, profileName: string, base?: Partial<Session>): Session {
    const profile = normalizeProfileName(profileName);
    const index = loadIndex(accountId);
    if (!index.profiles.includes(profile)) index.profiles.push(profile);
    let session = load(accountId, profile);
    if (!existsSync(getSessionPath(accountId, profile))) {
      session = createEmptySession(profile, base);
      save(accountId, session, profile);
    }
    saveIndex(accountId, { active: profile, profiles: index.profiles });
    return session;
  }

  function listProfiles(accountId: string): Array<{ name: string; active: boolean; session: Session }> {
    const index = loadIndex(accountId);
    return index.profiles.map((profile) => ({
      name: profile,
      active: profile === index.active,
      session: load(accountId, profile),
    }));
  }

  function deleteProfile(accountId: string, profileName: string): SessionIndex {
    const profile = normalizeProfileName(profileName);
    if (profile === DEFAULT_PROFILE) {
      throw new Error('default 会话不能删除');
    }
    const index = loadIndex(accountId);
    const profiles = index.profiles.filter((item) => item !== profile);
    try {
      unlinkSync(getSessionPath(accountId, profile));
    } catch {
      // ignore missing file
    }
    const active = index.active === profile ? DEFAULT_PROFILE : index.active;
    const updated = { active, profiles: profiles.includes(DEFAULT_PROFILE) ? profiles : [DEFAULT_PROFILE, ...profiles] };
    saveIndex(accountId, updated);
    return updated;
  }

  function clear(accountId: string, currentSession?: Session, profileName?: string): Session {
    const profile = normalizeProfileName(profileName || currentSession?.name || loadIndex(accountId).active);
    const session = createEmptySession(profile, currentSession);
    save(accountId, session, profile);
    return session;
  }

  function loadLegacyForMigration(accountId: string): Session {
    validateAccountId(accountId);
    const session = loadJson<Session & { sdkSessionId?: string; previousSdkSessionId?: string }>(getLegacySessionPath(accountId), {
      workingDirectory: DEFAULT_WORKING_DIR,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: DEFAULT_MAX_HISTORY,
    });

    return normalizeSession(session, DEFAULT_PROFILE);
  }

  function addChatMessage(session: Session, role: 'user' | 'assistant', content: string): void {
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    session.chatHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Trim if exceeds max length
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }
  }

  function getChatHistoryText(session: Session, limit?: number): string {
    const history = session.chatHistory || [];
    const messages = limit ? history.slice(-limit) : history;

    if (messages.length === 0) {
      return '暂无对话记录';
    }

    const lines: string[] = [];
    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleString('zh-CN');
      const role = msg.role === 'user' ? '用户' : 'Codex';
      lines.push(`[${time}] ${role}:`);
      lines.push(msg.content);
      lines.push('');
    }

    return lines.join('\n');
  }

  return {
    load,
    save,
    loadActive,
    loadIndex,
    setActive,
    listProfiles,
    deleteProfile,
    clear,
    addChatMessage,
    getChatHistoryText,
    normalizeProfileName,
    loadLegacyForMigration,
  };
}
