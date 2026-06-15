import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  ActiveTaskItem,
  AgentCapabilityManifest,
  AgentCapabilityPreview,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  BackgroundTaskSummary,
  BackgroundTaskTrigger,
  ChatStartRunRequest,
  EnabledCapabilities,
  ScheduledTaskRun,
  TaskDeleteThreadResult,
  TaskDetail,
  TaskEvent,
  TaskRun,
  TaskSnapshot,
  TaskStatus,
  TaskThread,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';
import { RocDomainError } from '../../services/errors';

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

type TaskRunRow = {
  id: string;
  thread_id: string;
  run_number: number;
  user_input: string;
  status: TaskRun['status'];
  started_at: string;
  ended_at: string | null;
  model_id: string | null;
  enabled_capabilities_json: string;
};

const taskDetailRunHistoryLimit = 20;
const taskDetailRecentEventLimit = 20;

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

  findBackgroundTaskByRunId(runId: string): BackgroundTask | null {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_description, next_run_at, workspace_path,
                trigger_type, cron_expression,
                allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
                requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
                enabled_capabilities_json
         FROM background_tasks
         WHERE run_id = ?`
      )
      .get(runId) as BackgroundTaskRow | undefined;
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

  archiveThread(threadId: string): TaskDeleteThreadResult {
    const thread = this.requireActiveThread(threadId);
    const now = new Date().toISOString();
    this.db
      .transaction(() => {
        this.db.prepare('UPDATE background_tasks SET status = ?, updated_at = ? WHERE thread_id = ?').run('archived', now, thread.id);
        this.db.prepare('UPDATE task_threads SET status = ?, updated_at = ?, archived_at = ? WHERE id = ?').run('archived', now, now, thread.id);
      })();
    return {
      deleted: true,
      threadId: thread.id
    };
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
      .run(input.runId, input.firedAt, null, input.nextRunAt, input.firedAt, task.id);
    return this.requireBackgroundTask(task.id);
  }

  recordAgentRunStarted(input: {
    runId: string;
    threadId: string;
    userInput: string;
    providerId: string;
    modelId: string;
    enabledCapabilities: EnabledCapabilities;
    capabilityPreview?: AgentCapabilityPreview;
    createdAt: string;
  }): TaskRun {
    const existingRun = this.findRun(input.runId);
    if (existingRun !== null) {
      return existingRun;
    }

    const existingThread = this.findActiveThread(input.threadId);
    const runNumber = existingThread === null ? 1 : this.nextRunNumber(input.threadId);
    const title = input.userInput.trim().slice(0, 60);
    const enabledCapabilitiesJson = JSON.stringify(input.enabledCapabilities);
    this.db
      .transaction(() => {
        if (existingThread === null) {
          this.db
            .prepare(
              `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(input.threadId, 'chat', title, input.userInput, 'running', input.createdAt, input.createdAt);
        } else {
          this.db
            .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
            .run('running', input.createdAt, input.threadId);
        }

        this.db
          .prepare(
            `INSERT INTO task_runs
             (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(input.runId, input.threadId, runNumber, input.userInput, 'running', input.createdAt, null, input.modelId, enabledCapabilitiesJson);
        this.insertTaskEvent({
          threadId: input.threadId,
          runId: input.runId,
          type: 'message',
          payload: {
            role: 'user',
            content: input.userInput,
            enabledCapabilities: input.enabledCapabilities
          },
          createdAt: input.createdAt
        });
        this.insertTaskEvent({
          threadId: input.threadId,
          runId: input.runId,
          type: 'context_manifest',
          payload:
            input.capabilityPreview === undefined
              ? createFallbackCapabilityManifest(input.enabledCapabilities)
              : createAgentCapabilityManifest(input.capabilityPreview),
          createdAt: input.createdAt
        });
        this.insertTaskEvent({
          threadId: input.threadId,
          runId: input.runId,
          type: 'agent_update',
          payload: {
            status: 'running'
          },
          createdAt: input.createdAt
        });
      })();
    return this.requireRun(input.runId);
  }

  getBackgroundTaskSummary(): BackgroundTaskSummary {
    const rows = this.db
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

  private listActiveBackgroundTasks(): BackgroundTask[] {
    const rows = this.db
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
      .all() as BackgroundTaskRow[];
    return rows.map(mapBackgroundTask);
  }

  getActiveTasks(): ActiveTaskItem[] {
    return this.listActiveBackgroundTasks()
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

  getTaskDetail(input: { taskId: string; schedulerRegistered: boolean }): TaskDetail {
    const task = this.requireBackgroundTask(input.taskId);
    const thread = this.requireActiveThread(task.threadId);
    const runHistory = this.listRunsForThread(task.threadId, taskDetailRunHistoryLimit);
    const lastRunId = runHistory[0]?.id ?? null;
    const recentEvents = mergeTaskEvents([
      this.listRecentEventsForThread(task.threadId, taskDetailRecentEventLimit),
      lastRunId === null ? [] : this.listEventsForRun(task.threadId, lastRunId)
    ]);
    return {
      threadId: task.threadId,
      taskId: task.id,
      thread,
      backgroundTask: task,
      lastRunId,
      runHistory,
      recentEvents,
      schedulerRegistered: input.schedulerRegistered
    };
  }

  listScheduledRuns(input: { taskId: string; limit?: number }): ScheduledTaskRun[] {
    const task = this.requireBackgroundTask(input.taskId);
    const limit = input.limit === undefined ? 20 : input.limit;
    const rows = this.db
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

  listThreadMessages(threadId: string): TaskEvent[] {
    this.requireActiveThread(threadId);
    return this.listEventsForThread(threadId);
  }

  openBackgroundTaskInChat(taskId: string): { threadId: string } {
    const task = this.requireBackgroundTask(taskId);
    this.insertTaskEvent({
      threadId: task.threadId,
      runId: task.runId,
      type: 'message',
      payload: {
        role: 'system',
        content: `[系统] 用户准备修改后台任务 ${task.id}。`
      },
      createdAt: new Date().toISOString()
    });
    return {
      threadId: task.threadId
    };
  }

  recordAgentRunCompleted(input: {
    runId: string;
    threadId: string;
    assistantMessage: string;
    providerId: string;
    modelId: string;
    durationMs: number;
    summary: string;
    finishReason: string;
  }): TaskEvent | null {
    const run = this.findRun(input.runId);
    if (run !== null && run.status === 'completed') {
      return null;
    }
    let mirroredAssistantEvent: TaskEvent | null = null;
    if (run !== null) {
      const now = new Date().toISOString();
      this.db
        .transaction(() => {
          this.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('completed', now, run.threadId);
          this.db.prepare('UPDATE task_runs SET status = ?, ended_at = ? WHERE id = ?').run('completed', now, input.runId);
          this.insertTaskEvent({
            threadId: run.threadId,
            runId: input.runId,
            type: 'agent_update',
            payload: {
              providerId: input.providerId,
              modelId: input.modelId,
              durationMs: input.durationMs,
              finishReason: input.finishReason,
              summary: input.summary
            },
            createdAt: now
          });
          mirroredAssistantEvent = this.insertTaskEvent({
            threadId: run.threadId,
            runId: input.runId,
            type: 'message',
            payload: {
              role: 'assistant',
              content: input.assistantMessage,
              providerId: input.providerId,
              modelId: input.modelId
            },
            createdAt: now
          });
        })();
    }

    const task = this.findBackgroundTaskByRunId(input.runId);
    if (task !== null) {
      this.updateBackgroundTaskLastRunStatus(task.id, 'success');
    }
    if (task !== null && (run === null || task.threadId !== run.threadId)) {
      return this.insertTaskEvent({
        threadId: task.threadId,
        runId: input.runId,
        type: 'message',
        payload: {
          role: 'assistant',
          content: input.assistantMessage,
          providerId: input.providerId,
          modelId: input.modelId
        },
        createdAt: new Date().toISOString()
      });
    }
    return mirroredAssistantEvent;
  }

  recordAgentRunFailed(input: {
    runId: string;
    threadId: string;
    providerId: string;
    modelId: string;
    error: string;
    code: string;
    retryable: boolean;
  }): TaskEvent | null {
    const run = this.findRun(input.runId);
    if (run !== null && run.status === 'failed') {
      return null;
    }
    let failureEvent: TaskEvent | null = null;
    const now = new Date().toISOString();
    if (run !== null) {
      this.db
        .transaction(() => {
          this.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, run.threadId);
          this.db.prepare('UPDATE task_runs SET status = ?, ended_at = ? WHERE id = ?').run('failed', now, input.runId);
          failureEvent = this.insertTaskEvent({
            threadId: run.threadId,
            runId: input.runId,
            type: 'agent_update',
            payload: {
              status: 'failed',
              providerId: input.providerId,
              modelId: input.modelId,
              code: input.code,
              error: input.error,
              retryable: input.retryable
            },
            createdAt: now
          });
        })();
    }

    const task = this.findBackgroundTaskByRunId(input.runId);
    if (task !== null) {
      this.pauseBackgroundTaskAfterRunFailure(task.id, now);
    }
    if (task !== null && (run === null || task.threadId !== run.threadId)) {
      return this.insertTaskEvent({
        threadId: task.threadId,
        runId: input.runId,
        type: 'agent_update',
        payload: {
          status: 'failed',
          providerId: input.providerId,
          modelId: input.modelId,
          code: input.code,
          error: input.error,
          retryable: input.retryable
        },
        createdAt: now
      });
    }
    return failureEvent;
  }

  recordAgentTaskEvent(input: {
    runId: string;
    threadId: string;
    type: TaskEvent['type'];
    payload: Record<string, unknown>;
    createdAt: string;
  }): TaskEvent | null {
    const run = this.findRun(input.runId);
    if (run === null || run.threadId !== input.threadId) {
      return null;
    }
    if (input.type === 'approval_requested') {
      let approvalEvent: TaskEvent | null = null;
      this.db.transaction(() => {
        this.db
          .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
          .run('waiting_user', input.createdAt, input.threadId);
        this.db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('waiting_user', input.runId);
        this.insertTaskEvent({
          threadId: input.threadId,
          runId: input.runId,
          type: 'agent_update',
          payload: {
            status: 'waiting_user'
          },
          createdAt: input.createdAt
        });
        approvalEvent = this.insertTaskEvent({
          threadId: input.threadId,
          runId: input.runId,
          type: input.type,
          payload: input.payload,
          createdAt: input.createdAt
        });
      })();
      return approvalEvent;
    }
    if (input.type === 'approval_decision') {
      let decisionEvent: TaskEvent | null = null;
      this.db.transaction(() => {
        this.db
          .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
          .run('running', input.createdAt, input.threadId);
        this.db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('running', input.runId);
        this.insertTaskEvent({
          threadId: input.threadId,
          runId: input.runId,
          type: 'agent_update',
          payload: {
            status: 'running',
            resumed: true
          },
          createdAt: input.createdAt
        });
        decisionEvent = this.insertTaskEvent({
          threadId: input.threadId,
          runId: input.runId,
          type: input.type,
          payload: input.payload,
          createdAt: input.createdAt
        });
      })();
      return decisionEvent;
    }
    return this.insertTaskEvent({
      threadId: input.threadId,
      runId: input.runId,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt
    });
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

  private requireActiveThread(threadId: string): TaskThread {
    const thread = this.findActiveThread(threadId);
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

  private findActiveThread(threadId: string): TaskThread | null {
    const row = this.db
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

  private requireRun(runId: string): TaskRun {
    const run = this.findRun(runId);
    if (run === null) {
      throw new Error('task_run_not_found');
    }
    return run;
  }

  private findRun(runId: string): TaskRun | null {
    const row = this.db
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

  private nextRunNumber(threadId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(run_number), 0) + 1 AS next_run_number FROM task_runs WHERE thread_id = ?')
      .get(threadId) as { next_run_number: number };
    return row.next_run_number;
  }

  private listRunsForThread(threadId: string, limit: number): TaskRun[] {
    const rows = this.db
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

  private listRecentEventsForThread(threadId: string, limit: number): TaskEvent[] {
    const rows = this.db
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

  private listEventsForThread(threadId: string): TaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT rowid, id, thread_id, run_id, type, payload_json, created_at
         FROM task_events
         WHERE thread_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(threadId) as Array<TaskEventRow & { rowid: number }>;
    return rows.map(mapTaskEvent);
  }

  private listEventsForRun(threadId: string, runId: string): TaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT rowid, id, thread_id, run_id, type, payload_json, created_at
         FROM task_events
         WHERE thread_id = ? AND run_id = ?
         ORDER BY created_at DESC, rowid DESC`
      )
      .all(threadId, runId) as Array<TaskEventRow & { rowid: number }>;
    return rows.map(mapTaskEvent);
  }

  private updateBackgroundTaskLastRunStatus(taskId: string, status: Exclude<BackgroundTask['lastRunStatus'], null>): void {
    this.db.prepare('UPDATE background_tasks SET last_run_status = ?, updated_at = ? WHERE id = ?').run(
      status,
      new Date().toISOString(),
      taskId
    );
  }

  private pauseBackgroundTaskAfterRunFailure(taskId: string, now: string): void {
    const task = this.requireBackgroundTask(taskId);
    this.db
      .transaction(() => {
        this.db
          .prepare('UPDATE background_tasks SET status = ?, last_run_status = ?, updated_at = ? WHERE id = ?')
          .run('paused', 'failed', now, task.id);
        this.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('paused', now, task.threadId);
        this.insertTaskEvent({
          threadId: task.threadId,
          runId: task.runId,
          type: 'background_task_paused',
          payload: {
            taskId: task.id,
            status: 'paused'
          },
          createdAt: now
        });
      })();
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
    return rows.map(mapTaskThread);
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
    return rows.map(mapTaskEvent);
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

function mapScheduledTaskRun(row: ScheduledTaskRunRow): ScheduledTaskRun {
  return {
    id: row.id,
    backgroundTaskId: row.background_task_id,
    taskRunId: row.task_run_id,
    scheduledAt: row.scheduled_at,
    triggeredAt: row.triggered_at,
    status: row.status,
    skipReason: row.skip_reason
  };
}

function mapTaskEvent(row: TaskEventRow & { rowid?: number }): TaskEvent {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
    sequence: row.rowid
  };
}

