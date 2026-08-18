import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  AgentOutboxEvent,
  BackgroundTask,
  EnabledCapabilities,
  PersistedTaskEvent,
  TaskEvent,
  TaskKind,
  TaskMessageHistoryPage,
  TaskMessageHistoryRequest,
  TaskRun,
  TaskSnapshot,
  TaskStatus,
  TaskThread
} from '../../../shared/types';
import { taskEventSchema } from '../../../shared/schemas/task-event';
import { deleteAgentThreadHistory } from '../../infrastructure/agent-history-deletion';
import { RocDomainError } from '../../services/errors';
const recentEventLimit = 50;

export class AgentTaskHistoryReader {
  constructor(private readonly agentDb: DatabaseConnection) {}

  ensureBackgroundTaskThread(task: BackgroundTask): void {
    const enabledCapabilities = task.enabledCapabilities === null ? emptyCapabilities() : task.enabledCapabilities;
    this.agentDb.transaction(() => {
      this.agentDb
        .prepare(
          `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             goal = excluded.goal,
             status = excluded.status,
             updated_at = excluded.updated_at,
             archived_at = NULL`
        )
        .run(task.threadId, 'background', task.goal.trim().slice(0, 60), task.goal, task.status, task.createdAt, task.updatedAt);
      this.agentDb
        .prepare(
          `INSERT INTO agent_runs
           (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
            enabled_capabilities_json, workspace_path, task_source, workflow_hint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             user_input = excluded.user_input,
             status = excluded.status,
             enabled_capabilities_json = excluded.enabled_capabilities_json,
             workspace_path = excluded.workspace_path,
             task_source = excluded.task_source,
             workflow_hint = excluded.workflow_hint`
        )
        .run(
          task.runId,
          task.threadId,
          1,
          task.goal,
          task.status,
          task.createdAt,
          null,
          null,
          null,
          JSON.stringify(enabledCapabilities),
          task.workspacePath,
          'workbench',
          'background_task'
        );
    })();
  }

