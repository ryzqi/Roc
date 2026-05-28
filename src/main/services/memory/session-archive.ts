import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../database-service';
import type {
  SessionMessageEntry,
  SessionMessagePhase,
  SessionMessageSearchRequest,
  SessionMessageSearchResult
} from '../../../shared/types';

type Role = 'user' | 'assistant' | 'tool' | 'system';

export class SessionArchiveService {
  private idSequence = 0;

  constructor(private readonly database: DatabaseService) {}

  recordUserInput(threadId: string, content: string, phase: SessionMessagePhase = 'visible'): void {
    this.insert(threadId, 'user', content, null, phase);
  }

  recordAssistantMessage(
    threadId: string,
    content: string,
    tokenCount: number | null,
    phase: SessionMessagePhase = 'visible'
  ): void {
    this.insert(threadId, 'assistant', content, tokenCount, phase);
  }

  recordToolCall(
    threadId: string,
    toolName: string,
    args: unknown,
    result: unknown,
    phase: SessionMessagePhase = 'visible'
  ): void {
    const body = JSON.stringify({ tool: toolName, args, result });
    this.insert(threadId, 'tool', body, null, phase);
  }

  recordSystemMessage(threadId: string, content: string, phase: SessionMessagePhase = 'visible'): void {
    this.insert(threadId, 'system', content, null, phase);
  }

  search(input: SessionMessageSearchRequest): SessionMessageSearchResult {
    const query = input.query.trim();
    if (query.length === 0) {
      return { query, total: 0, items: [] };
    }

    const limit = input.limit === undefined ? 10 : input.limit;
    const filters: string[] = [];
    const params: unknown[] = [];
    if (input.threadId !== undefined) {
      filters.push('sm.thread_id = ?');
      params.push(input.threadId);
    }
    if (input.sinceDays !== undefined) {
      filters.push("sm.created_at >= datetime('now', '-' || ? || ' days')");
      params.push(input.sinceDays);
    }
    const whereClause = filters.length === 0 ? '' : `AND ${filters.join(' AND ')}`;

    let rows = this.searchRows(query, whereClause, params, limit);
    const prefixQuery = buildPlainPrefixFtsQuery(query);
    if (rows.length === 0 && prefixQuery !== null) {
      rows = this.searchRows(prefixQuery, whereClause, params, limit);
    }

    return {
      query,
      total: rows.length,
      items: rows.map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        threadTitle: row.thread_title,
        role: row.role,
        content: row.content,
        phase: row.phase,
        tokenCount: row.token_count,
        createdAt: row.created_at,
        snippet: row.snippet
      }))
    };
  }

  private searchRows(
    ftsQuery: string,
    whereClause: string,
    params: readonly unknown[],
    limit: number
  ): Array<{
      id: string;
      thread_id: string;
      role: Role;
      content: string;
      phase: SessionMessagePhase;
      token_count: number | null;
      created_at: string;
      thread_title: string | null;
      snippet: string;
    }> {
    return this.database.db
      .prepare(
        `SELECT sm.id, sm.thread_id, sm.role, sm.content, sm.token_count, sm.phase, sm.created_at,
                tt.title AS thread_title,
                snippet(session_messages_fts, 0, '**', '**', '…', 32) AS snippet
         FROM session_messages_fts
         JOIN session_messages sm ON sm.rowid = session_messages_fts.rowid
         LEFT JOIN task_threads tt ON tt.id = sm.thread_id
         WHERE session_messages_fts MATCH ?
           ${whereClause}
         ORDER BY sm.created_at DESC
         LIMIT ?`
      )
      .all(ftsQuery, ...params, limit) as Array<{
      id: string;
      thread_id: string;
      role: Role;
      content: string;
      phase: SessionMessagePhase;
      token_count: number | null;
      created_at: string;
      thread_title: string | null;
      snippet: string;
    }>;
  }

  list(threadId: string, limit = 200): SessionMessageEntry[] {
    const rows = this.database.db
      .prepare(
        `SELECT sm.id, sm.thread_id, sm.role, sm.content, sm.token_count, sm.phase, sm.created_at,
                tt.title AS thread_title
         FROM session_messages sm
         LEFT JOIN task_threads tt ON tt.id = sm.thread_id
         WHERE sm.thread_id = ?
         ORDER BY sm.created_at ASC, sm.id ASC
         LIMIT ?`
      )
      .all(threadId, limit) as Array<{
      id: string;
      thread_id: string;
      role: Role;
      content: string;
      phase: SessionMessagePhase;
      token_count: number | null;
      created_at: string;
      thread_title: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      threadTitle: row.thread_title,
      role: row.role,
      content: row.content,
      phase: row.phase,
      tokenCount: row.token_count,
      createdAt: row.created_at
    }));
  }

  sweepRetention(retentionDays: number): { deletedRows: number } {
    const result = this.database.db
      .prepare("DELETE FROM session_messages WHERE created_at < datetime('now', '-' || ? || ' days')")
      .run(retentionDays);
    return { deletedRows: result.changes };
  }

  private insert(
    threadId: string,
    role: Role,
    content: string,
    tokenCount: number | null,
    phase: SessionMessagePhase
  ): void {
    this.idSequence += 1;
    this.database.db
      .prepare(
        `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `smsg_${Date.now().toString(36)}_${this.idSequence.toString().padStart(6, '0')}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        threadId,
        role,
        content,
        tokenCount,
        phase,
        new Date().toISOString()
      );
  }
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
