import type { Database as DatabaseConnection } from 'better-sqlite3';

export function applyAgentPluginSchema(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_threads (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'chat',
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_number INTEGER NOT NULL,
      user_input TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      model_id TEXT,
      enabled_capabilities_json TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES task_threads(id)
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES task_threads(id)
    );

    CREATE TABLE IF NOT EXISTS session_messages (
      id          TEXT PRIMARY KEY,
      thread_id   TEXT NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
      content     TEXT NOT NULL,
      token_count INTEGER,
      phase       TEXT NOT NULL DEFAULT 'visible' CHECK(phase IN ('visible','pre_compaction_flush')),
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_task_runs_thread_run_number
    ON task_runs(thread_id, run_number DESC);

    CREATE INDEX IF NOT EXISTS idx_agent_task_events_thread_run_created
    ON task_events(thread_id, run_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_agent_session_messages_thread_created
    ON session_messages(thread_id, created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
      content,
      content='session_messages',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS session_messages_ai AFTER INSERT ON session_messages BEGIN
      INSERT INTO session_messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS session_messages_ad AFTER DELETE ON session_messages BEGIN
      INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS session_messages_au AFTER UPDATE ON session_messages BEGIN
      INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
      INSERT INTO session_messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
}
