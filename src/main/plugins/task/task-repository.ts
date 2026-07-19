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
  TaskStatus,
  TaskThread,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';
import { deleteTaskProjectionForThread } from '../../infrastructure/agent-history-deletion';
import { RocDomainError } from '../../services/errors';
import { AgentTaskHistoryReader } from './agent-task-history';
import { computeNextRunAt } from './next-run-calculator';
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
const scheduledOccurrenceClaimLeaseMs = 60_000;

export type ClaimedScheduledOccurrence = {
  attempt: number;
  claimOwner: string;
  occurrenceKey: string;
  dispatchKey: string;
  taskId: string;
  taskRevision: number;
  scheduledAt: string;
  request: ChatStartRunRequest;
};

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

  claimDueScheduledOccurrence(input: {
    claimOwner: string;
    now: string;
    taskId: string;
  }): ClaimedScheduledOccurrence | null {
    const claimOwner = requireText(input.claimOwner, 'scheduled_occurrence_claim_owner_empty');
    const task = this.requireBackgroundTask(input.taskId);
    if (task.status !== 'running' || !task.scheduled) {
      return null;
    }
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) {
      throw new Error('scheduled_occurrence_time_invalid');
    }
    return this.db.transaction(() => {
      let pending = this.db
        .prepare(
          `SELECT occurrence_key, dispatch_key, request_json, scheduled_at, task_revision, attempt
           FROM scheduled_occurrences
           WHERE background_task_id = ? AND status = 'pending' AND scheduled_at <= ?
           ORDER BY scheduled_at DESC
           LIMIT 1`
        )
        .get(task.id, input.now) as
        | {
            occurrence_key: string;
            dispatch_key: string;
            request_json: string;
            scheduled_at: string;
            task_revision: number;
            attempt: number;
          }
        | undefined;
      const activeOccurrence = this.db
        .prepare(
          `SELECT occurrence_key
           FROM scheduled_occurrences
           WHERE background_task_id = ? AND status IN ('claimed', 'dispatched')
           LIMIT 1`
        )
        .get(task.id) as { occurrence_key: string } | undefined;
      if (pending !== undefined && activeOccurrence !== undefined) {
        if (task.nextRunAt === null) {
          return null;
        }
        const nextRunAtMs = Date.parse(task.nextRunAt);
        if (!Number.isFinite(nextRunAtMs)) {
          throw new Error('scheduled_occurrence_time_invalid');
        }
        if (nextRunAtMs > nowMs) {
          return null;
        }
        const schedule = resolveScheduledOccurrenceSchedule(task, task.nextRunAt, nowMs);
        const latestOccurrenceKey = `${task.id}:${schedule.scheduledAt}:${pending.task_revision}`;
        if (pending.occurrence_key === latestOccurrenceKey) {
          this.db
            .prepare('UPDATE background_tasks SET next_run_at = ?, updated_at = ? WHERE id = ?')
            .run(schedule.nextRunAt, input.now, task.id);
          return null;
        }
        this.db
          .prepare(
            `UPDATE scheduled_occurrences
             SET status = ?, terminal_at = ?, reason = ?
             WHERE background_task_id = ? AND status = 'pending' AND scheduled_at < ?`
          )
          .run('skipped', input.now, 'overlap_coalesced_superseded', task.id, schedule.scheduledAt);
        pending = undefined;
      }
      if (pending !== undefined) {
        if (activeOccurrence !== undefined) {
          return null;
        }
        const claimExpiresAt = new Date(nowMs + scheduledOccurrenceClaimLeaseMs).toISOString();
        const claimed = this.db
          .prepare(
            `UPDATE scheduled_occurrences
             SET status = ?, claim_owner = ?, claim_expires_at = ?, attempt = attempt + 1, claimed_at = ?
             WHERE occurrence_key = ? AND status = 'pending'`
          )
          .run('claimed', claimOwner, claimExpiresAt, input.now, pending.occurrence_key);
        if (claimed.changes !== 1) {
          return null;
        }
        return {
          attempt: pending.attempt + 1,
          claimOwner,
          occurrenceKey: pending.occurrence_key,
          dispatchKey: pending.dispatch_key,
          taskId: task.id,
          taskRevision: pending.task_revision,
          scheduledAt: pending.scheduled_at,
          request: parseScheduledOccurrenceRequest(pending.request_json)
        };
      }
      if (task.nextRunAt === null) {
        return null;
      }
      const scheduledAtMs = Date.parse(task.nextRunAt);
      if (!Number.isFinite(scheduledAtMs)) {
        throw new Error('scheduled_occurrence_time_invalid');
      }
      if (scheduledAtMs > nowMs) {
        return null;
      }
      const revisionRow = this.db
        .prepare('SELECT task_revision FROM background_tasks WHERE id = ?')
        .get(task.id) as { task_revision: number } | undefined;
      if (revisionRow === undefined || !Number.isInteger(revisionRow.task_revision) || revisionRow.task_revision <= 0) {
        throw new Error('background_task_revision_invalid');
      }
      const schedule = resolveScheduledOccurrenceSchedule(task, task.nextRunAt, nowMs);
      const occurrenceKey = `${task.id}:${schedule.scheduledAt}:${revisionRow.task_revision}`;
      const request: ChatStartRunRequest = {
        enabledCapabilities: task.enabledCapabilities === null ? { mcpServers: [], skills: [] } : task.enabledCapabilities,
        input: task.goal,
        mode: 'task',
        taskSource: 'background_schedule',
        threadId: task.threadId,
        workspacePath: task.workspacePath,
        shellAllowedCommands: [...task.allowedActions]
      };
      const existing = this.db
        .prepare('SELECT status FROM scheduled_occurrences WHERE occurrence_key = ?')
        .get(occurrenceKey) as { status: string } | undefined;
      if (existing !== undefined) {
        return null;
      }
      const claimExpiresAt = new Date(nowMs + scheduledOccurrenceClaimLeaseMs).toISOString();
      const initialStatus = activeOccurrence === undefined ? 'claimed' : 'pending';
      const reason = activeOccurrence === undefined
        ? schedule.reason
        : 'overlap_coalesced_latest';
      if (initialStatus === 'claimed') {
        this.db
          .prepare(
            `INSERT INTO scheduled_occurrences
             (occurrence_key, background_task_id, task_revision, scheduled_at, status, claim_owner, claim_expires_at,
              attempt, dispatch_key, run_id, request_json, created_at, claimed_at, dispatched_at, terminal_at, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            occurrenceKey,
            task.id,
            revisionRow.task_revision,
            schedule.scheduledAt,
            'claimed',
            claimOwner,
            claimExpiresAt,
            1,
            occurrenceKey,
            null,
            JSON.stringify(request),
            input.now,
            input.now,
            null,
            null,
            reason
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO scheduled_occurrences
             (occurrence_key, background_task_id, task_revision, scheduled_at, status, claim_owner, claim_expires_at,
              attempt, dispatch_key, run_id, request_json, created_at, claimed_at, dispatched_at, terminal_at, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            occurrenceKey,
            task.id,
            revisionRow.task_revision,
            schedule.scheduledAt,
            'pending',
            null,
            null,
            0,
            occurrenceKey,
            null,
            JSON.stringify(request),
            input.now,
            null,
            null,
            null,
            reason
          );
      }
      this.db
        .prepare('UPDATE background_tasks SET next_run_at = ?, updated_at = ? WHERE id = ?')
        .run(schedule.nextRunAt, input.now, task.id);
      if (initialStatus === 'pending') {
        return null;
      }
      return {
        attempt: 1,
        claimOwner,
        occurrenceKey,
        dispatchKey: occurrenceKey,
        taskId: task.id,
        taskRevision: revisionRow.task_revision,
        scheduledAt: schedule.scheduledAt,
        request
      };
    })();
  }

  reconcileScheduledOccurrences(input: { now: string }): void {
    if (!Number.isFinite(Date.parse(input.now))) {
      throw new Error('scheduled_occurrence_time_invalid');
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE scheduled_occurrences
           SET status = ?, claim_owner = NULL, claim_expires_at = NULL, reason = ?
           WHERE status = 'claimed' AND claim_expires_at <= ?`
        )
        .run('pending', 'claim_lease_expired', input.now);
    })();
    const dispatchedOccurrences = this.db
      .prepare(
        `SELECT background_task_id, occurrence_key, run_id
         FROM scheduled_occurrences
         WHERE status = 'dispatched'`
      )
      .all() as Array<{ background_task_id: string; occurrence_key: string; run_id: string | null }>;
    for (const occurrence of dispatchedOccurrences) {
      const run = occurrence.run_id === null ? null : this.agentHistory.findRun(occurrence.run_id);
      const resolution = resolveDispatchedOccurrence(run?.status ?? null);
      if (resolution === null) {
        continue;
      }
      const result = this.db.transaction(() => {
        const transitioned = this.db
          .prepare(
            `UPDATE scheduled_occurrences
             SET status = ?, terminal_at = ?, reason = ?
             WHERE occurrence_key = ? AND status = 'dispatched'`
          )
          .run(resolution.status, input.now, resolution.reason, occurrence.occurrence_key);
        if (transitioned.changes !== 1) {
          return { pauseTaskId: null as string | null };
        }
        const task = this.requireBackgroundTask(occurrence.background_task_id);
        if (task.runId !== occurrence.run_id) {
          return { pauseTaskId: null as string | null };
        }
        if (resolution.status === 'completed') {
          this.db
            .prepare('UPDATE background_tasks SET last_run_status = ?, updated_at = ? WHERE id = ?')
            .run('success', input.now, task.id);
          return { pauseTaskId: null as string | null };
        }
        if (resolution.status === 'failed') {
          this.db
            .prepare('UPDATE background_tasks SET status = ?, last_run_status = ?, updated_at = ? WHERE id = ?')
            .run('paused', 'failed', input.now, task.id);
          return { pauseTaskId: task.id };
        }
        if (resolution.status === 'cancelled') {
          this.db
            .prepare('UPDATE background_tasks SET last_run_status = ?, updated_at = ? WHERE id = ?')
            .run('cancelled', input.now, task.id);
        }
        return { pauseTaskId: null as string | null };
      })();
      if (result.pauseTaskId !== null) {
        const task = this.requireBackgroundTask(result.pauseTaskId);
        this.agentHistory.updateBackgroundTaskThread(task);
        if (!this.hasBackgroundTaskPausedEvent(task)) {
          this.agentHistory.recordBackgroundTaskEvent(task, 'background_task_paused', {
            taskId: task.id,
            status: task.status
          });
        }
      }
    }
  }

  hasDuePendingScheduledOccurrence(input: { now: string; taskId: string }): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found
         FROM scheduled_occurrences
         WHERE background_task_id = ? AND status = 'pending' AND scheduled_at <= ?
         LIMIT 1`
      )
      .get(input.taskId, input.now) as { found: number } | undefined;
    return row !== undefined;
  }

  nextScheduledOccurrenceClaimExpiry(): string | null {
    const row = this.db
      .prepare(
        `SELECT MIN(claim_expires_at) AS claim_expires_at
         FROM scheduled_occurrences
         WHERE status = 'claimed' AND claim_expires_at IS NOT NULL`
      )
      .get() as { claim_expires_at: string | null };
    if (row.claim_expires_at === null) {
      return null;
    }
    if (!Number.isFinite(Date.parse(row.claim_expires_at))) {
      throw new Error('scheduled_occurrence_claim_expiry_invalid');
    }
    return row.claim_expires_at;
  }

  markScheduledOccurrenceDispatched(input: {
    attempt: number;
    claimOwner: string;
    dispatchedAt: string;
    occurrenceKey: string;
    runId: string;
  }): BackgroundTask | null {
    const taskId = this.db.transaction(() => {
      const occurrence = this.db
        .prepare('SELECT background_task_id, run_id, status FROM scheduled_occurrences WHERE occurrence_key = ?')
        .get(input.occurrenceKey) as
        | { background_task_id: string; run_id: string | null; status: string }
        | undefined;
      if (occurrence === undefined) {
        throw new Error('scheduled_occurrence_not_found');
      }
      if (occurrence.status === 'dispatched') {
        if (occurrence.run_id !== input.runId) {
          throw new Error('scheduled_occurrence_dispatch_run_conflict');
        }
        return occurrence.background_task_id;
      }
      if (occurrence.status !== 'claimed') {
        throw new Error('scheduled_occurrence_dispatch_state_invalid');
      }
      const existingRunBinding = this.db
        .prepare('SELECT occurrence_key FROM scheduled_occurrences WHERE run_id = ?')
        .get(input.runId) as { occurrence_key: string } | undefined;
      if (existingRunBinding !== undefined && existingRunBinding.occurrence_key !== input.occurrenceKey) {
        throw new Error('scheduled_occurrence_dispatch_run_conflict');
      }
      const dispatched = this.db
        .prepare(
          `UPDATE scheduled_occurrences
           SET status = ?, run_id = ?, dispatched_at = ?, claim_expires_at = NULL
           WHERE occurrence_key = ? AND status = 'claimed' AND claim_owner = ? AND attempt = ?`
        )
        .run('dispatched', input.runId, input.dispatchedAt, input.occurrenceKey, input.claimOwner, input.attempt);
      if (dispatched.changes !== 1) {
        return null;
      }
      this.db
        .prepare(
          `UPDATE background_tasks
           SET run_id = ?, last_run_at = ?, last_run_status = NULL, run_count = run_count + 1, updated_at = ?
           WHERE id = ?`
        )
        .run(input.runId, input.dispatchedAt, input.dispatchedAt, occurrence.background_task_id);
      return occurrence.background_task_id;
    })();
    if (taskId === null) {
      return null;
    }
    const task = this.requireBackgroundTask(taskId);
    this.agentHistory.updateBackgroundTaskThread(task);
    return task;
  }

  recordScheduledOccurrenceStartFailure(input: {
    attempt: number;
    claimOwner: string;
    failedAt: string;
    occurrenceKey: string;
    reason: string;
  }): BackgroundTask | null {
    const taskId = this.db.transaction(() => {
      const occurrence = this.db
        .prepare('SELECT background_task_id, status FROM scheduled_occurrences WHERE occurrence_key = ?')
        .get(input.occurrenceKey) as { background_task_id: string; status: string } | undefined;
      if (occurrence === undefined) {
        throw new Error('scheduled_occurrence_not_found');
      }
      if (occurrence.status !== 'claimed') {
        throw new Error('scheduled_occurrence_start_failure_state_invalid');
      }
      const failed = this.db
        .prepare(
          `UPDATE scheduled_occurrences
           SET status = ?, terminal_at = ?, reason = ?, claim_expires_at = NULL
           WHERE occurrence_key = ? AND status = 'claimed' AND claim_owner = ? AND attempt = ?`
        )
        .run('failed', input.failedAt, input.reason, input.occurrenceKey, input.claimOwner, input.attempt);
      if (failed.changes !== 1) {
        return null;
      }
      this.db
        .prepare('UPDATE background_tasks SET status = ?, last_run_status = ?, updated_at = ? WHERE id = ?')
        .run('paused', 'failed', input.failedAt, occurrence.background_task_id);
      return occurrence.background_task_id;
    })();
    if (taskId === null) {
      return null;
    }
    const task = this.requireBackgroundTask(taskId);
    this.agentHistory.updateBackgroundTaskThread(task);
    this.agentHistory.recordBackgroundTaskEvent(task, 'background_task_paused', {
      taskId: task.id,
      status: task.status
    });
    return task;
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
         )
        `
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
        const occurrence = this.db
          .prepare(
            `SELECT background_task_id, occurrence_key, status
             FROM scheduled_occurrences
             WHERE run_id = ?`
          )
          .get(event.runId) as
          | { background_task_id: string; occurrence_key: string; status: string }
          | undefined;
        if (occurrence !== undefined) {
          const occurrenceStatus = outboxTerminalOccurrenceStatus(event);
          if (occurrenceStatus !== null && occurrence.status === 'dispatched') {
            this.db
              .prepare(
                `UPDATE scheduled_occurrences
                 SET status = ?, terminal_at = ?, reason = ?
                 WHERE occurrence_key = ? AND status = 'dispatched'`
              )
              .run(occurrenceStatus, event.createdAt, outboxTerminalOccurrenceReason(event), occurrence.occurrence_key);
          }
        }
        const task = occurrence === undefined
          ? this.findBackgroundTaskByRunId(event.runId)
          : this.requireBackgroundTask(occurrence.background_task_id);
        if (task !== null) {
          const isLatestRun = task.runId === event.runId;
          if (event.eventType === 'run_completed' && isLatestRun) {
            this.db
              .prepare('UPDATE background_tasks SET last_run_status = ?, updated_at = ? WHERE id = ?')
              .run('success', event.createdAt, task.id);
          } else if (event.eventType === 'run_failed' && isLatestRun) {
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
          } else if (event.eventType === 'run_cancelled' && isLatestRun) {
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

function resolveScheduledOccurrenceSchedule(
  task: BackgroundTask,
  firstScheduledAt: string,
  nowMs: number
): { nextRunAt: string | null; reason: string | null; scheduledAt: string } {
  if (task.triggerType !== 'cron') {
    return {
      nextRunAt: null,
      reason: null,
      scheduledAt: firstScheduledAt
    };
  }
  let scheduledAt = firstScheduledAt;
  let scheduledAtMs = Date.parse(scheduledAt);
  if (!Number.isFinite(scheduledAtMs)) {
    throw new Error('scheduled_occurrence_time_invalid');
  }
  let nextRunAt = computeNextRunAt(task, new Date(scheduledAt));
  let coalesced = false;
  while (nextRunAt !== null && Date.parse(nextRunAt) <= nowMs) {
    const nextRunAtMs = Date.parse(nextRunAt);
    if (!Number.isFinite(nextRunAtMs) || nextRunAtMs <= scheduledAtMs) {
      throw new Error('scheduled_occurrence_cron_progress_invalid');
    }
    scheduledAt = nextRunAt;
    scheduledAtMs = nextRunAtMs;
    nextRunAt = computeNextRunAt(task, new Date(scheduledAt));
    coalesced = true;
  }
  return {
    nextRunAt,
    reason: coalesced ? 'misfire_coalesced_latest' : null,
    scheduledAt
  };
}

function parseScheduledOccurrenceRequest(serialized: string): ChatStartRunRequest {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error('scheduled_occurrence_request_json_invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('scheduled_occurrence_request_invalid');
  }
  const input = readScheduledOccurrenceText(value, 'input');
  const mode = readScheduledOccurrenceText(value, 'mode');
  const taskSource = readScheduledOccurrenceText(value, 'taskSource');
  const threadId = readScheduledOccurrenceText(value, 'threadId');
  const workspacePath = readScheduledOccurrenceText(value, 'workspacePath');
  const shellAllowedCommands = readOptionalScheduledOccurrenceTextArray(value, 'shellAllowedCommands');
  if (mode !== 'task' || taskSource !== 'background_schedule') {
    throw new Error('scheduled_occurrence_request_invalid');
  }
  const enabledCapabilities = Reflect.get(value, 'enabledCapabilities');
  if (typeof enabledCapabilities !== 'object' || enabledCapabilities === null || Array.isArray(enabledCapabilities)) {
    throw new Error('scheduled_occurrence_request_invalid');
  }
  return {
    enabledCapabilities: {
      mcpServers: readScheduledOccurrenceTextArray(enabledCapabilities, 'mcpServers'),
      skills: readScheduledOccurrenceTextArray(enabledCapabilities, 'skills')
    },
    input,
    mode,
    taskSource,
    threadId,
    workspacePath,
    shellAllowedCommands
  };
}

function readScheduledOccurrenceText(value: object, key: string): string {
  const field = Reflect.get(value, key);
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error('scheduled_occurrence_request_invalid');
  }
  return field;
}

function readScheduledOccurrenceTextArray(value: object, key: string): string[] {
  const field = Reflect.get(value, key);
  if (!Array.isArray(field) || field.some((item) => typeof item !== 'string')) {
    throw new Error('scheduled_occurrence_request_invalid');
  }
  return field;
}

function readOptionalScheduledOccurrenceTextArray(value: object, key: string): string[] {
  const field = Reflect.get(value, key);
  if (field === undefined) {
    return [];
  }
  return readScheduledOccurrenceTextArray(value, key);
}

function outboxTerminalOccurrenceStatus(event: AgentOutboxEvent): 'cancelled' | 'completed' | 'failed' | null {
  if (event.eventType === 'run_completed') {
    return 'completed';
  }
  if (event.eventType === 'run_failed') {
    return 'failed';
  }
  if (event.eventType === 'run_cancelled') {
    return 'cancelled';
  }
  return null;
}

function outboxTerminalOccurrenceReason(event: AgentOutboxEvent): string | null {
  if (event.eventType === 'run_failed') {
    return event.payload.code;
  }
  if (event.eventType === 'run_cancelled') {
    return event.payload.reason;
  }
  return null;
}

function resolveDispatchedOccurrence(status: TaskStatus | null): {
  reason: string | null;
  status: 'cancelled' | 'completed' | 'failed' | 'unknown';
} | null {
  if (status === null) {
    return { status: 'unknown', reason: 'agent_run_missing' };
  }
  if (status === 'completed') {
    return { status: 'completed', reason: null };
  }
  if (status === 'failed') {
    return { status: 'failed', reason: 'agent_run_failed' };
  }
  if (status === 'cancelled') {
    return { status: 'cancelled', reason: 'agent_run_cancelled' };
  }
  if (status === 'interrupted') {
    return { status: 'unknown', reason: 'agent_run_interrupted' };
  }
  return null;
}
