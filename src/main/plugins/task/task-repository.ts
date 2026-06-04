import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  ActiveTaskItem,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  BackgroundTaskTrigger,
  ChatStartRunRequest,
  EnabledCapabilities,
  ScheduledTaskRun,
  TaskEvent,
  TaskSnapshot,
  TaskStatus,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';

type BackgroundTaskRow = {
  id: string;
  thread_id: string;
  run_id: string;
  goal: string;
  status: TaskStatus;
  scheduled: 0 | 1;
  trigger_type: BackgroundTaskTrigger['type'];
  trigger_description: string;
  next_run_at: string | null;
  cron_expression: string | null;
  workspace_path: string;
  allowed_actions_json: string;
  forbidden_actions_json: string;
  failure_policy: BackgroundTask['failurePolicy'];
  notification_policy: BackgroundTask['notificationPolicy'];
  risk_level: BackgroundTask['riskLevel'];
  requires_confirmation: 0 | 1;
  last_run_at: string | null;
  last_run_status: BackgroundTask['lastRunStatus'];
  run_count: number;
  created_at: string;
  updated_at: string;
  enabled_capabilities_json: string | null;
};

type TaskEventRow = {
  id: string;
  thread_id: string;
  run_id: string;
  type: TaskEvent['type'];
  payload_json: string;
  created_at: string;
};

type TaskThreadRow = {
  id: string;
  kind: ActiveTaskItem['kind'];
  title: string;
  goal: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
};

type ScheduledTaskRunRow = {
  id: string;
  background_task_id: string;
  task_run_id: string | null;
  scheduled_at: string;
  triggered_at: string | null;
  status: ScheduledTaskRun['status'];
  skip_reason: string | null;
};

const emptyCapabilities: EnabledCapabilities = {
  mcpServers: [],
  skills: []
};

export class TaskRepository {
  constructor(private readonly db: DatabaseConnection) {}

  createBackgroundTaskProposalRequest(input: {
    description: string;
    enabledCapabilities: EnabledCapabilities;
  }): ChatStartRunRequest {
    const description = requireText(input.description, 'background_task_description_empty');
    return {
      input: description,
      mode: 'task',
      enabledCapabilities: input.enabledCapabilities,
      workflowHint: 'propose_background_task'
    };
  }

  createBackgroundTaskPreview(request: BackgroundTaskPreviewRequest): BackgroundTaskPreview {
    const goal = requireText(request.goal, 'background_task_goal_empty');
    const triggerDescription = requireText(request.trigger.description, 'background_task_trigger_empty');
    const workspacePath = requireText(request.workspacePath, 'background_task_workspace_empty');
    const nextRunAt = request.trigger.type === 'manual' ? null : request.trigger.nextRunAt;
    const cronExpression = request.trigger.type === 'cron' ? request.trigger.cronExpression : null;
    const scheduled = request.trigger.type !== 'manual';
    if (scheduled && nextRunAt === null) {
      throw new Error('background_task_next_run_missing');
    }
    return {
      ...request,
      goal,
      trigger: normalizeTrigger(request.trigger, triggerDescription),
      workspacePath,
      scheduled,
      nextRunAt,
      cronExpression,
      riskLevel: inferBackgroundRisk(request.allowedActions, request.forbiddenActions),
      requiresConfirmation: request.forbiddenActions.length > 0 && request.allowedActions.length === 0,
      enabledCapabilities: request.enabledCapabilities === undefined ? null : request.enabledCapabilities
    };
  }

