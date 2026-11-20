import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  AutoMemoryAuditAction,
  AutoMemoryAuditRecord,
  AutoMemoryCandidateType,
  AutoMemoryConfidence,
  MemoryScope
} from '../../../shared/types';

export type AutoMemoryAuditInsert = {
  action: AutoMemoryAuditAction;
  type: AutoMemoryCandidateType;
  scope: MemoryScope;
  confidence: AutoMemoryConfidence;
  key: string;
  summary: string;
  sourceRunId: string;
  reason: string;
  workspacePath: string | null;
  targetPath: string | null;
  createdAt: string;
};

type AuditRow = {
  id: string;
  action: AutoMemoryAuditAction;
  memory_type: AutoMemoryCandidateType;
  scope: MemoryScope;
  confidence: AutoMemoryConfidence;
  memory_key: string;
  summary: string;
  source_run_id: string;
  reason: string;
  workspace_path: string | null;
  target_path: string | null;
  created_at: string;
};

export class AutoMemoryAuditRepository {
  constructor(private readonly db: DatabaseConnection) {}

  record(input: AutoMemoryAuditInsert): AutoMemoryAuditRecord {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO memory_auto_audit (
        id,
        action,
        memory_type,
        scope,
        confidence,
        memory_key,
        summary,
        source_run_id,
        reason,
        workspace_path,
        target_path,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.action,
      input.type,
      input.scope,
      input.confidence,
      input.key,
      input.summary,
      input.sourceRunId,
      input.reason,
      input.workspacePath,
      input.targetPath,
      input.createdAt
    );
    return {
      id,
      createdAt: input.createdAt,
      action: input.action,
      type: input.type,
      scope: input.scope,
      confidence: input.confidence,
      key: input.key,
      summary: input.summary,
      sourceRunId: input.sourceRunId,
      reason: input.reason,
      workspacePath: input.workspacePath,
      targetPath: input.targetPath
    };
  }

  listRecent(limit: number): AutoMemoryAuditRecord[] {
    const rows = this.db.prepare(`
      SELECT
        id,
        action,
        memory_type,
        scope,
        confidence,
        memory_key,
        summary,
        source_run_id,
        reason,
        workspace_path,
        target_path,
        created_at
      FROM memory_auto_audit
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit) as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      action: row.action,
      type: row.memory_type,
      scope: row.scope,
      confidence: row.confidence,
      key: row.memory_key,
      summary: row.summary,
      sourceRunId: row.source_run_id,
      reason: row.reason,
      workspacePath: row.workspace_path,
      targetPath: row.target_path
    }));
  }

  /** remember 工具的每轮写入配额依赖这个计数：只统计真正落盘的动作。 */
  countWritesForRun(sourceRunId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM memory_auto_audit
      WHERE source_run_id = ? AND action IN ('accepted', 'maintenance_merged')
    `).get(sourceRunId) as { total: number } | undefined;
    return row === undefined ? 0 : row.total;
  }

  prune(retentionDays: number, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare('DELETE FROM memory_auto_audit WHERE created_at < ?').run(cutoff);
    return result.changes;
  }
}
