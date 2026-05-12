import type { MemoryEntry, SessionRecallEntry } from '../../../shared/types';
import type { DatabaseService } from '../database-service';
import { hasTable } from './db';
import { readMemoryBody, summarize } from './markdown';

export function upsertMemoryFts(database: DatabaseService, entry: MemoryEntry, markdownPath: string): void {
  if (!hasTable(database, 'memory_entries_fts')) {
    return;
  }
  const content = readMemoryBody(markdownPath);
  deleteMemoryFts(database, entry.id);
  database.db
    .prepare(
      `INSERT INTO memory_entries_fts (memory_id, content, summary, scope, layer)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(entry.id, content, summarize(content), entry.scope, entry.layer);
}

export function deleteMemoryFts(database: DatabaseService, id: string): void {
  if (!hasTable(database, 'memory_entries_fts')) {
    return;
  }
  database.db.prepare('DELETE FROM memory_entries_fts WHERE memory_id = ?').run(id);
}

export function upsertSessionFts(database: DatabaseService, entry: SessionRecallEntry, content: string): void {
  if (!hasTable(database, 'session_recall_fts')) {
    return;
  }
  database.db.prepare('DELETE FROM session_recall_fts WHERE session_id = ?').run(entry.id);
  database.db
    .prepare(
      `INSERT INTO session_recall_fts (session_id, title, summary, content, scope)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(entry.id, entry.title, entry.summary, content, entry.scope);
}
