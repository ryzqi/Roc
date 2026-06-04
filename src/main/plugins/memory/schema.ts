import type { Database as DatabaseConnection } from 'better-sqlite3';

export function applyMemoryPluginSchema(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      thread_id TEXT,
      run_id TEXT,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_events_created
    ON memory_events(created_at DESC);
  `);
}
