import { randomUUID } from 'node:crypto';
import type {
  AgentCapabilityManifest,
  AgentCapabilityPreview,
  EnabledCapabilities,
  ProviderExecutionResult,
  TaskEvent,
  TaskRun
} from '../../../shared/types';
import type { DatabaseService } from '../database-service';
import { requireText } from './validation';
import { nextRunNumber, requireActiveThread } from './thread-queries';

export function createTaskRun(input: {
  database: DatabaseService;
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
  const runNumber = existingThreadId === null ? 1 : nextRunNumber(input.database, threadId);

  const transaction = input.database.db.transaction(() => {
    if (existingThreadId === null) {
      const title = input.userInput.trim().slice(0, 60);
      input.database.db
        .prepare(
          `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(threadId, 'chat', title, input.userInput, 'waiting_next_turn', now, now);
    } else {
      requireActiveThread(input.database, threadId);
      input.database.db
        .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
        .run('waiting_next_turn', now, threadId);
    }

    input.database.db
      .prepare(
        `INSERT INTO task_runs
         (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(runId, threadId, runNumber, input.userInput, 'waiting_next_turn', now, null, input.modelId, enabledCapabilitiesJson);

    input.database.db
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

export function archiveThread(input: { database: DatabaseService; threadId: string }): { deleted: true; threadId: string } {
  const normalizedThreadId = requireText(
    input.threadId,
    'task_thread_id_empty',
    '任务会话 ID 不能为空。',
    '请选择一个要删除的历史会话。'
  );
  requireActiveThread(input.database, normalizedThreadId);
  const now = new Date().toISOString();

  const transaction = input.database.db.transaction(() => {
    input.database.db
      .prepare('UPDATE task_threads SET status = ?, updated_at = ?, archived_at = ? WHERE id = ?')
      .run('archived', now, now, normalizedThreadId);
    input.database.db
      .prepare('UPDATE background_tasks SET status = ?, updated_at = ? WHERE thread_id = ? AND status != ?')
      .run('archived', now, normalizedThreadId, 'archived');
  });
  transaction();

  return {
    deleted: true,
    threadId: normalizedThreadId
  };
}

export function getRun(input: { database: DatabaseService; id: string }): TaskRun {
  const row = input.database.db
    .prepare(
      `SELECT id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json
       FROM task_runs
       WHERE id = ?`
    )
    .get(input.id) as
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
    throw new Error(`Task run not found: ${input.id}`);
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

export function listThreadMessages(input: { database: DatabaseService; threadId: string }): TaskEvent[] {
  const normalizedThreadId = requireText(
    input.threadId,
    'task_thread_id_empty',
    '任务会话 ID 不能为空。',
    '请选择一个有效的会话后再继续查看消息。'
  );
  requireActiveThread(input.database, normalizedThreadId);

  const rows = input.database.db
    .prepare(
      `SELECT rowid, id, thread_id, run_id, type, payload_json, created_at
       FROM task_events
       WHERE thread_id = ?
         AND type IN (
           'message',
           'message_delta',
           'reasoning_delta',
           'tool_call',
           'subagent_started',
           'subagent_completed',
           'guardrail_nudge'
         )
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(normalizedThreadId) as Array<{
    rowid: number;
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
    createdAt: event.created_at,
    sequence: event.rowid
  }));
}

export function markRunRunning(input: { database: DatabaseService; runId: string }): void {
  const run = getRun({ database: input.database, id: input.runId });
  const now = new Date().toISOString();
  const transaction = input.database.db.transaction(() => {
    input.database.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('running', now, run.threadId);
    input.database.db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('running', run.id);
    insertTaskEvent(input.database, {
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

export function markRunWaitingUser(input: { database: DatabaseService; runId: string }): void {
  const run = getRun({ database: input.database, id: input.runId });
  const now = new Date().toISOString();
  const transaction = input.database.db.transaction(() => {
    input.database.db
      .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
      .run('waiting_user', now, run.threadId);
    input.database.db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('waiting_user', run.id);
    insertTaskEvent(input.database, {
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

export function markRunResumed(input: { database: DatabaseService; runId: string }): void {
  const run = getRun({ database: input.database, id: input.runId });
  const now = new Date().toISOString();
  const transaction = input.database.db.transaction(() => {
    input.database.db
      .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
      .run('running', now, run.threadId);
    input.database.db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('running', run.id);
    insertTaskEvent(input.database, {
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

export function completeRunWithProviderResult(input: {
  database: DatabaseService;
  runId: string;
  result: ProviderExecutionResult;
}): void {
  const run = getRun({ database: input.database, id: input.runId });
  const now = new Date().toISOString();
  const transaction = input.database.db.transaction(() => {
    input.database.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('completed', now, run.threadId);
    input.database.db.prepare('UPDATE task_runs SET status = ?, ended_at = ? WHERE id = ?').run('completed', now, run.id);
    input.database.db
      .prepare('UPDATE background_tasks SET last_run_status = ?, updated_at = ? WHERE run_id = ?')
      .run('success', now, run.id);
    insertTaskEvent(input.database, {
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
    insertTaskEvent(input.database, {
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

export function failRunWithProviderError(input: {
  database: DatabaseService;
  runId: string;
  providerId: string;
  modelId: string;
  code: string;
  diagnostic?: {
    badKeys?: string[];
    schemaPath?: string;
    toolName?: string;
  };
  message: string;
  retryable: boolean;
  suggestion?: string;
}): void {
  const run = getRun({ database: input.database, id: input.runId });
  const now = new Date().toISOString();
  const transaction = input.database.db.transaction(() => {
    input.database.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, run.threadId);
    input.database.db.prepare('UPDATE task_runs SET status = ?, ended_at = ? WHERE id = ?').run('failed', now, run.id);
    input.database.db
      .prepare('UPDATE background_tasks SET status = ?, last_run_status = ?, updated_at = ? WHERE run_id = ?')
      .run('failed', 'failed', now, run.id);
    insertTaskEvent(input.database, {
      threadId: run.threadId,
      runId: run.id,
      type: 'error',
      payload: {
        code: input.code,
        diagnostic: input.diagnostic,
        message: input.message,
        providerId: input.providerId,
        modelId: input.modelId,
        retryable: input.retryable,
        suggestion: input.suggestion
      }
    });
  });
  transaction();
}

export function recordAgentCapabilityManifest(input: {
  database: DatabaseService;
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
  insertTaskEvent(input.database, {
    threadId: input.threadId,
    runId: input.runId,
    type: 'context_manifest',
    payload: manifest
  });
  return manifest;
}

function insertTaskEvent(database: DatabaseService, input: {
  threadId: string;
  runId: string;
  type: TaskEvent['type'];
  payload: unknown;
}): void {
  database.db
    .prepare(
      `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(`event_${randomUUID()}`, input.threadId, input.runId, input.type, JSON.stringify(input.payload), new Date().toISOString());
}
