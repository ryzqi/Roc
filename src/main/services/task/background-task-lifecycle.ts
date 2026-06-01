import { randomUUID } from 'node:crypto';
import type {
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  TaskEvent,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';
import type { DatabaseService } from '../database-service';
import { RocDomainError } from '../errors';
import { backgroundTaskFromRow, requireBackgroundTask } from './background-task-mapping';
import type { BackgroundTaskRow } from './types';
import { invalidTransition } from './validation';

export function pauseBackgroundTask(input: { database: DatabaseService; id: string }): BackgroundTask {
  const task = requireBackgroundTask(input.database, input.id);
  if (task.status !== 'running' && task.status !== 'pending_confirmation') {
    throw invalidTransition('后台任务当前状态不能暂停。');
  }
  return transitionBackgroundTask({ database: input.database, task, status: 'paused', eventType: 'background_task_paused' });
}

export function resumeBackgroundTask(input: { database: DatabaseService; id: string }): BackgroundTask {
  const task = requireBackgroundTask(input.database, input.id);
  if (task.status !== 'paused') {
    throw invalidTransition('后台任务当前状态不能继续。');
  }
  return transitionBackgroundTask({ database: input.database, task, status: 'running', eventType: 'background_task_resumed' });
}

export function cancelBackgroundTask(input: { database: DatabaseService; id: string }): BackgroundTask {
  const task = requireBackgroundTask(input.database, input.id);
  if (task.status === 'cancelled') {
    return task;
  }
  if (task.status === 'completed' || task.status === 'archived') {
    throw invalidTransition('后台任务当前状态不能取消。');
  }
  return transitionBackgroundTask({ database: input.database, task, status: 'cancelled', eventType: 'background_task_cancelled' });
}

export function deleteBackgroundTask(input: { database: DatabaseService; id: string }): { deleted: true; taskId: string } {
  const task = requireBackgroundTask(input.database, input.id);
  if (task.status !== 'completed' && task.status !== 'cancelled' && task.status !== 'failed') {
    throw new RocDomainError({
      code: 'background_task_delete_not_terminal',
      message: '只能删除已完成、已取消或已失败的后台任务。',
      category: 'conflict',
      retryable: false,
      userAction: '请先暂停或取消该任务，再删除。'
    });
  }
  const now = new Date().toISOString();
  const transaction = input.database.db.transaction(() => {
    input.database.db.prepare('UPDATE background_tasks SET status = ?, updated_at = ? WHERE id = ?').run('archived', now, task.id);
    input.database.db
      .prepare('UPDATE task_threads SET status = ?, updated_at = ?, archived_at = ? WHERE id = ?')
      .run('archived', now, now, task.threadId);
  });
  transaction();
  return {
    deleted: true,
    taskId: task.id
  };
}

export function updateBackgroundTask(input: {
  database: DatabaseService;
  request: UpdateBackgroundTaskRequest;
  createPreview: (request: BackgroundTaskPreviewRequest) => BackgroundTaskPreview;
}): BackgroundTask {
  const task = requireBackgroundTask(input.database, input.request.taskId);
  const nextGoal = input.request.patch.goal ?? task.goal;
  const nextTrigger = input.request.patch.trigger ?? triggerFromBackgroundTask(task);
  const nextWorkspacePath = input.request.patch.workspacePath ?? task.workspacePath;
  const nextAllowedActions = input.request.patch.allowedActions ?? task.allowedActions;
  const nextForbiddenActions = input.request.patch.forbiddenActions ?? task.forbiddenActions;
  const nextEnabledCapabilities =
    input.request.patch.enabledCapabilities === undefined ? task.enabledCapabilities : input.request.patch.enabledCapabilities;
  const preview = input.createPreview({
    goal: nextGoal,
    trigger: nextTrigger,
    workspacePath: nextWorkspacePath,
    allowedActions: nextAllowedActions,
    forbiddenActions: nextForbiddenActions,
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    enabledCapabilities: nextEnabledCapabilities
  });
  const now = new Date().toISOString();

  const transaction = input.database.db.transaction(() => {
    input.database.db
      .prepare(
        `UPDATE background_tasks
         SET goal = ?, scheduled = ?, trigger_type = ?, trigger_description = ?, next_run_at = ?, cron_expression = ?,
             workspace_path = ?, allowed_actions_json = ?, forbidden_actions_json = ?, risk_level = ?,
             requires_confirmation = ?, enabled_capabilities_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        preview.goal,
        preview.scheduled ? 1 : 0,
        preview.trigger.type,
        preview.trigger.description,
        preview.nextRunAt,
        preview.cronExpression,
        preview.workspacePath,
        JSON.stringify(preview.allowedActions),
        JSON.stringify(preview.forbiddenActions),
        preview.riskLevel,
        preview.requiresConfirmation ? 1 : 0,
        preview.enabledCapabilities === null ? null : JSON.stringify(preview.enabledCapabilities),
        now,
        task.id
      );
    input.database.db
      .prepare('UPDATE task_threads SET title = ?, goal = ?, updated_at = ? WHERE id = ?')
      .run(preview.goal.slice(0, 60), preview.goal, now, task.threadId);
    insertTaskEvent(input.database, {
      threadId: task.threadId,
      runId: task.runId,
      type: 'background_task_resumed',
      payload: {
        taskId: task.id,
        reason: input.request.reason,
        updated: true
      }
    });
  });
  transaction();

  return {
    ...task,
    goal: preview.goal,
    scheduled: preview.scheduled,
    triggerType: preview.trigger.type,
    triggerDescription: preview.trigger.description,
    nextRunAt: preview.nextRunAt,
    cronExpression: preview.cronExpression,
    workspacePath: preview.workspacePath,
    allowedActions: preview.allowedActions,
    forbiddenActions: preview.forbiddenActions,
    riskLevel: preview.riskLevel,
    requiresConfirmation: preview.requiresConfirmation,
    enabledCapabilities: preview.enabledCapabilities,
    updatedAt: now
  };
}

export function listBackgroundTasks(input: { database: DatabaseService }): BackgroundTask[] {
  const rows = input.database.db
    .prepare(
      `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
              trigger_type, cron_expression,
              allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
              requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
              enabled_capabilities_json
       FROM background_tasks
       ORDER BY updated_at DESC
       LIMIT 50`
    )
    .all() as BackgroundTaskRow[];

  return rows.map((row) => backgroundTaskFromRow(row));
}

export function findBackgroundTask(input: { database: DatabaseService; id: string }): BackgroundTask | null {
  const row = input.database.db
    .prepare(
      `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description, next_run_at,
              cron_expression, workspace_path,
              allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
              requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
              enabled_capabilities_json
       FROM background_tasks
       WHERE id = ?`
    )
    .get(input.id) as BackgroundTaskRow | undefined;

  return row === undefined ? null : backgroundTaskFromRow(row);
}

export function listSchedulableBackgroundTasks(input: { database: DatabaseService }): BackgroundTask[] {
  const rows = input.database.db
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
    .all() as BackgroundTaskRow[];

  return rows.map((row) => backgroundTaskFromRow(row));
}

export function markBackgroundTaskFired(input: {
  database: DatabaseService;
  taskId: string;
  runId: string;
  firedAt: string;
  nextRunAt: string | null;
}): BackgroundTask {
  const task = requireBackgroundTask(input.database, input.taskId);
  const status = task.triggerType === 'once' ? 'completed' : task.status;
  const now = new Date().toISOString();

  input.database.db
    .prepare(
      `UPDATE background_tasks
       SET status = ?, run_id = ?, last_run_at = ?, last_run_status = ?, run_count = run_count + 1, next_run_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(status, input.runId, input.firedAt, null, input.nextRunAt, now, input.taskId);
  input.database.db
    .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now, task.threadId);

  return {
    ...task,
    runId: input.runId,
    status,
    nextRunAt: input.nextRunAt,
    lastRunAt: input.firedAt,
    lastRunStatus: null,
    runCount: task.runCount + 1,
    updatedAt: now
  };
}

export function updateBackgroundTaskNextRunAt(input: {
  database: DatabaseService;
  taskId: string;
  nextRunAt: string | null;
}): BackgroundTask {
  const task = requireBackgroundTask(input.database, input.taskId);
  const now = new Date().toISOString();
  input.database.db
    .prepare('UPDATE background_tasks SET next_run_at = ?, updated_at = ? WHERE id = ?')
    .run(input.nextRunAt, now, input.taskId);
  return {
    ...task,
    nextRunAt: input.nextRunAt,
    updatedAt: now
  };
}

export function pauseBackgroundTaskForScheduler(input: {
  database: DatabaseService;
  taskId: string;
  runId: string;
  reason: string;
}): BackgroundTask {
  const task = requireBackgroundTask(input.database, input.taskId);
  if (task.status === 'paused') {
    return task;
  }
  const paused = transitionBackgroundTask({
    database: input.database,
    task,
    status: 'paused',
    eventType: 'background_task_paused'
  });
  insertTaskEvent(input.database, {
    threadId: task.threadId,
    runId: task.runId,
    type: 'diagnostic',
    payload: {
      code: input.reason,
      taskId: input.taskId,
      scheduledRunId: input.runId
    }
  });
  return paused;
}

export function transitionBackgroundTask(input: {
  database: DatabaseService;
  task: BackgroundTask;
  status: BackgroundTask['status'];
  eventType: Extract<TaskEvent['type'], 'background_task_paused' | 'background_task_resumed' | 'background_task_cancelled'>;
}): BackgroundTask {
  const now = new Date().toISOString();
  const transaction = input.database.db.transaction(() => {
    input.database.db
      .prepare('UPDATE background_tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(input.status, now, input.task.id);
    input.database.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run(input.status, now, input.task.threadId);
    input.database.db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run(input.status, input.task.runId);
    insertTaskEvent(input.database, {
      threadId: input.task.threadId,
      runId: input.task.runId,
      type: input.eventType,
      payload: {
        taskId: input.task.id,
        status: input.status
      }
    });
  });
  transaction();

  return {
    ...input.task,
    status: input.status,
    updatedAt: now
  };
}

export function triggerFromBackgroundTask(task: BackgroundTask): BackgroundTaskPreviewRequest['trigger'] {
  if (task.triggerType === 'manual') {
    return {
      type: 'manual',
      description: task.triggerDescription
    };
  }
  if (task.triggerType === 'once') {
    if (task.nextRunAt === null) {
      throw new Error(`Once background task ${task.id} is missing next_run_at.`);
    }
    return {
      type: 'once',
      description: task.triggerDescription,
      nextRunAt: task.nextRunAt
    };
  }
  if (task.nextRunAt === null || task.cronExpression === null) {
    throw new Error(`Cron background task ${task.id} is missing schedule fields.`);
  }
  return {
    type: 'cron',
    description: task.triggerDescription,
    cronExpression: task.cronExpression,
    nextRunAt: task.nextRunAt
  };
}

function insertTaskEvent(database: DatabaseService, input: {
  threadId: string;
  runId: string;
  type: TaskEvent['type'];
  payload: unknown;
}): void {
  database.db
    .prepare(
      `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(`event_${randomUUID()}`, input.threadId, input.runId, input.type, JSON.stringify(input.payload), new Date().toISOString());
}
