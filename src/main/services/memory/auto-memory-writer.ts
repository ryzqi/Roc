import type { RocPluginContext } from '../../kernel/types';
import type {
  AppSettings,
  AutoMemoryCandidateType,
  AutoMemoryConfidence,
  MemoryScope
} from '../../../shared/types';
import type { MemoryStoreRepository, MemoryWorkspaceContext } from '../../plugins/memory/memory-store-repository';
import { defaultSettings } from '../config/defaults';
import type { AutoMemoryAuditRepository } from './auto-memory-audit-repository';
import {
  type AutoMemoryCandidate,
  type ParsedAutoMemoryEntry,
  appendArchiveIndexLine,
  appendAutoMemoryEntry,
  appendTopicArchiveSection,
  appendUserPreferenceEntry,
  archiveTopicSlug,
  autoMemoryEntryExists,
  buildAutoMemoryCandidate,
  extractOldestAutoMemorySection,
  formatAutoMemoryEntry,
  formatUserPreferenceEntry,
  pruneExpiredAutoMemoryEntries,
  replaceUserPreferenceEntry,
  shouldRejectCandidate,
  userPreferenceEntryStatus
} from './auto-memory-candidates';
import { memoryTopicVirtualPath } from './store-slots';

const GLOBAL_USER_TARGET_PATH = '/memory/global/USER.md';
const GLOBAL_MEMORY_TARGET_PATH = '/memory/global/MEMORY.md';
const WORKSPACE_MEMORY_TARGET_PATH = '/memory/workspaces/current/MEMORY.md';

/** 单次写入最多搬走多少个日期小节，避免容量始终不够时无限循环。 */
const MAX_ARCHIVE_STEPS = 6;

const candidateTypes = new Set<AutoMemoryCandidateType>([
  'user_preference',
  'workspace_fact',
  'decision',
  'pitfall',
  'verification',
  'transient_task_result'
]);

const confidences = new Set<AutoMemoryConfidence>(['high', 'medium', 'low']);

export type AgentRunCompletedPayload = {
  runId: string;
  threadId: string | null;
  workspacePath?: string | null;
  summary: string;
  assistantMessage: string;
};

export type AutoMemoryRecordRequest = {
  type: AutoMemoryCandidateType;
  confidence: AutoMemoryConfidence;
  key: string;
  summary: string;
  evidence: readonly string[];
  sourceRunId: string;
  sourceThreadId?: string | null;
  workspacePath?: string | null;
  ttlDays?: number | null;
  revalidate?: string | null;
};

export type AutoMemoryRecordOutcome = {
  status: 'accepted' | 'superseded' | 'duplicate' | 'rejected' | 'write_failed' | 'disabled' | 'quota_exceeded';
  reason: string;
  scope: MemoryScope;
  targetPath: string | null;
  archivedTo: string[];
};

export type AutoMemoryMaintenanceResult = {
  removed: number;
  files: Array<{ targetPath: string; removedKeys: string[] }>;
};

type AutoMemoryWriterOptions = {
  repository: MemoryStoreRepository;
  auditRepository?: AutoMemoryAuditRepository;
  getMemorySettings?: () => AppSettings['memory'];
  logger: RocPluginContext['logger'];
};

type AutoMemoryTarget = {
  scope: MemoryScope;
  kind: 'user' | 'memory';
  targetPath: string;
};

export class AutoMemoryWriter {
  constructor(private readonly options: AutoMemoryWriterOptions) {}

  /**
   * remember 工具的唯一入口：校验候选、去重、合并冲突，并把接受或拒绝的原因回给模型。
   */
  async recordCandidate(request: AutoMemoryRecordRequest, createdAt?: string): Promise<AutoMemoryRecordOutcome> {
    const memorySettings = this.resolveMemorySettings();
    const settings = memorySettings.autoMemory;
    const eventCreatedAt = createdAt === undefined ? new Date().toISOString() : createdAt;
    const candidate = buildAutoMemoryCandidate(
      {
        type: request.type,
        confidence: request.confidence,
        key: request.key,
        summary: request.summary,
        evidence: request.evidence,
        sourceRunId: request.sourceRunId,
        sourceThreadId: request.sourceThreadId === undefined ? null : request.sourceThreadId,
        workspacePath: request.workspacePath,
        ttlDays: request.ttlDays === undefined ? null : request.ttlDays,
        revalidate: request.revalidate === undefined ? null : request.revalidate
      },
      settings,
      eventCreatedAt
    );
    const workspaceOverride = resolveWorkspaceOverride(request.workspacePath);
    const target = resolveCandidateTarget(candidate, workspaceOverride, this.options.repository);

    if (!settings.enabled) {
      return {
        status: 'disabled',
        reason: 'auto_memory_disabled',
        scope: target.scope,
        targetPath: null,
        archivedTo: []
      };
    }

    const rejection = shouldRejectCandidate(candidate);
    if (rejection !== null) {
      this.recordCandidateAudit(candidate, 'rejected', rejection, target.targetPath);
      return {
        status: 'rejected',
        reason: rejection,
        scope: target.scope,
        targetPath: target.targetPath,
        archivedTo: []
      };
    }

    if (this.isRunQuotaExceeded(candidate.sourceRunId, settings.maxCandidatesPerRun)) {
      this.recordCandidateAudit(candidate, 'rejected', 'max_candidates_per_run', target.targetPath);
      return {
        status: 'quota_exceeded',
        reason: `max_candidates_per_run=${settings.maxCandidatesPerRun}`,
        scope: target.scope,
        targetPath: target.targetPath,
        archivedTo: []
      };
    }

    if (target.kind === 'user') {
      return await this.writeUserPreference(candidate, target, workspaceOverride);
    }
    return await this.writeStructuredEntry(candidate, target, workspaceOverride, resolveDate(createdAt));
  }

