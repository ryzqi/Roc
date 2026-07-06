import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ScheduledTaskRun,
  TaskStatus,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';
import { taskTrigger } from './task-repository-mappers';
import { findBackgroundTask } from './task-repository-queries';

export function createBackgroundTaskRecord(db: DatabaseConnection, preview: BackgroundTaskPreview): BackgroundTask {
  const now = new Date().toISOString();
  const taskId = `background_${randomUUID()}`;
  const threadId = `thread_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const status: TaskStatus = preview.requiresConfirmation ? 'pending_confirmation' : 'running';
  db.transaction(() => {
    insertBackgroundTask(db, {
      preview,
      taskId,
      threadId,
      runId,
      status,
      now
    });
  })();
  const task = findBackgroundTask(db, taskId);
  if (task === null) {
    throw new Error('background_task_create_failed');
  }
  return task;
}

export function updateBackgroundTaskRecord(input: {
  db: DatabaseConnection;
  task: BackgroundTask;
  preview: BackgroundTaskPreview;
  reason: string;
}): BackgroundTask {
  const now = new Date().toISOString();
  input.db.transaction(() => {
    input.db.prepare(
      `UPDATE background_tasks
       SET goal = ?, scheduled = ?, trigger_type = ?, trigger_description = ?, next_run_at = ?, cron_expression = ?,
           workspace_path = ?, allowed_actions_json = ?, forbidden_actions_json = ?, failure_policy = ?,
           notification_policy = ?, risk_level = ?, requires_confirmation = ?, updated_at = ?, enabled_capabilities_json = ?
       WHERE id = ?`
    ).run(
      input.preview.goal,
      input.preview.scheduled ? 1 : 0,
      input.preview.trigger.type,
      input.preview.trigger.description,
      input.preview.nextRunAt,
      input.preview.cronExpression,
      input.preview.workspacePath,
      JSON.stringify(input.preview.allowedActions),
      JSON.stringify(input.preview.forbiddenActions),
      input.preview.failurePolicy,
      input.preview.notificationPolicy,
      input.preview.riskLevel,
      input.preview.requiresConfirmation ? 1 : 0,
      now,
      input.preview.enabledCapabilities === null ? null : JSON.stringify(input.preview.enabledCapabilities),
      input.task.id
    );
  })();
  return requireBackgroundTask(input.db, input.task.id);
}

export function createPreviewRequestFromTask(
  task: BackgroundTask,
  patch: UpdateBackgroundTaskRequest['patch']
): BackgroundTaskPreviewRequest {
  return {
    goal: patch.goal === undefined ? task.goal : patch.goal,
    trigger: patch.trigger === undefined ? taskTrigger(task) : patch.trigger,
    workspacePath: patch.workspacePath === undefined ? task.workspacePath : patch.workspacePath,
    allowedActions: patch.allowedActions === undefined ? task.allowedActions : patch.allowedActions,
    forbiddenActions: patch.forbiddenActions === undefined ? task.forbiddenActions : patch.forbiddenActions,
    failurePolicy: patch.failurePolicy === undefined ? task.failurePolicy : patch.failurePolicy,
    notificationPolicy: patch.notificationPolicy === undefined ? task.notificationPolicy : patch.notificationPolicy,
    enabledCapabilities: patch.enabledCapabilities === undefined ? task.enabledCapabilities : patch.enabledCapabilities
  };
}

export function recordScheduledTaskRun(
  db: DatabaseConnection,
  input: {
    backgroundTaskId: string;
    scheduledAt: string;
    status: ScheduledTaskRun['status'];
    taskRunId?: string | null;
    triggeredAt?: string | null;
    skipReason?: string | null;
  }
): ScheduledTaskRun {
  const now = new Date().toISOString();
  const taskRunId = input.taskRunId === undefined ? null : input.taskRunId;
  const triggeredAt = input.triggeredAt === undefined ? now : input.triggeredAt;
  const skipReason = input.skipReason === undefined ? null : input.skipReason;
  const scheduledRun: ScheduledTaskRun = {
    id: `scheduled_${randomUUID()}`,
    backgroundTaskId: input.backgroundTaskId,
    taskRunId,
    scheduledAt: input.scheduledAt,
    triggeredAt,
    status: input.status,
    skipReason
  };
  db.prepare(
    `INSERT INTO scheduled_task_runs
     (id, background_task_id, task_run_id, scheduled_at, triggered_at, status, skip_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
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

export function transitionBackgroundTask(db: DatabaseConnection, task: BackgroundTask, status: TaskStatus): BackgroundTask {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE background_tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, task.id);
  })();
  return requireBackgroundTask(db, task.id);
}

export function updateBackgroundTaskLastRunStatus(
  db: DatabaseConnection,
  taskId: string,
  status: Exclude<BackgroundTask['lastRunStatus'], null>
): void {
  db.prepare('UPDATE background_tasks SET last_run_status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), taskId);
}

export function pauseBackgroundTaskAfterRunFailure(db: DatabaseConnection, taskId: string, now: string): void {
  const task = requireBackgroundTask(db, taskId);
  db.transaction(() => {
    db.prepare('UPDATE background_tasks SET status = ?, last_run_status = ?, updated_at = ? WHERE id = ?').run('paused', 'failed', now, task.id);
  })();
}

function insertBackgroundTask(
  db: DatabaseConnection,
  input: {
    preview: BackgroundTaskPreview;
    taskId: string;
    threadId: string;
    runId: string;
    status: TaskStatus;
    now: string;
  }
): void {
  db.prepare(
    `INSERT INTO background_tasks
     (id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description, next_run_at, cron_expression, workspace_path,
      allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
      requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at, enabled_capabilities_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.taskId,
    input.threadId,
    input.runId,
    input.preview.goal,
    input.status,
    input.preview.scheduled ? 1 : 0,
    input.preview.trigger.type,
    input.preview.trigger.description,
    input.preview.nextRunAt,
    input.preview.cronExpression,
    input.preview.workspacePath,
    JSON.stringify(input.preview.allowedActions),
    JSON.stringify(input.preview.forbiddenActions),
    input.preview.failurePolicy,
    input.preview.notificationPolicy,
    input.preview.riskLevel,
    input.preview.requiresConfirmation ? 1 : 0,
    null,
    null,
    0,
    input.now,
    input.now,
    input.preview.enabledCapabilities === null ? null : JSON.stringify(input.preview.enabledCapabilities)
  );
}

function requireBackgroundTask(db: DatabaseConnection, id: string): BackgroundTask {
  const task = findBackgroundTask(db, id);
  if (task === null) {
    throw new Error('background_task_not_found');
  }
  return task;
}
