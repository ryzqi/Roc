import type {
  AgentCapabilityManifest,
  AgentCapabilityPreview,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  BackgroundTaskSummary,
  EnabledCapabilities,
  ProviderExecutionResult,
  TaskEvent,
  TaskRun,
  TaskSnapshot,
  TaskThread
} from '../../shared/types';
import { randomUUID } from 'node:crypto';
import type { DatabaseService } from './database-service';
import { RocDomainError } from './errors';

type BackgroundTaskRow = {
  id: string;
  thread_id: string;
  run_id: string;
  goal: string;
  status: BackgroundTask['status'];
  scheduled: number;
  trigger_description: string;
  next_run_at: string | null;
  workspace_path: string;
  allowed_actions_json: string;
  forbidden_actions_json: string;
  failure_policy: BackgroundTask['failurePolicy'];
  notification_policy: BackgroundTask['notificationPolicy'];
  risk_level: BackgroundTask['riskLevel'];
  requires_confirmation: number;
  created_at: string;
  updated_at: string;
};

export class TaskService {
  constructor(private readonly database: DatabaseService) {}

  createBackgroundTaskPreview(request: BackgroundTaskPreviewRequest): BackgroundTaskPreview {
    const goal = this.requireText(request.goal, 'background_task_goal_empty', '后台任务目标不能为空。', '请输入后台任务目标。');
    const triggerDescription = this.requireText(
      request.trigger.description,
      'background_task_trigger_empty',
      '后台任务触发条件不能为空。',
      '请填写后台任务触发方式。'
    );
    const workspacePath = this.requireText(
      request.workspacePath,
      'background_task_workspace_empty',
      '后台任务作用目录不能为空。',
      '请选择后台任务作用目录。'
    );
    const scheduled = request.trigger.type === 'schedule';
    if (scheduled && request.trigger.nextRunAt === null) {
      throw new RocDomainError({
        code: 'background_task_next_run_missing',
        message: '定时后台任务必须包含下次运行时间。',
        category: 'validation',
        retryable: false,
        userAction: '请为定时任务设置下次运行时间。'
      });
    }

    return {
      ...request,
      goal,
      trigger: {
        type: request.trigger.type,
        description: triggerDescription,
        nextRunAt: request.trigger.nextRunAt
      },
      workspacePath,
      scheduled,
      nextRunAt: request.trigger.nextRunAt,
      riskLevel: this.inferBackgroundRisk(request.allowedActions, request.forbiddenActions),
      requiresConfirmation: request.forbiddenActions.length > 0 && request.allowedActions.length === 0
    };
  }

