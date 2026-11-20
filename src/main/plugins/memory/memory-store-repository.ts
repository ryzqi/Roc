import type { Item } from '@langchain/langgraph';

import type {
  AppSettings,
  MemoryFileMeta,
  MemoryFileWriteOutcome,
  MemoryFileWriteRequest,
  MemoryKind,
  MemoryScope,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryStatus
} from '../../../shared/types';
import { defaultSettings } from '../../services/config/defaults';
import { parseAutoMemoryEntries, projectAutoMemoryScope } from '../../services/memory/auto-memory-candidates';
import type { AutoMemoryAuditRepository } from '../../services/memory/auto-memory-audit-repository';
import { withStoreMemoryMutation } from '../../services/memory/memory-mutations';
import { CapacityService } from '../../services/memory/capacity';
import { searchMemoryDocuments } from '../../services/memory/memory-entry-search';
import { SecurityScanService } from '../../services/memory/security-scan';
import {
  MAX_MEMORY_TOPICS_PER_SCOPE,
  memoryTopicStoreKey,
  memoryTopicVirtualPath,
  parseMemoryTopicStoreKey,
  resolveMemoryNamespace,
  resolveMemorySlotByScopeKind,
  type MemorySlot,
  type MemorySlotResolveResult
} from '../../services/memory/store-slots';
import { buildWorkspaceHash } from '../../services/paths';
import { RocSqliteStore } from '../../services/memory/sqlite-store';

export type MemoryStoreRepositorySettings = AppSettings['memory'];

export type MemoryWorkspaceContext = {
  path: string;
  label: string;
};

/**
 * The agent-database facts `memory.status` reports.
 *
 * `session_messages` and its full-text index live in the agent database, so the memory plugin
 * cannot read them from its own connection. Structural (not nominal) so
 * `AgentMemoryStatsContract` satisfies it without the memory plugin importing the agent plugin.
 */
export type MemoryAgentFactsProvider = {
  readSessionStats(): { totalRows: number; oldestAt: string | null };
  readFullTextIndexHealth(): { healthy: boolean; status: 'ready' | 'unavailable' };
};

type MemoryStoreRepositoryOptions = {
  store: RocSqliteStore;
  /**
   * Required, not optional: a status with no agent facts would have to invent them, which is
   * exactly the hardcoded `0 / null / healthy` this contract replaced.
   */
  agentFacts: MemoryAgentFactsProvider;
  getWorkspace: () => MemoryWorkspaceContext | null;
  getMemorySettings?: () => MemoryStoreRepositorySettings;
  auditRepository?: AutoMemoryAuditRepository;
};

type MemoryRepositoryContext = {
  workspace: MemoryWorkspaceContext | null;
  workspaceHash: string | null;
};

const slotRequests: Array<{ scope: MemoryScope; kind: MemoryKind }> = [
  { scope: 'global', kind: 'user' },
  { scope: 'global', kind: 'agents' },
  { scope: 'global', kind: 'memory' },
  { scope: 'workspace', kind: 'agents' },
  { scope: 'workspace', kind: 'memory' }
];

export class MemoryStoreRepository {
  private readonly getMemorySettings: () => MemoryStoreRepositorySettings;

  constructor(private readonly options: MemoryStoreRepositoryOptions) {
    this.getMemorySettings =
      options.getMemorySettings === undefined ? () => defaultSettings.memory : options.getMemorySettings;
  }

  withMutation<T>(operation: () => Promise<T>): Promise<T> {
    return withStoreMemoryMutation(this.options.store, operation);
  }

  async readFile(input: { scope: MemoryScope; kind: MemoryKind }, workspaceOverride?: MemoryWorkspaceContext | null): Promise<string | null> {
    const context = this.resolveContext(workspaceOverride);
    const resolved = resolveMemorySlotByScopeKind(input, context.workspaceHash);
    if (!resolved.ok) {
      return null;
    }
    const item = await this.options.store.get(resolved.slot.namespace, resolved.slot.storeKey);
    return readMarkdownContent(item);
  }

  async writeFile(
    request: MemoryFileWriteRequest,
    workspaceOverride?: MemoryWorkspaceContext | null
  ): Promise<MemoryFileWriteOutcome> {
    const workspace = this.resolveContext(workspaceOverride).workspace;
    return this.withMutation(() => this.writeFileLocked(request, workspace));
  }

