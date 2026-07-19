import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  AgentCapabilityPreview,
  ChatInterruptPayload,
  ChatPersistedAttachment,
  ChatRunEvent,
  EnabledCapabilities,
  RunExecutionSnapshotV2,
  SessionMessageEntry,
  SessionMessagePhase,
  SessionMessageSearchRequest,
  SessionMessageSearchResult,
  TaskEvent,
  TaskKind,
  TaskRun,
  TaskStatus
} from '../../../shared/types';
import type { RunFailure } from '../../services/deep-agent/types';
import { RocDomainError } from '../../services/errors';
import { agentRunEventLogMaxEvents } from './run-event-log';
import type { PendingInterrupt } from './runtime-types';
import {
  createRunExecutionSnapshot,
  parseRunExecutionSnapshot,
  type RunExecutionSnapshotSeed
} from './run-execution-snapshot';

type TaskRunRow = {
  id: string;
  thread_id: string;
  run_number: number;
  user_input: string;
  status: TaskStatus;
  started_at: string;
  ended_at: string | null;
  model_id: string | null;
  enabled_capabilities_json: string;
};

type TaskEventRow = {
  id: string;
  thread_id: string;
  run_id: string;
  type: TaskEvent['type'];
  payload_json: string;
  created_at: string;
};

type SessionMessageRow = {
  id: string;
  thread_id: string;
  thread_title: string | null;
  role: SessionMessageEntry['role'];
  content: string;
  phase: SessionMessagePhase;
  token_count: number | null;
  workspace_hash: string | null;
  created_at: string;
};

type SessionMessageSearchRow = SessionMessageRow & {
  snippet: string;
};

type PendingInterruptRow = {
  run_id: string;
  thread_id: string;
  interrupt_id: string;
  payload_json: string;
};

type RunStateRow = {
  id: string;
  status: TaskStatus;
  state_version: number;
  thread_id: string;
};

type StartupRunRow = RunStateRow & {
  model_id: string | null;
  provider_id: string | null;
};

type RestartEvidence = {
  hasCheckpoint: boolean;
  hasInFlightEffect: boolean;
};

type TerminalFailureInput = {
  code: string;
  diagnostic?: RunFailure['diagnostic'];
  endedAt: string;
  error: string;
  expectedStateVersion: number;
  expectedStatus: TaskStatus;
  modelId: string;
  providerId: string;
  retryable: boolean;
  runId: string;
  status: 'failed' | 'interrupted';
  suggestion?: RunFailure['suggestion'];
};

const allowedRunTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: [],
  pending_confirmation: [],
  dispatch_pending: ['running', 'recovering', 'failed', 'cancelled', 'interrupted'],
  running: ['waiting_user', 'recovering', 'completed', 'failed', 'cancelled', 'interrupted'],
  recovering: ['running', 'failed', 'cancelled', 'interrupted'],
  paused: [],
  waiting_user: ['running', 'cancelled', 'interrupted'],
  waiting_next_turn: ['dispatch_pending', 'running', 'waiting_user', 'recovering', 'completed', 'failed', 'cancelled', 'interrupted'],
  failed: [],
  cancelled: [],
  completed: [],
  interrupted: [],
  archived: []
};

