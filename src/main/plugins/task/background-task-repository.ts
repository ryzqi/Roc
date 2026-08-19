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
  TaskStatus,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';

type BackgroundTaskRecord = {
  id: string;
  thread_id: string;
  run_id: string;
  goal: string;
  status: BackgroundTask['status'];
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

type ScheduledTaskRunRow = {
  id: string;
  background_task_id: string;
  task_run_id: string | null;
  scheduled_at: string;
  triggered_at: string | null;
  status: ScheduledTaskRun['status'];
  skip_reason: string | null;
};

export type BackgroundTaskUpdatePlan = {
  taskId: string;
  preview: BackgroundTaskPreview;
  now: string;
  taskRevision: number;
};

export class BackgroundTaskRepository {
  constructor(private readonly db: DatabaseConnection) {}

  createProposalRequest(input: {
    description: string;
    enabledCapabilities: EnabledCapabilities;
  }): ChatStartRunRequest {
    return {
      input: requireText(input.description, 'background_task_description_empty'),
      mode: 'task',
      enabledCapabilities: input.enabledCapabilities,
      workflowHint: 'propose_background_task'
    };
  }

  createPreview(request: BackgroundTaskPreviewRequest): BackgroundTaskPreview {
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

  create(request: BackgroundTaskPreviewRequest): BackgroundTask {
    const preview = this.createPreview(request);
    const now = new Date().toISOString();
    const taskId = `background_${randomUUID()}`;
    const threadId = `thread_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const status: TaskStatus = preview.requiresConfirmation ? 'pending_confirmation' : 'running';
    this.db.transaction(() => {
      this.insert({ preview, taskId, threadId, runId, status, now });
    })();
    return this.require(taskId);
  }

  update(request: UpdateBackgroundTaskRequest): BackgroundTask {
    const plan = this.prepareUpdate(request);
    this.db.transaction(() => {
      this.updateInCurrentTransaction(plan);
    })();
    return this.require(plan.taskId);
  }

  prepareUpdate(request: UpdateBackgroundTaskRequest): BackgroundTaskUpdatePlan {
    const task = this.require(request.taskId);
    const preview = this.createPreview({
      goal: request.patch.goal === undefined ? task.goal : request.patch.goal,
      trigger: request.patch.trigger === undefined ? this.trigger(task) : request.patch.trigger,
      workspacePath: request.patch.workspacePath === undefined ? task.workspacePath : request.patch.workspacePath,
      allowedActions: request.patch.allowedActions === undefined ? task.allowedActions : request.patch.allowedActions,
      forbiddenActions: request.patch.forbiddenActions === undefined ? task.forbiddenActions : request.patch.forbiddenActions,
      failurePolicy: request.patch.failurePolicy === undefined ? task.failurePolicy : request.patch.failurePolicy,
      notificationPolicy: request.patch.notificationPolicy === undefined ? task.notificationPolicy : request.patch.notificationPolicy,
      enabledCapabilities: request.patch.enabledCapabilities === undefined ? task.enabledCapabilities : request.patch.enabledCapabilities
    });
    const revisionRow = this.db
      .prepare('SELECT task_revision FROM background_tasks WHERE id = ?')
      .get(task.id) as { task_revision: number } | undefined;
    if (revisionRow === undefined || !Number.isInteger(revisionRow.task_revision) || revisionRow.task_revision <= 0) {
      throw new Error('background_task_revision_invalid');
    }
    return {
      taskId: task.id,
      preview,
      now: new Date().toISOString(),
      taskRevision: revisionRow.task_revision
    };
  }

  updateInCurrentTransaction(plan: BackgroundTaskUpdatePlan): void {
    this.db
      .prepare(
        `UPDATE background_tasks
         SET goal = ?, scheduled = ?, trigger_type = ?, trigger_description = ?, next_run_at = ?, cron_expression = ?,
             workspace_path = ?, allowed_actions_json = ?, forbidden_actions_json = ?, failure_policy = ?,
             notification_policy = ?, risk_level = ?, requires_confirmation = ?, updated_at = ?, enabled_capabilities_json = ?,
             task_revision = task_revision + 1
         WHERE id = ? AND task_revision = ?`
      )
      .run(
        plan.preview.goal,
        plan.preview.scheduled ? 1 : 0,
        plan.preview.trigger.type,
        plan.preview.trigger.description,
        plan.preview.nextRunAt,
        plan.preview.cronExpression,
        plan.preview.workspacePath,
        JSON.stringify(plan.preview.allowedActions),
        JSON.stringify(plan.preview.forbiddenActions),
        plan.preview.failurePolicy,
        plan.preview.notificationPolicy,
        plan.preview.riskLevel,
        plan.preview.requiresConfirmation ? 1 : 0,
        plan.now,
        plan.preview.enabledCapabilities === null ? null : JSON.stringify(plan.preview.enabledCapabilities),
        plan.taskId,
        plan.taskRevision
      );
  }

  find(id: string): BackgroundTask | null {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
                trigger_type, cron_expression,
                allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
                requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
                enabled_capabilities_json
         FROM background_tasks
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM thread_deletion_journal deletion
             WHERE deletion.thread_id = background_tasks.thread_id
           )`
      )
      .get(id) as BackgroundTaskRecord | undefined;
    return row === undefined ? null : mapBackgroundTask(row);
  }

  findByRunId(runId: string): BackgroundTask | null {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
                trigger_type, cron_expression,
                allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
                requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
                enabled_capabilities_json
         FROM background_tasks
         WHERE run_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM thread_deletion_journal deletion
             WHERE deletion.thread_id = background_tasks.thread_id
           )`
      )
      .get(runId) as BackgroundTaskRecord | undefined;
    return row === undefined ? null : mapBackgroundTask(row);
  }

  require(id: string): BackgroundTask {
    const task = this.find(id);
    if (task === null) {
      throw new Error('background_task_not_found');
    }
    return task;
  }

  list(): BackgroundTask[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
                trigger_type, cron_expression,
                allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
                requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
                enabled_capabilities_json
         FROM background_tasks
         WHERE NOT EXISTS (
           SELECT 1
           FROM thread_deletion_journal deletion
           WHERE deletion.thread_id = background_tasks.thread_id
         )
         ORDER BY updated_at DESC`
      )
      .all() as BackgroundTaskRecord[];
    return rows.map(mapBackgroundTask);
  }

  listSchedulable(): BackgroundTask[] {
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
           AND NOT EXISTS (
             SELECT 1
             FROM thread_deletion_journal deletion
             WHERE deletion.thread_id = background_tasks.thread_id
           )
         ORDER BY next_run_at ASC, updated_at DESC`
      )
      .all() as BackgroundTaskRecord[];
    return rows.map(mapBackgroundTask);
  }

  listActive(): ActiveTaskItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
                trigger_type, cron_expression,
                allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
                requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
                enabled_capabilities_json
         FROM background_tasks
         WHERE status != 'archived'
           AND NOT EXISTS (
             SELECT 1
             FROM thread_deletion_journal deletion
             WHERE deletion.thread_id = background_tasks.thread_id
           )
         ORDER BY updated_at DESC`
      )
      .all() as BackgroundTaskRecord[];
    return rows.map(mapBackgroundTask).map((task) => ({
      kind: 'background' as const,
      threadId: task.threadId,
      taskId: task.id,
      title: task.goal.slice(0, 60),
      goal: task.goal,
      status: task.status,
      trigger: this.trigger(task),
      nextRunAt: task.nextRunAt,
      lastRunAt: task.lastRunAt,
      riskLevel: task.riskLevel,
      workspacePath: task.workspacePath,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    }));
  }

  pause(id: string): BackgroundTask {
    const task = this.require(id);
    if (task.status !== 'running' && task.status !== 'pending_confirmation') {
      throw new Error('background_task_invalid_transition');
    }
    return this.transition(task, 'paused');
  }

  resume(id: string): BackgroundTask {
    const task = this.require(id);
    if (task.status !== 'paused') {
      throw new Error('background_task_invalid_transition');
    }
    return this.transition(task, 'running');
  }

  cancel(id: string): BackgroundTask {
    const task = this.require(id);
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'archived') {
      throw new Error('background_task_invalid_transition');
    }
    return this.transition(task, 'cancelled');
  }

  assertArchivable(id: string): BackgroundTask {
    const task = this.require(id);
    if (task.status !== 'completed' && task.status !== 'cancelled' && task.status !== 'failed') {
      throw new Error('background_task_delete_not_terminal');
    }
    return task;
  }

  archive(id: string, now: string): void {
    this.db.prepare('UPDATE background_tasks SET status = ?, updated_at = ? WHERE id = ?').run('archived', now, id);
  }

  recordScheduledRun(input: {
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
      taskRunId: input.taskRunId === undefined ? null : input.taskRunId,
      scheduledAt: input.scheduledAt,
      triggeredAt: input.triggeredAt === undefined ? now : input.triggeredAt,
      status: input.status,
      skipReason: input.skipReason === undefined ? null : input.skipReason
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

  listScheduledRuns(input: { taskId: string; limit?: number }): ScheduledTaskRun[] {
    const task = this.require(input.taskId);
    const limit = input.limit === undefined ? 20 : input.limit;
    if (limit <= 0) {
      throw new Error('scheduled_runs_limit_invalid');
    }
    const rows = this.db
      .prepare(
        `SELECT id, background_task_id, task_run_id, scheduled_at, triggered_at, status, skip_reason
         FROM (
           SELECT id, background_task_id, task_run_id, scheduled_at, triggered_at, status, skip_reason, rowid AS sort_rowid
           FROM scheduled_task_runs
           WHERE background_task_id = ?
           UNION ALL
           SELECT occurrence_key AS id, background_task_id, run_id AS task_run_id, scheduled_at,
                  COALESCE(dispatched_at, claimed_at, created_at) AS triggered_at,
                  status, reason AS skip_reason, rowid AS sort_rowid
           FROM scheduled_occurrences
           WHERE background_task_id = ?
         )
         ORDER BY scheduled_at DESC, sort_rowid DESC
         LIMIT ?`
      )
      .all(task.id, task.id, limit) as ScheduledTaskRunRow[];
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

  markFired(input: { taskId: string; runId: string; firedAt: string; nextRunAt: string | null }): BackgroundTask {
    const task = this.require(input.taskId);
    this.db
      .prepare(
        `UPDATE background_tasks
         SET run_id = ?, last_run_at = ?, last_run_status = ?, run_count = run_count + 1, next_run_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.runId, input.firedAt, null, input.nextRunAt, input.firedAt, task.id);
    return this.require(task.id);
  }

  updateNextRunAtInCurrentTransaction(taskId: string, nextRunAt: string | null, updatedAt: string): void {
    this.db
      .prepare('UPDATE background_tasks SET next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(nextRunAt, updatedAt, taskId);
  }

  markDispatchedInCurrentTransaction(taskId: string, runId: string, dispatchedAt: string): void {
    this.db
      .prepare(
        `UPDATE background_tasks
         SET run_id = ?, last_run_at = ?, last_run_status = NULL, run_count = run_count + 1, updated_at = ?
         WHERE id = ?`
      )
      .run(runId, dispatchedAt, dispatchedAt, taskId);
  }

  recordOccurrenceTerminalInCurrentTransaction(
    taskId: string,
    status: Exclude<BackgroundTask['lastRunStatus'], null>,
    updatedAt: string,
    pause: boolean
  ): void {
    this.db
      .prepare(
        `UPDATE background_tasks
         SET status = CASE WHEN ? = 1 THEN 'paused' ELSE status END, last_run_status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(pause ? 1 : 0, status, updatedAt, taskId);
  }

  recordStartFailure(input: {
    taskId: string;
    scheduledAt: string;
    failedAt: string;
    reason: string;
  }): BackgroundTask {
    const task = this.require(input.taskId);
    this.db.transaction(() => {
      this.recordScheduledRun({
        backgroundTaskId: task.id,
        scheduledAt: input.scheduledAt,
        status: 'failed',
        taskRunId: null,
        triggeredAt: input.failedAt,
        skipReason: input.reason
      });
      this.pauseAfterRunFailure(task.id, input.failedAt);
    })();
    return this.require(task.id);
  }

  updateLastRunStatus(
    taskId: string,
    status: Exclude<BackgroundTask['lastRunStatus'], null>,
    updatedAt: string
  ): void {
    this.db
      .prepare('UPDATE background_tasks SET last_run_status = ?, updated_at = ? WHERE id = ?')
      .run(status, updatedAt, taskId);
  }

  pauseAfterRunFailure(taskId: string, now: string): void {
    const task = this.require(taskId);
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE background_tasks SET status = ?, last_run_status = ?, updated_at = ? WHERE id = ?')
        .run('paused', 'failed', now, task.id);
    })();
  }

  countRecentSkippedScheduledRuns(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total
         FROM (
           SELECT background_task_id FROM scheduled_task_runs WHERE status = 'skipped'
           UNION ALL
           SELECT background_task_id FROM scheduled_occurrences WHERE status = 'skipped'
         ) runs
         INNER JOIN background_tasks task ON task.id = runs.background_task_id
         WHERE NOT EXISTS (
           SELECT 1
           FROM thread_deletion_journal deletion
           WHERE deletion.thread_id = task.thread_id
         )`
      )
      .get() as { total: number } | undefined;
    return row === undefined ? 0 : row.total;
  }

  private trigger(task: BackgroundTask): BackgroundTaskTrigger {
    if (task.triggerType === 'manual') {
      return { type: 'manual', description: task.triggerDescription };
    }
    if (task.triggerType === 'once') {
      if (task.nextRunAt === null) {
        throw new Error('background_task_next_run_missing');
      }
      return { type: 'once', description: task.triggerDescription, nextRunAt: task.nextRunAt };
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

  private transition(task: BackgroundTask, status: TaskStatus): BackgroundTask {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('UPDATE background_tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, task.id);
    })();
    return this.require(task.id);
  }

  private insert(input: {
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
}

function mapBackgroundTask(row: BackgroundTaskRecord): BackgroundTask {
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

function requireText(value: string, code: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(code);
  }
  return trimmed;
}
