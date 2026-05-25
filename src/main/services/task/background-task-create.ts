import { randomUUID } from 'node:crypto';
import type {
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  EnabledCapabilities
} from '../../../shared/types';
import type { DatabaseService } from '../database-service';
import { RocDomainError } from '../errors';
import { inferBackgroundRisk, requireText } from './validation';

export function createBackgroundTaskPreview(input: { request: BackgroundTaskPreviewRequest }): BackgroundTaskPreview {
  const request = input.request;
  const goal = requireText(request.goal, 'background_task_goal_empty', '后台任务目标不能为空。', '请输入后台任务目标。');
  const triggerDescription = requireText(
    request.trigger.description,
    'background_task_trigger_empty',
    '后台任务触发条件不能为空。',
    '请填写后台任务触发方式。'
  );
  const workspacePath = requireText(
    request.workspacePath,
    'background_task_workspace_empty',
    '后台任务作用目录不能为空。',
    '请选择后台任务作用目录。'
  );
  const nextRunAt = request.trigger.type === 'manual' ? null : request.trigger.nextRunAt;
  const cronExpression = request.trigger.type === 'cron' ? request.trigger.cronExpression : null;
  const scheduled = request.trigger.type !== 'manual';
  if (scheduled && nextRunAt === null) {
    throw new RocDomainError({
      code: 'background_task_next_run_missing',
      message: '定时后台任务必须包含下次运行时间。',
      category: 'validation',
      retryable: false,
      userAction: '请为定时任务设置下次运行时间。'
    });
  }

  const trigger =
    request.trigger.type === 'manual'
      ? { type: 'manual' as const, description: triggerDescription }
      : request.trigger.type === 'once'
        ? { type: 'once' as const, description: triggerDescription, nextRunAt: request.trigger.nextRunAt }
        : {
            type: 'cron' as const,
            description: triggerDescription,
            cronExpression: request.trigger.cronExpression,
            nextRunAt: request.trigger.nextRunAt
          };

  return {
    ...request,
    goal,
    trigger,
    workspacePath,
    scheduled,
    nextRunAt,
    cronExpression,
    riskLevel: inferBackgroundRisk(request.allowedActions, request.forbiddenActions),
    requiresConfirmation: request.forbiddenActions.length > 0 && request.allowedActions.length === 0,
    enabledCapabilities: request.enabledCapabilities ?? null
  };
}

export function createBackgroundTask(input: { database: DatabaseService; preview: BackgroundTaskPreview }): BackgroundTask {
  const { database, preview } = input;
  const now = new Date().toISOString();
  const taskId = `background_${randomUUID()}`;
  const threadId = `thread_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const status = preview.requiresConfirmation ? 'pending_confirmation' : 'running';
  const title = preview.goal.slice(0, 60);
  const capabilities: EnabledCapabilities = {
    mcpServers: [],
    skills: []
  };

  const transaction = database.db.transaction(() => {
    database.db
      .prepare(
        `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(threadId, 'background', title, preview.goal, status, now, now);

    database.db
      .prepare(
        `INSERT INTO task_runs
         (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(runId, threadId, 1, preview.goal, status, now, null, null, JSON.stringify(capabilities));

    database.db
      .prepare(
        `INSERT INTO background_tasks
         (id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description, next_run_at, cron_expression, workspace_path,
          allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
          requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at, enabled_capabilities_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        taskId,
        threadId,
        runId,
        preview.goal,
        status,
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
        null,
        null,
        0,
        now,
        now,
        preview.enabledCapabilities === null ? null : JSON.stringify(preview.enabledCapabilities)
      );

    database.db
      .prepare(
        `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        `event_${randomUUID()}`,
        threadId,
        runId,
        'background_task_created',
        JSON.stringify({
          taskId,
          goal: preview.goal,
          scheduled: preview.scheduled,
          nextRunAt: preview.nextRunAt
        }),
        now
      );
  });
  transaction();

  return {
    id: taskId,
    threadId,
    runId,
    goal: preview.goal,
    status,
    scheduled: preview.scheduled,
    triggerType: preview.trigger.type,
    triggerDescription: preview.trigger.description,
    nextRunAt: preview.nextRunAt,
    cronExpression: preview.cronExpression,
    workspacePath: preview.workspacePath,
    allowedActions: preview.allowedActions,
    forbiddenActions: preview.forbiddenActions,
    failurePolicy: preview.failurePolicy,
    notificationPolicy: preview.notificationPolicy,
    riskLevel: preview.riskLevel,
    requiresConfirmation: preview.requiresConfirmation,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    createdAt: now,
    updatedAt: now,
    enabledCapabilities: preview.enabledCapabilities
  };
}
