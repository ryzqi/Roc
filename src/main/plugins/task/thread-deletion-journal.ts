import type { Database as DatabaseConnection } from 'better-sqlite3';

export type ThreadDeletionState = 'pending' | 'agent_deleted' | 'complete';

export type ThreadDeletionRecord = {
  threadId: string;
  state: ThreadDeletionState;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type ThreadDeletionRow = {
  thread_id: string;
  state: ThreadDeletionState;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export class ThreadDeletionJournal {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  ensurePending(threadId: string): ThreadDeletionRecord {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO thread_deletion_journal
         (thread_id, state, attempt_count, last_error, created_at, updated_at, completed_at)
         VALUES (?, 'pending', 0, NULL, ?, ?, NULL)
         ON CONFLICT(thread_id) DO NOTHING`
      )
      .run(threadId, now, now);
    return this.require(threadId);
  }

  find(threadId: string): ThreadDeletionRecord | null {
    const row = this.db
      .prepare(
        `SELECT thread_id, state, attempt_count, last_error, created_at, updated_at, completed_at
         FROM thread_deletion_journal
         WHERE thread_id = ?`
      )
      .get(threadId) as ThreadDeletionRow | undefined;
    return row === undefined ? null : mapThreadDeletionRow(row);
  }

  require(threadId: string): ThreadDeletionRecord {
    const record = this.find(threadId);
    if (record === null) {
      throw new Error('thread_deletion_not_found');
    }
    return record;
  }

  listIncomplete(): ThreadDeletionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT thread_id, state, attempt_count, last_error, created_at, updated_at, completed_at
         FROM thread_deletion_journal
         WHERE state != 'complete'
         ORDER BY created_at ASC, thread_id ASC`
      )
      .all() as ThreadDeletionRow[];
    return rows.map(mapThreadDeletionRow);
  }

  listHiddenThreadIds(): Set<string> {
    const rows = this.db.prepare('SELECT thread_id FROM thread_deletion_journal').all() as Array<{ thread_id: string }>;
    return new Set(rows.map((row) => row.thread_id));
  }

  markAgentDeleted(threadId: string): void {
    const result = this.db
      .prepare(
        `UPDATE thread_deletion_journal
         SET state = 'agent_deleted', last_error = NULL, updated_at = ?
         WHERE thread_id = ? AND state = 'pending'`
      )
      .run(this.now(), threadId);
    if (result.changes !== 1) {
      throw new Error('thread_deletion_transition_invalid:pending_to_agent_deleted');
    }
  }

  markCompleteInCurrentTransaction(threadId: string): void {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE thread_deletion_journal
         SET state = 'complete', last_error = NULL, updated_at = ?, completed_at = ?
         WHERE thread_id = ? AND state = 'agent_deleted'`
      )
      .run(now, now, threadId);
    if (result.changes !== 1) {
      throw new Error('thread_deletion_transition_invalid:agent_deleted_to_complete');
    }
  }

  recordFailure(threadId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const result = this.db
      .prepare(
        `UPDATE thread_deletion_journal
         SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
         WHERE thread_id = ?`
      )
      .run(message, this.now(), threadId);
    if (result.changes !== 1) {
      throw new Error('thread_deletion_not_found');
    }
  }
}

function mapThreadDeletionRow(row: ThreadDeletionRow): ThreadDeletionRecord {
  return {
    threadId: row.thread_id,
    state: row.state,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}
