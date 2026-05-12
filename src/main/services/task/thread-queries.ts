import type { TaskThread } from '../../../shared/types';
import type { DatabaseService } from '../database-service';
import { RocDomainError } from '../errors';

export function nextRunNumber(database: DatabaseService, threadId: string): number {
  const row = database.db
    .prepare(
      `SELECT COALESCE(MAX(run_number), 0) AS last_run_number
       FROM task_runs
       WHERE thread_id = ?`
    )
    .get(threadId) as { last_run_number: number };

  return row.last_run_number + 1;
}

export function requireActiveThread(database: DatabaseService, threadId: string): TaskThread {
  const row = database.db
    .prepare(
      `SELECT id, title, goal, status, created_at, updated_at
       FROM task_threads
       WHERE id = ? AND archived_at IS NULL`
    )
    .get(threadId) as
    | {
        id: string;
        title: string;
        goal: string;
        status: TaskThread['status'];
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (row === undefined) {
    throw new RocDomainError({
      code: 'task_thread_not_found',
      message: '任务会话不存在。',
      category: 'not_found',
      retryable: false,
      userAction: '请刷新历史会话列表后重试。'
    });
  }

  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
