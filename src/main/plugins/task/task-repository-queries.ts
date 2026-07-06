import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  ActiveTaskItem,
  BackgroundTask,
  ScheduledTaskRun
} from '../../../shared/types';
import {
  mapBackgroundTask,
  mapScheduledTaskRun,
  taskTrigger,
  type BackgroundTaskRecord,
  type ScheduledTaskRunRow
} from './task-repository-mappers';

function listActiveBackgroundTasks(db: DatabaseConnection): BackgroundTask[] {
  const rows = db
    .prepare(
      `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
              trigger_type, cron_expression,
              allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
              requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
              enabled_capabilities_json
       FROM background_tasks
       WHERE status != 'archived'
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
       ORDER BY next_run_at ASC, updated_at DESC`
    )
    .all() as BackgroundTaskRecord[];
  return rows.map(mapBackgroundTask);
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
