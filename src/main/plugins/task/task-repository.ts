import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  ActiveTaskItem,
  AgentCapabilityPreview,
  AgentOutboxEvent,
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
  TaskMessageHistoryPage,
  TaskMessageHistoryRequest,
  TaskRun,
  TaskSnapshot,
  TaskThread,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';
import { deleteTaskProjectionForThread } from '../../infrastructure/agent-history-deletion';
import { RocDomainError } from '../../services/errors';
import { AgentTaskHistoryReader } from './agent-task-history';
import {
  inferBackgroundRisk,
  mergeTaskEvents,
  normalizeTrigger,
  requireText
} from './task-repository-mappers';
import {
  createBackgroundTaskRecord,
  createPreviewRequestFromTask,
  recordScheduledTaskRun as insertScheduledTaskRun,
  pauseBackgroundTaskAfterRunFailure,
  transitionBackgroundTask,
  updateBackgroundTaskLastRunStatus,
  updateBackgroundTaskRecord
} from './task-repository-mutations';
import {
  getActiveTasks as readActiveTasks,
  findBackgroundTask as readBackgroundTask,
  findBackgroundTaskByRunId as readBackgroundTaskByRunId,
  listBackgroundTasks as readBackgroundTasks,
  listSchedulableBackgroundTasks as readSchedulableBackgroundTasks,
  listScheduledRuns as readScheduledRuns,
} from './task-repository-queries';
import { ThreadDeletionJournal, type ThreadDeletionRecord } from './thread-deletion-journal';

const taskDetailRunHistoryLimit = 20;
const taskDetailRecentEventLimit = 20;