  /**
   * 运行结束后的记忆维护：清掉 ttlDays 已过期的条目。
   * 事件回调是进程边界，异常在这里收敛为审计与日志，不向事件总线抛出。
   */
  async handleAgentRunCompleted(payload: AgentRunCompletedPayload, createdAt?: string): Promise<void> {
    try {
      await this.runMaintenance({ workspacePath: payload.workspacePath, sourceRunId: payload.runId }, createdAt);
    } catch (error) {
      this.options.logger.warn('memory_auto_maintenance_failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async runMaintenance(
    input: { workspacePath?: string | null; sourceRunId: string },
    createdAt?: string
  ): Promise<AutoMemoryMaintenanceResult> {
    const settings = this.resolveMemorySettings().autoMemory;
    if (!settings.enabled) {
      return { removed: 0, files: [] };
    }
    const workspaceOverride = resolveWorkspaceOverride(input.workspacePath);
    const today = resolveDate(createdAt);
    const eventCreatedAt = createdAt === undefined ? new Date().toISOString() : createdAt;
    const targets: AutoMemoryTarget[] = [
      { scope: 'global', kind: 'memory', targetPath: GLOBAL_MEMORY_TARGET_PATH }
    ];
    if (this.options.repository.hasWorkspace(workspaceOverride)) {
      targets.push({ scope: 'workspace', kind: 'memory', targetPath: WORKSPACE_MEMORY_TARGET_PATH });
    }
    const files: AutoMemoryMaintenanceResult['files'] = [];
    let removed = 0;
    for (const target of targets) {
      const current = await this.options.repository.readFile(
        { scope: target.scope, kind: target.kind },
        workspaceOverride
      );
      if (current === null || current.length === 0) {
        continue;
      }
      const pruned = pruneExpiredAutoMemoryEntries(current, today);
      if (pruned.removed.length === 0) {
        continue;
      }
      const result = await this.options.repository.writeFile(
        { scope: target.scope, kind: target.kind, content: pruned.content },
        workspaceOverride
      );
      if (!result.ok) {
        this.options.logger.warn('memory_auto_maintenance_write_skipped', { reason: result.reason });
        continue;
      }
      for (const entry of pruned.removed) {
        this.recordEntryAudit(entry, target, input, eventCreatedAt);
      }
      removed += pruned.removed.length;
      files.push({ targetPath: target.targetPath, removedKeys: pruned.removed.map((entry) => entry.key) });
    }
    return { removed, files };
  }

  private async writeUserPreference(
    candidate: AutoMemoryCandidate,
    target: AutoMemoryTarget,
    workspaceOverride: MemoryWorkspaceContext | null | undefined
  ): Promise<AutoMemoryRecordOutcome> {
    const current = await this.options.repository.readFile({ scope: target.scope, kind: target.kind }, workspaceOverride);
    const existing = current === null ? '' : current;
    const status = userPreferenceEntryStatus(existing, candidate);
    if (status === 'duplicate') {
      this.recordCandidateAudit(candidate, 'duplicate_skipped', 'duplicate', target.targetPath);
      return {
        status: 'duplicate',
        reason: 'duplicate',
        scope: target.scope,
        targetPath: target.targetPath,
        archivedTo: []
      };
    }
    // 冲突走 supersede：同一个 key 只保留最新值，旧值进审计表。
    if (status === 'conflict') {
      const superseded = replaceUserPreferenceEntry(existing, candidate);
      if (superseded === null) {
        throw new Error('user_preference_conflict_without_entry');
      }
      const result = await this.options.repository.writeFile(
        { scope: target.scope, kind: target.kind, content: superseded.content },
        workspaceOverride
      );
      if (!result.ok) {
        this.recordCandidateAudit(candidate, 'write_failed', result.reason, target.targetPath);
        return {
          status: 'write_failed',
          reason: result.reason,
          scope: target.scope,
          targetPath: target.targetPath,
          archivedTo: []
        };
      }
      this.recordCandidateAudit(
        candidate,
        'maintenance_merged',
        `superseded: ${superseded.previousSummary}`,
        target.targetPath
      );
      return {
        status: 'superseded',
        reason: `superseded: ${superseded.previousSummary}`,
        scope: target.scope,
        targetPath: target.targetPath,
        archivedTo: []
      };
    }
    const next = appendUserPreferenceEntry(existing, formatUserPreferenceEntry(candidate));
    const result = await this.options.repository.writeFile(
      { scope: target.scope, kind: target.kind, content: next },
      workspaceOverride
    );
    if (!result.ok) {
      this.recordCandidateAudit(candidate, 'write_failed', result.reason, target.targetPath);
      this.options.logger.warn('memory_auto_write_skipped', { reason: result.reason });
      return {
        status: 'write_failed',
        reason: result.reason,
        scope: target.scope,
        targetPath: target.targetPath,
        archivedTo: []
      };
    }
    this.recordCandidateAudit(candidate, 'accepted', 'accepted', target.targetPath);
    return {
      status: 'accepted',
      reason: 'accepted',
      scope: target.scope,
      targetPath: target.targetPath,
      archivedTo: []
    };
  }

  private async writeStructuredEntry(
    candidate: AutoMemoryCandidate,
    target: AutoMemoryTarget,
    workspaceOverride: MemoryWorkspaceContext | null | undefined,
    date: string
  ): Promise<AutoMemoryRecordOutcome> {
    const current = await this.options.repository.readFile({ scope: target.scope, kind: target.kind }, workspaceOverride);
    const existing = current === null ? '' : current;
    if (autoMemoryEntryExists(existing, candidate)) {
      this.recordCandidateAudit(candidate, 'duplicate_skipped', 'duplicate', target.targetPath);
      return {
        status: 'duplicate',
        reason: 'duplicate',
        scope: target.scope,
        targetPath: target.targetPath,
        archivedTo: []
      };
    }
    const entry = formatAutoMemoryEntry(candidate);
    const first = await this.options.repository.writeFile(
      { scope: target.scope, kind: target.kind, content: appendAutoMemoryEntry(existing, date, entry) },
      workspaceOverride
    );
    if (first.ok) {
      this.recordCandidateAudit(candidate, 'accepted', 'accepted', target.targetPath);
      return {
        status: 'accepted',
        reason: 'accepted',
        scope: target.scope,
        targetPath: target.targetPath,
        archivedTo: []
      };
    }
    if (first.reason !== 'capacity_exceeded') {
      this.recordCandidateAudit(candidate, 'write_failed', first.reason, target.targetPath);
      this.options.logger.warn('memory_auto_write_skipped', { reason: first.reason });
      return {
        status: 'write_failed',
        reason: first.reason,
        scope: target.scope,
        targetPath: target.targetPath,
        archivedTo: []
      };
    }

    // 容量不足：先压缩重复条目并清理过期条目，再按需把最旧的日期小节搬进归档主题文件。
    const compacted = pruneExpiredAutoMemoryEntries(removeExactDuplicateStructuredEntries(existing), date).content;
    let attempt = appendAutoMemoryEntry(compacted, date, entry);
    const archivedTo: string[] = [];
    for (let step = 0; step <= MAX_ARCHIVE_STEPS; step += 1) {
      const result = await this.options.repository.writeFile(
        { scope: target.scope, kind: target.kind, content: attempt },
        workspaceOverride
      );
      if (result.ok) {
        const reason =
          archivedTo.length === 0 ? 'accepted_after_capacity_retry' : `accepted_after_archive:${archivedTo.join(',')}`;
        this.recordCandidateAudit(candidate, 'accepted', reason, target.targetPath);
        return {
          status: 'accepted',
          reason,
          scope: target.scope,
          targetPath: target.targetPath,
          archivedTo
        };
      }
      if (result.reason !== 'capacity_exceeded' || step === MAX_ARCHIVE_STEPS) {
        this.recordCandidateAudit(candidate, 'write_failed', result.reason, target.targetPath);
        this.options.logger.warn('memory_auto_write_skipped', { reason: result.reason });
        return {
          status: 'write_failed',
          reason: result.reason,
          scope: target.scope,
          targetPath: target.targetPath,
          archivedTo
        };
      }
      const archived = await this.archiveOldestSection(attempt, target, workspaceOverride);
      if (archived === null) {
        this.recordCandidateAudit(candidate, 'write_failed', 'capacity_exceeded_no_archivable_section', target.targetPath);
        return {
          status: 'write_failed',
          reason: 'capacity_exceeded_no_archivable_section',
          scope: target.scope,
          targetPath: target.targetPath,
          archivedTo
        };
      }
      if (!archived.ok) {
        this.recordCandidateAudit(candidate, 'write_failed', `archive_failed:${archived.reason}`, target.targetPath);
        return {
          status: 'write_failed',
          reason: `archive_failed:${archived.reason}`,
          scope: target.scope,
          targetPath: target.targetPath,
          archivedTo
        };
      }
      archivedTo.push(archived.topicPath);
      attempt = archived.content;
    }
    throw new Error('auto_memory_archive_loop_not_terminated');
  }

  /**
   * 把最旧的日期小节搬进 topics/archive-YYYY-MM.md，并在 MEMORY.md 留下一行索引。
   * 先写归档文件再返回精简后的 MEMORY.md 内容，保证任何一步失败都不会丢内容。
   */
  private async archiveOldestSection(
    content: string,
    target: AutoMemoryTarget,
    workspaceOverride: MemoryWorkspaceContext | null | undefined
  ): Promise<{ ok: true; content: string; topicPath: string } | { ok: false; reason: string } | null> {
    const oldest = extractOldestAutoMemorySection(content);
    if (oldest === null) {
      return null;
    }
    const slug = archiveTopicSlug(oldest.sectionDate);
    const topicPath = memoryTopicVirtualPath(target.scope, slug);
    const existingTopic = await this.options.repository.readTopicFile(
      { scope: target.scope, slug },
      workspaceOverride
    );
    const topicContent = appendTopicArchiveSection(existingTopic === null ? '' : existingTopic, oldest.section);
    const topicResult = await this.options.repository.writeTopicFile(
      { scope: target.scope, slug, content: topicContent },
      workspaceOverride
    );
    if (!topicResult.ok) {
      return { ok: false, reason: topicResult.reason };
    }
    return {
      ok: true,
      content: appendArchiveIndexLine(oldest.remaining, { sectionDate: oldest.sectionDate, topicPath }),
      topicPath
    };
  }

  private isRunQuotaExceeded(sourceRunId: string, maxCandidatesPerRun: number): boolean {
    if (this.options.auditRepository === undefined) {
      return false;
    }
    return this.options.auditRepository.countWritesForRun(sourceRunId) >= maxCandidatesPerRun;
  }

  private recordEntryAudit(
    entry: ParsedAutoMemoryEntry,
    target: AutoMemoryTarget,
    input: { workspacePath?: string | null; sourceRunId: string },
    createdAt: string
  ): void {
    if (!isCandidateType(entry.type) || !isConfidence(entry.confidence)) {
      this.options.logger.warn('memory_auto_maintenance_audit_skipped', { key: entry.key, type: entry.type });
      return;
    }
    this.recordAudit({
      action: 'maintenance_deleted',
      type: entry.type,
      scope: target.scope,
      confidence: entry.confidence,
      key: entry.key,
      summary: entry.summary,
      sourceRunId: input.sourceRunId,
      reason: `ttl_expired:${entry.sectionDate ?? 'unknown'}+${entry.ttlDays ?? 0}d`,
      workspacePath: input.workspacePath === undefined ? null : input.workspacePath,
      targetPath: target.targetPath,
      createdAt
    });
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

function isCandidateType(value: string): value is AutoMemoryCandidateType {
  return candidateTypes.has(value as AutoMemoryCandidateType);
}

function isConfidence(value: string): value is AutoMemoryConfidence {
  return confidences.has(value as AutoMemoryConfidence);
}

function resolveWorkspaceOverride(
  workspacePath: string | null | undefined
): MemoryWorkspaceContext | null | undefined {
  if (workspacePath === undefined) {
    return undefined;
  }
  if (workspacePath === null) {
    return null;
  }
  const trimmed = workspacePath.trim();
  if (trimmed.length === 0) {
    throw new Error('agent_run_completed_workspace_path_empty');
  }
  return {
    path: trimmed,
    label: trimmed
  };
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

function resolveCandidateTarget(
  candidate: AutoMemoryCandidate,
  workspaceOverride: MemoryWorkspaceContext | null | undefined,
  repository: MemoryStoreRepository
): AutoMemoryTarget {
  if (candidate.type === 'user_preference') {
    return { scope: 'global', kind: 'user', targetPath: GLOBAL_USER_TARGET_PATH };
  }
  const targetScope = resolveTargetScope(candidate.scope, workspaceOverride, repository);
  if (targetScope === 'workspace') {
    return { scope: 'workspace', kind: 'memory', targetPath: WORKSPACE_MEMORY_TARGET_PATH };
  }
  return { scope: 'global', kind: 'memory', targetPath: GLOBAL_MEMORY_TARGET_PATH };
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
