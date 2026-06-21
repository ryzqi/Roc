import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  ActiveTaskItem,
  BackgroundTask,
  BackgroundTaskSummary,
  ScheduledTaskRun,
  TaskEvent,
  TaskRun,
  TaskStatus,
  TaskSnapshot,
  TaskThread
} from '../../../shared/types';
import { RocDomainError } from '../../services/errors';
import {
  mapBackgroundTask,
  mapScheduledTaskRun,
  mapTaskEvent,
  mapTaskRun,
  mapTaskThread,
  taskTrigger,
  type BackgroundTaskRecord,
  type ScheduledTaskRunRow,
  type TaskEventRow,
  type TaskRunRow,
  type TaskThreadRow
} from './task-repository-mappers';

export function listActiveBackgroundTasks(db: DatabaseConnection): BackgroundTask[] {
  const rows = db
    .prepare(
      `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
              trigger_type, cron_expression,
              allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
              requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
              enabled_capabilities_json
       FROM background_tasks
       WHERE status != 'archived'
         AND EXISTS (
           SELECT 1
           FROM task_threads
           WHERE task_threads.id = background_tasks.thread_id
             AND task_threads.archived_at IS NULL
         )
       ORDER BY updated_at DESC`
    )
    .all() as BackgroundTaskRecord[];
  return rows.map(mapBackgroundTask);
}

export function findBackgroundTask(db: DatabaseConnection, id: string): BackgroundTask | null {
  const row = db
    .prepare(
      `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
              trigger_type, cron_expression,
              allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
              requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
              enabled_capabilities_json
       FROM background_tasks
       WHERE id = ?`
    )
    .get(id) as BackgroundTaskRecord | undefined;
  if (row === undefined) {
    return null;
  }
  return mapBackgroundTask(row);
}

export function findBackgroundTaskByRunId(db: DatabaseConnection, runId: string): BackgroundTask | null {
  const row = db
    .prepare(
      `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
              trigger_type, cron_expression,
              allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
              requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
              enabled_capabilities_json
       FROM background_tasks
       WHERE run_id = ?`
    )
    .get(runId) as BackgroundTaskRecord | undefined;
  if (row === undefined) {
    return null;
  }
  return mapBackgroundTask(row);
}

export function listBackgroundTasks(db: DatabaseConnection): BackgroundTask[] {
  const rows = db
    .prepare(
      `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
              trigger_type, cron_expression,
              allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
              requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
              enabled_capabilities_json
       FROM background_tasks
       ORDER BY updated_at DESC`
    )
    .all() as BackgroundTaskRecord[];
  return rows.map(mapBackgroundTask);
}

export function listSchedulableBackgroundTasks(db: DatabaseConnection): BackgroundTask[] {
  const rows = db
    .prepare(
      `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
              trigger_type, cron_expression,
              allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
              requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
              enabled_capabilities_json
       FROM background_tasks
       WHERE scheduled = 1
         AND status IN ('running', 'pending_confirmation', 'paused')
         AND EXISTS (
           SELECT 1
           FROM task_threads
           WHERE task_threads.id = background_tasks.thread_id
             AND task_threads.archived_at IS NULL
         )
       ORDER BY next_run_at ASC, updated_at DESC`
    )
    .all() as BackgroundTaskRecord[];
  return rows.map(mapBackgroundTask);
}

export function getBackgroundTaskSummary(db: DatabaseConnection): BackgroundTaskSummary {
  const rows = db
    .prepare(
      `SELECT status, next_run_at
       FROM background_tasks
       WHERE status != 'archived'
         AND EXISTS (
           SELECT 1
           FROM task_threads
           WHERE task_threads.id = background_tasks.thread_id
             AND task_threads.archived_at IS NULL
         )
       ORDER BY updated_at DESC`
    )
    .all() as Array<{ status: TaskStatus; next_run_at: string | null }>;
  const futureRuns = rows
    .map((row) => row.next_run_at)
    .filter((value): value is string => value !== null)
    .sort();

  return {
    total: rows.length,
    running: rows.filter((row) => row.status === 'running').length,
    failed: rows.filter((row) => row.status === 'failed').length,
    pendingConfirmation: rows.filter((row) => row.status === 'pending_confirmation').length,
    nextRunAt: futureRuns.length === 0 ? null : futureRuns[0]
  };
}