  createBackgroundTask(preview: BackgroundTaskPreview): BackgroundTask {
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

    const transaction = this.database.db.transaction(() => {
      this.database.db
        .prepare(
          `INSERT INTO task_threads (id, title, goal, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(threadId, title, preview.goal, status, now, now);

      this.database.db
        .prepare(
          `INSERT INTO task_runs
           (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(runId, threadId, 1, preview.goal, status, now, null, null, JSON.stringify(capabilities));

      this.database.db
        .prepare(
          `INSERT INTO background_tasks
           (id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description, next_run_at, workspace_path,
            allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
            requires_confirmation, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          preview.workspacePath,
          JSON.stringify(preview.allowedActions),
          JSON.stringify(preview.forbiddenActions),
          preview.failurePolicy,
          preview.notificationPolicy,
          preview.riskLevel,
          preview.requiresConfirmation ? 1 : 0,
          now,
          now
        );

      this.recordEvent({
        threadId,
        runId,
        type: 'background_task_created',
        payload: {
          taskId,
          goal: preview.goal,
          scheduled: preview.scheduled,
          nextRunAt: preview.nextRunAt
        }
      });
    });
    transaction();

    return {
      id: taskId,
      threadId,
      runId,
      goal: preview.goal,
      status,
      scheduled: preview.scheduled,
      triggerDescription: preview.trigger.description,
      nextRunAt: preview.nextRunAt,
      workspacePath: preview.workspacePath,
      allowedActions: preview.allowedActions,
      forbiddenActions: preview.forbiddenActions,
      failurePolicy: preview.failurePolicy,
      notificationPolicy: preview.notificationPolicy,
      riskLevel: preview.riskLevel,
      requiresConfirmation: preview.requiresConfirmation,
      createdAt: now,
      updatedAt: now
    };
  }

  pauseBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status !== 'running' && task.status !== 'pending_confirmation') {
      throw this.invalidTransition('后台任务当前状态不能暂停。');
    }
    return this.transitionBackgroundTask(task, 'paused', 'background_task_paused');
  }

  resumeBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status !== 'paused') {
      throw this.invalidTransition('后台任务当前状态不能继续。');
    }
    return this.transitionBackgroundTask(task, 'running', 'background_task_resumed');
  }

  cancelBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status === 'cancelled') {
      return task;
    }
    if (task.status === 'completed' || task.status === 'archived') {
      throw this.invalidTransition('后台任务当前状态不能取消。');
    }
    return this.transitionBackgroundTask(task, 'cancelled', 'background_task_cancelled');
  }

  listBackgroundTasks(): BackgroundTask[] {
    const rows = this.database.db
      .prepare(
        `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
                allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
                requires_confirmation, created_at, updated_at
         FROM background_tasks
         ORDER BY updated_at DESC
         LIMIT 50`
      )
      .all() as BackgroundTaskRow[];

    return rows.map((row) => this.backgroundTaskFromRow(row));
  }

  getBackgroundTaskSummary(): BackgroundTaskSummary {
    const rows = this.database.db
      .prepare(
        `SELECT status, next_run_at
         FROM background_tasks
         ORDER BY updated_at DESC`
      )
      .all() as Array<{ status: TaskThread['status']; next_run_at: string | null }>;
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

  createTaskRun(input: { userInput: string; modelId: string; enabledCapabilities: EnabledCapabilities }): TaskRun {
    const now = new Date().toISOString();
    const threadId = `thread_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const eventId = `event_${randomUUID()}`;
    const title = input.userInput.trim().slice(0, 60);
    const enabledCapabilitiesJson = JSON.stringify(input.enabledCapabilities);

    this.database.db
      .prepare(
        `INSERT INTO task_threads (id, title, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(threadId, title, input.userInput, 'waiting_next_turn', now, now);

    this.database.db
      .prepare(
        `INSERT INTO task_runs
         (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(runId, threadId, 1, input.userInput, 'waiting_next_turn', now, null, input.modelId, enabledCapabilitiesJson);

    this.database.db
      .prepare(
        `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        threadId,
        runId,
        'message',
        JSON.stringify({
          role: 'user',
          content: input.userInput,
          enabledCapabilities: input.enabledCapabilities
        }),
        now
      );

    return {
      id: runId,
      threadId,
      runNumber: 1,
      userInput: input.userInput,
      status: 'waiting_next_turn',
      startedAt: now,
      endedAt: null,
      modelId: input.modelId,
      enabledCapabilities: input.enabledCapabilities
    };
  }

  getRun(id: string): TaskRun {
    const row = this.database.db
      .prepare(
        `SELECT id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json
         FROM task_runs
         WHERE id = ?`
      )
      .get(id) as
      | {
          id: string;
          thread_id: string;
          run_number: number;
          user_input: string;
          status: TaskRun['status'];
          started_at: string;
          ended_at: string | null;
          model_id: string | null;
          enabled_capabilities_json: string;
        }
      | undefined;

    if (row === undefined) {
      throw new Error(`Task run not found: ${id}`);
    }

    return {
      id: row.id,
      threadId: row.thread_id,
      runNumber: row.run_number,
      userInput: row.user_input,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      modelId: row.model_id,
      enabledCapabilities: JSON.parse(row.enabled_capabilities_json) as EnabledCapabilities
    };
  }

  recordEvent(input: { threadId: string; runId: string; type: TaskEvent['type']; payload: unknown }): TaskEvent {
    const now = new Date().toISOString();
    const eventId = `event_${randomUUID()}`;

    this.database.db
      .prepare(
        `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(eventId, input.threadId, input.runId, input.type, JSON.stringify(input.payload), now);

    return {
      id: eventId,
      threadId: input.threadId,
      runId: input.runId,
      type: input.type,
      payload: input.payload,
      createdAt: now
    };
  }

  completeRunWithProviderResult(input: { runId: string; result: ProviderExecutionResult }): void {
    const run = this.getRun(input.runId);
    const now = new Date().toISOString();
    const transaction = this.database.db.transaction(() => {
      this.database.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('completed', now, run.threadId);
      this.database.db.prepare('UPDATE task_runs SET status = ?, ended_at = ? WHERE id = ?').run('completed', now, run.id);
      this.recordEvent({
        threadId: run.threadId,
        runId: run.id,
        type: 'agent_update',
        payload: {
          providerId: input.result.providerId,
          modelId: input.result.modelId,
          durationMs: input.result.durationMs,
          finishReason: input.result.finishReason,
          usage: input.result.usage,
          summary: input.result.summary
        }
      });
      this.recordEvent({
        threadId: run.threadId,
        runId: run.id,
        type: 'message',
        payload: {
          role: 'assistant',
          content: input.result.assistantMessage,
          providerId: input.result.providerId,
          modelId: input.result.modelId
        }
      });
    });
    transaction();
  }

  failRunWithProviderError(input: {
    runId: string;
    providerId: string;
    modelId: string;
    code: string;
    message: string;
    retryable: boolean;
  }): void {
    const run = this.getRun(input.runId);
    const now = new Date().toISOString();
    const transaction = this.database.db.transaction(() => {
      this.database.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, run.threadId);
      this.database.db.prepare('UPDATE task_runs SET status = ?, ended_at = ? WHERE id = ?').run('failed', now, run.id);
      this.recordEvent({
        threadId: run.threadId,
        runId: run.id,
        type: 'error',
        payload: {
          code: input.code,
          message: input.message,
          providerId: input.providerId,
          modelId: input.modelId,
          retryable: input.retryable
        }
      });
    });
    transaction();
  }

  recordAgentCapabilityManifest(input: {
    threadId: string;
    runId: string;
    preview: AgentCapabilityPreview;
  }): AgentCapabilityManifest {
    const manifest: AgentCapabilityManifest = {
      requestedCapabilities: input.preview.requestedCapabilities,
      resolvedCapabilities: input.preview.selectedCapabilities,
      skippedCapabilities: input.preview.skippedCapabilities,
      toolCards: [...input.preview.toolCards, ...input.preview.skillCards].map((card) => ({
        id: card.id,
        name: card.name,
        capabilityType: card.capabilityType,
        riskLevel: card.riskLevel,
        scope: card.scope,
        requiresApproval: card.requiresApproval
      })),
      untrustedContextPolicy: input.preview.untrustedContextPolicy
    };
    this.recordEvent({
      threadId: input.threadId,
      runId: input.runId,
      type: 'context_manifest',
      payload: manifest
    });
    for (const skillCard of input.preview.skillCards) {
      this.recordEvent({
        threadId: input.threadId,
        runId: input.runId,
        type: 'skill_loaded',
        payload: {
          skillId: skillCard.id.replace('skill:', ''),
          path: skillCard.sourcePath,
          enabledBy: 'turn_selection',
          source: 'agent_capability_preview'
        }
      });
    }
    return manifest;
  }

  getSnapshot(): TaskSnapshot {
    const threads = this.database.db
      .prepare(
        `SELECT id, title, goal, status, created_at, updated_at
         FROM task_threads
         WHERE archived_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 50`
      )
      .all() as Array<{
      id: string;
      title: string;
      goal: string;
      status: TaskThread['status'];
      created_at: string;
      updated_at: string;
    }>;

    const recentEvents = this.database.db
      .prepare(
        `SELECT id, thread_id, run_id, type, payload_json, created_at
         FROM task_events
         ORDER BY created_at DESC
         LIMIT 50`
      )
      .all() as Array<{
      id: string;
      thread_id: string;
      run_id: string;
      type: TaskEvent['type'];
      payload_json: string;
      created_at: string;
    }>;

    const normalizedThreads: TaskThread[] = threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      goal: thread.goal,
      status: thread.status,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at
    }));

    return {
      generatedAt: new Date().toISOString(),
      counts: {
        total: normalizedThreads.length,
        running: normalizedThreads.filter((thread) => thread.status === 'running').length,
        failed: normalizedThreads.filter((thread) => thread.status === 'failed').length,
        pendingConfirmation: normalizedThreads.filter((thread) => thread.status === 'pending_confirmation').length
      },
      threads: normalizedThreads,
      recentEvents: recentEvents.map((event) => ({
        id: event.id,
        threadId: event.thread_id,
        runId: event.run_id,
        type: event.type,
        payload: JSON.parse(event.payload_json) as unknown,
        createdAt: event.created_at
      }))
    };
  }

  private transitionBackgroundTask(
    task: BackgroundTask,
    status: BackgroundTask['status'],
    eventType: Extract<TaskEvent['type'], 'background_task_paused' | 'background_task_resumed' | 'background_task_cancelled'>
  ): BackgroundTask {
    const now = new Date().toISOString();
    const transaction = this.database.db.transaction(() => {
      this.database.db
        .prepare('UPDATE background_tasks SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, task.id);
      this.database.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run(status, now, task.threadId);
      this.database.db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run(status, task.runId);
      this.recordEvent({
        threadId: task.threadId,
        runId: task.runId,
        type: eventType,
        payload: {
          taskId: task.id,
          status
        }
      });
    });
    transaction();

    return {
      ...task,
      status,
      updatedAt: now
    };
  }

  private requireBackgroundTask(id: string): BackgroundTask {
    const taskId = this.requireText(id, 'background_task_id_empty', '后台任务 ID 不能为空。', '请选择一个后台任务。');
    const row = this.database.db
      .prepare(
        `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
                allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
                requires_confirmation, created_at, updated_at
         FROM background_tasks
         WHERE id = ?`
      )
      .get(taskId) as BackgroundTaskRow | undefined;

    if (row === undefined) {
      throw new RocDomainError({
        code: 'background_task_not_found',
        message: '后台任务不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请刷新任务工作台后重试。'
      });
    }

    return this.backgroundTaskFromRow(row);
  }

  private backgroundTaskFromRow(row: BackgroundTaskRow): BackgroundTask {
    return {
      id: row.id,
      threadId: row.thread_id,
      runId: row.run_id,
      goal: row.goal,
      status: row.status,
      scheduled: row.scheduled === 1,
      triggerDescription: row.trigger_description,
      nextRunAt: row.next_run_at,
      workspacePath: row.workspace_path,
      allowedActions: JSON.parse(row.allowed_actions_json) as string[],
      forbiddenActions: JSON.parse(row.forbidden_actions_json) as string[],
      failurePolicy: row.failure_policy,
      notificationPolicy: row.notification_policy,
      riskLevel: row.risk_level,
      requiresConfirmation: row.requires_confirmation === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private inferBackgroundRisk(allowedActions: string[], forbiddenActions: string[]): BackgroundTaskPreview['riskLevel'] {
    const commands = [...allowedActions, ...forbiddenActions].map((item) => item.toLowerCase());
    if (commands.some((command) => command.includes('git push') || command.includes('rm ') || command.includes('remove-item'))) {
      return 'medium';
    }
    if (commands.length === 0) {
      return 'low';
    }
    return 'medium';
  }

  private invalidTransition(message: string): RocDomainError {
    return new RocDomainError({
      code: 'background_task_invalid_transition',
      message,
      category: 'conflict',
      retryable: false,
      userAction: '请查看任务状态，必要时创建新的后台任务。'
    });
  }

  private requireText(value: string, code: string, message: string, userAction: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new RocDomainError({
        code,
        message,
        category: 'validation',
        retryable: false,
        userAction
      });
    }
    return trimmed;
  }
}
