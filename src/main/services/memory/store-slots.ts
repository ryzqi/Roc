import type { MemoryKind, MemoryScope } from '../../../shared/types';

export type MemorySlot = {
  scope: MemoryScope;
  kind: MemoryKind;
  virtualPath: string;
  routePrefix: '/memory/global/' | '/memory/workspaces/current/';
  storeKey: string;
  namespace: string[];
  limitKey: MemoryKind;
};

export type MemorySlotResolveResult =
  | { ok: true; slot: MemorySlot }
  | { ok: false; reason: 'invalid_path' | 'workspace_required'; detail: string };

const globalNamespace = ['roc', 'memory', 'global'] as const;
const workspaceNamespacePrefix = ['roc', 'memory', 'workspaces'] as const;

const whitelistError = [
  'Path not writable. Memory file whitelist:',
  '  /memory/global/USER.md',
  '  /memory/global/AGENTS.md  |  /memory/workspaces/current/AGENTS.md',
  '  /memory/global/MEMORY.md  |  /memory/workspaces/current/MEMORY.md'
].join('\n');

const workspaceRequiredDetail = 'No workspace selected; select a workspace before writing workspace-scoped memory.';

export function listMemorySlots(workspaceHash: string | null): MemorySlot[] {
  const slots: MemorySlot[] = [
    createGlobalSlot('user'),
    createGlobalSlot('agents'),
    createGlobalSlot('memory')
  ];
  if (workspaceHash !== null) {
    slots.push(createWorkspaceSlot('agents', workspaceHash), createWorkspaceSlot('memory', workspaceHash));
  }
  return slots;
}

export function resolveMemorySlotByVirtualPath(
  path: string,
  workspaceHash: string | null
): MemorySlotResolveResult {
  for (const slot of listMemorySlots(workspaceHash)) {
    if (slot.virtualPath === path) {
      return { ok: true, slot };
    }
  }
  if (path === '/memory/workspaces/current/USER.md') {
    return { ok: false, reason: 'invalid_path', detail: 'USER.md lives only at /memory/global/USER.md.' };
  }
  if (
    workspaceHash === null &&
    (path === '/memory/workspaces/current/AGENTS.md' || path === '/memory/workspaces/current/MEMORY.md')
  ) {
    return { ok: false, reason: 'workspace_required', detail: workspaceRequiredDetail };
  }
  return { ok: false, reason: 'invalid_path', detail: whitelistError };
}

export function resolveMemorySlotByScopeKind(
  input: { scope: MemoryScope; kind: MemoryKind },
  workspaceHash: string | null
): MemorySlotResolveResult {
  if (input.scope === 'workspace' && input.kind === 'user') {
    return { ok: false, reason: 'invalid_path', detail: 'USER.md lives only at /memory/global/USER.md.' };
  }
  if (input.scope === 'workspace' && workspaceHash === null) {
    return { ok: false, reason: 'workspace_required', detail: workspaceRequiredDetail };
  }
  const slots = listMemorySlots(workspaceHash);
  const slot = slots.find((candidate) => candidate.scope === input.scope && candidate.kind === input.kind);
  if (slot === undefined) {
    return { ok: false, reason: 'invalid_path', detail: whitelistError };
  }
  return { ok: true, slot };
}

function createGlobalSlot(kind: MemoryKind): MemorySlot {
  return {
    scope: 'global',
    kind,
    virtualPath: `/memory/global/${filenameForKind(kind)}`,
    routePrefix: '/memory/global/',
    storeKey: `/${filenameForKind(kind)}`,
    namespace: [...globalNamespace],
    limitKey: kind
  };
}

function createWorkspaceSlot(kind: Exclude<MemoryKind, 'user'>, workspaceHash: string): MemorySlot {
  return {
    scope: 'workspace',
    kind,
    virtualPath: `/memory/workspaces/current/${filenameForKind(kind)}`,
    routePrefix: '/memory/workspaces/current/',
    storeKey: `/${filenameForKind(kind)}`,
    namespace: [...workspaceNamespacePrefix, workspaceHash],
    limitKey: kind
  };
}

function filenameForKind(kind: MemoryKind): 'USER.md' | 'AGENTS.md' | 'MEMORY.md' {
  if (kind === 'user') {
    return 'USER.md';
  }
  if (kind === 'agents') {
    return 'AGENTS.md';
  }
  return 'MEMORY.md';
}