  private async writeFileLocked(
    request: MemoryFileWriteRequest,
    workspaceOverride: MemoryWorkspaceContext | null
  ): Promise<MemoryFileWriteOutcome> {
    const context = this.resolveContext(workspaceOverride);
    const resolved = resolveMemorySlotByScopeKind(request, context.workspaceHash);
    if (!resolved.ok) {
      return resolveFailure(resolved);
    }
    const settings = this.getMemorySettings();
    const securityScan = new SecurityScanService(settings.securityScan);
    const issues = securityScan.scan(request.content);
    if (issues.length > 0) {
      return {
        ok: false,
        reason: 'security_scan',
        detail: securityScan.formatIssues(issues),
        issues
      };
    }
    const capacity = new CapacityService(settings.charLimits);
    const capacityResult = capacity.check(request.kind, request.content);
    if (!capacityResult.ok) {
      return {
        ok: false,
        reason: 'capacity_exceeded',
        detail: capacity.formatOverflow(request.kind, capacityResult.chars, capacityResult.limit),
        chars: capacityResult.chars,
        limit: capacityResult.limit
      };
    }
    const existing = await this.options.store.get(resolved.slot.namespace, resolved.slot.storeKey);
    await this.options.store.put(resolved.slot.namespace, resolved.slot.storeKey, createMarkdownFileValue(request.content, existing));
    const written = await this.options.store.get(resolved.slot.namespace, resolved.slot.storeKey);
    return {
      ok: true,
      meta: this.buildMeta(resolved.slot, written)
    };
  }

  /** 读取主题文件；主题文件是 MEMORY.md 索引指向的按需明细，不参与自动注入。 */
  async readTopicFile(
    input: { scope: MemoryScope; slug: string },
    workspaceOverride?: MemoryWorkspaceContext | null
  ): Promise<string | null> {
    const context = this.resolveContext(workspaceOverride);
    const namespace = resolveMemoryNamespace(input.scope, context.workspaceHash);
    if (!namespace.ok) {
      return null;
    }
    const storeKey = memoryTopicStoreKey(input.slug);
    if (parseMemoryTopicStoreKey(storeKey) === null) {
      return null;
    }
    const item = await this.options.store.get(namespace.namespace, storeKey);
    return readMarkdownContent(item);
  }

  async writeTopicFile(
    input: { scope: MemoryScope; slug: string; content: string },
    workspaceOverride?: MemoryWorkspaceContext | null
  ): Promise<MemoryFileWriteOutcome> {
    const workspace = this.resolveContext(workspaceOverride).workspace;
    return this.withMutation(() => this.writeTopicFileLocked(input, workspace));
  }

  private async writeTopicFileLocked(
    input: { scope: MemoryScope; slug: string; content: string },
    workspaceOverride: MemoryWorkspaceContext | null
  ): Promise<MemoryFileWriteOutcome> {
    const context = this.resolveContext(workspaceOverride);
    const namespace = resolveMemoryNamespace(input.scope, context.workspaceHash);
    if (!namespace.ok) {
      return { ok: false, reason: namespace.reason, detail: namespace.detail };
    }
    const storeKey = memoryTopicStoreKey(input.slug);
    if (parseMemoryTopicStoreKey(storeKey) === null) {
      return {
        ok: false,
        reason: 'invalid_path',
        detail: 'Topic slug must use lowercase letters, digits, and hyphens, at most 48 characters.'
      };
    }
    const settings = this.getMemorySettings();
    const securityScan = new SecurityScanService(settings.securityScan);
    const issues = securityScan.scan(input.content);
    if (issues.length > 0) {
      return { ok: false, reason: 'security_scan', detail: securityScan.formatIssues(issues), issues };
    }
    const capacity = new CapacityService(settings.charLimits);
    const capacityResult = capacity.check('memory', input.content);
    if (!capacityResult.ok) {
      return {
        ok: false,
        reason: 'capacity_exceeded',
        detail: capacity.formatOverflow('memory', capacityResult.chars, capacityResult.limit),
        chars: capacityResult.chars,
        limit: capacityResult.limit
      };
    }
    const existing = await this.options.store.get(namespace.namespace, storeKey);
    if (existing === null) {
      const topics = await this.listTopicFiles(input.scope, workspaceOverride);
      if (topics.length >= MAX_MEMORY_TOPICS_PER_SCOPE) {
        return {
          ok: false,
          reason: 'capacity_exceeded',
          detail: `Topic file limit reached (${MAX_MEMORY_TOPICS_PER_SCOPE}). Merge or delete an existing topic file first.`,
          chars: topics.length,
          limit: MAX_MEMORY_TOPICS_PER_SCOPE
        };
      }
    }
    await this.options.store.put(
      namespace.namespace,
      storeKey,
      createMarkdownFileValue(input.content, existing)
    );
    const written = await this.options.store.get(namespace.namespace, storeKey);
    return {
      ok: true,
      meta: {
        scope: input.scope,
        kind: 'memory',
        exists: true,
        charCount: [...input.content].length,
        charLimit: settings.charLimits.memory,
        absolutePath: memoryTopicVirtualPath(input.scope, input.slug),
        effective: true,
        updatedAt: readModifiedAt(written)
      }
    };
  }

