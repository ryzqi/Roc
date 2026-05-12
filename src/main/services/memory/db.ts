import type { DatabaseService } from '../database-service';
import { RocDomainError } from '../errors';
import type { CandidateRow, MemoryIndexRow } from './types';

export function hasTable(database: DatabaseService, table: string): boolean {
  const row = database.db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

export function getMemoryRow(database: DatabaseService, id: string): MemoryIndexRow {
  const row = database.db
    .prepare(
      `SELECT id, layer, type, scope, status, confidence, priority, source, source_ref, markdown_path, created_at, updated_at
       FROM memory_entries_index
       WHERE id = ?`
    )
    .get(id) as MemoryIndexRow | undefined;

  if (row === undefined) {
    throw new RocDomainError({
      code: 'memory_not_found',
      message: `找不到记忆条目 ${id}。`,
      category: 'not_found',
      retryable: false,
      userAction: '请刷新记忆中心或检查记忆 ID。'
    });
  }
  return row;
}

export function getCandidateRow(database: DatabaseService, id: string): CandidateRow {
  const row = database.db
    .prepare(
      `SELECT i.id, i.layer, i.type, i.scope, i.status, i.confidence, i.priority, i.source, i.source_ref, i.markdown_path,
              i.created_at, i.updated_at, c.state AS candidate_state, c.suggested_action
       FROM memory_candidates c
       JOIN memory_entries_index i ON i.id = c.memory_id
       WHERE c.memory_id = ?`
    )
    .get(id) as CandidateRow | undefined;

  if (row === undefined) {
    throw new RocDomainError({
      code: 'memory_candidate_not_found',
      message: `找不到候选记忆 ${id}。`,
      category: 'not_found',
      retryable: false,
      userAction: '请刷新候选记忆列表。'
    });
  }
  return row;
}

export function countCandidateConflicts(database: DatabaseService, candidateId: string): number {
  const row = database.db
    .prepare("SELECT COUNT(*) AS count FROM memory_conflicts WHERE candidate_id = ? AND status = 'open'")
    .get(candidateId) as { count: number };
  return row.count;
}
