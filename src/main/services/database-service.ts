import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';
import type { RocPaths } from './paths';

export class DatabaseService {
  private connection: DatabaseConnection | null = null;

  constructor(private readonly paths: RocPaths) {}

  initialize(): void {
    const db = new Database(this.paths.databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    this.connection = db;
    this.migrate(db);
  }

  get db(): DatabaseConnection {
    if (this.connection === null) {
      throw new Error('DatabaseService has not been initialized.');
    }
    return this.connection;
  }

  close(): void {
    if (this.connection !== null) {
      this.connection.close();
      this.connection = null;
    }
  }

  private migrate(db: DatabaseConnection): void {
    db.exec(`
      DROP TABLE IF EXISTS memory_entries_fts;
      DROP TABLE IF EXISTS session_recall_fts;
      DROP TABLE IF EXISTS memory_entries_index;
      DROP TABLE IF EXISTS memory_candidates;
      DROP TABLE IF EXISTS memory_conflicts;
      DROP TABLE IF EXISTS memory_operations;
      DROP TABLE IF EXISTS session_recall_index;
      DROP TABLE IF EXISTS langgraph_store_items;
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS app_config_versions (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

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

      CREATE INDEX IF NOT EXISTS session_messages_thread_idx
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

      CREATE TABLE IF NOT EXISTS background_tasks (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        scheduled INTEGER NOT NULL,
        trigger_type TEXT NOT NULL,
        trigger_description TEXT NOT NULL,
        next_run_at TEXT,
        cron_expression TEXT,
        workspace_path TEXT NOT NULL,
        allowed_actions_json TEXT NOT NULL,
        forbidden_actions_json TEXT NOT NULL,
        failure_policy TEXT NOT NULL,
        notification_policy TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        requires_confirmation INTEGER NOT NULL,
        last_run_at TEXT,
        last_run_status TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        enabled_capabilities_json TEXT,
        FOREIGN KEY(thread_id) REFERENCES task_threads(id)
      );

      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id TEXT PRIMARY KEY,
        background_task_id TEXT NOT NULL,
        task_run_id TEXT,
        scheduled_at TEXT NOT NULL,
        triggered_at TEXT,
        status TEXT NOT NULL,
        skip_reason TEXT,
        FOREIGN KEY(background_task_id) REFERENCES background_tasks(id)
      );

      CREATE TABLE IF NOT EXISTS recovery_points (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        status TEXT NOT NULL,
        tools_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        path TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS performance_samples (
        id TEXT PRIMARY KEY,
        sampled_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        uptime_seconds REAL NOT NULL,
        rss_mb REAL NOT NULL,
        heap_used_mb REAL NOT NULL,
        heap_total_mb REAL NOT NULL,
        memory_budget_mb REAL NOT NULL,
        exceeds_budget INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diagnostic_packages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        includes_json TEXT NOT NULL,
        redacted INTEGER NOT NULL
      );

     `);

    this.ensureColumn(db, 'task_threads', 'kind', "TEXT NOT NULL DEFAULT 'chat'");
    this.ensureColumn(db, 'background_tasks', 'cron_expression', 'TEXT');
    this.ensureColumn(db, 'background_tasks', 'last_run_at', 'TEXT');
    this.ensureColumn(db, 'background_tasks', 'last_run_status', 'TEXT');
    this.ensureColumn(db, 'background_tasks', 'run_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn(db, 'background_tasks', 'enabled_capabilities_json', 'TEXT');

    db.prepare(
      `UPDATE task_threads
       SET kind = 'chat', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE kind = 'long_running'`
    ).run();

    db.exec(`

      CREATE INDEX IF NOT EXISTS idx_task_threads_active_updated
      ON task_threads(archived_at, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_task_events_thread_type_created
      ON task_events(thread_id, type, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_task_events_recent_active_threads
      ON task_events(thread_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_background_tasks_updated
      ON background_tasks(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task_status
      ON scheduled_task_runs(background_task_id, status, scheduled_at DESC);

      CREATE INDEX IF NOT EXISTS idx_task_threads_kind_status
      ON task_threads(kind, status, updated_at DESC);
     `);

    db.prepare(
      `INSERT OR REPLACE INTO app_config_versions (id, schema_version, updated_at)
       VALUES (1, 2, ?)`
    ).run(new Date().toISOString());
    this.tryCreateFtsTables(db);
  }

  private ensureColumn(db: DatabaseConnection, table: string, column: string, definition: string): void {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) {
      return;
    }
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }

  private tryCreateFtsTables(db: DatabaseConnection): void {
    void db;
  }
}
