import type { Item } from '@langchain/langgraph';

import type {
  AppSettings,
  MemoryFileMeta,
  MemoryFileWriteOutcome,
  MemoryFileWriteRequest,
  MemoryKind,
  MemoryScope,
  MemoryStatus
} from '../../../shared/types';
import { defaultSettings } from '../../services/config/defaults';
import type { AutoMemoryAuditRepository } from '../../services/memory/auto-memory-audit-repository';
import { CapacityService } from '../../services/memory/capacity';
import { SecurityScanService } from '../../services/memory/security-scan';
import {
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

type MemoryStoreRepositoryOptions = {
  store: RocSqliteStore;
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

  async status(): Promise<MemoryStatus> {
    const context = this.resolveContext();
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
        totalRows: 0,
        retentionDays: this.getMemorySettings().sessionRetentionDays,
        oldestAt: null
      },
      fullTextIndex: { healthy: true, status: 'ready' },
      autoMemory: {
        enabled: this.getMemorySettings().autoMemory.enabled,
        auditRetentionDays: this.getMemorySettings().autoMemory.auditRetentionDays,
        recent: this.options.auditRepository === undefined ? [] : this.options.auditRepository.listRecent(20)
      }
    };
  }

  async buildSnapshotPreview(): Promise<{ text: string }> {
    const context = this.resolveContext();
    const sections = ['# DeepAgents Memory Preview'];
    for (const request of slotRequests) {
      const resolved = resolveMemorySlotByScopeKind(request, context.workspaceHash);
      if (!resolved.ok) {
        continue;
      }
      const item = await this.options.store.get(resolved.slot.namespace, resolved.slot.storeKey);
      const content = readMarkdownContent(item);
      if (content === null || content.length === 0) {
        continue;
      }
      sections.push(`## ${resolved.slot.virtualPath}`, content);
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