  updateBackgroundTaskThread(task: BackgroundTask): void {
    this.agentDb
      .prepare('UPDATE agent_threads SET title = ?, goal = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(task.goal.trim().slice(0, 60), task.goal, task.status, task.updatedAt, task.threadId);
  }

  archiveThread(threadId: string, archivedAt: string): void {
    this.agentDb
      .prepare('UPDATE agent_threads SET status = ?, updated_at = ?, archived_at = ? WHERE id = ?')
      .run('archived', archivedAt, archivedAt, threadId);
  }

  deleteThread(threadId: string): void {
    deleteAgentThreadHistory(this.agentDb, threadId);
  }

  recordBackgroundTaskEvent(task: BackgroundTask, type: TaskEvent['type'], payload: Record<string, unknown>): TaskEvent {
    const createdAt = new Date().toISOString();
    const event = taskEventSchema.parse({
      id: `event_${randomUUID()}`,
      threadId: task.threadId,
      runId: task.runId,
      type,
      payload,
      createdAt
    });
    this.agentDb.transaction(() => {
      const sequence = this.nextEventSequence(task.threadId);
      this.agentDb
        .prepare(
          `INSERT INTO agent_events (id, thread_id, run_id, sequence, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(event.id, event.threadId, event.runId, sequence, event.type, JSON.stringify(event.payload), event.createdAt);
    })();
    return event;
  }

  findActiveThread(threadId: string): TaskThread | null {
    const row = this.agentDb
      .prepare(
        `SELECT id,
                CASE WHEN kind = 'background' THEN 'background' ELSE 'chat' END AS kind,
                title, goal, status, created_at, updated_at
         FROM agent_threads
         WHERE id = ? AND archived_at IS NULL`
      )
      .get(threadId) as TaskThreadRow | undefined;
    if (row === undefined) {
      return null;
    }
    return mapTaskThread(row);
  }

  requireActiveThread(threadId: string): TaskThread {
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

  findRun(runId: string): TaskRun | null {
    const row = this.agentDb
      .prepare(
        `SELECT id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json
         FROM agent_runs
         WHERE id = ?`
      )
      .get(runId) as TaskRunRow | undefined;
    if (row === undefined) {
      return null;
    }
    return mapTaskRun(row);
  }

  listRunsForThread(threadId: string, limit: number): TaskRun[] {
    const rows = this.agentDb
      .prepare(
        `SELECT id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json
         FROM agent_runs
         WHERE thread_id = ?
         ORDER BY run_number DESC
         LIMIT ?`
      )
      .all(threadId, limit) as TaskRunRow[];
    return rows.map(mapTaskRun);
  }

  listEventsForThread(threadId: string): TaskEvent[] {
    const rows = this.agentDb
      .prepare(
        `SELECT sequence AS rowid, id, thread_id, run_id, type, payload_json, created_at
         FROM agent_events
         WHERE thread_id = ?
         ORDER BY sequence ASC, created_at ASC, id ASC`
      )
      .all(threadId) as Array<TaskEventRow & { rowid: number }>;
    return rows.map(mapTaskEvent);
  }

  listEventPage(request: TaskMessageHistoryRequest): TaskMessageHistoryPage {
    const rows = request.cursor === null
      ? (this.agentDb
          .prepare(
            `SELECT sequence, id, thread_id, run_id, type, payload_json, created_at
             FROM agent_events
             WHERE thread_id = ?
             ORDER BY sequence DESC
             LIMIT ?`
          )
          .all(request.threadId, request.limit) as PersistedTaskEventRow[]).reverse()
      : request.cursor.direction === 'before'
        ? (this.agentDb
            .prepare(
              `SELECT sequence, id, thread_id, run_id, type, payload_json, created_at
               FROM agent_events
               WHERE thread_id = ? AND sequence < ?
               ORDER BY sequence DESC
               LIMIT ?`
            )
            .all(request.threadId, request.cursor.sequence, request.limit) as PersistedTaskEventRow[]).reverse()
        : (this.agentDb
            .prepare(
              `SELECT sequence, id, thread_id, run_id, type, payload_json, created_at
               FROM agent_events
               WHERE thread_id = ? AND sequence > ?
               ORDER BY sequence ASC
               LIMIT ?`
            )
            .all(request.threadId, request.cursor.sequence, request.limit) as PersistedTaskEventRow[]);
    return buildTaskMessageHistoryPage(this.agentDb, request, rows.map(mapPersistedTaskEvent));
  }

  listRecentEventsForThread(threadId: string, limit: number): TaskEvent[] {
    const rows = this.agentDb
      .prepare(
        `SELECT sequence AS rowid, id, thread_id, run_id, type, payload_json, created_at
         FROM agent_events
         WHERE thread_id = ?
         ORDER BY created_at DESC, sequence DESC
         LIMIT ?`
      )
      .all(threadId, limit) as Array<TaskEventRow & { rowid: number }>;
    return rows.map(mapTaskEvent);
  }

  listEventsForRun(threadId: string, runId: string): TaskEvent[] {
    const rows = this.agentDb
      .prepare(
        `SELECT sequence AS rowid, id, thread_id, run_id, type, payload_json, created_at
         FROM agent_events
         WHERE thread_id = ? AND run_id = ?
         ORDER BY created_at DESC, sequence DESC`
      )
      .all(threadId, runId) as Array<TaskEventRow & { rowid: number }>;
    return rows.map(mapTaskEvent);
  }

  listOutboxEventsAfter(input: { afterSequence: number; limit: number }): AgentOutboxEvent[] {
    if (!Number.isInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new Error('agent_outbox_after_sequence_invalid');
    }
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new Error('agent_outbox_limit_invalid');
    }
    const rows = this.agentDb
      .prepare(
        `SELECT sequence, id, event_type, run_id, thread_id, payload_json, created_at
         FROM agent_outbox
         WHERE sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`
      )
      .all(input.afterSequence, input.limit) as AgentOutboxRow[];
    return rows.map(mapAgentOutboxEvent);
  }

  readThreads(): TaskSnapshot['threads'] {
    const rows = this.agentDb
      .prepare(
        `SELECT id,
                CASE WHEN kind = 'background' THEN 'background' ELSE 'chat' END AS kind,
                title, goal, status, created_at, updated_at
         FROM agent_threads
         WHERE archived_at IS NULL
         ORDER BY updated_at DESC`
      )
      .all() as TaskThreadRow[];
    return rows.map(mapTaskThread);
  }

  readRecentEvents(): TaskEvent[] {
    const rows = this.agentDb
      .prepare(
        `SELECT sequence AS rowid, id, thread_id, run_id, type, payload_json, created_at
         FROM agent_events
         ORDER BY created_at DESC, sequence DESC
         LIMIT ?`
      )
      .all(recentEventLimit) as Array<TaskEventRow & { rowid: number }>;
    return rows.map(mapTaskEvent);
  }

  private nextEventSequence(threadId: string): number {
    const row = this.agentDb
      .prepare('SELECT next_sequence FROM agent_thread_event_cursors WHERE thread_id = ?')
      .get(threadId) as
      | { next_sequence: number }
      | undefined;
    if (row === undefined) {
      this.agentDb
        .prepare(
          `INSERT INTO agent_thread_event_cursors (thread_id, next_sequence)
           VALUES (?, ?)`
        )
        .run(threadId, 2);
      return 1;
    }
    this.agentDb
      .prepare('UPDATE agent_thread_event_cursors SET next_sequence = ? WHERE thread_id = ?')
      .run(row.next_sequence + 1, threadId);
    return row.next_sequence;
  }
}

type PersistedTaskEventRow = TaskEventRow & { sequence: number };

type AgentOutboxRow = {
  sequence: number;
  id: string;
  event_type: string;
  run_id: string;
  thread_id: string;
  payload_json: string;
  created_at: string;
};

function mapAgentOutboxEvent(row: AgentOutboxRow): AgentOutboxEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new Error('agent_outbox_payload_json_invalid');
  }
  const record = requireOutboxPayloadRecord(payload);
  if (row.event_type === 'run_completed') {
    const finishReason = requireOutboxString(record, 'finishReason');
    if (finishReason !== 'stop') {
      throw new Error('agent_outbox_payload_invalid');
    }
    return {
      id: row.id,
      sequence: row.sequence,
      eventType: 'run_completed',
      runId: row.run_id,
      threadId: row.thread_id,
      payload: {
        assistantMessage: requireOutboxString(record, 'assistantMessage'),
        durationMs: requireOutboxNumber(record, 'durationMs'),
        finishReason,
        modelId: requireOutboxString(record, 'modelId'),
        providerId: requireOutboxString(record, 'providerId'),
        summary: requireOutboxString(record, 'summary')
      },
      createdAt: row.created_at
    };
  }
  if (row.event_type === 'run_failed') {
    const diagnostic = readOptionalOutboxDiagnostic(record);
    const suggestion = readOptionalOutboxString(record, 'suggestion');
    return {
      id: row.id,
      sequence: row.sequence,
      eventType: 'run_failed',
      runId: row.run_id,
      threadId: row.thread_id,
      payload: {
        code: requireOutboxString(record, 'code'),
        error: requireOutboxString(record, 'error'),
        modelId: requireOutboxString(record, 'modelId'),
        providerId: requireOutboxString(record, 'providerId'),
        retryable: requireOutboxBoolean(record, 'retryable'),
        ...(diagnostic === undefined ? {} : { diagnostic }),
        ...(suggestion === undefined ? {} : { suggestion })
      },
      createdAt: row.created_at
    };
  }
  if (row.event_type === 'run_cancelled') {
    const reason = requireOutboxString(record, 'reason');
    if (reason !== 'user_cancelled') {
      throw new Error('agent_outbox_payload_invalid');
    }
    return {
      id: row.id,
      sequence: row.sequence,
      eventType: 'run_cancelled',
      runId: row.run_id,
      threadId: row.thread_id,
      payload: { reason },
      createdAt: row.created_at
    };
  }
  if (row.event_type === 'run_deleted') {
    if (Object.keys(record).length !== 0) {
      throw new Error('agent_outbox_payload_invalid');
    }
    return {
      id: row.id,
      sequence: row.sequence,
      eventType: 'run_deleted',
      runId: row.run_id,
      threadId: row.thread_id,
      payload: {},
      createdAt: row.created_at
    };
  }
  throw new Error('agent_outbox_event_type_invalid');
}

function requireOutboxPayloadRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('agent_outbox_payload_invalid');
  }
  return value as Record<string, unknown>;
}

function requireOutboxString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new Error('agent_outbox_payload_invalid');
  }
  return field;
}

function readOptionalOutboxString(value: Record<string, unknown>, key: string): string | undefined {
  if (!(key in value)) {
    return undefined;
  }
  return requireOutboxString(value, key);
}

function readOptionalOutboxDiagnostic(
  value: Record<string, unknown>
): { badKeys?: string[]; schemaPath?: string; toolName?: string } | undefined {
  if (!('diagnostic' in value)) {
    return undefined;
  }
  const diagnostic = requireOutboxPayloadRecord(value.diagnostic);
  const badKeys = readOptionalOutboxStringArray(diagnostic, 'badKeys');
  const schemaPath = readOptionalOutboxString(diagnostic, 'schemaPath');
  const toolName = readOptionalOutboxString(diagnostic, 'toolName');
  return {
    ...(badKeys === undefined ? {} : { badKeys }),
    ...(schemaPath === undefined ? {} : { schemaPath }),
    ...(toolName === undefined ? {} : { toolName })
  };
}

function readOptionalOutboxStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  if (!(key in value)) {
    return undefined;
  }
  const field = value[key];
  if (!Array.isArray(field) || field.some((entry) => typeof entry !== 'string')) {
    throw new Error('agent_outbox_payload_invalid');
  }
  return field;
}

function requireOutboxNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    throw new Error('agent_outbox_payload_invalid');
  }
  return field;
}

function requireOutboxBoolean(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new Error('agent_outbox_payload_invalid');
  }
  return field;
}

function mapPersistedTaskEvent(row: PersistedTaskEventRow): PersistedTaskEvent {
  const event = mapTaskEvent({ ...row, rowid: row.sequence });
  if (event.sequence === undefined) {
    throw new Error('task_history_sequence_missing');
  }
  return { ...event, sequence: event.sequence };
}

function buildTaskMessageHistoryPage(
  db: DatabaseConnection,
  request: TaskMessageHistoryRequest,
  items: PersistedTaskEvent[]
): TaskMessageHistoryPage {
  const oldestSequence = items[0] === undefined ? null : items[0].sequence;
  const newestItem = items.at(-1);
  const newestSequence = newestItem === undefined ? null : newestItem.sequence;
  if (oldestSequence !== null && newestSequence !== null) {
    return {
      items,
      oldestSequence,
      newestSequence,
      hasMoreBefore: eventExists(db, request.threadId, '<', oldestSequence),
      hasMoreAfter: eventExists(db, request.threadId, '>', newestSequence)
    };
  }
  if (request.cursor === null) {
    return { items: [], oldestSequence: null, newestSequence: null, hasMoreBefore: false, hasMoreAfter: false };
  }
  return {
    items: [],
    oldestSequence: null,
    newestSequence: null,
    hasMoreBefore:
      request.cursor.direction === 'after'
        ? eventExists(db, request.threadId, '<', request.cursor.sequence)
        : false,
    hasMoreAfter:
      request.cursor.direction === 'before'
        ? eventExists(db, request.threadId, '>', request.cursor.sequence)
        : false
  };
}

function eventExists(
  db: DatabaseConnection,
  threadId: string,
  operator: '<' | '>',
  sequence: number
): boolean {
  const value = db
    .prepare(`SELECT EXISTS(SELECT 1 FROM agent_events WHERE thread_id = ? AND sequence ${operator} ?)`)
    .pluck()
    .get(threadId, sequence);
  return value === 1;
}

function emptyCapabilities(): EnabledCapabilities {
  return {
    mcpServers: [],
    skills: []
  };
}

type TaskEventRow = {
  id: string;
  thread_id: string;
  run_id: string;
  type: TaskEvent['type'];
  payload_json: string;
  created_at: string;
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

type TaskThreadRow = {
  id: string;
  kind: TaskKind;
  title: string;
  goal: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
};

function mapTaskEvent(row: TaskEventRow & { rowid?: number }): TaskEvent {
  return taskEventSchema.parse({
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
    sequence: row.rowid
  });
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
