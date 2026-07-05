import type { RocPluginContext } from '../../kernel/types';
import type { AppSettings, MemoryScope } from '../../../shared/types';
import type { MemoryStoreRepository, MemoryWorkspaceContext } from '../../plugins/memory/memory-store-repository';
import { defaultSettings } from '../config/defaults';
import type { AutoMemoryAuditRepository } from './auto-memory-audit-repository';
import {
  type AutoMemoryCandidate,
  appendAutoMemoryEntry,
  autoMemoryEntryExists,
  extractAutoMemoryCandidates,
  formatAutoMemoryEntry,
  shouldRejectCandidate
} from './auto-memory-candidates';

const GLOBAL_MEMORY_TARGET_PATH = '/memory/global/MEMORY.md';
const WORKSPACE_MEMORY_TARGET_PATH = '/memory/workspaces/current/MEMORY.md';

export type AgentRunCompletedPayload = {
  runId: string;
  threadId: string | null;
  workspacePath?: string | null;
  summary: string;
  assistantMessage: string;
};

type AutoMemoryWriterOptions = {
  repository: MemoryStoreRepository;
  auditRepository?: AutoMemoryAuditRepository;
  getMemorySettings?: () => AppSettings['memory'];
  logger: RocPluginContext['logger'];
};

export class AutoMemoryWriter {
  constructor(private readonly options: AutoMemoryWriterOptions) {}

