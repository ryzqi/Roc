import type { Database as DatabaseConnection } from 'better-sqlite3';

import { applyDatabaseMigrations, type RocDatabaseMigration } from './database-migrations';
import type { RocLogicalDatabaseName } from './database-pragmas';

type Clock = () => string;

export function applyCoreDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applySchema(db, 'core', coreMigrations, now);
}

export function applyAgentDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  ensureLegacyAgentTableCompatibility(db);
  applySchema(db, 'agent', agentMigrations, now);
}

export function applyMemoryDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applySchema(db, 'memory', memoryMigrations, now);
}

export function applyTaskDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applySchema(db, 'task', taskMigrations, now);
}

export function applyWorkspaceDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applySchema(db, 'plugin:@roc/plugin-workspace', workspaceMigrations, now);
}

export function applyDiagnosticsDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applySchema(db, 'plugin:@roc/plugin-diagnostics', diagnosticsMigrations, now);
}

export const coreMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'core_platform_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS plugin_config (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, key)
      );

      CREATE TABLE IF NOT EXISTS plugin_secrets (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        ciphertext_base64 TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, key)
      );

      CREATE TABLE IF NOT EXISTS database_health_checks (
        id TEXT PRIMARY KEY,
        db_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('healthy','degraded','unhealthy')),
        detail_json TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_database_health_checks_db_checked
        ON database_health_checks(db_name, checked_at DESC);

      CREATE TABLE IF NOT EXISTS database_backup_manifests (
        id TEXT PRIMARY KEY,
        backup_dir TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    name: 'database_maintenance_runs',
    sql: `
      CREATE TABLE database_maintenance_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('retention','full_health_check')),
        status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        detail_json TEXT NOT NULL,
        error_message TEXT
      );

      CREATE INDEX idx_core_database_maintenance_runs_kind_finished
        ON database_maintenance_runs(kind, finished_at DESC);
    `
  }
];

