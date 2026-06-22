import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  ActiveTaskItem,
  AgentCapabilityPreview,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  BackgroundTaskSummary,
  ChatStartRunRequest,
  EnabledCapabilities,
  ScheduledTaskRun,
  TaskDeleteThreadResult,
  TaskDetail,
  TaskEvent,
  TaskKind,
  TaskRun,
  TaskSnapshot,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';
import {
  recordAgentRunCompleted as recordAgentRunCompletedEvent,
  recordAgentRunFailed as recordAgentRunFailedEvent,
  recordAgentTaskEvent as recordAgentTaskRunEvent
} from './task-repository-events';
import {
  inferBackgroundRisk,
  mergeTaskEvents,
  normalizeTrigger,
  requireText
} from './task-repository-mappers';
import {
  recordAgentRunStarted as createAgentRun,
  createBackgroundTaskRecord,
  createPreviewRequestFromTask,
  recordScheduledTaskRun as insertScheduledTaskRun,
  pauseBackgroundTaskAfterRunFailure,
  transitionBackgroundTask,
  updateBackgroundTaskLastRunStatus,
  updateBackgroundTaskRecord
} from './task-repository-mutations';
import {
  listEventsForRun,
  listEventsForThread,
  listRecentEventsForThread,
  listRunsForThread,
  getActiveTasks as readActiveTasks,
  findBackgroundTask as readBackgroundTask,
  findBackgroundTaskByRunId as readBackgroundTaskByRunId,
  listBackgroundTasks as readBackgroundTasks,
  getBackgroundTaskSummary as readBackgroundTaskSummary,
  readRecentEvents,
  listSchedulableBackgroundTasks as readSchedulableBackgroundTasks,
  listScheduledRuns as readScheduledRuns,
  readThreads,
  requireActiveThread
} from './task-repository-queries';

const taskDetailRunHistoryLimit = 20;
const taskDetailRecentEventLimit = 20;

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
    return createBackgroundTaskRecord(this.db, preview);
  }

  updateBackgroundTask(request: UpdateBackgroundTaskRequest): BackgroundTask {
    const task = this.requireBackgroundTask(request.taskId);
    const previewRequest = createPreviewRequestFromTask(task, request.patch);
    const preview = this.createBackgroundTaskPreview(previewRequest);
    return updateBackgroundTaskRecord({
      db: this.db,
      task,
      preview,
      reason: request.reason
    });
  }

  findBackgroundTask(id: string): BackgroundTask | null {
    return readBackgroundTask(this.db, id);
  }

  findBackgroundTaskByRunId(runId: string): BackgroundTask | null {
    return readBackgroundTaskByRunId(this.db, runId);
  }

  listBackgroundTasks(): BackgroundTask[] {
    return readBackgroundTasks(this.db);
  }

  archiveThread(threadId: string): TaskDeleteThreadResult {
    const thread = requireActiveThread(this.db, threadId);
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
    return readSchedulableBackgroundTasks(this.db);
  }

  pauseBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status !== 'running' && task.status !== 'pending_confirmation') {
      throw new Error('background_task_invalid_transition');
    }
    return transitionBackgroundTask(this.db, task, 'paused', 'background_task_paused');
  }

  resumeBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status !== 'paused') {
      throw new Error('background_task_invalid_transition');
    }
    return transitionBackgroundTask(this.db, task, 'running', 'background_task_resumed');
  }

  cancelBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'archived') {
      throw new Error('background_task_invalid_transition');
    }
    return transitionBackgroundTask(this.db, task, 'cancelled', 'background_task_cancelled');
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
    return insertScheduledTaskRun(this.db, input);
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
    threadKind: TaskKind;
    capabilityPreview?: AgentCapabilityPreview;
    createdAt: string;
  }): TaskRun {
    return createAgentRun(this.db, input);
  }

  getBackgroundTaskSummary(): BackgroundTaskSummary {
    return readBackgroundTaskSummary(this.db);
  }

  getSnapshot(): TaskSnapshot {
    const tasks = this.listBackgroundTasks().filter((task) => task.status !== 'archived');
    const threads = readThreads(this.db);
    const recentEvents = readRecentEvents(this.db);
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
    return readActiveTasks(this.db);
  }

  getTaskDetail(input: { taskId: string; schedulerRegistered: boolean }): TaskDetail {
    const task = this.requireBackgroundTask(input.taskId);
    const thread = requireActiveThread(this.db, task.threadId);
    const runHistory = listRunsForThread(this.db, task.threadId, taskDetailRunHistoryLimit);
    const lastRunId = runHistory[0]?.id ?? null;
    const recentEvents = mergeTaskEvents([
      listRecentEventsForThread(this.db, task.threadId, taskDetailRecentEventLimit),
      lastRunId === null ? [] : listEventsForRun(this.db, task.threadId, lastRunId)
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
    return readScheduledRuns(this.db, task, limit);
  }

  listThreadMessages(threadId: string): TaskEvent[] {
    requireActiveThread(this.db, threadId);
    return listEventsForThread(this.db, threadId);
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
    return recordAgentRunCompletedEvent(
      this.db,
      input,
      this.findBackgroundTaskByRunId(input.runId),
      (taskId, status) => this.updateBackgroundTaskLastRunStatus(taskId, status)
    );
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
    return recordAgentRunFailedEvent(
      this.db,
      input,
      this.findBackgroundTaskByRunId(input.runId),
      (taskId, now) => this.pauseBackgroundTaskAfterRunFailure(taskId, now)
    );
  }
  recordAgentTaskEvent(input: {
    runId: string;
    threadId: string;
    type: TaskEvent['type'];
    payload: Record<string, unknown>;
    createdAt: string;
  }): TaskEvent | null {
    return recordAgentTaskRunEvent(this.db, input);
  }
  private requireBackgroundTask(id: string): BackgroundTask {
    const task = this.findBackgroundTask(id);
    if (task === null) {
      throw new Error('background_task_not_found');
    }
    return task;
  }

  private updateBackgroundTaskLastRunStatus(taskId: string, status: Exclude<BackgroundTask['lastRunStatus'], null>): void {
    updateBackgroundTaskLastRunStatus(this.db, taskId, status);
  }

  private pauseBackgroundTaskAfterRunFailure(taskId: string, now: string): void {
    pauseBackgroundTaskAfterRunFailure(this.db, taskId, now);
  }

}
