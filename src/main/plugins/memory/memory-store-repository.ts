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

type MemoryStoreRepositoryOptions = {
  store: RocSqliteStore;
  workspace?: {
    path: string;
    label: string;
  } | null;
  getMemorySettings?: () => MemoryStoreRepositorySettings;
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

  async readFile(input: { scope: MemoryScope; kind: MemoryKind }): Promise<string | null> {
    const resolved = resolveMemorySlotByScopeKind(input, this.workspaceHash());
    if (!resolved.ok) {
      return null;
    }
    const item = await this.options.store.get(resolved.slot.namespace, resolved.slot.storeKey);
    return readMarkdownContent(item);
  }

  async writeFile(request: MemoryFileWriteRequest): Promise<MemoryFileWriteOutcome> {
    const resolved = resolveMemorySlotByScopeKind(request, this.workspaceHash());
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
    const files: MemoryFileMeta[] = [];
    for (const request of slotRequests) {
      const resolved = resolveMemorySlotByScopeKind(request, this.workspaceHash());
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
      workspaceHash: this.workspaceHash(),
      workspaceLabel: this.options.workspace === null || this.options.workspace === undefined ? null : this.options.workspace.label,
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
      fullTextIndex: { healthy: true, status: 'ready' }
    };
  }

  async buildSnapshotPreview(): Promise<{ text: string }> {
    const sections = ['# DeepAgents Memory Preview'];
    for (const request of slotRequests) {
      const resolved = resolveMemorySlotByScopeKind(request, this.workspaceHash());
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

  private workspaceHash(): string | null {
    if (this.options.workspace === null || this.options.workspace === undefined) {
      return null;
    }
    return buildWorkspaceHash(this.options.workspace.path);
  }
}

export function createMarkdownFileValue(content: string, existing?: Item | null): Record<string, unknown> {
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