  createBackgroundTask(preview: BackgroundTaskPreview): BackgroundTask {
    const now = new Date().toISOString();
    const taskId = `background_${randomUUID()}`;
    const threadId = `thread_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const status: TaskStatus = preview.requiresConfirmation ? 'pending_confirmation' : 'running';
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(threadId, 'background', preview.goal.slice(0, 60), preview.goal, status, now, now);
        this.db
          .prepare(
            `INSERT INTO task_runs
             (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(runId, threadId, 1, preview.goal, status, now, null, null, JSON.stringify(emptyCapabilities));
        this.insertBackgroundTask({
          preview,
          taskId,
          threadId,
          runId,
          status,
          now
        });
        this.insertTaskEvent({
          threadId,
          runId,
          type: 'background_task_created',
          payload: {
            taskId,
            goal: preview.goal,
            scheduled: preview.scheduled,
            nextRunAt: preview.nextRunAt
          },
          createdAt: now
        });
      })();
    const task = this.findBackgroundTask(taskId);
    if (task === null) {
      throw new Error('background_task_create_failed');
    }
    return task;
  }

  updateBackgroundTask(request: UpdateBackgroundTaskRequest): BackgroundTask {
    const task = this.requireBackgroundTask(request.taskId);
    const previewRequest = this.createPreviewRequestFromTask(task, request.patch);
    const preview = this.createBackgroundTaskPreview(previewRequest);
    const now = new Date().toISOString();
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `UPDATE background_tasks
             SET goal = ?, scheduled = ?, trigger_type = ?, trigger_description = ?, next_run_at = ?, cron_expression = ?,
                 workspace_path = ?, allowed_actions_json = ?, forbidden_actions_json = ?, failure_policy = ?,
                 notification_policy = ?, risk_level = ?, requires_confirmation = ?, updated_at = ?, enabled_capabilities_json = ?
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
            preview.failurePolicy,
            preview.notificationPolicy,
            preview.riskLevel,
            preview.requiresConfirmation ? 1 : 0,
            now,
            preview.enabledCapabilities === null ? null : JSON.stringify(preview.enabledCapabilities),
            task.id
          );
        this.db.prepare('UPDATE task_threads SET title = ?, goal = ?, updated_at = ? WHERE id = ?').run(
          preview.goal.slice(0, 60),
          preview.goal,
          now,
          task.threadId
        );
        this.insertTaskEvent({
          threadId: task.threadId,
          runId: task.runId,
          type: 'background_task_created',
          payload: {
            taskId: task.id,
            reason: request.reason,
            updated: true
          },
          createdAt: now
        });
      })();
    return this.requireBackgroundTask(task.id);
  }

  findBackgroundTask(id: string): BackgroundTask | null {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
                trigger_type, cron_expression,
                allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
                requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
                enabled_capabilities_json
         FROM background_tasks
         WHERE id = ?`
      )
      .get(id) as BackgroundTaskRow | undefined;
    if (row === undefined) {
      return null;
    }
    return mapBackgroundTask(row);
  }

  listBackgroundTasks(): BackgroundTask[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
                trigger_type, cron_expression,
                allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
                requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
                enabled_capabilities_json
         FROM background_tasks
         ORDER BY updated_at DESC`
      )
      .all() as BackgroundTaskRow[];
    return rows.map(mapBackgroundTask);
  }

  listSchedulableBackgroundTasks(): BackgroundTask[] {
    const rows = this.db
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
      .all() as BackgroundTaskRow[];
    return rows.map(mapBackgroundTask);
  }

  pauseBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status !== 'running' && task.status !== 'pending_confirmation') {
      throw new Error('background_task_invalid_transition');
    }
    return this.transitionBackgroundTask(task, 'paused', 'background_task_paused');
  }

  resumeBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status !== 'paused') {
      throw new Error('background_task_invalid_transition');
    }
    return this.transitionBackgroundTask(task, 'running', 'background_task_resumed');
  }

  cancelBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'archived') {
      throw new Error('background_task_invalid_transition');
    }
    return this.transitionBackgroundTask(task, 'cancelled', 'background_task_cancelled');
  }

  deleteBackgroundTask(id: string): { deleted: true; taskId: string } {
    const task = this.requireBackgroundTask(id);
    if (task.status !== 'completed' && task.status !== 'cancelled' && task.status !== 'failed') {
      throw new Error('background_task_delete_not_terminal');
    }
    const now = new Date().toISOString();
    this.db
      .transaction(() => {
        this.db.prepare('UPDATE background_tasks SET status = ?, updated_at = ? WHERE id = ?').run('archived', now, task.id);
        this.db
          .prepare('UPDATE task_threads SET status = ?, updated_at = ?, archived_at = ? WHERE id = ?')
          .run('archived', now, now, task.threadId);
      })();
    return {
      deleted: true,
      taskId: task.id
    };
  }

  recordScheduledTaskRun(input: {
    backgroundTaskId: string;
    scheduledAt: string;
    status: ScheduledTaskRun['status'];
    taskRunId?: string | null;
    triggeredAt?: string | null;
    skipReason?: string | null;
  }): ScheduledTaskRun {
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
    this.db
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

  countRecentSkippedScheduledRuns(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM scheduled_task_runs WHERE status = 'skipped'").get() as
      | { total: number }
      | undefined;
    if (row === undefined) {
      return 0;
    }
    return row.total;
  }

  markBackgroundTaskFired(input: { taskId: string; runId: string; firedAt: string; nextRunAt: string | null }): BackgroundTask {
    const task = this.requireBackgroundTask(input.taskId);
    this.db
      .prepare(
        `UPDATE background_tasks
         SET run_id = ?, last_run_at = ?, last_run_status = ?, run_count = run_count + 1, next_run_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.runId, input.firedAt, 'success', input.nextRunAt, input.firedAt, task.id);
    return this.requireBackgroundTask(task.id);
  }

  getSnapshot(): TaskSnapshot {
    const tasks = this.listBackgroundTasks().filter((task) => task.status !== 'archived');
    const threads = this.readThreads();
    const recentEvents = this.readRecentEvents();
    return {
      generatedAt: new Date().toISOString(),
      counts: {
        total: tasks.length,
        running: tasks.filter((task) => task.status === 'running').length,
        failed: tasks.filter((task) => task.status === 'failed').length,
        pendingConfirmation: tasks.filter((task) => task.status === 'pending_confirmation').length
      },
      threads,
      recentEvents
    };
  }

  getActiveTasks(): ActiveTaskItem[] {
    return this.listBackgroundTasks()
      .filter((task) => task.status !== 'archived')
      .map((task) => ({
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

  private transitionBackgroundTask(task: BackgroundTask, status: TaskStatus, eventType: TaskEvent['type']): BackgroundTask {
    const now = new Date().toISOString();
    this.db
      .transaction(() => {
        this.db.prepare('UPDATE background_tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, task.id);
        this.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run(status, now, task.threadId);
        this.insertTaskEvent({
          threadId: task.threadId,
          runId: task.runId,
          type: eventType,
          payload: {
            taskId: task.id,
            status
          },
          createdAt: now
        });
      })();
    return this.requireBackgroundTask(task.id);
  }

  private insertBackgroundTask(input: {
    preview: BackgroundTaskPreview;
    taskId: string;
    threadId: string;
    runId: string;
    status: TaskStatus;
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO background_tasks
         (id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description, next_run_at, cron_expression, workspace_path,
          allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
          requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at, enabled_capabilities_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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

  private insertTaskEvent(input: {
    threadId: string;
    runId: string;
    type: TaskEvent['type'];
    payload: unknown;
    createdAt: string;
  }): TaskEvent {
    const event: TaskEvent = {
      id: `event_${randomUUID()}`,
      threadId: input.threadId,
      runId: input.runId,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt
    };
    this.db
      .prepare(
        `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(event.id, event.threadId, event.runId, event.type, JSON.stringify(event.payload), event.createdAt);
    return event;
  }

  private createPreviewRequestFromTask(task: BackgroundTask, patch: UpdateBackgroundTaskRequest['patch']): BackgroundTaskPreviewRequest {
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

  private requireBackgroundTask(id: string): BackgroundTask {
    const task = this.findBackgroundTask(id);
    if (task === null) {
      throw new Error('background_task_not_found');
    }
    return task;
  }

  private readThreads(): TaskSnapshot['threads'] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, title, goal, status, created_at, updated_at
         FROM task_threads
         WHERE archived_at IS NULL
         ORDER BY updated_at DESC`
      )
      .all() as TaskThreadRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      goal: row.goal,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  private readRecentEvents(): TaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, run_id, type, payload_json, created_at
         FROM task_events
         ORDER BY created_at DESC, id DESC
         LIMIT 50`
      )
      .all() as TaskEventRow[];
    return rows.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      runId: row.run_id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at
    }));
  }
}

function mapBackgroundTask(row: BackgroundTaskRow): BackgroundTask {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    goal: row.goal,
    status: row.status,
    scheduled: row.scheduled === 1,
    triggerType: row.trigger_type,
    triggerDescription: row.trigger_description,
    nextRunAt: row.next_run_at,
    cronExpression: row.cron_expression,
    workspacePath: row.workspace_path,
    allowedActions: JSON.parse(row.allowed_actions_json) as string[],
    forbiddenActions: JSON.parse(row.forbidden_actions_json) as string[],
    failurePolicy: row.failure_policy,
    notificationPolicy: row.notification_policy,
    riskLevel: row.risk_level,
    requiresConfirmation: row.requires_confirmation === 1,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    enabledCapabilities: parseEnabledCapabilities(row.enabled_capabilities_json)
  };
}

function parseEnabledCapabilities(value: string | null): EnabledCapabilities | null {
  if (value === null) {
    return null;
  }
  return JSON.parse(value) as EnabledCapabilities;
}

function normalizeTrigger(trigger: BackgroundTaskTrigger, description: string): BackgroundTaskTrigger {
  if (trigger.type === 'manual') {
    return { type: 'manual', description };
  }
  if (trigger.type === 'once') {
    return { type: 'once', description, nextRunAt: trigger.nextRunAt };
  }
  return {
    type: 'cron',
    description,
    cronExpression: trigger.cronExpression,
    nextRunAt: trigger.nextRunAt
  };
}

function taskTrigger(task: BackgroundTask): BackgroundTaskTrigger {
  if (task.triggerType === 'manual') {
    return {
      type: 'manual',
      description: task.triggerDescription
    };
  }
  if (task.triggerType === 'once') {
    if (task.nextRunAt === null) {
      throw new Error('background_task_next_run_missing');
    }
    return {
      type: 'once',
      description: task.triggerDescription,
      nextRunAt: task.nextRunAt
    };
  }
  if (task.nextRunAt === null || task.cronExpression === null) {
    throw new Error('background_task_cron_missing');
  }
  return {
    type: 'cron',
    description: task.triggerDescription,
    cronExpression: task.cronExpression,
    nextRunAt: task.nextRunAt
  };
}

function requireText(value: string, code: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(code);
  }
  return trimmed;
}

function inferBackgroundRisk(allowedActions: string[], forbiddenActions: string[]): BackgroundTaskPreview['riskLevel'] {
  const commands = [...allowedActions, ...forbiddenActions].map((item) => item.toLowerCase());
  if (commands.some((command) => command.includes('git push') || command.includes('rm ') || command.includes('remove-item'))) {
    return 'medium';
  }
  if (commands.length === 0) {
    return 'low';
  }
  return 'medium';
}
