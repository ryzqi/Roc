import type Database from 'better-sqlite3';

import type { RocEventBus, RocEventEnvelope, RocPluginContext } from '../../../../src/main/kernel/types';
import { applyTaskDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import type { EnabledCapabilities, TaskEvent, TaskKind, TaskStatus } from '../../../../src/shared/types';

export function createTaskPluginTestDatabaseFacade(
  taskDb: Database.Database,
  _agentDb: Database.Database
): RocPluginContext['database'] {
  applyTaskDatabaseSchema(taskDb);
  return {
    getConnection: () => taskDb,
  };
}

export function createTaskPluginTestEventBus(agentDb: Database.Database): RocEventBus & { published: RocEventEnvelope[] } {
  const subscriptions: Array<{
    type: string;
    handler: (event: RocEventEnvelope) => void | Promise<void>;
  }> = [];
  return {
    published: [],
    publish: async function publish(event) {
      persistAgentHistory(agentDb, event);
      this.published.push(event);
      for (const subscription of subscriptions.filter((item) => item.type === event.type)) {
        await subscription.handler(event);
      }
    },
    subscribe: (type, handler) => {
      const subscription = {
        type,
        handler: handler as (event: RocEventEnvelope) => void | Promise<void>
      };
      subscriptions.push(subscription);
      return () => {
        const index = subscriptions.indexOf(subscription);
        if (index !== -1) {
          subscriptions.splice(index, 1);
        }
      };
    }
  };
}

function persistAgentHistory(db: Database.Database, event: RocEventEnvelope): void {
  if (event.source !== '@roc/plugin-agent') {
    return;
  }
  if (event.type === 'agent.run.started') {
    persistRunStarted(db, event);
    return;
  }
  if (event.type === 'agent.run.completed') {
    persistRunCompleted(db, event);
    return;
  }
  if (event.type === 'agent.run.failed') {
    persistRunFailed(db, event);
    return;
  }
  if (event.type === 'agent.run.task-event') {
    persistTaskEvent(db, event);
  }
}

function persistRunStarted(db: Database.Database, event: RocEventEnvelope): void {
  const payload = readRecord(event.payload, 'agent_run_started_payload_invalid');
  const runId = readString(payload, 'runId');
  const threadId = readString(payload, 'threadId');
  const mode = readString(payload, 'mode');
  const providerId = readString(payload, 'providerId');
  const modelId = readString(payload, 'modelId');
  const createdAt = readString(payload, 'createdAt');
  const userInput = readString(payload, 'userInput');
  const enabledCapabilities = readEnabledCapabilities(payload, 'enabledCapabilities');
  const threadKind = readThreadKind(mode);
  const workflowHint = readOptionalString(payload, 'workflowHint');
  const taskSource = readOptionalString(payload, 'taskSource');
  const workspacePath = readOptionalString(payload, 'workspacePath');
  const title = userInput.trim().slice(0, 60);
  const capabilityPreview = readOptionalRecord(payload, 'capabilityPreview');

  db.transaction(() => {
    if (hasActiveThread(db, threadId)) {
      db.prepare('UPDATE agent_threads SET status = ?, updated_at = ? WHERE id = ?').run('running', createdAt, threadId);
    } else {
      db.prepare(
        `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(threadId, threadKind, title, userInput, 'running', createdAt, createdAt);
    }
    db.prepare(
      `INSERT INTO agent_runs
       (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
        enabled_capabilities_json, workspace_path, task_source, workflow_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runId,
      threadId,
      nextRunNumber(db, threadId),
      userInput,
      'running',
      createdAt,
      null,
      providerId,
      modelId,
      JSON.stringify(enabledCapabilities),
      workspacePath,
      taskSource,
      workflowHint
    );
    insertAgentEvent(db, threadId, runId, 'message', { role: 'user', content: userInput, enabledCapabilities }, createdAt);
    if (capabilityPreview !== null) {
      const manifest = readRecord(capabilityPreview, 'manifest');
      insertAgentEvent(
        db,
        threadId,
        runId,
        'context_manifest',
        {
          manifest,
          requestedCapabilities: readUnknown(manifest, 'requestedCapabilities'),
          resolvedCapabilities: readUnknown(manifest, 'resolvedCapabilities'),
          skippedCapabilities: readUnknown(manifest, 'skippedCapabilities'),
          toolCards: readUnknown(capabilityPreview, 'toolCards'),
          skillCards: readUnknown(capabilityPreview, 'skillCards'),
          untrustedContextPolicy: readUnknown(manifest, 'untrustedContextPolicy')
        },
        createdAt
      );
    }
    insertAgentEvent(db, threadId, runId, 'agent_update', { status: 'running' }, createdAt);
  })();
}

function persistRunCompleted(db: Database.Database, event: RocEventEnvelope): void {
  const payload = readRecord(event.payload, 'agent_run_completed_payload_invalid');
  const runId = readString(payload, 'runId');
  const threadId = readString(payload, 'threadId');
  const providerId = readString(payload, 'providerId');
  const modelId = readString(payload, 'modelId');
  const finishReason = readString(payload, 'finishReason');
  const durationMs = readNumber(payload, 'durationMs');
  const summary = readString(payload, 'summary');
  const assistantMessage = readString(payload, 'assistantMessage');
  const createdAt = event.createdAt;

  db.transaction(() => {
    updateRunAndThreadStatus(db, runId, threadId, 'completed', createdAt);
    insertAgentEvent(
      db,
      threadId,
      runId,
      'message',
      { role: 'assistant', content: assistantMessage, providerId, modelId },
      createdAt
    );
    insertAgentEvent(
      db,
      threadId,
      runId,
      'agent_update',
      { status: 'completed', providerId, modelId, finishReason, durationMs, summary },
      createdAt
    );
    db.prepare(
      `INSERT INTO agent_outbox (id, event_type, run_id, thread_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      `outbox_test_completed_${runId}`,
      'run_completed',
      runId,
      threadId,
      JSON.stringify({ assistantMessage, durationMs, finishReason, modelId, providerId, summary }),
      createdAt
    );
  })();
}

function persistRunFailed(db: Database.Database, event: RocEventEnvelope): void {
  const payload = readRecord(event.payload, 'agent_run_failed_payload_invalid');
  const runId = readString(payload, 'runId');
  const threadId = readString(payload, 'threadId');
  const providerId = readString(payload, 'providerId');
  const modelId = readString(payload, 'modelId');
  const error = readString(payload, 'error');
  const code = readString(payload, 'code');
  const retryable = readBoolean(payload, 'retryable');
  const createdAt = event.createdAt;

  db.transaction(() => {
    updateRunAndThreadStatus(db, runId, threadId, 'failed', createdAt);
    insertAgentEvent(
      db,
      threadId,
      runId,
      'error',
      { code, error, retryable },
      createdAt
    );
    db.prepare(
      `INSERT INTO agent_outbox (id, event_type, run_id, thread_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      `outbox_test_failed_${runId}`,
      'run_failed',
      runId,
      threadId,
      JSON.stringify({ code, error, modelId, providerId, retryable }),
      createdAt
    );
  })();
}

function persistTaskEvent(db: Database.Database, event: RocEventEnvelope): void {
  const payload = readRecord(event.payload, 'agent_task_event_payload_invalid');
  const runId = readString(payload, 'runId');
  const threadId = readString(payload, 'threadId');
  const type = readString(payload, 'type') as TaskEvent['type'];
  const eventPayload = readRecord(payload, 'payload');
  const createdAt = event.createdAt;

  db.transaction(() => {
    if (type === 'approval_requested') {
      updateRunAndThreadStatus(db, runId, threadId, 'waiting_user', null);
    }
    if (type === 'approval_decision') {
      updateRunAndThreadStatus(db, runId, threadId, 'running', null);
    }
    insertAgentEvent(db, threadId, runId, type, eventPayload, createdAt);
  })();
}

function insertAgentEvent(
  db: Database.Database,
  threadId: string,
  runId: string,
  type: TaskEvent['type'],
  payload: unknown,
  createdAt: string
): void {
  const sequence = nextEventSequence(db, threadId);
  db.prepare(
    `INSERT INTO agent_events (id, thread_id, run_id, sequence, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(`event_test_${threadId}_${sequence}`, threadId, runId, sequence, type, JSON.stringify(payload), createdAt);
}

function updateRunAndThreadStatus(
  db: Database.Database,
  runId: string,
  threadId: string,
  status: TaskStatus,
  endedAt: string | null
): void {
  db.prepare('UPDATE agent_threads SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    endedAt === null ? new Date().toISOString() : endedAt,
    threadId
  );
  db.prepare('UPDATE agent_runs SET status = ?, ended_at = ? WHERE id = ?').run(status, endedAt, runId);
}

function hasActiveThread(db: Database.Database, threadId: string): boolean {
  const row = db.prepare('SELECT id FROM agent_threads WHERE id = ? AND archived_at IS NULL').get(threadId) as
    | { id: string }
    | undefined;
  return row !== undefined;
}

function nextRunNumber(db: Database.Database, threadId: string): number {
  const row = db.prepare('SELECT MAX(run_number) AS max_run_number FROM agent_runs WHERE thread_id = ?').get(threadId) as
    | { max_run_number: number | null }
    | undefined;
  if (row === undefined || row.max_run_number === null) {
    return 1;
  }
  return row.max_run_number + 1;
}

function nextEventSequence(db: Database.Database, threadId: string): number {
  const row = db
    .prepare('SELECT next_sequence FROM agent_thread_event_cursors WHERE thread_id = ?')
    .get(threadId) as
    | { next_sequence: number }
    | undefined;
  if (row === undefined) {
    db.prepare(
      `INSERT INTO agent_thread_event_cursors (thread_id, next_sequence)
       VALUES (?, ?)`
    ).run(threadId, 2);
    return 1;
  }
  db.prepare('UPDATE agent_thread_event_cursors SET next_sequence = ? WHERE thread_id = ?').run(row.next_sequence + 1, threadId);
  return row.next_sequence;
}

function readThreadKind(mode: string): TaskKind {
  if (mode === 'task') {
    return 'background';
  }
  if (mode === 'chat' || mode === 'plan') {
    return 'chat';
  }
  throw new Error('agent_run_mode_invalid');
}

function readEnabledCapabilities(payload: Record<string, unknown>, key: string): EnabledCapabilities {
  const value = readRecord(payload, key);
  const mcpServers = readStringArray(value, 'mcpServers');
  const skills = readStringArray(value, 'skills');
  return { mcpServers, skills };
}

function readStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = readUnknown(payload, key);
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key}_invalid`);
  }
  return value;
}

function readOptionalRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = payload[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key}_invalid`);
  }
  return value as Record<string, unknown>;
}

function readRecord(payload: unknown, key: string): Record<string, unknown> {
  const value = typeof payload === 'object' && payload !== null && key in payload ? (payload as Record<string, unknown>)[key] : payload;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${key}_invalid`);
  }
  return value as Record<string, unknown>;
}

function readUnknown(payload: Record<string, unknown>, key: string): unknown {
  if (!(key in payload)) {
    throw new Error(`${key}_missing`);
  }
  return payload[key];
}

function readString(payload: Record<string, unknown>, key: string): string {
  const value = readUnknown(payload, key);
  if (typeof value !== 'string') {
    throw new Error(`${key}_invalid`);
  }
  return value;
}

function readOptionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key}_invalid`);
  }
  return value;
}

function readNumber(payload: Record<string, unknown>, key: string): number {
  const value = readUnknown(payload, key);
  if (typeof value !== 'number') {
    throw new Error(`${key}_invalid`);
  }
  return value;
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean {
  const value = readUnknown(payload, key);
  if (typeof value !== 'boolean') {
    throw new Error(`${key}_invalid`);
  }
  return value;
}
