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
  },
  {
    version: 3,
    name: 'agent_run_execution_snapshot',
    sql: `
      ALTER TABLE agent_runs ADD COLUMN snapshot_json TEXT;
      ALTER TABLE agent_runs ADD COLUMN snapshot_version INTEGER;
      ALTER TABLE agent_runs ADD COLUMN snapshot_error_code TEXT;
      ALTER TABLE agent_runs ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE agent_runs ADD COLUMN run_origin TEXT;
      ALTER TABLE agent_runs ADD COLUMN dispatch_key TEXT;

      CREATE UNIQUE INDEX idx_agent_runs_dispatch_key
        ON agent_runs(dispatch_key)
        WHERE dispatch_key IS NOT NULL;

      UPDATE agent_runs
      SET status = 'interrupted',
          ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          snapshot_error_code = 'legacy_snapshot_missing'
      WHERE snapshot_json IS NULL
        AND status IN ('running', 'waiting_next_turn', 'waiting_user');

      UPDATE agent_threads
      SET status = 'interrupted',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status IN ('running', 'waiting_next_turn', 'waiting_user')
        AND EXISTS (
          SELECT 1
          FROM agent_runs
          WHERE agent_runs.thread_id = agent_threads.id
            AND agent_runs.status = 'interrupted'
            AND agent_runs.snapshot_error_code = 'legacy_snapshot_missing'
        );
    `
  },
  {
    version: 4,
    name: 'agent_run_state_transition',
    sql: `
      CREATE TABLE agent_run_leases (
        thread_id   TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id),
        FOREIGN KEY(run_id) REFERENCES agent_runs(id)
      );
    `
  },
  {
    version: 5,
    name: 'agent_terminal_outbox',
    sql: `
      CREATE TABLE agent_outbox (
        sequence    INTEGER PRIMARY KEY,
        id          TEXT NOT NULL UNIQUE,
        event_type  TEXT NOT NULL CHECK(event_type IN ('run_completed','run_failed')),
        run_id      TEXT NOT NULL,
        thread_id   TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES agent_runs(id),
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );

      CREATE INDEX idx_agent_outbox_sequence
        ON agent_outbox(sequence);
      CREATE INDEX idx_agent_outbox_run
        ON agent_outbox(run_id, sequence);

      INSERT INTO agent_run_leases (thread_id, run_id, acquired_at)
      SELECT runs.thread_id, runs.id, runs.started_at
      FROM agent_runs AS runs
      WHERE runs.snapshot_json IS NOT NULL
        AND runs.status IN ('dispatch_pending','waiting_next_turn','running','recovering','waiting_user')
        AND runs.run_number = (
          SELECT MAX(candidate.run_number)
          FROM agent_runs AS candidate
          WHERE candidate.thread_id = runs.thread_id
            AND candidate.snapshot_json IS NOT NULL
            AND candidate.status IN ('dispatch_pending','waiting_next_turn','running','recovering','waiting_user')
        )
      ON CONFLICT(thread_id) DO NOTHING;
    `
  },
  {
    version: 6,
    name: 'agent_event_sequence_cursors',
    sql: `
      CREATE UNIQUE INDEX idx_agent_events_thread_sequence_unique
        ON agent_events(thread_id, sequence);

      CREATE TABLE agent_thread_event_cursors (
        thread_id     TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );

      INSERT INTO agent_thread_event_cursors (thread_id, next_sequence)
      SELECT thread_id, MAX(sequence) + 1
      FROM agent_events
      GROUP BY thread_id;

      CREATE TABLE agent_run_event_cursors (
        run_id        TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL,
        FOREIGN KEY(run_id) REFERENCES agent_runs(id)
      );

      INSERT INTO agent_run_event_cursors (run_id, next_sequence)
      SELECT run_id, MAX(sequence) + 1
      FROM agent_run_events
      GROUP BY run_id;
    `
  },
  {
    version: 7,
    name: 'agent_outbox_monotonic_sequence',
    sql: `
      ALTER TABLE agent_outbox RENAME TO agent_outbox_legacy;

      CREATE TABLE agent_outbox (
        sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
        id          TEXT NOT NULL UNIQUE,
        event_type  TEXT NOT NULL CHECK(event_type IN ('run_completed','run_failed','run_cancelled','run_deleted')),
        run_id      TEXT NOT NULL,
        thread_id   TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      INSERT INTO agent_outbox (sequence, id, event_type, run_id, thread_id, payload_json, created_at)
      SELECT sequence, id, event_type, run_id, thread_id, payload_json, created_at
      FROM agent_outbox_legacy;

      DROP TABLE agent_outbox_legacy;

      CREATE INDEX idx_agent_outbox_sequence
        ON agent_outbox(sequence);
      CREATE INDEX idx_agent_outbox_run
        ON agent_outbox(run_id, sequence);
    `
  },
  {
    version: 8,
    name: 'agent_notification_metrics',
    sql: `
      CREATE TABLE agent_notification_metrics (
        code          TEXT PRIMARY KEY,
        failure_count INTEGER NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `
  },
  {
    version: 9,
    name: 'agent_effect_execution_identity',
    sql: `
      ALTER TABLE agent_tool_effects RENAME TO agent_tool_effects_legacy;

      CREATE TABLE agent_tool_effects (
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        execution_path TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        effect_class TEXT NOT NULL CHECK(effect_class IN ('external_call','host_execution','network_read','workspace_mutation')),
        reconcile_strategy TEXT NOT NULL CHECK(reconcile_strategy IN ('retry_safe','manual_confirmation')),
        status TEXT NOT NULL CHECK(status IN ('in_progress','succeeded','failed_retryable','failed_final','unknown')),
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, execution_path, checkpoint_id, tool_call_id)
      );

      INSERT INTO agent_tool_effects
        (run_id, thread_id, execution_path, checkpoint_id, tool_call_id, tool_name, input_hash,
         effect_class, reconcile_strategy, status, result_json, error_json, created_at, updated_at)
      SELECT run_id, thread_id, 'legacy-main', 'legacy-checkpoint', tool_call_id, tool_name, input_hash,
             'external_call', 'manual_confirmation',
             CASE status
               WHEN 'success' THEN 'succeeded'
               WHEN 'error' THEN 'failed_final'
               WHEN 'in_progress' THEN 'unknown'
               ELSE status
             END,
             result_json, error_json, created_at, updated_at
      FROM agent_tool_effects_legacy;

      DROP TABLE agent_tool_effects_legacy;

      CREATE INDEX idx_agent_tool_effects_thread_updated
        ON agent_tool_effects(thread_id, updated_at DESC);
      CREATE INDEX idx_agent_tool_effects_run_status
        ON agent_tool_effects(run_id, status);
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
  },
  {
    version: 3,
    name: 'task_agent_outbox_cursor',
    sql: `
      CREATE TABLE task_agent_outbox_cursors (
        projector_name TEXT PRIMARY KEY,
        last_sequence  INTEGER NOT NULL,
        updated_at     TEXT NOT NULL
      );
    `
  },
  {
    version: 4,
    name: 'durable_scheduled_occurrences',
    sql: `
      ALTER TABLE background_tasks ADD COLUMN task_revision INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE scheduled_occurrences (
        occurrence_key     TEXT PRIMARY KEY,
        background_task_id TEXT NOT NULL,
        task_revision      INTEGER NOT NULL,
        scheduled_at       TEXT NOT NULL,
        status             TEXT NOT NULL CHECK(status IN ('pending','claimed','dispatched','completed','failed','cancelled','skipped','unknown')),
        claim_owner        TEXT,
        claim_expires_at   TEXT,
        attempt            INTEGER NOT NULL DEFAULT 0,
        dispatch_key       TEXT NOT NULL UNIQUE,
        run_id             TEXT,
        request_json       TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        claimed_at         TEXT,
        dispatched_at      TEXT,
        terminal_at        TEXT,
        reason             TEXT,
        FOREIGN KEY(background_task_id) REFERENCES background_tasks(id),
        UNIQUE(background_task_id, scheduled_at, task_revision)
      );

      CREATE INDEX idx_scheduled_occurrences_task_status_scheduled
        ON scheduled_occurrences(background_task_id, status, scheduled_at DESC);
      CREATE INDEX idx_scheduled_occurrences_run
        ON scheduled_occurrences(run_id);
      CREATE UNIQUE INDEX idx_scheduled_occurrences_run_unique
        ON scheduled_occurrences(run_id)
        WHERE run_id IS NOT NULL;
      CREATE INDEX idx_scheduled_occurrences_claim_expiry
        ON scheduled_occurrences(status, claim_expires_at);
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
