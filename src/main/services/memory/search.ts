import type {
  MemoryLayer,
  MemorySearchRequest,
  MemorySearchResult,
  SessionSearchRequest
} from '../../../shared/types';
import type { DatabaseService } from '../database-service';
import { hasTable } from './db';
import { readMemoryBody, summarize } from './markdown';
import type { SessionRecallRow } from './types';
import { requireText } from './validation';

export function searchDegradedReason(database: DatabaseService): string {
  const fullTextStatus = hasTable(database, 'memory_entries_fts') ? 'FTS5 is available.' : 'FTS5 is unavailable.';
  return `Vector index is not configured. ${fullTextStatus} Search falls back to deterministic local indexes.`;
}

export function searchCuratedItems(
  database: DatabaseService,
  request: MemorySearchRequest,
  query: string
): MemorySearchResult['items'] {
  const byId = new Map<string, MemorySearchResult['items'][number]>();
  for (const item of searchMemoryFts(database, request, query)) {
    byId.set(item.id, item);
  }
  for (const item of searchMemoryFallback(database, request, query)) {
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

function searchMemoryFts(
  database: DatabaseService,
  request: MemorySearchRequest,
  query: string
): MemorySearchResult['items'] {
  if (!hasTable(database, 'memory_entries_fts')) {
    return [];
  }

  const includeCold = request.includeCold === true;
  const rows =
    request.scope === undefined
      ? (database.db
          .prepare(
            `SELECT i.id, i.layer, i.scope, i.confidence, i.source_ref, i.markdown_path
             FROM memory_entries_fts f
             JOIN memory_entries_index i ON i.id = f.memory_id
             WHERE memory_entries_fts MATCH ?
               AND i.status = 'active'
               AND (i.layer IN ('hot', 'warm') OR (? = 1 AND i.layer = 'cold'))
             ORDER BY rank
             LIMIT 20`
          )
          .all(query, includeCold ? 1 : 0) as Array<{
          id: string;
          layer: MemoryLayer;
          scope: string;
          confidence: number;
          source_ref: string;
          markdown_path: string;
        }>)
      : (database.db
          .prepare(
            `SELECT i.id, i.layer, i.scope, i.confidence, i.source_ref, i.markdown_path
             FROM memory_entries_fts f
             JOIN memory_entries_index i ON i.id = f.memory_id
             WHERE memory_entries_fts MATCH ?
               AND i.status = 'active'
               AND i.scope = ?
               AND (i.layer IN ('hot', 'warm') OR (? = 1 AND i.layer = 'cold'))
             ORDER BY rank
             LIMIT 20`
          )
          .all(query, request.scope, includeCold ? 1 : 0) as Array<{
          id: string;
          layer: MemoryLayer;
          scope: string;
          confidence: number;
          source_ref: string;
          markdown_path: string;
        }>);

  return rows.map((row) => ({
    id: row.id,
    layer: row.layer,
    scope: row.scope,
    confidence: row.confidence,
    sourceRef: row.source_ref,
    reason: 'SQLite FTS5 keyword match',
    summary: summarize(readMemoryBody(row.markdown_path))
  }));
}

function searchMemoryFallback(
  database: DatabaseService,
  request: MemorySearchRequest,
  query: string
): MemorySearchResult['items'] {
  const includeCold = request.includeCold === true;
  const rows =
    request.scope === undefined
      ? (database.db
          .prepare(
            `SELECT id, layer, scope, confidence, source_ref, markdown_path
             FROM memory_entries_index
             WHERE status = 'active'
               AND (layer IN ('hot', 'warm') OR (? = 1 AND layer = 'cold'))
             ORDER BY updated_at DESC
             LIMIT 50`
          )
          .all(includeCold ? 1 : 0) as Array<{
          id: string;
          layer: MemoryLayer;
          scope: string;
          confidence: number;
          source_ref: string;
          markdown_path: string;
        }>)
      : (database.db
          .prepare(
            `SELECT id, layer, scope, confidence, source_ref, markdown_path
             FROM memory_entries_index
             WHERE status = 'active'
               AND scope = ?
               AND (layer IN ('hot', 'warm') OR (? = 1 AND layer = 'cold'))
             ORDER BY updated_at DESC
             LIMIT 50`
          )
          .all(request.scope, includeCold ? 1 : 0) as Array<{
          id: string;
          layer: MemoryLayer;
          scope: string;
          confidence: number;
          source_ref: string;
          markdown_path: string;
        }>);

  const loweredQuery = query.toLocaleLowerCase();
  return rows
    .map((row) => ({ row, content: readMemoryBody(row.markdown_path) }))
    .filter(({ row, content }) => `${row.scope}\n${content}`.toLocaleLowerCase().includes(loweredQuery))
    .map(({ row, content }) => ({
      id: row.id,
      layer: row.layer,
      scope: row.scope,
      confidence: row.confidence,
      sourceRef: row.source_ref,
      reason: 'Markdown fallback keyword match',
      summary: summarize(content)
    }));
}

export function searchSessionItems(
  database: DatabaseService,
  request: SessionSearchRequest
): MemorySearchResult['items'] {
  return searchSessionRows(database, request).map((row) => ({
    id: row.id,
    layer: 'session',
    scope: row.scope,
    confidence: 1,
    sourceRef: row.source_ref,
    reason: hasTable(database, 'session_recall_fts') ? 'SQLite FTS5 session match' : 'Markdown session keyword match',
    summary: summarize(row.summary)
  }));
}

export function searchSessionRows(database: DatabaseService, request: SessionSearchRequest): SessionRecallRow[] {
  const query = requireText(
    request.query,
    'session_query_empty',
    '会话回忆检索 query 不能为空。',
    '请输入要检索的会话关键词。'
  );
  const rowsById = new Map<string, SessionRecallRow>();

  if (hasTable(database, 'session_recall_fts')) {
    const ftsRows =
      request.scope === undefined
        ? (database.db
            .prepare(
              `SELECT s.id, s.scope, s.title, s.summary, s.source_ref, s.markdown_path, s.created_at
               FROM session_recall_fts f
               JOIN session_recall_index s ON s.id = f.session_id
               WHERE session_recall_fts MATCH ?
               ORDER BY rank
               LIMIT 20`
            )
            .all(query) as SessionRecallRow[])
        : (database.db
            .prepare(
              `SELECT s.id, s.scope, s.title, s.summary, s.source_ref, s.markdown_path, s.created_at
               FROM session_recall_fts f
               JOIN session_recall_index s ON s.id = f.session_id
               WHERE session_recall_fts MATCH ?
                 AND s.scope = ?
               ORDER BY rank
               LIMIT 20`
            )
            .all(query, request.scope) as SessionRecallRow[]);
    for (const row of ftsRows) {
      rowsById.set(row.id, row);
    }
  }

  const fallbackRows =
    request.scope === undefined
      ? (database.db
          .prepare(
            `SELECT id, scope, title, summary, source_ref, markdown_path, created_at
             FROM session_recall_index
             ORDER BY created_at DESC
             LIMIT 50`
          )
          .all() as SessionRecallRow[])
      : (database.db
          .prepare(
            `SELECT id, scope, title, summary, source_ref, markdown_path, created_at
             FROM session_recall_index
             WHERE scope = ?
             ORDER BY created_at DESC
             LIMIT 50`
          )
          .all(request.scope) as SessionRecallRow[]);
  const loweredQuery = query.toLocaleLowerCase();
  for (const row of fallbackRows) {
    const content = readMemoryBody(row.markdown_path);
    const searchable = `${row.scope}\n${row.title}\n${row.summary}\n${content}`.toLocaleLowerCase();
    if (searchable.includes(loweredQuery) && !rowsById.has(row.id)) {
      rowsById.set(row.id, row);
    }
  }

  return [...rowsById.values()];
}
