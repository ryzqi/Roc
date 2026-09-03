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
import { RocDomainError } from '../../services/errors';
import { AgentTaskHistoryContract } from '../agent/agent-task-history-contract';
import { BackgroundTaskRepository } from './background-task-repository';
import {
  ScheduledOccurrenceRepository,
  type ClaimedScheduledOccurrence
} from './scheduled-occurrence-repository';
import { ThreadDeletionJournal } from './thread-deletion-journal';
import {
  DefaultTaskOutboxProjectionStrategy,
  type TaskOutboxProjectionStrategy
} from './task-outbox-projection-strategy';

export type { ClaimedScheduledOccurrence } from './scheduled-occurrence-repository';

const taskDetailRunHistoryLimit = 20;
const taskDetailRecentEventLimit = 20;

export class TaskRepository {
  private readonly backgroundTasks: BackgroundTaskRepository;
  private readonly occurrences: ScheduledOccurrenceRepository;
  private readonly projectionStrategy: TaskOutboxProjectionStrategy;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly agentHistory: AgentTaskHistoryContract,
    private readonly deletionJournal: ThreadDeletionJournal = new ThreadDeletionJournal({ agentHistory, db }),
    projectionStrategy?: TaskOutboxProjectionStrategy
  ) {
    this.backgroundTasks = new BackgroundTaskRepository(db);
    this.projectionStrategy = projectionStrategy ?? new DefaultTaskOutboxProjectionStrategy();
    this.occurrences = new ScheduledOccurrenceRepository(db, this.backgroundTasks, {
      findRunStatus: (runId) => {
        const run = this.agentHistory.findRun(runId);
        return run === null ? null : run.status;
      }
    });
  }

  createBackgroundTaskProposalRequest(input: {
    description: string;
    enabledCapabilities: EnabledCapabilities;
  }): ChatStartRunRequest {
    return this.backgroundTasks.createProposalRequest(input);
  }

  createBackgroundTaskPreview(request: BackgroundTaskPreviewRequest): BackgroundTaskPreview {
    return this.backgroundTasks.createPreview(request);
  }

  createBackgroundTask(request: BackgroundTaskPreviewRequest): BackgroundTask {
    const task = this.backgroundTasks.create(request);
    this.agentHistory.ensureBackgroundTaskThread(task);
    this.agentHistory.recordBackgroundTaskEvent(task, 'background_task_created', {
      taskId: task.id,
      goal: task.goal,
      status: task.status
    });
    return task;
  }

  updateBackgroundTask(request: UpdateBackgroundTaskRequest): BackgroundTask {
    const plan = this.backgroundTasks.prepareUpdate(request);
    this.db.transaction(() => {
      this.occurrences.skipPendingForTaskRevisionInCurrentTransaction(plan.taskId, plan.taskRevision, plan.now);
      this.backgroundTasks.updateInCurrentTransaction(plan);
    })();
    const task = this.backgroundTasks.require(plan.taskId);
    this.agentHistory.updateBackgroundTaskThread(task);
    return task;
  }

  findBackgroundTask(id: string): BackgroundTask | null {
    return this.backgroundTasks.find(id);
  }

  findBackgroundTaskByRunId(runId: string): BackgroundTask | null {
    return this.backgroundTasks.findByRunId(runId);
  }

  listBackgroundTasks(): BackgroundTask[] {
    return this.backgroundTasks.list();
  }

  listSchedulableBackgroundTasks(): BackgroundTask[] {
    return this.backgroundTasks.listSchedulable().filter((task) => this.hasActiveThread(task.threadId));
  }

  claimDueScheduledOccurrence(input: {
    claimOwner: string;
    now: string;
    taskId: string;
  }): ClaimedScheduledOccurrence | null {
    return this.db.transaction(() => this.occurrences.claimDueInCurrentTransaction(input))();
  }

  reconcileScheduledOccurrences(input: { now: string }): void {
    const pausedTasks = this.db.transaction(() => this.occurrences.reconcileInCurrentTransaction(input))();
    for (const task of pausedTasks) {
      this.agentHistory.updateBackgroundTaskThread(task);
      if (!this.hasBackgroundTaskPausedEvent(task)) {
        this.agentHistory.recordBackgroundTaskEvent(task, 'background_task_paused', {
          taskId: task.id,
          status: task.status
        });
      }
    }
  }

  hasDuePendingScheduledOccurrence(input: { now: string; taskId: string }): boolean {
    return this.occurrences.hasDuePending(input);
  }

  nextScheduledOccurrenceClaimExpiry(): string | null {
    return this.occurrences.nextClaimExpiry();
  }

  markScheduledOccurrenceDispatched(input: {
    attempt: number;
    claimOwner: string;
    dispatchedAt: string;
    occurrenceKey: string;
    runId: string;
  }): BackgroundTask | null {
    const task = this.db.transaction(() => this.occurrences.markDispatchedInCurrentTransaction(input))();
    if (task !== null) {
      this.agentHistory.updateBackgroundTaskThread(task);
    }
    return task;
  }

  recordScheduledOccurrenceStartFailure(input: {
    attempt: number;
    claimOwner: string;
    failedAt: string;
    occurrenceKey: string;
    reason: string;
  }): BackgroundTask | null {
    const task = this.db.transaction(() => this.occurrences.recordStartFailureInCurrentTransaction(input))();
    if (task !== null) {
      this.agentHistory.updateBackgroundTaskThread(task);
      this.agentHistory.recordBackgroundTaskEvent(task, 'background_task_paused', {
        taskId: task.id,
        status: task.status
      });
    }
    return task;
  }

  pauseBackgroundTask(id: string): BackgroundTask {
    const task = this.backgroundTasks.pause(id);
    this.agentHistory.updateBackgroundTaskThread(task);
    this.agentHistory.recordBackgroundTaskEvent(task, 'background_task_paused', {
      taskId: task.id,
      status: task.status
    });
    return task;
  }

  resumeBackgroundTask(id: string): BackgroundTask {
    const task = this.backgroundTasks.resume(id);
    this.agentHistory.updateBackgroundTaskThread(task);
    this.agentHistory.recordBackgroundTaskEvent(task, 'background_task_resumed', {
      taskId: task.id,
      status: task.status
    });
    return task;
  }

  cancelBackgroundTask(id: string): BackgroundTask {
    const task = this.backgroundTasks.cancel(id);
    this.agentHistory.updateBackgroundTaskThread(task);
    this.agentHistory.recordBackgroundTaskEvent(task, 'background_task_cancelled', {
      taskId: task.id,
      status: task.status
    });
    return task;
  }

  deleteBackgroundTask(id: string): { deleted: true; taskId: string } {
    const task = this.backgroundTasks.assertArchivable(id);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.backgroundTasks.archive(task.id, now);
      this.agentHistory.archiveThread(task.threadId, now);
    })();
    return { deleted: true, taskId: task.id };
  }

  recordScheduledTaskRun(input: {
    backgroundTaskId: string;
    scheduledAt: string;
    status: ScheduledTaskRun['status'];
    taskRunId?: string | null;
    triggeredAt?: string | null;
    skipReason?: string | null;
  }): ScheduledTaskRun {
    return this.backgroundTasks.recordScheduledRun(input);
  }

  recordBackgroundTaskStartFailure(input: {
    taskId: string;
    scheduledAt: string;
    failedAt: string;
    reason: string;
  }): BackgroundTask {
    const task = this.backgroundTasks.recordStartFailure(input);
    this.agentHistory.updateBackgroundTaskThread(task);
    this.agentHistory.recordBackgroundTaskEvent(task, 'background_task_paused', {
      taskId: task.id,
      status: task.status
    });
    return task;
  }

  countRecentSkippedScheduledRuns(): number {
    return this.backgroundTasks.countRecentSkippedScheduledRuns();
  }

  markBackgroundTaskFired(input: {
    taskId: string;
    runId: string;
    firedAt: string;
    nextRunAt: string | null;
  }): BackgroundTask {
    const task = this.backgroundTasks.markFired(input);
    this.agentHistory.updateBackgroundTaskThread(task);
    return task;
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
    return this.backgroundTasks.listActive().filter((task) => this.hasActiveThread(task.threadId));
  }

  getTaskDetail(input: { taskId: string; schedulerRegistered: boolean }): TaskDetail {
    const task = this.requireBackgroundTask(input.taskId);
    const thread = this.requireVisibleThread(task.threadId);
    const runHistory = this.agentHistory.listRunsForThread(task.threadId, taskDetailRunHistoryLimit);
    const firstRun = runHistory[0];
    const lastRunId = firstRun === undefined ? null : firstRun.id;
    const recentEvents = this.mergeTaskEvents([
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
    return this.backgroundTasks.listScheduledRuns(input);
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
      this.backgroundTasks.updateLastRunStatus(task.id, 'success', new Date().toISOString());
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
      this.backgroundTasks.pauseAfterRunFailure(task.id, new Date().toISOString());
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
        const occurrenceTask = this.occurrences.projectOutboxTerminal(event);
        const task = occurrenceTask === null ? this.findBackgroundTaskByRunId(event.runId) : occurrenceTask;

        // 使用策略对象计算状态转换
        const transition = this.projectionStrategy.applyEvent(task, event);

        // 应用状态转换
        this.applyTransition(transition);

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
    return row === undefined ? 0 : row.last_sequence;
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
    return this.backgroundTasks.require(id);
  }

  /**
   * 应用状态转换动作
   */
  private applyTransition(transition: import('./task-outbox-projection-strategy').TaskStateTransition): void {
    switch (transition.type) {
      case 'no_op':
        // 无操作
        break;

      case 'update_status':
        this.backgroundTasks.updateLastRunStatus(transition.taskId, transition.status, transition.timestamp);
        break;

      case 'pause_after_failure': {
        this.backgroundTasks.pauseAfterRunFailure(transition.taskId, transition.timestamp);
        const updatedTask = this.requireBackgroundTask(transition.taskId);
        this.agentHistory.updateBackgroundTaskThread(updatedTask);
        if (!this.hasBackgroundTaskPausedEvent(updatedTask)) {
          this.agentHistory.recordBackgroundTaskEvent(updatedTask, 'background_task_paused', {
            taskId: updatedTask.id,
            status: updatedTask.status
          });
        }
        break;
      }

      default: {
        const exhaustive: never = transition;
        throw new Error(`未处理的转换类型: ${JSON.stringify(exhaustive)}`);
      }
    }
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

  private mergeTaskEvents(eventGroups: readonly TaskEvent[][]): TaskEvent[] {
    const eventsById = new Map<string, TaskEvent>();
    for (const events of eventGroups) {
      for (const event of events) {
        if (!eventsById.has(event.id)) {
          eventsById.set(event.id, event);
        }
      }
    }
    return [...eventsById.values()].sort((left, right) => {
      const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
      if (createdAtOrder !== 0) {
        return createdAtOrder;
      }
      return (right.sequence === undefined ? 0 : right.sequence) - (left.sequence === undefined ? 0 : left.sequence);
    });
  }
}
