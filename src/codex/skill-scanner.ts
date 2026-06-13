import { readdirSync, readFileSync, existsSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../logger.js';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

function parseSkillMd(filePath: string): { name: string; description: string } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const frontmatter = match[1];
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

    if (!nameMatch) return null;

    return {
      name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
      description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : '',
    };
  } catch {
    logger.warn(`Failed to read SKILL.md: ${filePath}`);
    return null;
  }
}

function scanDirectory(baseDir: string, depth: number = 2): SkillInfo[] {
  const skills: SkillInfo[] = [];

  if (!existsSync(baseDir)) return skills;

  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(baseDir, entry.name);

    if (depth > 1) {
      skills.push(...scanDirectory(fullPath, depth - 1));
    }

    const skillFile = join(fullPath, 'SKILL.md');
    if (existsSync(skillFile)) {
      const info = parseSkillMd(skillFile);
      if (info) {
        skills.push({ ...info, path: fullPath });
      }
    }
  }

  return skills;
}

export function scanAllSkills(): SkillInfo[] {
  const home = homedir();
  const codexDir = join(home, '.codex');
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();

  for (const skill of scanDirectory(join(codexDir, 'skills'), 1)) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      skills.push(skill);
    }
  }

  const pluginsCacheDir = join(codexDir, 'plugins', 'cache');
  if (existsSync(pluginsCacheDir)) {
    let cacheEntries: Dirent[];
    try {
      cacheEntries = readdirSync(pluginsCacheDir, { withFileTypes: true });
    } catch {
      cacheEntries = [];
    }

    for (const cacheEntry of cacheEntries) {
      if (!cacheEntry.isDirectory()) continue;
      const cacheDir = join(pluginsCacheDir, cacheEntry.name);

      for (const skill of scanDirectory(join(cacheDir, 'skills'), 2)) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name);
          skills.push(skill);
        }
      }

      for (const skill of scanDirectory(join(cacheDir, 'superpowers', 'skills'), 1)) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name);
          skills.push(skill);
        }
      }
    }
  }

  logger.info(`Scanned ${skills.length} Codex skills`);
  return skills;
}

export function findSkill(skills: SkillInfo[], name: string): SkillInfo | undefined {
  const lower = name.toLowerCase();
  return skills.find(
    (s) => s.name.toLowerCase() === lower || s.name.toLowerCase().replace(/\s+/g, '-') === lower,
  );
}
