import { randomUUID } from 'node:crypto';
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
import type { DatabaseService } from './database-service';
import { RocDomainError } from './errors';
import {
  backgroundTaskFromRow,
  inferBackgroundRisk,
  invalidTransition,
  nextRunNumber,
  requireActiveThread,
  requireBackgroundTask,
  requireText,
  type BackgroundTaskRow
} from './task';

export class TaskService {
  constructor(private readonly database: DatabaseService) {}

  createBackgroundTaskPreview(request: BackgroundTaskPreviewRequest): BackgroundTaskPreview {
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
      riskLevel: inferBackgroundRisk(request.allowedActions, request.forbiddenActions),
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
    const task = requireBackgroundTask(this.database, id);
    if (task.status !== 'running' && task.status !== 'pending_confirmation') {
      throw invalidTransition('后台任务当前状态不能暂停。');
    }
    return this.transitionBackgroundTask(task, 'paused', 'background_task_paused');
  }

  resumeBackgroundTask(id: string): BackgroundTask {
    const task = requireBackgroundTask(this.database, id);
    if (task.status !== 'paused') {
      throw invalidTransition('后台任务当前状态不能继续。');
    }
    return this.transitionBackgroundTask(task, 'running', 'background_task_resumed');
  }

  cancelBackgroundTask(id: string): BackgroundTask {
    const task = requireBackgroundTask(this.database, id);
    if (task.status === 'cancelled') {
      return task;
    }
    if (task.status === 'completed' || task.status === 'archived') {
      throw invalidTransition('后台任务当前状态不能取消。');
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

    return rows.map((row) => backgroundTaskFromRow(row));
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

  createTaskRun(input: {
    userInput: string;
    modelId: string;
    enabledCapabilities: EnabledCapabilities;
    threadId?: string;
  }): TaskRun {
    const now = new Date().toISOString();
    const runId = `run_${randomUUID()}`;
    const eventId = `event_${randomUUID()}`;
    const enabledCapabilitiesJson = JSON.stringify(input.enabledCapabilities);
    const existingThreadId =
      input.threadId === undefined
        ? null
        : requireText(
            input.threadId,
            'task_thread_id_empty',
            '任务会话 ID 不能为空。',
            '请选择一个有效的会话后再继续发送。'
          );
    const threadId = existingThreadId ?? `thread_${randomUUID()}`;
    const runNumber = existingThreadId === null ? 1 : nextRunNumber(this.database, threadId);

    const transaction = this.database.db.transaction(() => {
      if (existingThreadId === null) {
        const title = input.userInput.trim().slice(0, 60);
        this.database.db
          .prepare(
            `INSERT INTO task_threads (id, title, goal, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(threadId, title, input.userInput, 'waiting_next_turn', now, now);
      } else {
        requireActiveThread(this.database, threadId);
        this.database.db
          .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
          .run('waiting_next_turn', now, threadId);
      }

      this.database.db
        .prepare(
          `INSERT INTO task_runs
           (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(runId, threadId, runNumber, input.userInput, 'waiting_next_turn', now, null, input.modelId, enabledCapabilitiesJson);

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
    });
    transaction();

    return {
      id: runId,
      threadId,
      runNumber,
      userInput: input.userInput,
      status: 'waiting_next_turn',
      startedAt: now,
      endedAt: null,
      modelId: input.modelId,
      enabledCapabilities: input.enabledCapabilities
    };
  }

  archiveThread(threadId: string): { deleted: true; threadId: string } {
    const normalizedThreadId = requireText(
      threadId,
      'task_thread_id_empty',
      '任务会话 ID 不能为空。',
      '请选择一个要删除的历史会话。'
    );
    requireActiveThread(this.database, normalizedThreadId);
    const now = new Date().toISOString();

    this.database.db
      .prepare('UPDATE task_threads SET status = ?, updated_at = ?, archived_at = ? WHERE id = ?')
      .run('archived', now, now, normalizedThreadId);

    return {
      deleted: true,
      threadId: normalizedThreadId
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

  listThreadMessages(threadId: string): TaskEvent[] {
    const normalizedThreadId = requireText(
      threadId,
      'task_thread_id_empty',
      '任务会话 ID 不能为空。',
      '请选择一个有效的会话后再继续查看消息。'
    );
    requireActiveThread(this.database, normalizedThreadId);

    const rows = this.database.db
      .prepare(
        `SELECT id, thread_id, run_id, type, payload_json, created_at
         FROM task_events
         WHERE thread_id = ? AND type = 'message'
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(normalizedThreadId) as Array<{
      id: string;
      thread_id: string;
      run_id: string;
      type: TaskEvent['type'];
      payload_json: string;
      created_at: string;
    }>;

    return rows.map((event) => ({
      id: event.id,
      threadId: event.thread_id,
      runId: event.run_id,
      type: event.type,
      payload: JSON.parse(event.payload_json) as unknown,
      createdAt: event.created_at
    }));
  }

  recordEvent(input: { threadId: string; runId: string; type: TaskEvent['type']; payload: unknown }): TaskEvent {
    return this.recordEvents([input])[0]!;
  }

  recordEvents(inputs: Array<{ threadId: string; runId: string; type: TaskEvent['type']; payload: unknown }>): TaskEvent[] {
    if (inputs.length === 0) {
      return [];
    }
    const now = new Date().toISOString();
    const insert = this.database.db.prepare(
      `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const events: TaskEvent[] = [];

    this.database.db.transaction(() => {
      for (const input of inputs) {
        const event: TaskEvent = {
          id: `event_${randomUUID()}`,
          threadId: input.threadId,
          runId: input.runId,
          type: input.type,
          payload: input.payload,
          createdAt: now
        };
        insert.run(event.id, event.threadId, event.runId, event.type, JSON.stringify(event.payload), event.createdAt);
        events.push(event);
      }
    })();

    return events;
  }

  markRunRunning(runId: string): void {
    const run = this.getRun(runId);
    const now = new Date().toISOString();
    const transaction = this.database.db.transaction(() => {
      this.database.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('running', now, run.threadId);
      this.database.db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('running', run.id);
      this.recordEvent({
        threadId: run.threadId,
        runId: run.id,
        type: 'agent_update',
        payload: {
          status: 'running'
        }
      });
    });
    transaction();
  }

  markRunWaitingUser(runId: string): void {
    const run = this.getRun(runId);
    const now = new Date().toISOString();
    const transaction = this.database.db.transaction(() => {
      this.database.db
        .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
        .run('waiting_user', now, run.threadId);
      this.database.db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('waiting_user', run.id);
      this.recordEvent({
        threadId: run.threadId,
        runId: run.id,
        type: 'agent_update',
        payload: {
          status: 'waiting_user'
        }
      });
    });
    transaction();
  }

  markRunResumed(runId: string): void {
    const run = this.getRun(runId);
    const now = new Date().toISOString();
    const transaction = this.database.db.transaction(() => {
      this.database.db
        .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
        .run('running', now, run.threadId);
      this.database.db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('running', run.id);
      this.recordEvent({
        threadId: run.threadId,
        runId: run.id,
        type: 'agent_update',
        payload: {
          status: 'running',
          resumed: true
        }
      });
    });
    transaction();
  }

  recordApprovalRequested(input: { runId: string; payload: unknown }): TaskEvent {
    const run = this.getRun(input.runId);
    return this.recordEvent({
      threadId: run.threadId,
      runId: run.id,
      type: 'approval_requested',
      payload: input.payload
    });
  }

  recordApprovalDecision(input: { runId: string; payload: unknown }): TaskEvent {
    const run = this.getRun(input.runId);
    return this.recordEvent({
      threadId: run.threadId,
      runId: run.id,
      type: 'approval_decision',
      payload: input.payload
    });
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
         WHERE thread_id IN (SELECT id FROM task_threads WHERE archived_at IS NULL)
         ORDER BY created_at DESC, rowid DESC
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
}
