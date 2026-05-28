import type { MemoryKind } from '../../../shared/types';

export type PathResolveResult =
  | { ok: true; resolved: string; kind: MemoryKind }
  | { ok: false; error: string };

const WHITELIST_ERROR = [
  'Path not writable. Memory file whitelist:',
  '  /memory/global/USER.md',
  '  /memory/global/AGENTS.md  |  /memory/workspaces/current/AGENTS.md',
  '  /memory/global/MEMORY.md  |  /memory/workspaces/current/MEMORY.md'
].join('\n');

const FILENAME_TO_KIND: Record<string, MemoryKind> = {
  'USER.md': 'user',
  'AGENTS.md': 'agents',
  'MEMORY.md': 'memory'
};

export function resolveMemoryPath(filePath: string, workspaceHash: string | null): PathResolveResult {
  if (!filePath.startsWith('/memory/')) {
    return { ok: false, error: WHITELIST_ERROR };
  }

  const remainder = filePath.slice('/memory/'.length);
  if (remainder.startsWith('.consolidator-backup/') || remainder.startsWith('logs/')) {
    return { ok: false, error: 'Path not writable: internal directory.' };
  }

  if (remainder.startsWith('global/')) {
    const filename = remainder.slice('global/'.length);
    const kind = FILENAME_TO_KIND[filename];
    if (kind === undefined) {
      return { ok: false, error: WHITELIST_ERROR };
    }
    return { ok: true, resolved: `/global/${filename}`, kind };
  }

  if (remainder.startsWith('workspaces/')) {
    return resolveWorkspaceMemoryPath(remainder.slice('workspaces/'.length), workspaceHash);
  }

  return { ok: false, error: WHITELIST_ERROR };
}

function resolveWorkspaceMemoryPath(afterWorkspaces: string, workspaceHash: string | null): PathResolveResult {
  const slash = afterWorkspaces.indexOf('/');
  if (slash === -1) {
    return { ok: false, error: WHITELIST_ERROR };
  }

  const segment = afterWorkspaces.slice(0, slash);
  const filename = afterWorkspaces.slice(slash + 1);
  const kind = FILENAME_TO_KIND[filename];
  if (kind === undefined) {
    return { ok: false, error: WHITELIST_ERROR };
  }
  if (kind === 'user') {
    return { ok: false, error: 'USER.md lives only at /memory/global/USER.md.' };
  }

  if (segment === 'current') {
    if (workspaceHash === null) {
      return { ok: false, error: 'No workspace selected; select a workspace before writing workspace-scoped memory.' };
    }
    return { ok: true, resolved: `/workspaces/${workspaceHash}/${filename}`, kind };
  }

  if (/^[a-f0-9]{16}$/i.test(segment)) {
    return { ok: true, resolved: `/workspaces/${segment}/${filename}`, kind };
  }

  return { ok: false, error: WHITELIST_ERROR };
}