export class TaskRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly agentHistory: AgentTaskHistoryReader,
    private readonly deletionJournal: ThreadDeletionJournal = new ThreadDeletionJournal(db)
  ) {}

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

  createBackgroundTask(request: BackgroundTaskPreviewRequest): BackgroundTask {
    const preview = this.createBackgroundTaskPreview(request);
    const task = createBackgroundTaskRecord(this.db, preview);
    this.agentHistory.ensureBackgroundTaskThread(task);
    this.agentHistory.recordBackgroundTaskEvent(task, 'background_task_created', {
      taskId: task.id,
      goal: task.goal,
      status: task.status
    });
    return task;
  }

  updateBackgroundTask(request: UpdateBackgroundTaskRequest): BackgroundTask {
    const task = this.requireBackgroundTask(request.taskId);
    const previewRequest = createPreviewRequestFromTask(task, request.patch);
    const preview = this.createBackgroundTaskPreview(previewRequest);
    const updatedTask = updateBackgroundTaskRecord({
      db: this.db,
      task,
      preview,
      reason: request.reason
    });
    this.agentHistory.updateBackgroundTaskThread(updatedTask);
    return updatedTask;
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

  deleteThread(threadId: string): TaskDeleteThreadResult {
    const existing = this.deletionJournal.find(threadId);
    if (existing !== null && existing.state === 'complete') {
      return {
        deleted: true,
        threadId
      };
    }
    if (existing === null) {
      this.agentHistory.requireActiveThread(threadId);
      this.deletionJournal.ensurePending(threadId);
    }

    let record = this.deletionJournal.require(threadId);
    if (record.state === 'pending') {
      try {
        this.agentHistory.deleteThread(threadId);
        this.deletionJournal.markAgentDeleted(threadId);
      } catch (error) {
        this.deletionJournal.recordFailure(threadId, error);
        throw error;
      }
      record = this.deletionJournal.require(threadId);
    }

    if (record.state === 'agent_deleted') {
      try {
        this.db.transaction(() => {
          deleteTaskProjectionForThread(this.db, threadId);
          this.deletionJournal.markCompleteInCurrentTransaction(threadId);
        })();
      } catch (error) {
        this.deletionJournal.recordFailure(threadId, error);
        throw error;
      }
    }

    if (this.deletionJournal.require(threadId).state !== 'complete') {
      throw new Error('thread_deletion_state_incomplete');
    }
    return {
      deleted: true,
      threadId
    };
  }

  listIncompleteThreadDeletions(): ThreadDeletionRecord[] {
    return this.deletionJournal.listIncomplete();
  }

  listSchedulableBackgroundTasks(): BackgroundTask[] {
    return readSchedulableBackgroundTasks(this.db).filter((task) => this.hasActiveThread(task.threadId));
  }

  pauseBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status !== 'running' && task.status !== 'pending_confirmation') {
      throw new Error('background_task_invalid_transition');
    }
    const updatedTask = transitionBackgroundTask(this.db, task, 'paused');
    this.agentHistory.updateBackgroundTaskThread(updatedTask);
    this.agentHistory.recordBackgroundTaskEvent(updatedTask, 'background_task_paused', {
      taskId: updatedTask.id,
      status: updatedTask.status
    });
    return updatedTask;
  }

  resumeBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status !== 'paused') {
      throw new Error('background_task_invalid_transition');
    }
    const updatedTask = transitionBackgroundTask(this.db, task, 'running');
    this.agentHistory.updateBackgroundTaskThread(updatedTask);
    this.agentHistory.recordBackgroundTaskEvent(updatedTask, 'background_task_resumed', {
      taskId: updatedTask.id,
      status: updatedTask.status
    });
    return updatedTask;
  }

  cancelBackgroundTask(id: string): BackgroundTask {
    const task = this.requireBackgroundTask(id);
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'archived') {
      throw new Error('background_task_invalid_transition');
    }
    const updatedTask = transitionBackgroundTask(this.db, task, 'cancelled');
    this.agentHistory.updateBackgroundTaskThread(updatedTask);
    this.agentHistory.recordBackgroundTaskEvent(updatedTask, 'background_task_cancelled', {
      taskId: updatedTask.id,
      status: updatedTask.status
    });
    return updatedTask;
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
        this.agentHistory.archiveThread(task.threadId, now);
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

  recordBackgroundTaskStartFailure(input: {
    taskId: string;
    scheduledAt: string;
    failedAt: string;
    reason: string;
  }): BackgroundTask {
    const task = this.requireBackgroundTask(input.taskId);
    this.db.transaction(() => {
      insertScheduledTaskRun(this.db, {
        backgroundTaskId: task.id,
        scheduledAt: input.scheduledAt,
        status: 'failed',
        taskRunId: null,
        triggeredAt: input.failedAt,
        skipReason: input.reason
      });
      pauseBackgroundTaskAfterRunFailure(this.db, task.id, input.failedAt);
    })();
    const updatedTask = this.requireBackgroundTask(task.id);
    this.agentHistory.updateBackgroundTaskThread(updatedTask);
    this.agentHistory.recordBackgroundTaskEvent(updatedTask, 'background_task_paused', {
      taskId: updatedTask.id,
      status: updatedTask.status
    });
    return updatedTask;
  }

  countRecentSkippedScheduledRuns(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total
         FROM scheduled_task_runs runs
         INNER JOIN background_tasks task ON task.id = runs.background_task_id
         WHERE runs.status = 'skipped'
           AND NOT EXISTS (
             SELECT 1
             FROM thread_deletion_journal deletion
             WHERE deletion.thread_id = task.thread_id
           )`
      )
      .get() as
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
    const updatedTask = this.requireBackgroundTask(task.id);
    this.agentHistory.updateBackgroundTaskThread(updatedTask);
    return updatedTask;
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
    const run = this.agentHistory.findRun(input.runId);
    if (run !== null) {
      return run;
    }
    return {
      id: input.runId,
      threadId: input.threadId,
      runNumber: 1,
      userInput: input.userInput,
      status: 'running',
      startedAt: input.createdAt,
      endedAt: null,
      modelId: input.modelId,
      enabledCapabilities: input.enabledCapabilities
    };
  }

  getBackgroundTaskSummary(): BackgroundTaskSummary {
    const tasks = this.listVisibleBackgroundTasks();
    const futureRuns = tasks
      .map((task) => task.nextRunAt)
      .filter((value): value is string => value !== null)
      .sort();
    return {
      total: tasks.length,
      running: tasks.filter((task) => task.status === 'running').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      pendingConfirmation: tasks.filter((task) => task.status === 'pending_confirmation').length,
      nextRunAt: futureRuns.length === 0 ? null : futureRuns[0]
    };
  }

  getSnapshot(): TaskSnapshot {
    const tasks = this.listVisibleBackgroundTasks();
    const hiddenThreadIds = this.deletionJournal.listHiddenThreadIds();
    const threads = this.agentHistory.readThreads().filter((thread) => !hiddenThreadIds.has(thread.id));
    const recentEvents = this.agentHistory.readRecentEvents().filter((event) => !hiddenThreadIds.has(event.threadId));
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
    return readActiveTasks(this.db).filter((task) => this.hasActiveThread(task.threadId));
  }

  getTaskDetail(input: { taskId: string; schedulerRegistered: boolean }): TaskDetail {
    const task = this.requireBackgroundTask(input.taskId);
    const thread = this.requireVisibleThread(task.threadId);
    const runHistory = this.agentHistory.listRunsForThread(task.threadId, taskDetailRunHistoryLimit);
    const firstRun = runHistory[0];
    const lastRunId = firstRun === undefined ? null : firstRun.id;
    const recentEvents = mergeTaskEvents([
      this.agentHistory.listRecentEventsForThread(task.threadId, taskDetailRecentEventLimit),
      lastRunId === null ? [] : this.agentHistory.listEventsForRun(task.threadId, lastRunId)
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
    if (limit <= 0) {
      throw new Error('scheduled_runs_limit_invalid');
    }
    return readScheduledRuns(this.db, task, limit);
  }

  listThreadMessages(request: TaskMessageHistoryRequest): TaskMessageHistoryPage {
    this.requireVisibleThread(request.threadId);
    return this.agentHistory.listEventPage(request);
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
    const task = this.findBackgroundTaskByRunId(input.runId);
    if (task !== null) {
      this.updateBackgroundTaskLastRunStatus(task.id, 'success');
    }
    return null;
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
    const task = this.findBackgroundTaskByRunId(input.runId);
    if (task !== null) {
      this.pauseBackgroundTaskAfterRunFailure(task.id, new Date().toISOString());
      const updatedTask = this.requireBackgroundTask(task.id);
      this.agentHistory.updateBackgroundTaskThread(updatedTask);
      this.agentHistory.recordBackgroundTaskEvent(updatedTask, 'background_task_paused', {
        taskId: updatedTask.id,
        status: updatedTask.status
      });
    }
    return null;
  }
  projectAgentOutboxEvents(input: {
    events: readonly AgentOutboxEvent[];
    projectorName: string;
  }): { appliedCount: number; lastSequence: number } {
    const projectorName = input.projectorName.trim();
    if (projectorName.length === 0) {
      throw new Error('task_agent_outbox_projector_name_empty');
    }
    return this.db.transaction(() => {
      const cursorRow = this.db
        .prepare('SELECT last_sequence FROM task_agent_outbox_cursors WHERE projector_name = ?')
        .get(projectorName) as { last_sequence: number } | undefined;
      let lastSequence = cursorRow === undefined ? 0 : cursorRow.last_sequence;
      let appliedCount = 0;
      let updatedAt: string | null = null;
      for (const event of input.events) {
        if (event.sequence <= lastSequence) {
          continue;
        }
        if (event.sequence !== lastSequence + 1) {
          throw new Error('task_agent_outbox_sequence_gap');
        }
        const task = this.findBackgroundTaskByRunId(event.runId);
        if (task !== null) {
          if (event.eventType === 'run_completed') {
            this.db
              .prepare('UPDATE background_tasks SET last_run_status = ?, updated_at = ? WHERE id = ?')
              .run('success', event.createdAt, task.id);
          } else if (event.eventType === 'run_failed') {
            this.db
              .prepare('UPDATE background_tasks SET status = ?, last_run_status = ?, updated_at = ? WHERE id = ?')
              .run('paused', 'failed', event.createdAt, task.id);
            const updatedTask = this.requireBackgroundTask(task.id);
            this.agentHistory.updateBackgroundTaskThread(updatedTask);
            if (!this.hasBackgroundTaskPausedEvent(updatedTask)) {
              this.agentHistory.recordBackgroundTaskEvent(updatedTask, 'background_task_paused', {
                taskId: updatedTask.id,
                status: updatedTask.status
              });
            }
          } else if (event.eventType === 'run_cancelled') {
            this.db
              .prepare('UPDATE background_tasks SET last_run_status = ?, updated_at = ? WHERE id = ?')
              .run('cancelled', event.createdAt, task.id);
          }
        }
        lastSequence = event.sequence;
        updatedAt = event.createdAt;
        appliedCount += 1;
      }
      if (updatedAt !== null) {
        this.db
          .prepare(
            `INSERT INTO task_agent_outbox_cursors (projector_name, last_sequence, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(projector_name) DO UPDATE SET
               last_sequence = excluded.last_sequence,
               updated_at = excluded.updated_at`
          )
          .run(projectorName, lastSequence, updatedAt);
      }
      return { appliedCount, lastSequence };
    })();
  }
  getAgentOutboxCursor(projectorName: string): number {
    const normalizedProjectorName = projectorName.trim();
    if (normalizedProjectorName.length === 0) {
      throw new Error('task_agent_outbox_projector_name_empty');
    }
    const row = this.db
      .prepare('SELECT last_sequence FROM task_agent_outbox_cursors WHERE projector_name = ?')
      .get(normalizedProjectorName) as { last_sequence: number } | undefined;
    if (row === undefined) {
      return 0;
    }
    return row.last_sequence;
  }
  recordAgentTaskEvent(input: {
    runId: string;
    threadId: string;
    type: TaskEvent['type'];
    payload: Record<string, unknown>;
    createdAt: string;
  }): TaskEvent | null {
    void input;
    return null;
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

  private hasBackgroundTaskPausedEvent(task: BackgroundTask): boolean {
    return this.agentHistory.listEventsForRun(task.threadId, task.runId).some((event) => {
      if (event.type !== 'background_task_paused' || typeof event.payload !== 'object' || event.payload === null) {
        return false;
      }
      return Reflect.get(event.payload, 'taskId') === task.id && Reflect.get(event.payload, 'status') === 'paused';
    });
  }

  private listVisibleBackgroundTasks(): BackgroundTask[] {
    return this.listBackgroundTasks().filter((task) => task.status !== 'archived' && this.hasActiveThread(task.threadId));
  }

  private hasActiveThread(threadId: string): boolean {
    return this.agentHistory.findActiveThread(threadId) !== null;
  }

  private requireVisibleThread(threadId: string): TaskThread {
    if (this.deletionJournal.find(threadId) !== null) {
      throw new RocDomainError({
        code: 'task_thread_not_found',
        message: '任务会话不存在或已被删除。',
        category: 'not_found',
        retryable: false,
        userAction: '该会话可能已被删除，请刷新任务列表后重试。'
      });
    }
    return this.agentHistory.requireActiveThread(threadId);
  }
}
