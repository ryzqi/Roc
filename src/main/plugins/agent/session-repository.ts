import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
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
              `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(threadId, input.threadKind, input.userInput.trim().slice(0, 60), input.userInput, 'waiting_next_turn', now, now);
        } else {
          this.db
            .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
            .run('waiting_next_turn', now, threadId);
        }

        this.db
          .prepare(
            `INSERT INTO task_runs
             (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(runId, threadId, runNumber, input.userInput, 'waiting_next_turn', now, null, input.modelId, enabledCapabilitiesJson);

        this.db
          .prepare(
            `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            eventId,
            threadId,
            runId,
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
    const row = this.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as TaskRunRow | undefined;
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
        this.db.prepare('UPDATE task_runs SET status = ?, ended_at = ? WHERE id = ?').run(input.status, endedAt, input.runId);
        this.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run(input.status, now, run.threadId);
      })();
    return this.getRun(input.runId);
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
    this.db
      .prepare(
        `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(event.id, event.threadId, event.runId, event.type, JSON.stringify(event.payload), event.createdAt);
    return event;
  }

  listThreadEvents(threadId: string): TaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, run_id, type, payload_json, created_at
         FROM task_events
         WHERE thread_id = ?
         ORDER BY created_at ASC, id ASC`
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
         LEFT JOIN task_threads tt ON tt.id = sm.thread_id
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
    const rows = this.searchRows(query, input, limit);
    const fallbackQuery = rows.length === 0 ? buildPlainPrefixFtsQuery(query) : null;
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
         LEFT JOIN task_threads tt ON tt.id = sm.thread_id
         WHERE session_messages_fts MATCH ?
           ${whereClause}
         ORDER BY sm.created_at DESC
         LIMIT ?`
      )
      .all(...params) as SessionMessageSearchRow[];
  }

  private nextRunNumber(threadId: string): number {
    const row = this.db.prepare('SELECT MAX(run_number) AS max_run_number FROM task_runs WHERE thread_id = ?').get(threadId) as
      | { max_run_number: number | null }
      | undefined;
    if (row === undefined || row.max_run_number === null) {
      return 1;
    }
    return row.max_run_number + 1;
  }

  private hasActiveThread(threadId: string): boolean {
    const row = this.db.prepare('SELECT id FROM task_threads WHERE id = ? AND archived_at IS NULL').get(threadId) as
      | { id: string }
      | undefined;
    return row !== undefined;
  }

  private findThreadTitle(threadId: string): string | null {
    const row = this.db.prepare('SELECT title FROM task_threads WHERE id = ?').get(threadId) as { title: string } | undefined;
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

function buildPlainPrefixFtsQuery(query: string): string | null {
  if (/[":*()^{}+\-]/.test(query) || /\b(?:OR|AND|NOT|NEAR)\b/i.test(query)) {
    return null;
  }
  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `${token}*`).join(' ');
}