function mapTaskRun(row: TaskRunRow): TaskRun {
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

function mapTaskThread(row: TaskThreadRow): TaskThread {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    goal: row.goal,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mergeTaskEvents(eventGroups: readonly TaskEvent[][]): TaskEvent[] {
  const eventsById = new Map<string, TaskEvent>();
  for (const events of eventGroups) {
    for (const event of events) {
      if (!eventsById.has(event.id)) {
        eventsById.set(event.id, event);
      }
    }
  }
  return [...eventsById.values()].sort(compareTaskEventsDescending);
}

function createFallbackCapabilityManifest(enabledCapabilities: EnabledCapabilities): AgentCapabilityManifest {
  return {
    requestedCapabilities: enabledCapabilities,
    resolvedCapabilities: enabledCapabilities,
    skippedCapabilities: [],
    toolCards: [],
    untrustedContextPolicy: 'external_content_reference_only'
  };
}

function createAgentCapabilityManifest(preview: AgentCapabilityPreview): AgentCapabilityManifest {
  return {
    requestedCapabilities: preview.requestedCapabilities,
    resolvedCapabilities: preview.selectedCapabilities,
    skippedCapabilities: preview.skippedCapabilities,
    toolCards: [...preview.toolCards, ...preview.skillCards].map((card) => ({
      id: card.id,
      name: card.name,
      capabilityType: card.capabilityType,
      riskLevel: card.riskLevel,
      scope: card.scope,
      requiresApproval: card.requiresApproval
    })),
    untrustedContextPolicy: preview.untrustedContextPolicy
  };
}

function compareTaskEventsDescending(left: TaskEvent, right: TaskEvent): number {
  const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }
  return (right.sequence === undefined ? 0 : right.sequence) - (left.sequence === undefined ? 0 : left.sequence);
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