  async handleAgentRunCompleted(payload: AgentRunCompletedPayload, createdAt?: string): Promise<void> {
    const settings = this.resolveMemorySettings().autoMemory;
    if (!settings.enabled) {
      return;
    }
    const workspaceOverride = resolveWorkspaceOverride(payload);
    const date = resolveDate(createdAt);
    const eventCreatedAt = createdAt === undefined ? new Date().toISOString() : createdAt;
    const candidates = extractAutoMemoryCandidates(payload, settings, eventCreatedAt);
    if (candidates.length === 0) {
      this.recordAudit({
        action: 'rejected',
        type: 'transient_task_result',
        scope: this.options.repository.hasWorkspace(workspaceOverride) ? 'workspace' : 'global',
        confidence: 'low',
        key: 'no_candidates',
        summary: payload.summary.trim(),
        sourceRunId: payload.runId,
        reason: 'no_candidates',
        workspacePath: readWorkspacePath(payload),
        targetPath: null,
        createdAt: eventCreatedAt
      });
      return;
    }

    for (const candidate of candidates) {
      const targetScope = resolveTargetScope(candidate.scope, workspaceOverride, this.options.repository);
      const targetPath = resolveMemoryTargetPath(targetScope);
      const rejection = shouldRejectCandidate(candidate);
      if (rejection !== null) {
        this.recordCandidateAudit(candidate, 'rejected', rejection, targetPath);
        continue;
      }
      try {
        const current = await this.options.repository.readFile({ scope: targetScope, kind: 'memory' }, workspaceOverride);
        const existing = current === null ? '' : current;
        if (autoMemoryEntryExists(existing, candidate)) {
          this.recordCandidateAudit(candidate, 'duplicate_skipped', 'duplicate', targetPath);
          continue;
        }
        const entry = formatAutoMemoryEntry(candidate);
        const next = appendAutoMemoryEntry(existing, date, entry);
        const result = await this.options.repository.writeFile({
          scope: targetScope,
          kind: 'memory',
          content: next
        }, workspaceOverride);
        if (!result.ok && result.reason === 'capacity_exceeded') {
          const compacted = removeExactDuplicateStructuredEntries(existing);
          const retryContent = appendAutoMemoryEntry(compacted, date, entry);
          const retryResult = await this.options.repository.writeFile({
            scope: targetScope,
            kind: 'memory',
            content: retryContent
          }, workspaceOverride);
          if (retryResult.ok) {
            this.recordCandidateAudit(candidate, 'accepted', 'accepted_after_capacity_retry', targetPath);
            continue;
          }
          this.recordCandidateAudit(candidate, 'write_failed', retryResult.reason, targetPath);
          this.options.logger.warn('memory_auto_write_skipped', {
            reason: retryResult.reason
          });
          continue;
        }
        if (!result.ok) {
          this.recordCandidateAudit(candidate, 'write_failed', result.reason, targetPath);
          this.options.logger.warn('memory_auto_write_skipped', {
            reason: result.reason
          });
          continue;
        }
        this.recordCandidateAudit(candidate, 'accepted', 'accepted', targetPath);
      } catch (error) {
        this.recordCandidateAudit(candidate, 'write_failed', 'exception', targetPath);
        this.options.logger.warn('memory_auto_write_failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private recordCandidateAudit(
    candidate: AutoMemoryCandidate,
    action: Parameters<AutoMemoryAuditRepository['record']>[0]['action'],
    reason: string,
    targetPath: string | null
  ): void {
    this.recordAudit({
      action,
      type: candidate.type,
      scope: candidate.scope,
      confidence: candidate.confidence,
      key: candidate.key,
      summary: candidate.summary,
      sourceRunId: candidate.sourceRunId,
      reason,
      workspacePath: candidate.workspacePath,
      targetPath,
      createdAt: candidate.createdAt
    });
  }

  private recordAudit(input: Parameters<AutoMemoryAuditRepository['record']>[0]): void {
    if (this.options.auditRepository === undefined) {
      return;
    }
    try {
      this.options.auditRepository.record(input);
    } catch (error) {
      this.options.logger.warn('memory_auto_audit_write_failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private resolveMemorySettings(): AppSettings['memory'] {
    if (this.options.getMemorySettings === undefined) {
      return defaultSettings.memory;
    }
    return this.options.getMemorySettings();
  }
}

export function isAgentRunCompletedPayload(value: unknown): value is AgentRunCompletedPayload {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.runId === 'string' &&
    (typeof record.threadId === 'string' || record.threadId === null) &&
    (record.workspacePath === undefined || typeof record.workspacePath === 'string' || record.workspacePath === null) &&
    typeof record.summary === 'string' &&
    typeof record.assistantMessage === 'string'
  );
}

function resolveWorkspaceOverride(payload: AgentRunCompletedPayload): MemoryWorkspaceContext | null | undefined {
  if (payload.workspacePath === undefined) {
    return undefined;
  }
  if (payload.workspacePath === null) {
    return null;
  }
  const workspacePath = payload.workspacePath.trim();
  if (workspacePath.length === 0) {
    throw new Error('agent_run_completed_workspace_path_empty');
  }
  return {
    path: workspacePath,
    label: workspacePath
  };
}

function readWorkspacePath(payload: AgentRunCompletedPayload): string | null {
  if (payload.workspacePath === undefined) {
    return null;
  }
  return payload.workspacePath;
}

function resolveDate(createdAt: string | undefined): string {
  if (createdAt !== undefined) {
    const parsed = new Date(createdAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

function resolveTargetScope(
  candidateScope: MemoryScope,
  workspaceOverride: MemoryWorkspaceContext | null | undefined,
  repository: MemoryStoreRepository
): MemoryScope {
  if (candidateScope === 'workspace' && repository.hasWorkspace(workspaceOverride)) {
    return 'workspace';
  }
  return 'global';
}

function resolveMemoryTargetPath(scope: MemoryScope): string {
  if (scope === 'workspace') {
    return WORKSPACE_MEMORY_TARGET_PATH;
  }
  return GLOBAL_MEMORY_TARGET_PATH;
}

function removeExactDuplicateStructuredEntries(existing: string): string {
  const lines = existing.split('\n');
  const result: string[] = [];
  const seenEntries = new Set<string>();
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].startsWith('- type: ')) {
      result.push(lines[index]);
      index += 1;
      continue;
    }
    const entry: string[] = [];
    while (index < lines.length && (entry.length === 0 || !lines[index].startsWith('- type: '))) {
      entry.push(lines[index]);
      index += 1;
    }
    const normalized = entry.join('\n').replace(/\s+/gu, ' ').trim();
    if (!seenEntries.has(normalized)) {
      seenEntries.add(normalized);
      result.push(...entry);
    }
  }
  return result.join('\n').trimEnd();
}