export function getActiveTasks(db: DatabaseConnection): ActiveTaskItem[] {
  return listActiveBackgroundTasks(db).map((task) => ({
    kind: 'background',
    threadId: task.threadId,
    taskId: task.id,
    title: task.goal.slice(0, 60),
    goal: task.goal,
    status: task.status,
    trigger: taskTrigger(task),
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    riskLevel: task.riskLevel,
    workspacePath: task.workspacePath,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  }));
}

export function listScheduledRuns(
  db: DatabaseConnection,
  task: BackgroundTask,
  limit: number
): ScheduledTaskRun[] {
  const rows = db
    .prepare(
      `SELECT id, background_task_id, task_run_id, scheduled_at, triggered_at, status, skip_reason
       FROM scheduled_task_runs
       WHERE background_task_id = ?
       ORDER BY scheduled_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(task.id, limit) as ScheduledTaskRunRow[];
  return rows.map(mapScheduledTaskRun);
}

export function requireActiveThread(db: DatabaseConnection, threadId: string): TaskThread {
  const thread = findActiveThread(db, threadId);
  if (thread === null) {
    throw new RocDomainError({
      code: 'task_thread_not_found',
      message: '任务会话不存在或已被删除。',
      category: 'not_found',
      retryable: false,
      userAction: '该会话可能已被删除，请刷新任务列表后重试。'
    });
  }
  return thread;
}

export function findActiveThread(db: DatabaseConnection, threadId: string): TaskThread | null {
  const row = db
    .prepare(
      `SELECT id, kind, title, goal, status, created_at, updated_at
       FROM task_threads
       WHERE id = ?
         AND archived_at IS NULL`
    )
    .get(threadId) as TaskThreadRow | undefined;
  if (row === undefined) {
    return null;
  }
  return mapTaskThread(row);
}

export function findRun(db: DatabaseConnection, runId: string): TaskRun | null {
  const row = db
    .prepare(
      `SELECT id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json
       FROM task_runs
       WHERE id = ?`
    )
    .get(runId) as TaskRunRow | undefined;
  if (row === undefined) {
    return null;
  }
  return mapTaskRun(row);
}

export function nextRunNumber(db: DatabaseConnection, threadId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(run_number), 0) + 1 AS next_run_number FROM task_runs WHERE thread_id = ?')
    .get(threadId) as { next_run_number: number };
  return row.next_run_number;
}

export function listRunsForThread(db: DatabaseConnection, threadId: string, limit: number): TaskRun[] {
  const rows = db
    .prepare(
      `SELECT id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json
       FROM task_runs
       WHERE thread_id = ?
       ORDER BY run_number DESC
       LIMIT ?`
    )
    .all(threadId, limit) as TaskRunRow[];
  return rows.map(mapTaskRun);
}

export function listRecentEventsForThread(db: DatabaseConnection, threadId: string, limit: number): TaskEvent[] {
  const rows = db
    .prepare(
      `SELECT rowid, id, thread_id, run_id, type, payload_json, created_at
       FROM task_events
       WHERE thread_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(threadId, limit) as Array<TaskEventRow & { rowid: number }>;
  return rows.map(mapTaskEvent);
}

export function listEventsForThread(db: DatabaseConnection, threadId: string): TaskEvent[] {
  const rows = db
    .prepare(
      `SELECT rowid, id, thread_id, run_id, type, payload_json, created_at
       FROM task_events
       WHERE thread_id = ?
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(threadId) as Array<TaskEventRow & { rowid: number }>;
  return rows.map(mapTaskEvent);
}

export function listEventsForRun(db: DatabaseConnection, threadId: string, runId: string): TaskEvent[] {
  const rows = db
    .prepare(
      `SELECT rowid, id, thread_id, run_id, type, payload_json, created_at
       FROM task_events
       WHERE thread_id = ? AND run_id = ?
       ORDER BY created_at DESC, rowid DESC`
    )
    .all(threadId, runId) as Array<TaskEventRow & { rowid: number }>;
  return rows.map(mapTaskEvent);
}

export function readThreads(db: DatabaseConnection): TaskSnapshot['threads'] {
  const rows = db
    .prepare(
      `SELECT id, kind, title, goal, status, created_at, updated_at
       FROM task_threads
       WHERE archived_at IS NULL
       ORDER BY updated_at DESC`
    )
    .all() as TaskThreadRow[];
  return rows.map(mapTaskThread);
}

export function readRecentEvents(db: DatabaseConnection): TaskEvent[] {
  const rows = db
    .prepare(
      `SELECT id, thread_id, run_id, type, payload_json, created_at
       FROM task_events
       ORDER BY created_at DESC, id DESC
       LIMIT 50`
    )
    .all() as TaskEventRow[];
  return rows.map(mapTaskEvent);
}