export class AgentSessionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  createTaskRun(input: {
    userInput: string;
    capabilityPreview: AgentCapabilityPreview;
    snapshot: RunExecutionSnapshotSeed;
    threadKind: TaskKind;
    threadId?: string;
    attachments?: ChatPersistedAttachment[];
  }): TaskRun {
    const now = new Date().toISOString();
    const runId = `run_${randomUUID()}`;
    const eventId = `event_${randomUUID()}`;
    const existingThreadId = input.threadId === undefined ? null : requireNonEmpty(input.threadId, 'thread_id_empty');
    const threadId = existingThreadId === null ? `thread_${randomUUID()}` : existingThreadId;
    const hasExistingThread = existingThreadId !== null && this.hasActiveThread(threadId);
    if (existingThreadId !== null && this.findActiveRun(threadId) !== null) {
      throw createThreadRunConflictError(threadId);
    }
    const runNumber = existingThreadId === null || !hasExistingThread ? 1 : this.nextRunNumber(threadId);
    const snapshot = createRunExecutionSnapshot({
      runId,
      threadId,
      inputMessageId: eventId,
      snapshot: input.snapshot
    });
    if (snapshot.capabilityManifest.manifestHash !== input.capabilityPreview.manifest.manifestHash) {
      throw new Error('run_execution_snapshot_manifest_mismatch');
    }
    const enabledCapabilities = snapshot.capabilityManifest.resolvedCapabilities;
    const enabledCapabilitiesJson = JSON.stringify(enabledCapabilities);
    const userMessagePayload: {
      role: 'user';
      content: string;
      enabledCapabilities: EnabledCapabilities;
      attachments?: ChatPersistedAttachment[];
    } = {
      role: 'user',
      content: input.userInput,
      enabledCapabilities
    };
    if (input.attachments !== undefined && input.attachments.length > 0) {
      userMessagePayload.attachments = input.attachments;
    }

    try {
      this.db
        .transaction(() => {
        if (existingThreadId === null || !hasExistingThread) {
          this.db
            .prepare(
              `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(threadId, input.threadKind, input.userInput.trim().slice(0, 60), input.userInput, 'waiting_next_turn', now, now);
        } else {
          this.db
            .prepare('UPDATE agent_threads SET status = ?, updated_at = ? WHERE id = ?')
            .run('waiting_next_turn', now, threadId);
        }

        this.db
          .prepare(
            `INSERT INTO agent_runs
             (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
              enabled_capabilities_json, workspace_path, task_source, workflow_hint, snapshot_json, snapshot_version,
              snapshot_error_code, state_version, run_origin, dispatch_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            runId,
            threadId,
            runNumber,
            input.userInput,
            'waiting_next_turn',
            now,
            null,
            snapshot.model.providerId,
            snapshot.model.modelId,
            enabledCapabilitiesJson,
            snapshot.workspace === null ? null : snapshot.workspace.path,
            snapshot.runOrigin === 'workbench_creation' ? 'workbench' : null,
            snapshot.workflowHint,
            JSON.stringify(snapshot),
            snapshot.schemaVersion,
            null,
            1,
            snapshot.runOrigin,
            snapshot.dispatchKey
          );

        this.db
          .prepare(
            `INSERT INTO agent_run_leases (thread_id, run_id, acquired_at)
             VALUES (?, ?, ?)`
          )
          .run(threadId, runId, now);

        this.insertEvent({
          id: eventId,
          threadId,
          runId,
          type: 'message',
          payload: userMessagePayload,
          createdAt: now
        });
        this.insertEvent({
          id: `event_${randomUUID()}`,
          threadId,
          runId,
          type: 'context_manifest',
          payload: {
            manifest: snapshot.capabilityManifest,
            requestedCapabilities: snapshot.capabilityManifest.requestedCapabilities,
            resolvedCapabilities: snapshot.capabilityManifest.resolvedCapabilities,
            skippedCapabilities: snapshot.capabilityManifest.skippedCapabilities,
            toolCards: input.capabilityPreview.toolCards,
            skillCards: input.capabilityPreview.skillCards,
            untrustedContextPolicy: snapshot.capabilityManifest.untrustedContextPolicy
          },
          createdAt: now
        });
        this.insertEvent({
          id: `event_${randomUUID()}`,
          threadId,
          runId,
          type: 'agent_update',
          payload: {
            status: 'running',
            providerId: snapshot.model.providerId,
            modelId: snapshot.model.modelId
          },
          createdAt: now
        });
        const runStartedEvent: ChatRunEvent = {
          type: 'run_started',
          runId,
          mode: snapshot.mode === 'run' ? 'chat' : snapshot.mode,
          threadId,
          providerId: snapshot.model.providerId,
          modelId: snapshot.model.modelId,
          createdAt: now
        };
        this.db
          .prepare(
            `INSERT INTO agent_run_events (run_id, sequence, event_json, created_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(runId, 1, JSON.stringify(runStartedEvent), now);
        this.db
          .prepare(
            `INSERT INTO agent_run_event_cursors (run_id, next_sequence)
             VALUES (?, ?)`
          )
          .run(runId, 2);
        })();
    } catch (error) {
      if (isThreadLeaseConflict(error)) {
        throw createThreadRunConflictError(threadId);
      }
      throw error;
    }

    return {
      id: runId,
      threadId,
      runNumber,
      userInput: input.userInput,
      status: 'waiting_next_turn',
      startedAt: now,
      endedAt: null,
      modelId: snapshot.model.modelId,
      enabledCapabilities
    };
  }

  getRun(id: string): TaskRun {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as TaskRunRow | undefined;
    if (row === undefined) {
      throw new Error('task_run_not_found');
    }
    return mapTaskRun(row);
  }

  findRunByDispatchKey(dispatchKey: string): TaskRun | null {
    const normalizedDispatchKey = requireNonEmpty(dispatchKey, 'agent_run_dispatch_key_empty');
    const row = this.db
      .prepare('SELECT * FROM agent_runs WHERE dispatch_key = ?')
      .get(normalizedDispatchKey) as TaskRunRow | undefined;
    if (row === undefined) {
      return null;
    }
    return mapTaskRun(row);
  }

  getRunTransitionState(runId: string): { stateVersion: number; status: TaskStatus } {
    const row = this.db
      .prepare('SELECT status, state_version FROM agent_runs WHERE id = ?')
      .get(runId) as { status: TaskStatus; state_version: number } | undefined;
    if (row === undefined) {
      throw new Error('task_run_not_found');
    }
    return {
      stateVersion: row.state_version,
      status: row.status
    };
  }

  getRunExecutionSnapshot(runId: string): RunExecutionSnapshotV2 {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, status, state_version, provider_id, model_id,
                snapshot_json, snapshot_version, snapshot_error_code
         FROM agent_runs
         WHERE id = ?`
      )
      .get(runId) as
      | {
          id: string;
          thread_id: string;
          status: TaskStatus;
          state_version: number;
          provider_id: string | null;
          model_id: string | null;
          snapshot_json: string | null;
          snapshot_version: number | null;
          snapshot_error_code: string | null;
        }
      | undefined;
    if (row === undefined) {
      throw new Error('task_run_not_found');
    }
    if (row.snapshot_json === null || (row.snapshot_version !== 1 && row.snapshot_version !== 2)) {
      this.quarantineRunSnapshot(row, 'run_execution_snapshot_missing');
      throw new Error('run_execution_snapshot_missing');
    }
    let storedSnapshot: unknown;
    try {
      storedSnapshot = JSON.parse(row.snapshot_json) as unknown;
    } catch {
      this.quarantineRunSnapshot(row, 'run_execution_snapshot_json_invalid');
      throw new Error('run_execution_snapshot_json_invalid');
    }
    try {
      const snapshot = parseRunExecutionSnapshot(storedSnapshot);
      if (snapshot.runId !== row.id || snapshot.threadId !== row.thread_id) {
        throw new Error('run_execution_snapshot_identity_mismatch');
      }
      return snapshot;
    } catch (error) {
      const code = error instanceof Error && error.message === 'run_execution_snapshot_identity_mismatch'
        ? 'run_execution_snapshot_identity_mismatch'
        : 'run_execution_snapshot_corrupt';
      this.quarantineRunSnapshot(row, code);
      throw new Error(code);
    }
  }

  transitionRun(input: {
    endedAt: string | null;
    expectedStateVersion: number;
    expectedStatus: TaskStatus;
    runId: string;
    status: TaskStatus;
  }): { run: TaskRun; stateVersion: number } {
    return this.db.transaction(() =>
      this.transitionRunInTransaction({
        ...input,
        updatedAt: new Date().toISOString()
      })
    )();
  }

  completeRunAtomically(input: {
    assistantMessage: string;
    durationMs: number;
    endedAt: string;
    expectedStateVersion: number;
    expectedStatus: TaskStatus;
    modelId: string;
    providerId: string;
    runId: string;
    runStartedAt: string;
    summary: string;
    workspaceHash: string | null;
  }): { event: TaskEvent; message: SessionMessageEntry; run: TaskRun; stateVersion: number } {
    return this.db.transaction(() => {
      const transition = this.transitionRunInTransaction({
        endedAt: input.endedAt,
        expectedStateVersion: input.expectedStateVersion,
        expectedStatus: input.expectedStatus,
        runId: input.runId,
        status: 'completed',
        updatedAt: input.endedAt
      });
      this.db.prepare('DELETE FROM agent_pending_interrupts WHERE run_id = ?').run(input.runId);

      const message: SessionMessageEntry = {
        id: `smsg_${randomUUID()}`,
        threadId: transition.run.threadId,
        threadTitle: this.findThreadTitle(transition.run.threadId),
        role: 'assistant',
        content: input.assistantMessage,
        phase: 'visible',
        tokenCount: null,
        workspaceHash: input.workspaceHash,
        createdAt: input.endedAt
      };
      this.db
        .prepare(
          `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, workspace_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          message.id,
          message.threadId,
          message.role,
          message.content,
          message.tokenCount,
          message.phase,
          message.workspaceHash,
          message.createdAt
        );

      const event: TaskEvent = {
        id: `event_${randomUUID()}`,
        threadId: transition.run.threadId,
        runId: transition.run.id,
        type: 'message',
        payload: {
          role: 'assistant',
          content: input.assistantMessage,
          providerId: input.providerId,
          modelId: input.modelId
        },
        createdAt: input.endedAt
      };
      this.insertEvent(event);
      this.insertEvent({
        id: `event_${randomUUID()}`,
        threadId: transition.run.threadId,
        runId: transition.run.id,
        type: 'agent_update',
        payload: {
          providerId: input.providerId,
          modelId: input.modelId,
          finishReason: 'stop',
          durationMs: input.durationMs,
          summary: input.summary
        },
        createdAt: input.endedAt
      });

      const runCompletedEvent: ChatRunEvent = {
        type: 'run_completed',
        runId: transition.run.id,
        threadId: transition.run.threadId,
        providerId: input.providerId,
        modelId: input.modelId,
        createdAt: input.runStartedAt,
        durationMs: input.durationMs,
        summary: input.summary,
        assistantMessage: input.assistantMessage
      };
      const sequence = this.nextRunEventSequence(transition.run.id);
      this.db
        .prepare(
          `INSERT INTO agent_run_events (run_id, sequence, event_json, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(transition.run.id, sequence, JSON.stringify(runCompletedEvent), input.endedAt);

      this.db
        .prepare(
          `INSERT INTO agent_outbox (id, event_type, run_id, thread_id, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          `outbox_${randomUUID()}`,
          'run_completed',
          transition.run.id,
          transition.run.threadId,
          JSON.stringify({
            assistantMessage: input.assistantMessage,
            durationMs: input.durationMs,
            finishReason: 'stop',
            modelId: input.modelId,
            providerId: input.providerId,
            summary: input.summary
          }),
          input.endedAt
        );

      return {
        event,
        message,
        run: transition.run,
        stateVersion: transition.stateVersion
      };
    })();
  }

  failRunAtomically(input: Omit<TerminalFailureInput, 'status'>): { event: TaskEvent; run: TaskRun; stateVersion: number } {
    return this.db.transaction(() => this.writeTerminalFailureInTransaction({ ...input, status: 'failed' }))();
  }

  interruptRunAtomically(input: Omit<TerminalFailureInput, 'status'>): { event: TaskEvent; run: TaskRun; stateVersion: number } {
    return this.db.transaction(() => this.writeTerminalFailureInTransaction({ ...input, status: 'interrupted' }))();
  }

  reconcileStartupRuns(): TaskRun[] {
    const candidates = this.db
      .prepare(
        `SELECT id, thread_id, status, state_version, provider_id, model_id
         FROM agent_runs
         WHERE snapshot_json IS NOT NULL
           AND status IN ('waiting_next_turn', 'dispatch_pending', 'running', 'recovering', 'waiting_user')`
      )
      .all() as StartupRunRow[];
    const reconciled: TaskRun[] = [];

    for (const candidate of candidates) {
      this.markRestartedToolEffectsUnknown(candidate.id);
      const evidence = this.readRestartEvidence(candidate);
      if (
        candidate.status === 'waiting_user' &&
        evidence.hasCheckpoint &&
        !evidence.hasInFlightEffect &&
        this.hasRecoverablePendingInterrupt(candidate.id)
      ) {
        this.verifyWaitingUserSnapshot(candidate.id);
        continue;
      }
      const providerId = requireNonEmpty(candidate.provider_id, 'agent_run_provider_missing');
      const modelId = requireNonEmpty(candidate.model_id, 'agent_run_model_missing');
      const restartFailure = readRestartFailure(evidence);
      const terminal = this.interruptRunAtomically({
        code: restartFailure.code,
        endedAt: new Date().toISOString(),
        error: restartFailure.message,
        expectedStateVersion: candidate.state_version,
        expectedStatus: candidate.status,
        modelId,
        providerId,
        retryable: restartFailure.retryable,
        runId: candidate.id
      });
      reconciled.push(terminal.run);
    }

    return reconciled;
  }

  markRunInterrupted(input: {
    expectedStateVersion: number;
    expectedStatus: TaskStatus;
    interrupt: PendingInterrupt;
    runId: string;
    threadId: string;
  }): TaskRun {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const transition = this.transitionRunInTransaction({
        endedAt: null,
        expectedStateVersion: input.expectedStateVersion,
        expectedStatus: input.expectedStatus,
        runId: input.runId,
        status: 'waiting_user',
        updatedAt: now
      });
      if (transition.run.threadId !== input.threadId) {
        throw new Error('agent_pending_interrupt_thread_mismatch');
      }
      this.db
        .prepare(
          `INSERT INTO agent_pending_interrupts
           (run_id, thread_id, interrupt_id, payload_json, mode, task_source, workflow_hint,
            workspace_path_state, workspace_path, explicit_skill_ids_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             thread_id = excluded.thread_id,
             interrupt_id = excluded.interrupt_id,
             payload_json = excluded.payload_json,
             mode = excluded.mode,
             task_source = excluded.task_source,
             workflow_hint = excluded.workflow_hint,
             workspace_path_state = excluded.workspace_path_state,
             workspace_path = excluded.workspace_path,
             explicit_skill_ids_json = excluded.explicit_skill_ids_json,
             updated_at = excluded.updated_at`
        )
        .run(
          input.runId,
          input.threadId,
          input.interrupt.interruptId,
          JSON.stringify(input.interrupt.payload),
          'snapshot',
          null,
          null,
          'null',
          null,
          null,
          now,
          now
        );
      return transition.run;
    })();
  }

  resumeRunAtomically(input: {
    expectedStateVersion: number;
    expectedStatus: TaskStatus;
    runId: string;
  }): TaskRun {
    return this.db.transaction(() => {
      const transition = this.transitionRunInTransaction({
        endedAt: null,
        expectedStateVersion: input.expectedStateVersion,
        expectedStatus: input.expectedStatus,
        runId: input.runId,
        status: 'running',
        updatedAt: new Date().toISOString()
      });
      this.db.prepare('DELETE FROM agent_pending_interrupts WHERE run_id = ?').run(input.runId);
      return transition.run;
    })();
  }

  cancelRunAtomically(input: {
    endedAt: string;
    expectedStateVersion: number;
    expectedStatus: TaskStatus;
    runId: string;
  }): { event: TaskEvent; run: TaskRun; stateVersion: number } {
    return this.db.transaction(() => {
      const transition = this.transitionRunInTransaction({
        endedAt: input.endedAt,
        expectedStateVersion: input.expectedStateVersion,
        expectedStatus: input.expectedStatus,
        runId: input.runId,
        status: 'cancelled',
        updatedAt: input.endedAt
      });
      this.db.prepare('DELETE FROM agent_pending_interrupts WHERE run_id = ?').run(input.runId);
      const event: TaskEvent = {
        id: `event_${randomUUID()}`,
        threadId: transition.run.threadId,
        runId: transition.run.id,
        type: 'agent_update',
        payload: {
          status: 'cancelled',
          reason: 'user_cancelled'
        },
        createdAt: input.endedAt
      };
      this.insertEvent(event);

      const runCancelledEvent: ChatRunEvent = {
        type: 'run_cancelled',
        runId: transition.run.id,
        threadId: transition.run.threadId,
        reason: 'user_cancelled'
      };
      const sequence = this.nextRunEventSequence(transition.run.id);
      this.db
        .prepare(
          `INSERT INTO agent_run_events (run_id, sequence, event_json, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(transition.run.id, sequence, JSON.stringify(runCancelledEvent), input.endedAt);
      this.db
        .prepare(
          `INSERT INTO agent_outbox (id, event_type, run_id, thread_id, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          `outbox_${randomUUID()}`,
          'run_cancelled',
          transition.run.id,
          transition.run.threadId,
          JSON.stringify({ reason: 'user_cancelled' }),
          input.endedAt
        );
      return {
        event,
        run: transition.run,
        stateVersion: transition.stateVersion
      };
    })();
  }

  getPendingInterrupt(runId: string): { runId: string; threadId: string; interrupt: PendingInterrupt } | null {
    const row = this.db
      .prepare('SELECT run_id, thread_id, interrupt_id, payload_json FROM agent_pending_interrupts WHERE run_id = ?')
      .get(runId) as
      | PendingInterruptRow
      | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      runId: row.run_id,
      threadId: row.thread_id,
      interrupt: {
        interruptId: row.interrupt_id,
        payload: JSON.parse(row.payload_json) as ChatInterruptPayload
      }
    };
  }

  clearPendingInterrupt(runId: string): void {
    this.db.prepare('DELETE FROM agent_pending_interrupts WHERE run_id = ?').run(runId);
  }

  recordNotificationFailure(code: string): void {
    const normalizedCode = requireNonEmpty(code, 'agent_notification_metric_code_empty');
    this.db
      .prepare(
        `INSERT INTO agent_notification_metrics (code, failure_count, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           failure_count = agent_notification_metrics.failure_count + 1,
           updated_at = excluded.updated_at`
      )
      .run(normalizedCode, 1, new Date().toISOString());
  }

  recordEvent(input: { threadId: string; runId: string; type: TaskEvent['type']; payload: unknown }): TaskEvent {
    const createdAt = new Date().toISOString();
    const event: TaskEvent = {
      id: `event_${randomUUID()}`,
      threadId: input.threadId,
      runId: input.runId,
      type: input.type,
      payload: input.payload,
      createdAt
    };
    this.db.transaction(() => {
      this.insertEvent(event);
    })();
    return event;
  }

  listThreadEvents(threadId: string): TaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, run_id, type, payload_json, created_at
         FROM agent_events
         WHERE thread_id = ?
         ORDER BY sequence ASC, created_at ASC, id ASC`
      )
      .all(threadId) as TaskEventRow[];
    return rows.map(mapTaskEvent);
  }

  recordSessionMessage(input: {
    threadId: string;
    role: SessionMessageEntry['role'];
    content: string;
    tokenCount?: number | null;
    phase?: SessionMessagePhase;
    workspaceHash?: string | null;
  }): SessionMessageEntry {
    const createdAt = new Date().toISOString();
    const tokenCount = input.tokenCount === undefined ? null : input.tokenCount;
    const phase = input.phase === undefined ? 'visible' : input.phase;
    const workspaceHash = input.workspaceHash === undefined ? null : input.workspaceHash;
    const id = `smsg_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, workspace_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.threadId, input.role, input.content, tokenCount, phase, workspaceHash, createdAt);
    return {
      id,
      threadId: input.threadId,
      threadTitle: this.findThreadTitle(input.threadId),
      role: input.role,
      content: input.content,
      phase,
      tokenCount,
      workspaceHash,
      createdAt
    };
  }

  listSessionMessages(input: { threadId: string; limit?: number }): SessionMessageEntry[] {
    const limit = input.limit === undefined ? 200 : input.limit;
    const rows = this.db
      .prepare(
        `SELECT sm.id, sm.thread_id, sm.role, sm.content, sm.token_count, sm.phase, sm.workspace_hash, sm.created_at,
                tt.title AS thread_title
         FROM session_messages sm
         LEFT JOIN agent_threads tt ON tt.id = sm.thread_id
         WHERE sm.thread_id = ?
         ORDER BY sm.created_at ASC, sm.id ASC
         LIMIT ?`
      )
      .all(input.threadId, limit) as SessionMessageRow[];
    return rows.map(mapSessionMessage);
  }

  searchSessionMessages(input: SessionMessageSearchRequest): SessionMessageSearchResult {
    const query = input.query.trim();
    if (query.length === 0) {
      return { query, total: 0, items: [] };
    }
    const limit = input.limit === undefined ? 10 : input.limit;
    const primaryQuery = canUseRawFtsQuery(query) ? query : buildPlainPrefixFtsQuery(query);
    if (primaryQuery === null) {
      return { query, total: 0, items: [] };
    }
    const rows = this.searchRows(primaryQuery, input, limit);
    const fallbackQuery = primaryQuery === query && rows.length === 0 ? buildPlainPrefixFtsQuery(query) : null;
    const finalRows = fallbackQuery === null ? rows : this.searchRows(fallbackQuery, input, limit);
    return {
      query,
      total: finalRows.length,
      items: finalRows.map((row) => ({
        ...mapSessionMessage(row),
        snippet: row.snippet
      }))
    };
  }

  private searchRows(query: string, input: SessionMessageSearchRequest, limit: number): SessionMessageSearchRow[] {
    const filters: string[] = [];
    const params: unknown[] = [query];
    if (input.workspaceScope === 'current') {
      if (input.workspaceHash === undefined || input.workspaceHash === null || input.workspaceHash.trim().length === 0) {
        throw new Error('session_search_workspace_required');
      }
      filters.push('sm.workspace_hash = ?');
      params.push(input.workspaceHash);
    }
    if (input.threadId !== undefined) {
      filters.push('sm.thread_id = ?');
      params.push(input.threadId);
    }
    if (input.sinceDays !== undefined) {
      filters.push("sm.created_at >= datetime('now', '-' || ? || ' days')");
      params.push(input.sinceDays);
    }
    const whereClause = filters.length === 0 ? '' : `AND ${filters.join(' AND ')}`;
    params.push(limit);
    return this.db
      .prepare(
        `SELECT sm.id, sm.thread_id, sm.role, sm.content, sm.token_count, sm.phase, sm.workspace_hash, sm.created_at,
                tt.title AS thread_title,
                snippet(session_messages_fts, 0, '**', '**', '...', 32) AS snippet
         FROM session_messages_fts
         JOIN session_messages sm ON sm.rowid = session_messages_fts.rowid
         LEFT JOIN agent_threads tt ON tt.id = sm.thread_id
         WHERE session_messages_fts MATCH ?
           ${whereClause}
         ORDER BY sm.created_at DESC
         LIMIT ?`
      )
      .all(...params) as SessionMessageSearchRow[];
  }

  private nextRunNumber(threadId: string): number {
    const row = this.db.prepare('SELECT MAX(run_number) AS max_run_number FROM agent_runs WHERE thread_id = ?').get(threadId) as
      | { max_run_number: number | null }
      | undefined;
    if (row === undefined || row.max_run_number === null) {
      return 1;
    }
    return row.max_run_number + 1;
  }

  private nextEventSequence(threadId: string): number {
    const row = this.db
      .prepare('SELECT next_sequence FROM agent_thread_event_cursors WHERE thread_id = ?')
      .get(threadId) as
      | { next_sequence: number }
      | undefined;
    if (row === undefined) {
      this.db
        .prepare(
          `INSERT INTO agent_thread_event_cursors (thread_id, next_sequence)
           VALUES (?, ?)`
        )
        .run(threadId, 2);
      return 1;
    }
    this.db
      .prepare('UPDATE agent_thread_event_cursors SET next_sequence = ? WHERE thread_id = ?')
      .run(row.next_sequence + 1, threadId);
    return row.next_sequence;
  }

  private nextRunEventSequence(runId: string): number {
    const row = this.db
      .prepare('SELECT next_sequence FROM agent_run_event_cursors WHERE run_id = ?')
      .get(runId) as { next_sequence: number } | undefined;
    if (row === undefined) {
      throw new Error('agent_run_event_cursor_missing');
    }
    if (row.next_sequence === agentRunEventLogMaxEvents + 1) {
      this.db.prepare('DELETE FROM agent_run_events WHERE run_id = ? AND sequence = ?').run(runId, agentRunEventLogMaxEvents);
      return agentRunEventLogMaxEvents;
    }
    if (row.next_sequence > agentRunEventLogMaxEvents) {
      throw new Error('agent_run_event_terminal_capacity_exceeded');
    }
    this.db
      .prepare('UPDATE agent_run_event_cursors SET next_sequence = ? WHERE run_id = ?')
      .run(row.next_sequence + 1, runId);
    return row.next_sequence;
  }

  private transitionRunInTransaction(input: {
    endedAt: string | null;
    expectedStateVersion: number;
    expectedStatus: TaskStatus;
    runId: string;
    status: TaskStatus;
    updatedAt: string;
  }): { run: TaskRun; stateVersion: number } {
    const current = this.db
      .prepare('SELECT id, thread_id, status, state_version FROM agent_runs WHERE id = ?')
      .get(input.runId) as RunStateRow | undefined;
    if (current === undefined) {
      throw new Error('task_run_not_found');
    }
    if (current.status !== input.expectedStatus || current.state_version !== input.expectedStateVersion) {
      throw createRunTransitionConflictError(input.runId);
    }
    if (!allowedRunTransitions[current.status].includes(input.status)) {
      throw createRunTransitionInvalidError({ currentStatus: current.status, nextStatus: input.status, runId: input.runId });
    }
    const nextStateVersion = current.state_version + 1;
    const update = this.db
      .prepare(
        `UPDATE agent_runs
         SET status = ?, ended_at = ?, state_version = ?
         WHERE id = ? AND status = ? AND state_version = ?`
      )
      .run(input.status, input.endedAt, nextStateVersion, input.runId, input.expectedStatus, input.expectedStateVersion);
    if (update.changes !== 1) {
      throw createRunTransitionConflictError(input.runId);
    }
    this.db
      .prepare('UPDATE agent_threads SET status = ?, updated_at = ? WHERE id = ?')
      .run(input.status, input.updatedAt, current.thread_id);
    if (isTerminalRunStatus(input.status)) {
      this.db.prepare('DELETE FROM agent_run_leases WHERE run_id = ?').run(input.runId);
    }
    return {
      run: this.getRun(input.runId),
      stateVersion: nextStateVersion
    };
  }

  private writeTerminalFailureInTransaction(input: TerminalFailureInput): {
    event: TaskEvent;
    run: TaskRun;
    stateVersion: number;
  } {
    const transition = this.transitionRunInTransaction({
      endedAt: input.endedAt,
      expectedStateVersion: input.expectedStateVersion,
      expectedStatus: input.expectedStatus,
      runId: input.runId,
      status: input.status,
      updatedAt: input.endedAt
    });
    this.db.prepare('DELETE FROM agent_pending_interrupts WHERE run_id = ?').run(input.runId);

    const event: TaskEvent = {
      id: `event_${randomUUID()}`,
      threadId: transition.run.threadId,
      runId: transition.run.id,
      type: 'error',
      payload: {
        code: input.code,
        error: input.error,
        retryable: input.retryable,
        ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
        ...(input.suggestion === undefined ? {} : { suggestion: input.suggestion })
      },
      createdAt: input.endedAt
    };
    this.insertEvent(event);

    const runFailedEvent: ChatRunEvent = {
      type: 'run_failed',
      runId: transition.run.id,
      threadId: transition.run.threadId,
      code: input.code,
      message: input.error,
      retryable: input.retryable,
      ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
      ...(input.suggestion === undefined ? {} : { suggestion: input.suggestion })
    };
    const sequence = this.nextRunEventSequence(transition.run.id);
    this.db
      .prepare(
        `INSERT INTO agent_run_events (run_id, sequence, event_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(transition.run.id, sequence, JSON.stringify(runFailedEvent), input.endedAt);

    this.db
      .prepare(
        `INSERT INTO agent_outbox (id, event_type, run_id, thread_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        `outbox_${randomUUID()}`,
        'run_failed',
        transition.run.id,
        transition.run.threadId,
        JSON.stringify({
          code: input.code,
          error: input.error,
          modelId: input.modelId,
          providerId: input.providerId,
          retryable: input.retryable,
          ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
          ...(input.suggestion === undefined ? {} : { suggestion: input.suggestion })
        }),
        input.endedAt
      );

    return {
      event,
      run: transition.run,
      stateVersion: transition.stateVersion
    };
  }

  private insertEvent(event: TaskEvent): void {
    this.db
      .prepare(
        `INSERT INTO agent_events (id, thread_id, run_id, sequence, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.threadId,
        event.runId,
        this.nextEventSequence(event.threadId),
        event.type,
        JSON.stringify(event.payload),
        event.createdAt
      );
  }

  private quarantineRunSnapshot(
    row: {
      id: string;
      thread_id: string;
      status: TaskStatus;
      state_version: number;
      provider_id: string | null;
      model_id: string | null;
      snapshot_error_code: string | null;
    },
    code: string
  ): void {
    if (row.snapshot_error_code !== null) {
      return;
    }
    const now = new Date().toISOString();
    this.db.transaction(() => {
      if (isTerminalRunStatus(row.status)) {
        this.db.prepare('UPDATE agent_runs SET snapshot_error_code = ? WHERE id = ?').run(code, row.id);
      } else {
        this.writeTerminalFailureInTransaction({
          code,
          endedAt: now,
          error: `Run execution snapshot is unavailable: ${code}.`,
          expectedStateVersion: row.state_version,
          expectedStatus: row.status,
          modelId: requireNonEmpty(row.model_id, 'agent_run_model_missing'),
          providerId: requireNonEmpty(row.provider_id, 'agent_run_provider_missing'),
          retryable: false,
          runId: row.id,
          status: 'interrupted'
        });
        this.db.prepare('UPDATE agent_runs SET snapshot_error_code = ? WHERE id = ?').run(code, row.id);
      }
      if (isTerminalRunStatus(row.status)) {
        this.insertEvent({
          id: `event_${randomUUID()}`,
          threadId: row.thread_id,
          runId: row.id,
          type: 'error',
          payload: { code },
          createdAt: now
        });
      }
    })();
  }

  private hasRecoverablePendingInterrupt(runId: string): boolean {
    const row = this.db
      .prepare('SELECT interrupt_id, payload_json FROM agent_pending_interrupts WHERE run_id = ?')
      .get(runId) as { interrupt_id: string; payload_json: string } | undefined;
    if (row === undefined || row.interrupt_id.trim().length === 0) {
      return false;
    }
    try {
      const payload = JSON.parse(row.payload_json) as unknown;
      return typeof payload === 'object' && payload !== null && !Array.isArray(payload) && 'kind' in payload;
    } catch {
      return false;
    }
  }

  private readRestartEvidence(candidate: StartupRunRow): RestartEvidence {
    const checkpoint = this.db
      .prepare('SELECT 1 FROM langgraph_checkpoints WHERE thread_id = ? LIMIT 1')
      .get(candidate.thread_id) as { 1: number } | undefined;
    const effect = this.db
      .prepare("SELECT 1 FROM agent_tool_effects WHERE run_id = ? AND status = 'unknown' LIMIT 1")
      .get(candidate.id) as { 1: number } | undefined;
    return {
      hasCheckpoint: checkpoint !== undefined,
      hasInFlightEffect: effect !== undefined
    };
  }

  private markRestartedToolEffectsUnknown(runId: string): void {
    this.db
      .prepare(
        `UPDATE agent_tool_effects
         SET status = 'unknown', updated_at = ?
         WHERE run_id = ? AND status = 'in_progress'`
      )
      .run(new Date().toISOString(), runId);
  }

  private verifyWaitingUserSnapshot(runId: string): void {
    try {
      this.getRunExecutionSnapshot(runId);
    } catch (error) {
      if (this.getRun(runId).status !== 'interrupted') {
        throw error;
      }
    }
  }

  private hasActiveThread(threadId: string): boolean {
    const row = this.db.prepare('SELECT id FROM agent_threads WHERE id = ? AND archived_at IS NULL').get(threadId) as
      | { id: string }
      | undefined;
    return row !== undefined;
  }

  private findActiveRun(threadId: string): { id: string; status: TaskStatus } | null {
    const row = this.db
      .prepare(
        `SELECT runs.id, runs.status
         FROM agent_run_leases AS leases
         JOIN agent_runs AS runs ON runs.id = leases.run_id
         WHERE leases.thread_id = ?`
      )
      .get(threadId) as { id: string; status: TaskStatus } | undefined;
    if (row === undefined) {
      return null;
    }
    return row;
  }

  private findThreadTitle(threadId: string): string | null {
    const row = this.db.prepare('SELECT title FROM agent_threads WHERE id = ?').get(threadId) as { title: string } | undefined;
    if (row === undefined) {
      return null;
    }
    return row.title;
  }
}

function isTerminalRunStatus(status: TaskStatus): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'completed' || status === 'interrupted' || status === 'archived';
}

function readRestartFailure(evidence: RestartEvidence): { code: string; message: string; retryable: boolean } {
  if (evidence.hasInFlightEffect) {
    return {
      code: 'agent_run_interrupted_on_restart_effect_unknown',
      message: 'The run was interrupted because Roc restarted while a tool effect remained in progress.',
      retryable: false
    };
  }
  if (!evidence.hasCheckpoint) {
    return {
      code: 'agent_run_interrupted_on_restart_checkpoint_missing',
      message: 'The run was interrupted because Roc restarted without a recoverable checkpoint.',
      retryable: false
    };
  }
  return {
    code: 'agent_run_interrupted_on_restart',
    message: 'The run was interrupted because Roc restarted before it reached a terminal state.',
    retryable: true
  };
}

function createThreadRunConflictError(threadId: string): RocDomainError {
  return new RocDomainError({
    code: 'thread_run_conflict',
    message: `Thread ${threadId} already has an active run.`,
    category: 'conflict',
    retryable: true,
    userAction: '请等待当前运行结束，或先取消当前运行。'
  });
}

function createRunTransitionConflictError(runId: string): RocDomainError {
  return new RocDomainError({
    code: 'agent_run_transition_conflict',
    message: `Run ${runId} changed before the requested transition completed.`,
    category: 'conflict',
    retryable: true,
    userAction: '请刷新运行状态后重试。'
  });
}

function createRunTransitionInvalidError(input: { currentStatus: TaskStatus; nextStatus: TaskStatus; runId: string }): RocDomainError {
  return new RocDomainError({
    code: 'agent_run_transition_invalid',
    message: `Run ${input.runId} cannot transition from ${input.currentStatus} to ${input.nextStatus}.`,
    category: 'conflict',
    retryable: false,
    userAction: '请检查运行状态机。'
  });
}

function isThreadLeaseConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('agent_run_leases.thread_id');
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

function mapTaskEvent(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at
  };
}

function mapSessionMessage(row: SessionMessageRow): SessionMessageEntry {
  return {
    id: row.id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    role: row.role,
    content: row.content,
    phase: row.phase,
    tokenCount: row.token_count,
    workspaceHash: row.workspace_hash,
    createdAt: row.created_at
  };
}

function requireNonEmpty(value: string | null, code: string): string {
  if (value === null) {
    throw new Error(code);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(code);
  }
  return normalized;
}

function buildPlainPrefixFtsQuery(query: string): string | null {
  const tokens = Array.from(query.matchAll(/[\p{L}\p{N}_]+/gu), (match) => match[0])
    .filter((token) => !/^(?:OR|AND|NOT|NEAR)$/iu.test(token));
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `${token}*`).join(' ');
}

function canUseRawFtsQuery(query: string): boolean {
  return /^[\p{L}\p{N}_\s]+$/u.test(query) && !/\b(?:OR|AND|NOT|NEAR)\b/iu.test(query);
}