  async listTopicFiles(
    scope: MemoryScope,
    workspaceOverride?: MemoryWorkspaceContext | null
  ): Promise<Array<{ slug: string; virtualPath: string; content: string }>> {
    const context = this.resolveContext(workspaceOverride);
    const namespace = resolveMemoryNamespace(scope, context.workspaceHash);
    if (!namespace.ok) {
      return [];
    }
    const items = await this.options.store.search(namespace.namespace, {
      limit: MAX_MEMORY_TOPICS_PER_SCOPE + slotRequests.length
    });
    const topics: Array<{ slug: string; virtualPath: string; content: string }> = [];
    for (const item of items) {
      const slug = parseMemoryTopicStoreKey(item.key);
      if (slug === null) {
        continue;
      }
      const content = readMarkdownContent(item);
      if (content === null) {
        continue;
      }
      topics.push({ slug, virtualPath: memoryTopicVirtualPath(scope, slug), content });
    }
    return topics.sort((left, right) => left.slug.localeCompare(right.slug));
  }

  /** memory_search 的检索面：五个固定文件加上两个作用域下的所有主题文件。 */
  async collectSearchDocuments(
    workspaceOverride?: MemoryWorkspaceContext | null
  ): Promise<Array<{ path: string; scope: MemoryScope; kind: MemoryKind | 'topic'; content: string }>> {
    const documents: Array<{ path: string; scope: MemoryScope; kind: MemoryKind | 'topic'; content: string }> = [];
    const context = this.resolveContext(workspaceOverride);
    for (const request of slotRequests) {
      const resolved = resolveMemorySlotByScopeKind(request, context.workspaceHash);
      if (!resolved.ok) {
        continue;
      }
      const item = await this.options.store.get(resolved.slot.namespace, resolved.slot.storeKey);
      const content = readMarkdownContent(item);
      if (content === null || content.trim().length === 0) {
        continue;
      }
      documents.push({
        path: resolved.slot.virtualPath,
        scope: resolved.slot.scope,
        kind: resolved.slot.kind,
        content
      });
    }
    const scopes: MemoryScope[] = context.workspaceHash === null ? ['global'] : ['global', 'workspace'];
    for (const scope of scopes) {
      const topics = await this.listTopicFiles(scope, context.workspace);
      for (const topic of topics) {
        documents.push({ path: topic.virtualPath, scope, kind: 'topic', content: topic.content });
      }
    }
    return documents;
  }

  /** memory_search 的检索入口：解析记忆条目后按查询词打分，返回条目而不是整个文件。 */
  async searchEntries(
    request: MemorySearchRequest,
    workspaceOverride?: MemoryWorkspaceContext | null
  ): Promise<MemorySearchResult> {
    const pinnedWorkspace = workspaceOverride !== undefined ? workspaceOverride
      : request.workspacePath === undefined ? undefined
        : request.workspacePath === null ? null : { path: request.workspacePath, label: request.workspacePath };
    const documents = await this.collectSearchDocuments(pinnedWorkspace);
    return searchMemoryDocuments(documents, request.query, request.limit === undefined ? 5 : request.limit, request.applicability);
  }

  async status(): Promise<MemoryStatus> {
    const context = this.resolveContext();
    const sessionStats = this.options.agentFacts.readSessionStats();
    const fullTextIndex = this.options.agentFacts.readFullTextIndexHealth();
    const files: MemoryFileMeta[] = [];
    for (const request of slotRequests) {
      const resolved = resolveMemorySlotByScopeKind(request, context.workspaceHash);
      if (!resolved.ok) {
        files.push(this.buildUnavailableMeta(request.scope, request.kind));
        continue;
      }
      const item = await this.options.store.get(resolved.slot.namespace, resolved.slot.storeKey);
      files.push(this.buildMeta(resolved.slot, item));
    }
    let totalChars = 0;
    let totalLimit = 0;
    for (const file of files) {
      if (file.effective) {
        totalChars += file.charCount;
        totalLimit += file.charLimit;
      }
    }
    return {
      root: '/memory',
      workspaceHash: context.workspaceHash,
      workspaceLabel: context.workspace === null ? null : context.workspace.label,
      files,
      snapshot: {
        enabled: true,
        totalChars,
        totalLimit
      },
      sessionMessages: {
        totalRows: sessionStats.totalRows,
        retentionDays: this.getMemorySettings().sessionRetentionDays,
        oldestAt: sessionStats.oldestAt
      },
      fullTextIndex,
      autoMemory: {
        enabled: this.getMemorySettings().autoMemory.enabled,
        auditRetentionDays: this.getMemorySettings().autoMemory.auditRetentionDays,
        recent: this.options.auditRepository === undefined ? [] : this.options.auditRepository.listRecent(20)
      }
    };
  }

