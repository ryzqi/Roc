import { randomUUID } from 'node:crypto';
import type { ScheduledTaskRun } from '../../../shared/types';
import type { DatabaseService } from '../database-service';
import { requireBackgroundTask } from './background-task-mapping';

export function recordScheduledTaskRun(input: {
  database: DatabaseService;
  backgroundTaskId: string;
  scheduledAt: string;
  status: ScheduledTaskRun['status'];
  taskRunId?: string | null;
  triggeredAt?: string | null;
  skipReason?: string | null;
}): ScheduledTaskRun {
  const now = new Date().toISOString();
  const scheduledRun: ScheduledTaskRun = {
    id: `scheduled_${randomUUID()}`,
    backgroundTaskId: input.backgroundTaskId,
    taskRunId: input.taskRunId ?? null,
    scheduledAt: input.scheduledAt,
    triggeredAt: input.triggeredAt ?? now,
    status: input.status,
    skipReason: input.skipReason ?? null
  };

  input.database.db
    .prepare(
      `INSERT INTO scheduled_task_runs
       (id, background_task_id, task_run_id, scheduled_at, triggered_at, status, skip_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      scheduledRun.id,
      scheduledRun.backgroundTaskId,
      scheduledRun.taskRunId,
      scheduledRun.scheduledAt,
      scheduledRun.triggeredAt,
      scheduledRun.status,
      scheduledRun.skipReason
    );

  return scheduledRun;
}

export function listScheduledRuns(input: { database: DatabaseService; taskId: string; limit?: number }): ScheduledTaskRun[] {
  const task = requireBackgroundTask(input.database, input.taskId);
  const limit = input.limit ?? 20;
  const rows = input.database.db
    .prepare(
      `SELECT id, background_task_id, task_run_id, scheduled_at, triggered_at, status, skip_reason
       FROM scheduled_task_runs
       WHERE background_task_id = ?
       ORDER BY scheduled_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(task.id, limit) as Array<{
    id: string;
    background_task_id: string;
    task_run_id: string | null;
    scheduled_at: string;
    triggered_at: string | null;
    status: ScheduledTaskRun['status'];
    skip_reason: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    backgroundTaskId: row.background_task_id,
    taskRunId: row.task_run_id,
    scheduledAt: row.scheduled_at,
    triggeredAt: row.triggered_at,
    status: row.status,
    skipReason: row.skip_reason
  }));
}

export function countRecentSkippedScheduledRuns(input: { database: DatabaseService; since: string }): number {
  const row = input.database.db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM scheduled_task_runs
       WHERE status = 'skipped'
         AND scheduled_at >= ?`
    )
    .get(input.since) as { count: number };
  return row.count;
}
