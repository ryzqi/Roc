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

    CREATE TABLE IF NOT EXISTS memory_auto_audit (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      confidence TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      workspace_path TEXT,
      target_path TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_auto_audit_created
    ON memory_auto_audit(created_at DESC);
  `);
  ensureMemoryAutoAuditTargetPathColumn(db);
}

function ensureMemoryAutoAuditTargetPathColumn(db: DatabaseConnection): void {
  const columns = db.prepare('PRAGMA table_info(memory_auto_audit)').all() as Array<{ name: string }>;
  const hasTargetPath = columns.some((column) => column.name === 'target_path');
  if (hasTargetPath) {
    return;
  }
  db.exec('ALTER TABLE memory_auto_audit ADD COLUMN target_path TEXT');
}
