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

/** 主题文件目录名，主题文件是 MEMORY.md 索引指向的按需加载明细。 */
export const MEMORY_TOPIC_DIRECTORY = 'topics';

/** 每个作用域允许的主题文件数量上限，防止索引层无限膨胀。 */
export const MAX_MEMORY_TOPICS_PER_SCOPE = 32;

/** 主题文件 slug 只允许小写字母、数字和连字符，避免出现路径穿越或大小写歧义。 */
const topicSlugPattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;

export const MEMORY_WHITELIST_ERROR = [
  'Path not writable. Memory file whitelist:',
  '  /memory/global/USER.md',
  '  /memory/global/AGENTS.md  |  /memory/workspaces/current/AGENTS.md',
  '  /memory/global/MEMORY.md  |  /memory/workspaces/current/MEMORY.md',
  '  /memory/global/topics/<slug>.md  |  /memory/workspaces/current/topics/<slug>.md',
  '  <slug> allows lowercase letters, digits, and hyphens, up to 48 characters.'
].join('\n');

const workspaceRequiredDetail = 'No workspace selected; select a workspace before writing workspace-scoped memory.';

export function memoryTopicStoreKey(slug: string): string {
  return `/${MEMORY_TOPIC_DIRECTORY}/${slug}.md`;
}

/** 从 store key（例如 `/topics/build-pipeline.md`）解析主题 slug，非法路径返回 null。 */
export function parseMemoryTopicStoreKey(storeKey: string): string | null {
  const prefix = `/${MEMORY_TOPIC_DIRECTORY}/`;
  if (!storeKey.startsWith(prefix) || !storeKey.endsWith('.md')) {
    return null;
  }
  const slug = storeKey.slice(prefix.length, storeKey.length - '.md'.length);
  return topicSlugPattern.test(slug) ? slug : null;
}

/** 从虚拟路径（例如 `/memory/global/topics/build-pipeline.md`）解析主题 slug。 */
export function parseMemoryTopicVirtualPath(
  path: string
): { scope: MemoryScope; slug: string } | null {
  const routes: Array<{ scope: MemoryScope; prefix: string }> = [
    { scope: 'global', prefix: '/memory/global/' },
    { scope: 'workspace', prefix: '/memory/workspaces/current/' }
  ];
  for (const route of routes) {
    if (!path.startsWith(route.prefix)) {
      continue;
    }
    const slug = parseMemoryTopicStoreKey(`/${path.slice(route.prefix.length)}`);
    if (slug === null) {
      return null;
    }
    return { scope: route.scope, slug };
  }
  return null;
}

export function memoryTopicVirtualPath(scope: MemoryScope, slug: string): string {
  const prefix = scope === 'global' ? '/memory/global/' : '/memory/workspaces/current/';
  return `${prefix}${MEMORY_TOPIC_DIRECTORY}/${slug}.md`;
}

export type MemoryNamespaceResolveResult =
  | { ok: true; namespace: string[] }
  | { ok: false; reason: 'workspace_required'; detail: string };

/** 主题文件与固定文件共用作用域命名空间，这里单独解析，避免主题路径混进 MemorySlot 列表。 */
export function resolveMemoryNamespace(
  scope: MemoryScope,
  workspaceHash: string | null
): MemoryNamespaceResolveResult {
  if (scope === 'global') {
    return { ok: true, namespace: [...globalNamespace] };
  }
  if (workspaceHash === null) {
    return { ok: false, reason: 'workspace_required', detail: workspaceRequiredDetail };
  }
  return { ok: true, namespace: [...workspaceNamespacePrefix, workspaceHash] };
}

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
  return { ok: false, reason: 'invalid_path', detail: MEMORY_WHITELIST_ERROR };
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
    return { ok: false, reason: 'invalid_path', detail: MEMORY_WHITELIST_ERROR };
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
