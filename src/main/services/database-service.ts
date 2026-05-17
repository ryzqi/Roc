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
      CREATE TABLE IF NOT EXISTS app_config_versions (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_threads (
        id TEXT PRIMARY KEY,
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
        workspace_path TEXT NOT NULL,
        allowed_actions_json TEXT NOT NULL,
        forbidden_actions_json TEXT NOT NULL,
        failure_policy TEXT NOT NULL,
        notification_policy TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        requires_confirmation INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES task_threads(id)
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

      CREATE TABLE IF NOT EXISTS memory_entries_index (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        priority TEXT NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        markdown_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        state TEXT NOT NULL,
        suggested_action TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_conflicts (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        active_memory_id TEXT NOT NULL,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_operations (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        operation_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_recall_index (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        markdown_path TEXT NOT NULL,
        created_at TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS doctor_runs (
        id TEXT PRIMARY KEY,
        generated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS doctor_findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES doctor_runs(id)
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

      CREATE TABLE IF NOT EXISTS langgraph_store_items (
        namespace_key TEXT NOT NULL,
        namespace_json TEXT NOT NULL,
        item_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(namespace_key, item_key)
      );
     `);

    db.prepare(
      `INSERT OR REPLACE INTO app_config_versions (id, schema_version, updated_at)
       VALUES (1, 1, ?)`
    ).run(new Date().toISOString());
    this.ensureColumn(db, 'session_recall_index', 'source_ref', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn(db, 'doctor_findings', 'repair_action_json', 'TEXT');
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
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
          memory_id UNINDEXED,
          content,
          summary,
          scope UNINDEXED,
          layer UNINDEXED
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS session_recall_fts USING fts5(
          session_id UNINDEXED,
          title,
          summary,
          content,
          scope UNINDEXED
        );
      `);
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('fts5')) {
        return;
      }
      throw error;
    }
  }
}