  async buildSnapshotPreview(applicability?: string): Promise<{ text: string }> {
    const { workspace } = this.resolveContext();
    // Pin a copy before the first await, including the no-workspace case.
    const documents = await this.collectSearchDocuments(workspace === null ? null : { ...workspace });
    const resolvedApplicability = /^[a-f0-9]{64}$/u.test(applicability ?? '') ? applicability : undefined;
    const sections = [
      '# DeepAgents Memory Preview',
      '仅展示自动注入的固定记忆文档。主题文件仅参与替代和失效判定，其正文按需读取，不在此自动注入。',
      resolvedApplicability === undefined
        ? '当前未绑定运行环境，依赖环境的经验（pitfall / verification）尚未解析，未展示。本预览不是完整运行提示词。'
        : '已按提供的运行环境过滤经验。本预览仅包含记忆文档，不是完整运行提示词。'
    ];
    for (const scope of ['global', 'workspace'] as const) {
      const scoped = documents.filter(document => document.scope === scope);
      const projected = projectPreviewScope(scoped.map(document => document.content), resolvedApplicability);
      scoped.forEach((document, index) => {
        if (document.kind !== 'topic' && projected[index].trim().length > 0) {
          sections.push(`## ${document.path}`, projected[index]);
        }
      });
    }
    return { text: sections.join('\n\n') };
  }

  hasWorkspace(workspaceOverride?: MemoryWorkspaceContext | null): boolean {
    return this.resolveContext(workspaceOverride).workspaceHash !== null;
  }

  private buildUnavailableMeta(scope: MemoryScope, kind: MemoryKind): MemoryFileMeta {
    return {
      scope,
      kind,
      exists: false,
      charCount: 0,
      charLimit: this.getMemorySettings().charLimits[kind],
      absolutePath: '',
      effective: false,
      updatedAt: null
    };
  }

  private buildMeta(slot: MemorySlot, item: Item | null): MemoryFileMeta {
    const content = readMarkdownContent(item);
    return {
      scope: slot.scope,
      kind: slot.kind,
      exists: content !== null,
      charCount: content === null ? 0 : [...content].length,
      charLimit: this.getMemorySettings().charLimits[slot.limitKey],
      absolutePath: slot.virtualPath,
      effective: true,
      updatedAt: readModifiedAt(item)
    };
  }

  private resolveContext(workspaceOverride?: MemoryWorkspaceContext | null): MemoryRepositoryContext {
    const workspace = workspaceOverride === undefined ? this.options.getWorkspace() : workspaceOverride;
    return {
      workspace,
      workspaceHash: workspace === null ? null : buildWorkspaceHash(workspace.path)
    };
  }
}

function projectPreviewScope(contents: readonly string[], applicability: string | undefined): string[] {
  const projected = projectAutoMemoryScope(contents, applicability ?? '');
  if (applicability !== undefined) return projected;
  // An empty applicability must not expose legacy experiences whose hash is also missing.
  return projected.map(content => {
    const lines = content.split('\n');
    for (const entry of parseAutoMemoryEntries(content)) {
      if (entry.type === 'workspace_fact' || entry.type === 'decision') continue;
      for (let line = entry.startLine; line < entry.endLine; line++) lines[line] = '';
    }
    return lines.join('\n');
  });
}

function createMarkdownFileValue(content: string, existing?: Item | null): Record<string, unknown> {
  const now = new Date().toISOString();
  const createdAt = readCreatedAt(existing);
  return {
    content,
    mimeType: 'text/markdown',
    created_at: createdAt === null ? now : createdAt,
    modified_at: now
  };
}

function resolveFailure(resolved: Extract<MemorySlotResolveResult, { ok: false }>): MemoryFileWriteOutcome {
  return {
    ok: false,
    reason: resolved.reason,
    detail: resolved.detail
  };
}

function readMarkdownContent(item: Item | null | undefined): string | null {
  if (item === null || item === undefined) {
    return null;
  }
  const content = item.value.content;
  return typeof content === 'string' ? content : null;
}

function readCreatedAt(item: Item | null | undefined): string | null {
  if (item === null || item === undefined) {
    return null;
  }
  const value = item.value.created_at;
  return typeof value === 'string' ? value : null;
}

function readModifiedAt(item: Item | null | undefined): string | null {
  if (item === null || item === undefined) {
    return null;
  }
  const value = item.value.modified_at;
  return typeof value === 'string' ? value : item.updatedAt.toISOString();
}
