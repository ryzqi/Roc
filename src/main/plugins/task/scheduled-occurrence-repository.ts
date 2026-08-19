import type { Database as DatabaseConnection } from 'better-sqlite3';

import type { AgentOutboxEvent, BackgroundTask, ChatStartRunRequest, TaskStatus } from '../../../shared/types';
import { computeNextRunAt } from './next-run-calculator';

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

export type ScheduledOccurrenceRunReader = {
  findRunStatus(runId: string): TaskStatus | null;
};

export type ScheduledOccurrenceTaskReader = {
  require(id: string): BackgroundTask;
};

export type ScheduledOccurrenceTaskWriter = ScheduledOccurrenceTaskReader & {
  updateNextRunAtInCurrentTransaction(taskId: string, nextRunAt: string | null, updatedAt: string): void;
  markDispatchedInCurrentTransaction(taskId: string, runId: string, dispatchedAt: string): void;
  recordOccurrenceTerminalInCurrentTransaction(
    taskId: string,
    status: Exclude<BackgroundTask['lastRunStatus'], null>,
    updatedAt: string,
    pause: boolean
  ): void;
};

export class ScheduledOccurrenceRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly backgroundTasks: ScheduledOccurrenceTaskWriter,
    private readonly runs: ScheduledOccurrenceRunReader
  ) {}

  claimDue(input: {
    claimOwner: string;
    now: string;
    taskId: string;
  }): ClaimedScheduledOccurrence | null {
    const claimOwner = requireText(input.claimOwner, 'scheduled_occurrence_claim_owner_empty');
    const task = this.backgroundTasks.require(input.taskId);
    if (task.status !== 'running' || !task.scheduled) {
      return null;
    }
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) {
      throw new Error('scheduled_occurrence_time_invalid');
    }
    return this.db.transaction(() => this.claimInCurrentTransaction({ claimOwner, now: input.now, nowMs, task }))();
  }

  claimDueInCurrentTransaction(input: {
    claimOwner: string;
    now: string;
    taskId: string;
  }): ClaimedScheduledOccurrence | null {
    const claimOwner = requireText(input.claimOwner, 'scheduled_occurrence_claim_owner_empty');
    const task = this.backgroundTasks.require(input.taskId);
    if (task.status !== 'running' || !task.scheduled) {
      return null;
    }
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) {
      throw new Error('scheduled_occurrence_time_invalid');
    }
    return this.claimInCurrentTransaction({ claimOwner, now: input.now, nowMs, task });
  }

  reconcile(input: { now: string }): BackgroundTask[] {
    if (!Number.isFinite(Date.parse(input.now))) {
      throw new Error('scheduled_occurrence_time_invalid');
    }
    return this.db.transaction(() => this.reconcileInCurrentTransaction(input))();
  }

  reconcileInCurrentTransaction(input: { now: string }): BackgroundTask[] {
    if (!Number.isFinite(Date.parse(input.now))) {
      throw new Error('scheduled_occurrence_time_invalid');
    }
    this.db
      .prepare(
        `UPDATE scheduled_occurrences
         SET status = ?, claim_owner = NULL, claim_expires_at = NULL, reason = ?
         WHERE status = 'claimed' AND claim_expires_at <= ?`
      )
      .run('pending', 'claim_lease_expired', input.now);
    const dispatchedOccurrences = this.db
      .prepare(
        `SELECT background_task_id, occurrence_key, run_id
         FROM scheduled_occurrences
         WHERE status = 'dispatched'`
      )
      .all() as Array<{ background_task_id: string; occurrence_key: string; run_id: string | null }>;
    const pausedTasks: BackgroundTask[] = [];
    for (const occurrence of dispatchedOccurrences) {
      const resolution = resolveDispatchedOccurrence(
        occurrence.run_id === null ? null : this.runs.findRunStatus(occurrence.run_id)
      );
      if (resolution === null) {
        continue;
      }
      const transitioned = this.db
        .prepare(
          `UPDATE scheduled_occurrences
           SET status = ?, terminal_at = ?, reason = ?
           WHERE occurrence_key = ? AND status = 'dispatched'`
        )
        .run(resolution.status, input.now, resolution.reason, occurrence.occurrence_key);
      if (transitioned.changes !== 1) {
        continue;
      }
      const task = this.backgroundTasks.require(occurrence.background_task_id);
      if (task.runId !== occurrence.run_id) {
        continue;
      }
      if (resolution.status === 'completed') {
        this.backgroundTasks.recordOccurrenceTerminalInCurrentTransaction(task.id, 'success', input.now, false);
      } else if (resolution.status === 'failed') {
        this.backgroundTasks.recordOccurrenceTerminalInCurrentTransaction(task.id, 'failed', input.now, true);
        pausedTasks.push(this.backgroundTasks.require(task.id));
      } else if (resolution.status === 'cancelled') {
        this.backgroundTasks.recordOccurrenceTerminalInCurrentTransaction(task.id, 'cancelled', input.now, false);
      }
    }
    return pausedTasks;
  }

  hasDuePending(input: { now: string; taskId: string }): boolean {
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

  nextClaimExpiry(): string | null {
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

  markDispatched(input: {
    attempt: number;
    claimOwner: string;
    dispatchedAt: string;
    occurrenceKey: string;
    runId: string;
  }): BackgroundTask | null {
    return this.db.transaction(() => this.markDispatchedInCurrentTransaction(input))();
  }

  markDispatchedInCurrentTransaction(input: {
    attempt: number;
    claimOwner: string;
    dispatchedAt: string;
    occurrenceKey: string;
    runId: string;
  }): BackgroundTask | null {
    const taskId = (() => {
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
      this.backgroundTasks.markDispatchedInCurrentTransaction(occurrence.background_task_id, input.runId, input.dispatchedAt);
      return occurrence.background_task_id;
    })();
    return taskId === null ? null : this.backgroundTasks.require(taskId);
  }

  recordStartFailure(input: {
    attempt: number;
    claimOwner: string;
    failedAt: string;
    occurrenceKey: string;
    reason: string;
  }): BackgroundTask | null {
    return this.db.transaction(() => this.recordStartFailureInCurrentTransaction(input))();
  }

  recordStartFailureInCurrentTransaction(input: {
    attempt: number;
    claimOwner: string;
    failedAt: string;
    occurrenceKey: string;
    reason: string;
  }): BackgroundTask | null {
    const taskId = (() => {
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
      this.backgroundTasks.recordOccurrenceTerminalInCurrentTransaction(
        occurrence.background_task_id,
        'failed',
        input.failedAt,
        true
      );
      return occurrence.background_task_id;
    })();
    return taskId === null ? null : this.backgroundTasks.require(taskId);
  }

  skipPendingForTaskRevisionInCurrentTransaction(taskId: string, taskRevision: number, now: string): void {
    this.db
      .prepare(
        `UPDATE scheduled_occurrences
         SET status = ?, terminal_at = ?, reason = ?
         WHERE background_task_id = ? AND task_revision = ? AND status = 'pending'`
      )
      .run('skipped', now, 'superseded_by_task_revision', taskId, taskRevision);
  }

  projectOutboxTerminal(event: AgentOutboxEvent): BackgroundTask | null {
    const occurrence = this.db
      .prepare(
        `SELECT background_task_id, occurrence_key, status
         FROM scheduled_occurrences
         WHERE run_id = ?`
      )
      .get(event.runId) as
      | { background_task_id: string; occurrence_key: string; status: string }
      | undefined;
    if (occurrence === undefined) {
      return null;
    }
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
    return this.backgroundTasks.require(occurrence.background_task_id);
  }

  private claimInCurrentTransaction(input: {
    claimOwner: string;
    now: string;
    nowMs: number;
    task: BackgroundTask;
  }): ClaimedScheduledOccurrence | null {
    let pending = this.findLatestDuePending(input.task.id, input.now);
    const activeOccurrence = this.findActive(input.task.id);
    if (pending !== undefined && activeOccurrence !== undefined) {
      pending = this.coalesceOverlappingPending(input, pending);
      if (pending !== undefined) {
        return null;
      }
    }
    if (pending !== undefined) {
      if (activeOccurrence !== undefined) {
        return null;
      }
      return this.claimExisting(input, pending);
    }
    return this.createAndClaim(input, activeOccurrence !== undefined);
  }

  private coalesceOverlappingPending(
    input: { now: string; nowMs: number; task: BackgroundTask },
    pending: PendingOccurrenceRow
  ): PendingOccurrenceRow | undefined {
    if (input.task.nextRunAt === null) {
      return pending;
    }
    const nextRunAtMs = Date.parse(input.task.nextRunAt);
    if (!Number.isFinite(nextRunAtMs)) {
      throw new Error('scheduled_occurrence_time_invalid');
    }
    if (nextRunAtMs > input.nowMs) {
      return pending;
    }
    const schedule = resolveScheduledOccurrenceSchedule(input.task, input.task.nextRunAt, input.nowMs);
    const latestOccurrenceKey = `${input.task.id}:${schedule.scheduledAt}:${pending.task_revision}`;
    if (pending.occurrence_key === latestOccurrenceKey) {
      this.backgroundTasks.updateNextRunAtInCurrentTransaction(input.task.id, schedule.nextRunAt, input.now);
      return pending;
    }
    this.db
      .prepare(
        `UPDATE scheduled_occurrences
         SET status = ?, terminal_at = ?, reason = ?
         WHERE background_task_id = ? AND status = 'pending' AND scheduled_at < ?`
      )
      .run('skipped', input.now, 'overlap_coalesced_superseded', input.task.id, schedule.scheduledAt);
    return undefined;
  }

  private claimExisting(
    input: { claimOwner: string; now: string; nowMs: number; task: BackgroundTask },
    pending: PendingOccurrenceRow
  ): ClaimedScheduledOccurrence | null {
    const claimExpiresAt = new Date(input.nowMs + scheduledOccurrenceClaimLeaseMs).toISOString();
    const claimed = this.db
      .prepare(
        `UPDATE scheduled_occurrences
         SET status = ?, claim_owner = ?, claim_expires_at = ?, attempt = attempt + 1, claimed_at = ?
         WHERE occurrence_key = ? AND status = 'pending'`
      )
      .run('claimed', input.claimOwner, claimExpiresAt, input.now, pending.occurrence_key);
    if (claimed.changes !== 1) {
      return null;
    }
    return {
      attempt: pending.attempt + 1,
      claimOwner: input.claimOwner,
      occurrenceKey: pending.occurrence_key,
      dispatchKey: pending.dispatch_key,
      taskId: input.task.id,
      taskRevision: pending.task_revision,
      scheduledAt: pending.scheduled_at,
      request: parseScheduledOccurrenceRequest(pending.request_json)
    };
  }

  private createAndClaim(
    input: { claimOwner: string; now: string; nowMs: number; task: BackgroundTask },
    hasActiveOccurrence: boolean
  ): ClaimedScheduledOccurrence | null {
    if (input.task.nextRunAt === null) {
      return null;
    }
    const scheduledAtMs = Date.parse(input.task.nextRunAt);
    if (!Number.isFinite(scheduledAtMs)) {
      throw new Error('scheduled_occurrence_time_invalid');
    }
    if (scheduledAtMs > input.nowMs) {
      return null;
    }
    const revisionRow = this.db
      .prepare('SELECT task_revision FROM background_tasks WHERE id = ?')
      .get(input.task.id) as { task_revision: number } | undefined;
    if (revisionRow === undefined || !Number.isInteger(revisionRow.task_revision) || revisionRow.task_revision <= 0) {
      throw new Error('background_task_revision_invalid');
    }
    const schedule = resolveScheduledOccurrenceSchedule(input.task, input.task.nextRunAt, input.nowMs);
    const occurrenceKey = `${input.task.id}:${schedule.scheduledAt}:${revisionRow.task_revision}`;
    const request = buildScheduledOccurrenceRequest(input.task);
    const existing = this.db
      .prepare('SELECT status FROM scheduled_occurrences WHERE occurrence_key = ?')
      .get(occurrenceKey) as { status: string } | undefined;
    if (existing !== undefined) {
      return null;
    }
    const initialStatus = hasActiveOccurrence ? 'pending' : 'claimed';
    const reason = hasActiveOccurrence ? 'overlap_coalesced_latest' : schedule.reason;
    const claimExpiresAt = new Date(input.nowMs + scheduledOccurrenceClaimLeaseMs).toISOString();
    this.insertOccurrence({
      attempt: hasActiveOccurrence ? 0 : 1,
      claimExpiresAt: hasActiveOccurrence ? null : claimExpiresAt,
      claimOwner: hasActiveOccurrence ? null : input.claimOwner,
      claimedAt: hasActiveOccurrence ? null : input.now,
      occurrenceKey,
      reason,
      request,
      scheduledAt: schedule.scheduledAt,
      status: initialStatus,
      taskId: input.task.id,
      taskRevision: revisionRow.task_revision,
      createdAt: input.now
    });
    this.backgroundTasks.updateNextRunAtInCurrentTransaction(input.task.id, schedule.nextRunAt, input.now);
    if (hasActiveOccurrence) {
      return null;
    }
    return {
      attempt: 1,
      claimOwner: input.claimOwner,
      occurrenceKey,
      dispatchKey: occurrenceKey,
      taskId: input.task.id,
      taskRevision: revisionRow.task_revision,
      scheduledAt: schedule.scheduledAt,
      request
    };
  }

  private findLatestDuePending(taskId: string, now: string): PendingOccurrenceRow | undefined {
    return this.db
      .prepare(
        `SELECT occurrence_key, dispatch_key, request_json, scheduled_at, task_revision, attempt
         FROM scheduled_occurrences
         WHERE background_task_id = ? AND status = 'pending' AND scheduled_at <= ?
         ORDER BY scheduled_at DESC
         LIMIT 1`
      )
      .get(taskId, now) as PendingOccurrenceRow | undefined;
  }

  private findActive(taskId: string): { occurrence_key: string } | undefined {
    return this.db
      .prepare(
        `SELECT occurrence_key
         FROM scheduled_occurrences
         WHERE background_task_id = ? AND status IN ('claimed', 'dispatched')
         LIMIT 1`
      )
      .get(taskId) as { occurrence_key: string } | undefined;
  }

  private insertOccurrence(input: {
    attempt: number;
    claimExpiresAt: string | null;
    claimOwner: string | null;
    claimedAt: string | null;
    createdAt: string;
    occurrenceKey: string;
    reason: string | null;
    request: ChatStartRunRequest;
    scheduledAt: string;
    status: 'claimed' | 'pending';
    taskId: string;
    taskRevision: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO scheduled_occurrences
         (occurrence_key, background_task_id, task_revision, scheduled_at, status, claim_owner, claim_expires_at,
          attempt, dispatch_key, run_id, request_json, created_at, claimed_at, dispatched_at, terminal_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.occurrenceKey,
        input.taskId,
        input.taskRevision,
        input.scheduledAt,
        input.status,
        input.claimOwner,
        input.claimExpiresAt,
        input.attempt,
        input.occurrenceKey,
        null,
        JSON.stringify(input.request),
        input.createdAt,
        input.claimedAt,
        null,
        null,
        input.reason
      );
  }
}

type PendingOccurrenceRow = {
  occurrence_key: string;
  dispatch_key: string;
  request_json: string;
  scheduled_at: string;
  task_revision: number;
  attempt: number;
};

function buildScheduledOccurrenceRequest(task: BackgroundTask): ChatStartRunRequest {
  return {
    enabledCapabilities: task.enabledCapabilities === null ? { mcpServers: [], skills: [] } : task.enabledCapabilities,
    input: task.goal,
    mode: 'task',
    taskSource: 'background_schedule',
    threadId: task.threadId,
    workspacePath: task.workspacePath,
    shellAllowedCommands: [...task.allowedActions]
  };
}

function resolveScheduledOccurrenceSchedule(
  task: BackgroundTask,
  firstScheduledAt: string,
  nowMs: number
): { nextRunAt: string | null; reason: string | null; scheduledAt: string } {
  if (task.triggerType !== 'cron') {
    return { nextRunAt: null, reason: null, scheduledAt: firstScheduledAt };
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
  const input = readText(value, 'input');
  const mode = readText(value, 'mode');
  const taskSource = readText(value, 'taskSource');
  const threadId = readText(value, 'threadId');
  const workspacePath = readText(value, 'workspacePath');
  const shellAllowedCommands = readOptionalTextArray(value, 'shellAllowedCommands');
  if (mode !== 'task' || taskSource !== 'background_schedule') {
    throw new Error('scheduled_occurrence_request_invalid');
  }
  const enabledCapabilities = Reflect.get(value, 'enabledCapabilities');
  if (typeof enabledCapabilities !== 'object' || enabledCapabilities === null || Array.isArray(enabledCapabilities)) {
    throw new Error('scheduled_occurrence_request_invalid');
  }
  return {
    enabledCapabilities: {
      mcpServers: readTextArray(enabledCapabilities, 'mcpServers'),
      skills: readTextArray(enabledCapabilities, 'skills')
    },
    input,
    mode,
    taskSource,
    threadId,
    workspacePath,
    shellAllowedCommands
  };
}

function readText(value: object, key: string): string {
  const field = Reflect.get(value, key);
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error('scheduled_occurrence_request_invalid');
  }
  return field;
}

function readTextArray(value: object, key: string): string[] {
  const field = Reflect.get(value, key);
  if (!Array.isArray(field) || field.some((item) => typeof item !== 'string')) {
    throw new Error('scheduled_occurrence_request_invalid');
  }
  return field;
}

function readOptionalTextArray(value: object, key: string): string[] {
  return Reflect.get(value, key) === undefined ? [] : readTextArray(value, key);
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

function requireText(value: string, code: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(code);
  }
  return trimmed;
}
