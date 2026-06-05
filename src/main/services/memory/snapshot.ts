import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings, MemoryKind } from '../../../shared/types';

export type FrozenSnapshotPart = {
  kind: MemoryKind;
  filename: 'USER.md' | 'AGENTS.md' | 'MEMORY.md';
  content: string;
  charCount: number;
  charLimit: number;
  source: 'global' | 'workspace';
  enabled: boolean;
};

export type FrozenSnapshot = {
  user: FrozenSnapshotPart;
  agents: FrozenSnapshotPart;
  memory: FrozenSnapshotPart;
  totalChars: number;
  totalLimit: number;
  globallyEnabled: boolean;
};

type ReadPartInput = {
  memoryDir: string;
  kind: MemoryKind;
  filename: FrozenSnapshotPart['filename'];
  workspaceHash: string | null;
  limit: number;
  enabled: boolean;
};

const TAG_BY_KIND: Record<MemoryKind, string> = {
  user: 'USER_PROFILE',
  agents: 'AGENTS_RULES',
  memory: 'LONG_TERM_MEMORY'
};

export function buildFrozenSnapshot(input: {
  memoryDir: string;
  workspaceHash: string | null;
  settings: AppSettings['memory'];
}): FrozenSnapshot {
  const { memoryDir, settings, workspaceHash } = input;
  const user = readPart({
    memoryDir,
    kind: 'user',
    filename: 'USER.md',
    workspaceHash: null,
    limit: settings.charLimits.user,
    enabled: settings.frozenSnapshotEnabled && settings.userProfileEnabled
  });
  const agents = readPart({
    memoryDir,
    kind: 'agents',
    filename: 'AGENTS.md',
    workspaceHash,
    limit: settings.charLimits.agents,
    enabled: settings.frozenSnapshotEnabled && settings.agentsRulesEnabled
  });
  const memory = readPart({
    memoryDir,
    kind: 'memory',
    filename: 'MEMORY.md',
    workspaceHash,
    limit: settings.charLimits.memory,
    enabled: settings.frozenSnapshotEnabled
  });

  return {
    user,
    agents,
    memory,
    totalChars: user.charCount + agents.charCount + memory.charCount,
    totalLimit: settings.charLimits.user + settings.charLimits.agents + settings.charLimits.memory,
    globallyEnabled: settings.frozenSnapshotEnabled
  };
}

export function renderFrozenSnapshot(snapshot: FrozenSnapshot): string {
  if (!snapshot.globallyEnabled) {
    return '';
  }
  const parts = [snapshot.user, snapshot.agents, snapshot.memory].map((part) => {
    const tag = TAG_BY_KIND[part.kind];
    if (!part.enabled) {
      return `<${tag} disabled="true"/>`;
    }
    return [
      `<${tag} usage="${part.charCount}/${part.charLimit}" source="${part.source}">`,
      part.content,
      `</${tag}>`
    ].join('\n');
  });
  return ['<FROZEN_SNAPSHOT>', ...parts, '</FROZEN_SNAPSHOT>'].join('\n');
}

function readPart(input: ReadPartInput): FrozenSnapshotPart {
  if (!input.enabled) {
    return {
      kind: input.kind,
      filename: input.filename,
      content: '',
      charCount: 0,
      charLimit: input.limit,
      source: 'global',
      enabled: false
    };
  }

  if (input.workspaceHash !== null) {
    const workspacePath = join(input.memoryDir, 'workspaces', input.workspaceHash, input.filename);
    if (existsSync(workspacePath)) {
      const content = readFileSync(workspacePath, 'utf8');
      return buildPart(input, content, 'workspace');
    }
  }

  const globalPath = join(input.memoryDir, 'global', input.filename);
  if (existsSync(globalPath)) {
    const content = readFileSync(globalPath, 'utf8');
    return buildPart(input, content, 'global');
  }

  return buildPart(input, '', 'global');
}

function buildPart(input: ReadPartInput, content: string, source: FrozenSnapshotPart['source']): FrozenSnapshotPart {
  return {
    kind: input.kind,
    filename: input.filename,
    content,
    charCount: [...content].length,
    charLimit: input.limit,
    source,
    enabled: true
  };
}

/**
 * 使用百分比渲染 usage，减少绝对值微变对缓存的影响
 */
export function renderFrozenSnapshotWithPercentage(snapshot: FrozenSnapshot): string {
  if (snapshot.parts.length === 0) {
    return '';
  }

  const parts: string[] = ['<FROZEN_SNAPSHOT>'];

  for (const part of snapshot.parts) {
    const usagePercent = part.charLimit > 0
      ? Math.floor((part.charCount / part.charLimit) * 100)
      : 0;
    const tag = TAG_BY_KIND[part.kind];
    parts.push(`<${tag} usage="${usagePercent}%" source="${part.source}">`);
    parts.push(part.content);
    parts.push(`</${tag}>`);
  }

  parts.push('</FROZEN_SNAPSHOT>');
  return parts.join('\n');
}