export const agentMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'agent_canonical_runtime_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_threads (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('chat','plan','background')),
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_number INTEGER NOT NULL,
        user_input TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        provider_id TEXT,
        model_id TEXT,
        enabled_capabilities_json TEXT NOT NULL,
        workspace_path TEXT,
        task_source TEXT,
        workflow_hint TEXT,
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id),
        FOREIGN KEY(run_id) REFERENCES agent_runs(id)
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id             TEXT PRIMARY KEY,
        thread_id      TEXT NOT NULL,
        role           TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        content        TEXT NOT NULL,
        token_count    INTEGER,
        phase          TEXT NOT NULL DEFAULT 'visible' CHECK(phase IN ('visible','pre_compaction_flush')),
        workspace_hash TEXT,
        created_at     TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );

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

      CREATE TABLE IF NOT EXISTS agent_pending_interrupts (
        run_id                  TEXT PRIMARY KEY,
        thread_id               TEXT NOT NULL,
        interrupt_id            TEXT NOT NULL,
        payload_json            TEXT NOT NULL,
        mode                    TEXT NOT NULL,
        task_source             TEXT,
        workflow_hint           TEXT,
        workspace_path_state    TEXT NOT NULL CHECK(workspace_path_state IN ('undefined','null','value')),
        workspace_path          TEXT,
        explicit_skill_ids_json TEXT,
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES agent_runs(id),
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );

      CREATE TABLE IF NOT EXISTS agent_run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        checkpoint_type TEXT NOT NULL,
        checkpoint_blob BLOB NOT NULL,
        metadata_type TEXT NOT NULL,
        metadata_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );

      CREATE TABLE IF NOT EXISTS langgraph_checkpoint_writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        value_type TEXT NOT NULL,
        value_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );

      CREATE TABLE IF NOT EXISTS agent_tool_effects (
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('in_progress','success','error','unknown')),
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, tool_call_id)
      );

      CREATE TABLE IF NOT EXISTS context_artifacts (
        id             TEXT PRIMARY KEY,
        run_id         TEXT NOT NULL,
        thread_id      TEXT NOT NULL,
        kind           TEXT NOT NULL CHECK(kind IN ('tool_result','transcript','summary_index')),
        tool_call_id   TEXT,
        tool_name      TEXT,
        sha256         TEXT NOT NULL,
        original_chars INTEGER NOT NULL,
        preview        TEXT NOT NULL,
        content        TEXT NOT NULL,
        workspace_hash TEXT,
        created_at     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_threads_updated
        ON agent_threads(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_run_number
        ON agent_runs(thread_id, run_number DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_events_thread_run_sequence
        ON agent_events(thread_id, run_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_events_thread_created
        ON agent_events(thread_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_session_messages_thread_created
        ON session_messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_session_messages_workspace_created
        ON session_messages(workspace_hash, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_pending_interrupts_thread
        ON agent_pending_interrupts(thread_id);
      CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_sequence
        ON agent_run_events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_thread_checkpoint
        ON langgraph_checkpoints(thread_id, checkpoint_ns, checkpoint_id DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_tool_effects_thread_updated
        ON agent_tool_effects(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_context_artifacts_thread_created
        ON context_artifacts(thread_id, created_at);
    `
  },
  {
    version: 2,
    name: 'agent_event_sequence_cursor',
    sql: `
      CREATE INDEX idx_agent_events_thread_sequence
        ON agent_events(thread_id, sequence);
    `
  }
];

export const memoryMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'memory_store_and_audit_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS langgraph_store_items (
        namespace_key TEXT NOT NULL,
        namespace_json TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace_key, key)
      );

      CREATE INDEX IF NOT EXISTS idx_langgraph_store_items_namespace_key
        ON langgraph_store_items(namespace_key);

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
    `
  }
];

export const taskMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'background_task_projection_tables',
    sql: `
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
        enabled_capabilities_json TEXT
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

      CREATE INDEX IF NOT EXISTS idx_task_plugin_background_tasks_updated
        ON background_tasks(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_plugin_background_tasks_status_updated
        ON background_tasks(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_plugin_scheduled_task_runs_task_status
        ON scheduled_task_runs(background_task_id, status, scheduled_at DESC);
    `
  },
  {
    version: 2,
    name: 'thread_deletion_journal',
    sql: `
      CREATE TABLE thread_deletion_journal (
        thread_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('pending','agent_deleted','complete')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX idx_task_thread_deletion_journal_state_updated
        ON thread_deletion_journal(state, updated_at);
    `
  }
];

export const workspaceMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'workspace_private_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS recovery_points (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_recovery_points_created
        ON recovery_points(created_at DESC);
    `
  }
];

export const diagnosticsMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'diagnostics_private_tables',
    sql: `
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

      CREATE INDEX IF NOT EXISTS idx_performance_samples_sampled
        ON performance_samples(sampled_at DESC);

      CREATE TABLE IF NOT EXISTS diagnostic_packages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        includes_json TEXT NOT NULL,
        redacted INTEGER NOT NULL
      );
    `
  }
];

function applySchema(
  db: DatabaseConnection,
  dbName: RocLogicalDatabaseName,
  migrations: readonly RocDatabaseMigration[],
  now: Clock | undefined
): void {
  if (now === undefined) {
    applyDatabaseMigrations(db, { dbName, migrations });
    return;
  }
  applyDatabaseMigrations(db, { dbName, migrations, now });
}

function ensureLegacyAgentTableCompatibility(db: DatabaseConnection): void {
  if (!tableExists(db, 'session_messages')) {
    return;
  }
  if (!columnExists(db, 'session_messages', 'workspace_hash')) {
    db.exec('ALTER TABLE session_messages ADD COLUMN workspace_hash TEXT;');
  }
}

function tableExists(db: DatabaseConnection, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return row !== undefined;
}

function columnExists(db: DatabaseConnection, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}
