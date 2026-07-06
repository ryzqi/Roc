import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  ChatInterruptPayload,
  ChatPersistedAttachment,
  EnabledCapabilities,
  SessionMessageEntry,
  SessionMessagePhase,
  SessionMessageSearchRequest,
  SessionMessageSearchResult,
  TaskEvent,
  TaskKind,
  TaskRun,
  TaskStatus
} from '../../../shared/types';
import type { PendingInterrupt } from './runtime-types';

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
  mode: PendingInterrupt['mode'];
  task_source: PendingInterrupt['taskSource'];
  workflow_hint: PendingInterrupt['workflowHint'];
  workspace_path_state: 'undefined' | 'null' | 'value';
  workspace_path: string | null;
  explicit_skill_ids_json: string | null;
  created_at: string;
  updated_at: string;
};

export class AgentSessionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  createTaskRun(input: {
    userInput: string;
    modelId: string;
    enabledCapabilities: EnabledCapabilities;
    threadKind: TaskKind;
    threadId?: string;
    attachments?: ChatPersistedAttachment[];
  }): TaskRun {
    const now = new Date().toISOString();
    const runId = `run_${randomUUID()}`;
    const eventId = `event_${randomUUID()}`;
    const existingThreadId = input.threadId === undefined ? null : requireNonEmpty(input.threadId, 'thread_id_empty');
    const threadId = existingThreadId === null ? `thread_${randomUUID()}` : existingThreadId;
    const hasActiveThread = existingThreadId !== null && this.hasActiveThread(threadId);
    const runNumber = existingThreadId === null || !hasActiveThread ? 1 : this.nextRunNumber(threadId);
    const enabledCapabilitiesJson = JSON.stringify(input.enabledCapabilities);
    const userMessagePayload: {
      role: 'user';
      content: string;
      enabledCapabilities: EnabledCapabilities;
      attachments?: ChatPersistedAttachment[];
    } = {
      role: 'user',
      content: input.userInput,
      enabledCapabilities: input.enabledCapabilities
    };
    if (input.attachments !== undefined && input.attachments.length > 0) {
      userMessagePayload.attachments = input.attachments;
    }

    this.db
      .transaction(() => {
        if (existingThreadId === null || !hasActiveThread) {
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
              enabled_capabilities_json, workspace_path, task_source, workflow_hint)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            runId,
            threadId,
            runNumber,
            input.userInput,
            'waiting_next_turn',
            now,
            null,
            null,
            input.modelId,
            enabledCapabilitiesJson,
            null,
            null,
            null
          );

        this.db
          .prepare(
            `INSERT INTO agent_events (id, thread_id, run_id, sequence, type, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            eventId,
            threadId,
            runId,
            this.nextEventSequence(threadId),
            'message',
            JSON.stringify(userMessagePayload),
            now
          );
      })();

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

  getRun(id: string): TaskRun {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as TaskRunRow | undefined;
    if (row === undefined) {
      throw new Error('task_run_not_found');
    }
    return mapTaskRun(row);
  }

  updateRunStatus(input: { runId: string; status: TaskStatus; endedAt?: string | null }): TaskRun {
    const run = this.getRun(input.runId);
    const now = new Date().toISOString();
    const endedAt = input.endedAt === undefined ? run.endedAt : input.endedAt;
    this.db
      .transaction(() => {
        this.db.prepare('UPDATE agent_runs SET status = ?, ended_at = ? WHERE id = ?').run(input.status, endedAt, input.runId);
        this.db.prepare('UPDATE agent_threads SET status = ?, updated_at = ? WHERE id = ?').run(input.status, now, run.threadId);
      })();
    return this.getRun(input.runId);
  }

  markRunInterrupted(input: { runId: string; threadId: string; interrupt: PendingInterrupt }): TaskRun {
    const run = this.getRun(input.runId);
    if (run.threadId !== input.threadId) {
      throw new Error('agent_pending_interrupt_thread_mismatch');
    }
    const now = new Date().toISOString();
    const workspacePath = encodeWorkspacePath(input.interrupt.workspacePath);
    const explicitSkillIdsJson =
      input.interrupt.explicitSkillIds === undefined ? null : JSON.stringify(input.interrupt.explicitSkillIds);
    this.db.transaction(() => {
      this.db.prepare('UPDATE agent_runs SET status = ?, ended_at = ? WHERE id = ?').run('waiting_user', null, input.runId);
      this.db.prepare('UPDATE agent_threads SET status = ?, updated_at = ? WHERE id = ?').run('waiting_user', now, run.threadId);
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
          input.interrupt.mode,
          input.interrupt.taskSource,
          input.interrupt.workflowHint,
          workspacePath.state,
          workspacePath.value,
          explicitSkillIdsJson,
          now,
          now
        );
    })();
    return this.getRun(input.runId);
  }

  getPendingInterrupt(runId: string): { runId: string; threadId: string; interrupt: PendingInterrupt } | null {
    const row = this.db.prepare('SELECT * FROM agent_pending_interrupts WHERE run_id = ?').get(runId) as
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
        payload: JSON.parse(row.payload_json) as ChatInterruptPayload,
        mode: row.mode,
        taskSource: row.task_source,
        workflowHint: row.workflow_hint,
        workspacePath: decodeWorkspacePath(row),
        explicitSkillIds:
          row.explicit_skill_ids_json === null ? undefined : JSON.parse(row.explicit_skill_ids_json) as string[]
      }
    };
  }

  clearPendingInterrupt(runId: string): void {
    this.db.prepare('DELETE FROM agent_pending_interrupts WHERE run_id = ?').run(runId);
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
    const sequence = this.nextEventSequence(input.threadId);
    this.db
      .prepare(
        `INSERT INTO agent_events (id, thread_id, run_id, sequence, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(event.id, event.threadId, event.runId, sequence, event.type, JSON.stringify(event.payload), event.createdAt);
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
    const row = this.db.prepare('SELECT MAX(sequence) AS max_sequence FROM agent_events WHERE thread_id = ?').get(threadId) as
      | { max_sequence: number | null }
      | undefined;
    if (row === undefined) {
      return 1;
    }
    if (row.max_sequence === null) {
      return 1;
    }
    return row.max_sequence + 1;
  }

  private hasActiveThread(threadId: string): boolean {
    const row = this.db.prepare('SELECT id FROM agent_threads WHERE id = ? AND archived_at IS NULL').get(threadId) as
      | { id: string }
      | undefined;
    return row !== undefined;
  }

  private findThreadTitle(threadId: string): string | null {
    const row = this.db.prepare('SELECT title FROM agent_threads WHERE id = ?').get(threadId) as { title: string } | undefined;
    if (row === undefined) {
      return null;
    }
    return row.title;
  }
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

function requireNonEmpty(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(code);
  }
  return normalized;
}

function encodeWorkspacePath(workspacePath: PendingInterrupt['workspacePath']): { state: 'undefined' | 'null' | 'value'; value: string | null } {
  if (workspacePath === undefined) {
    return { state: 'undefined', value: null };
  }
  if (workspacePath === null) {
    return { state: 'null', value: null };
  }
  return { state: 'value', value: workspacePath };
}

function decodeWorkspacePath(row: Pick<PendingInterruptRow, 'workspace_path_state' | 'workspace_path'>): PendingInterrupt['workspacePath'] {
  if (row.workspace_path_state === 'undefined') {
    return undefined;
  }
  if (row.workspace_path_state === 'null') {
    return null;
  }
  if (row.workspace_path_state === 'value') {
    if (row.workspace_path === null) {
      throw new Error('agent_pending_interrupt_workspace_path_missing');
    }
    return row.workspace_path;
  }
  throw new Error('agent_pending_interrupt_workspace_path_state_invalid');
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
