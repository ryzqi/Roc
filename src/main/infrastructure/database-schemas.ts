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

export function applyResearchDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applySchema(db, 'plugin:@roc/plugin-research', researchMigrations, now);
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
  },
  {
    version: 3,
    name: 'remove_legacy_langsmith_configuration',
    sql: `
      DELETE FROM plugin_config
      WHERE plugin_id = '@roc/plugin-agent'
        AND key = 'langsmith.settings';

      DELETE FROM plugin_secrets
      WHERE plugin_id = '@roc/plugin-agent'
        AND key = 'langsmith.apiKey';
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
      SELECT events.thread_id, MAX(events.sequence) + 1
      FROM agent_events AS events
      INNER JOIN agent_threads AS threads ON threads.id = events.thread_id
      GROUP BY events.thread_id;

      CREATE TABLE agent_run_event_cursors (
        run_id        TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL,
        FOREIGN KEY(run_id) REFERENCES agent_runs(id)
      );

      INSERT INTO agent_run_event_cursors (run_id, next_sequence)
      SELECT events.run_id, MAX(events.sequence) + 1
      FROM agent_run_events AS events
      INNER JOIN agent_runs AS runs ON runs.id = events.run_id
      GROUP BY events.run_id;
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
  },
  {
    version: 10,
    name: 'agent_pending_interrupt_collection',
    sql: `
      ALTER TABLE agent_pending_interrupts RENAME TO agent_pending_interrupts_legacy;

      CREATE TABLE agent_pending_interrupts (
        run_id                  TEXT NOT NULL,
        thread_id               TEXT NOT NULL,
        interrupt_id            TEXT NOT NULL,
        position                INTEGER NOT NULL DEFAULT 0,
        payload_json            TEXT NOT NULL,
        mode                    TEXT NOT NULL,
        task_source             TEXT,
        workflow_hint           TEXT,
        workspace_path_state    TEXT NOT NULL CHECK(workspace_path_state IN ('undefined','null','value')),
        workspace_path          TEXT,
        explicit_skill_ids_json TEXT,
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        PRIMARY KEY(run_id, interrupt_id),
        UNIQUE(run_id, position),
        FOREIGN KEY(run_id) REFERENCES agent_runs(id),
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );

      INSERT INTO agent_pending_interrupts
        (run_id, thread_id, interrupt_id, position, payload_json, mode, task_source, workflow_hint,
         workspace_path_state, workspace_path, explicit_skill_ids_json, created_at, updated_at)
      SELECT run_id, thread_id, interrupt_id, 0, payload_json, mode, task_source, workflow_hint,
             workspace_path_state, workspace_path, explicit_skill_ids_json, created_at, updated_at
      FROM agent_pending_interrupts_legacy;

      DROP TABLE agent_pending_interrupts_legacy;

      CREATE INDEX idx_agent_pending_interrupts_thread
        ON agent_pending_interrupts(thread_id);
    `
  },
  {
    version: 11,
    name: 'agent_pending_interrupt_projection_minimal',
    sql: `
      ALTER TABLE agent_pending_interrupts RENAME TO agent_pending_interrupts_with_run_config;

      CREATE TABLE agent_pending_interrupts (
        run_id       TEXT NOT NULL,
        thread_id    TEXT NOT NULL,
        interrupt_id TEXT NOT NULL,
        position     INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY(run_id, interrupt_id),
        UNIQUE(run_id, position),
        FOREIGN KEY(run_id) REFERENCES agent_runs(id),
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );

      INSERT INTO agent_pending_interrupts
        (run_id, thread_id, interrupt_id, position, payload_json, created_at, updated_at)
      SELECT run_id, thread_id, interrupt_id, position, payload_json, created_at, updated_at
      FROM agent_pending_interrupts_with_run_config;

      DROP TABLE agent_pending_interrupts_with_run_config;

      CREATE INDEX idx_agent_pending_interrupts_thread
        ON agent_pending_interrupts(thread_id);
    `
  },
  {
    version: 12,
    name: 'agent_run_telemetry',
    sql: `
      CREATE TABLE agent_run_telemetry (
        run_id         TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        telemetry_json TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES agent_runs(id)
      );

      INSERT INTO agent_run_telemetry (run_id, schema_version, telemetry_json, created_at, updated_at)
      SELECT id,
             1,
             json_object(
               'schemaVersion', 1,
               'correlation', json_object(
                 'runId', id,
                 'threadId', thread_id,
                 'runOrigin', json_extract(snapshot_json, '$.runOrigin'),
                 'dispatchKey', json_extract(snapshot_json, '$.dispatchKey'),
                 'snapshotVersion', 2,
                 'manifestHash', json_extract(snapshot_json, '$.capabilityManifest.manifestHash'),
                 'providerId', json_extract(snapshot_json, '$.model.providerId'),
                 'modelId', json_extract(snapshot_json, '$.model.modelId')
               ),
               'model', json_object(
                 'callCount', 0,
                 'inputTokens', NULL,
                 'outputTokens', NULL,
                 'totalTokens', NULL,
                 'cacheReadTokens', NULL,
                 'cacheCreationTokens', NULL,
                 'reportedCostUsd', NULL
               ),
               'tool', json_object('callCount', 0, 'errorCount', 0),
               'subagent', json_object('count', 0, 'failedCount', 0, 'maxDepth', 0),
               'context', json_object(
                 'compactionCount', 0,
                 'summaryCount', 0,
                 'artifactCount', 0,
                 'failureCount', 0,
                 'estimatedCount', 0,
                 'inputTokens', NULL,
                 'budgetTokens', NULL,
                 'removedChars', 0,
                 'persistedChars', 0
               ),
               'runtime', json_object('firstOutputMs', NULL, 'totalDurationMs', 0, 'recoveryCount', 0),
               'terminal', json_object(
                 'status', CASE
                   WHEN status IN ('cancelled','completed','failed','interrupted') THEN status
                   ELSE NULL
                 END,
                 'errorCode', NULL,
                 'retryable', NULL,
                 'cancelSource', CASE WHEN status = 'cancelled' THEN 'user_cancelled' ELSE NULL END
               )
             ),
             started_at,
             COALESCE(ended_at, started_at)
      FROM agent_runs
      WHERE snapshot_version IN (1, 2)
        AND snapshot_json IS NOT NULL
        AND json_valid(snapshot_json);
    `
  },
  {
    version: 13,
    name: 'agent_langsmith_trace_sessions',
    sql: `
      CREATE TABLE agent_langsmith_trace_sessions (
        run_id         TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        session_json   TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES agent_runs(id)
      );
    `
  },
  {
    version: 14,
    name: 'remove_legacy_langsmith_trace_sessions',
    sql: `
      DROP TABLE IF EXISTS agent_langsmith_trace_sessions;
    `
  },
  {
    version: 15,
    name: 'session_messages_fts_trigram',
    sql: `
      DROP TRIGGER IF EXISTS session_messages_ai;
      DROP TRIGGER IF EXISTS session_messages_ad;
      DROP TRIGGER IF EXISTS session_messages_au;
      DROP TABLE IF EXISTS session_messages_fts;

      CREATE VIRTUAL TABLE session_messages_fts USING fts5(
        content,
        content='session_messages',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER session_messages_ai AFTER INSERT ON session_messages BEGIN
        INSERT INTO session_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER session_messages_ad AFTER DELETE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
          VALUES('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER session_messages_au AFTER UPDATE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
          VALUES('delete', old.rowid, old.content);
        INSERT INTO session_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      INSERT INTO session_messages_fts(session_messages_fts) VALUES('rebuild');
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

export const researchMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'research_workbench_foundation',
    sql: `
      CREATE TABLE IF NOT EXISTS research_projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        workspace_path TEXT,
        status TEXT NOT NULL CHECK(status IN ('active','paused','completed','archived')),
        current_stage TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS research_stage_states (
        project_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        active_run_id TEXT,
        artifact_ids_json TEXT NOT NULL,
        entered_at TEXT,
        completed_at TEXT,
        gate_required INTEGER NOT NULL,
        gate_approved INTEGER NOT NULL,
        last_error TEXT,
        PRIMARY KEY(project_id, stage),
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS research_artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT,
        status TEXT NOT NULL CHECK(status IN ('draft','approved','superseded')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS research_provenance (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        artifact_id TEXT,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        locator TEXT,
        excerpt TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(artifact_id) REFERENCES research_artifacts(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS research_workflow_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS research_embedding_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        api_key_secret_key TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS research_literature_records (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        doi TEXT,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL,
        abstract TEXT,
        published_year INTEGER,
        citation_count INTEGER,
        url TEXT,
        open_access_url TEXT,
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, external_id)
      );

      CREATE TABLE IF NOT EXISTS research_knowledge_documents (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS research_knowledge_documents_fts USING fts5(
        title,
        content,
        content='research_knowledge_documents',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS research_knowledge_documents_ai AFTER INSERT ON research_knowledge_documents BEGIN
        INSERT INTO research_knowledge_documents_fts(rowid, title, content)
          VALUES (new.rowid, new.title, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS research_knowledge_documents_ad AFTER DELETE ON research_knowledge_documents BEGIN
        INSERT INTO research_knowledge_documents_fts(research_knowledge_documents_fts, rowid, title, content)
          VALUES ('delete', old.rowid, old.title, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS research_knowledge_documents_au AFTER UPDATE ON research_knowledge_documents BEGIN
        INSERT INTO research_knowledge_documents_fts(research_knowledge_documents_fts, rowid, title, content)
          VALUES ('delete', old.rowid, old.title, old.content);
        INSERT INTO research_knowledge_documents_fts(rowid, title, content)
          VALUES (new.rowid, new.title, new.content);
      END;

      CREATE TABLE IF NOT EXISTS research_knowledge_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        project_id TEXT,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        locator TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(document_id) REFERENCES research_knowledge_documents(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE,
        UNIQUE(document_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS research_knowledge_embeddings (
        chunk_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(chunk_id, model),
        FOREIGN KEY(chunk_id) REFERENCES research_knowledge_chunks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS research_templates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        status TEXT NOT NULL,
        pdf_path TEXT,
        errors_json TEXT NOT NULL,
        last_compiled_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS research_experiment_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        label TEXT NOT NULL,
        command TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        environment_json TEXT NOT NULL,
        status TEXT NOT NULL,
        outputs_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS research_figures (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        code_path TEXT NOT NULL,
        data_paths_json TEXT NOT NULL,
        output_paths_json TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(run_id) REFERENCES research_experiment_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_research_projects_updated
        ON research_projects(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_research_stage_states_project
        ON research_stage_states(project_id, stage);
      CREATE INDEX IF NOT EXISTS idx_research_artifacts_project_stage
        ON research_artifacts(project_id, stage, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_research_provenance_subject
        ON research_provenance(subject_type, subject_id);
      CREATE INDEX IF NOT EXISTS idx_research_workflow_events_project_created
        ON research_workflow_events(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_research_knowledge_documents_project
        ON research_knowledge_documents(project_id, indexed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_research_literature_doi
        ON research_literature_records(doi);
      CREATE INDEX IF NOT EXISTS idx_research_literature_updated
        ON research_literature_records(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_research_knowledge_chunks_document
        ON research_knowledge_chunks(document_id, chunk_index);
      CREATE INDEX IF NOT EXISTS idx_research_templates_project
        ON research_templates(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_research_experiment_runs_project
        ON research_experiment_runs(project_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_research_figures_project
        ON research_figures(project_id, updated_at DESC);
    `
  },
  {
    version: 2,
    name: 'research_evidence_and_manuscripts',
    sql: `
      CREATE TABLE research_evidence (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('literature','file','experiment')),
        source_id TEXT NOT NULL,
        source_version TEXT NOT NULL,
        title TEXT NOT NULL,
        locator TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, chunk_id, source_version, locator, content_hash)
      );
      CREATE INDEX idx_research_evidence_project ON research_evidence(project_id, created_at DESC);

      CREATE TABLE research_claims (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
        subject_type TEXT NOT NULL CHECK(subject_type IN ('claim','paragraph','figure')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('supported','hypothesis','pending')),
        evidence_ids_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_research_claims_artifact ON research_claims(project_id, artifact_id);

      CREATE TABLE research_claim_revisions (
        claim_id TEXT NOT NULL REFERENCES research_claims(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(claim_id, version)
      );

      CREATE TABLE research_manuscripts (
        artifact_id TEXT PRIMARY KEY REFERENCES research_artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        sections_json TEXT NOT NULL,
        latex TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        claims_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    version: 3,
    name: 'research_stage_execution',
    sql: `
      CREATE TABLE research_stage_policies (
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        PRIMARY KEY(project_id, stage)
      );
      INSERT INTO research_stage_policies (project_id, stage, policy_json)
        SELECT project_id, stage, json_object(
          'projectId', project_id, 'stage', stage,
          'tier', CASE WHEN stage = 'retrieval' THEN 'fast' WHEN stage IN ('writing','review','revision') THEN 'deep' ELSE 'balanced' END,
          'model', json_object('kind', 'app_default'), 'maxSteps', 30, 'timeoutMs', 180000
        ) FROM research_stage_states;
      CREATE TABLE research_stage_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        request_id TEXT NOT NULL,
        parent_run_id TEXT REFERENCES research_stage_runs(id),
        status TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        UNIQUE(project_id, request_id)
      );
      CREATE INDEX idx_research_stage_runs_project ON research_stage_runs(project_id, stage, status);
      CREATE TABLE research_artifact_contents (
        artifact_id TEXT PRIMARY KEY REFERENCES research_artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES research_stage_runs(id),
        output_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    version: 4,
    name: 'research_peer_review_cycles',
    sql: `
      CREATE TABLE research_review_cycles (
        project_id TEXT PRIMARY KEY REFERENCES research_projects(id) ON DELETE CASCADE,
        origin_artifact_id TEXT NOT NULL REFERENCES research_artifacts(id),
        manuscript_artifact_id TEXT NOT NULL REFERENCES research_artifacts(id),
        revision_round INTEGER NOT NULL CHECK(revision_round BETWEEN 0 AND 2),
        status TEXT NOT NULL CHECK(status IN ('reviewing','revision_required','accepted')),
        report_artifact_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO research_review_cycles (project_id, origin_artifact_id, manuscript_artifact_id, revision_round, status, report_artifact_ids_json, updated_at)
        SELECT p.id, a.id, a.id, 0,
          CASE WHEN s.gate_approved = 1 AND p.current_stage = 'revision' THEN 'revision_required'
               WHEN s.gate_approved = 1 AND p.current_stage = 'export' THEN 'accepted' ELSE 'reviewing' END,
          s.artifact_ids_json, p.updated_at
        FROM research_projects p
        JOIN research_artifacts a ON a.id = (SELECT latest.id FROM research_artifacts latest
          WHERE latest.project_id = p.id AND latest.kind = 'manuscript' AND latest.status = 'approved' ORDER BY latest.rowid DESC LIMIT 1)
        JOIN research_stage_states s ON s.project_id = p.id AND s.stage = 'review';
      UPDATE research_stage_runs AS r SET snapshot_json = json_set(snapshot_json,
        '$.reviewCycleId', CASE WHEN r.stage IN ('review','revision','export') THEN
          (SELECT a.id FROM json_each(r.snapshot_json, '$.inputArtifactIds') i
            JOIN research_artifacts a ON a.id = i.value
            WHERE a.project_id = r.project_id AND a.kind = 'manuscript' ORDER BY a.rowid DESC LIMIT 1)
          ELSE NULL END,
        '$.revisionRound', CASE WHEN r.stage = 'revision' THEN 1 ELSE 0 END),
        context_json = json_set(context_json, '$.reviewReports', json('[]'));
      UPDATE research_stage_runs SET snapshot_json = json_insert(snapshot_json, '$.toolNames[#]', 'read_review_report')
        WHERE stage = 'review' AND parent_run_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM json_each(snapshot_json, '$.toolNames') WHERE value = 'read_review_report');
    `
  },
  {
    version: 5,
    name: 'research_template_compile_versions',
    sql: `
      ALTER TABLE research_templates ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE research_templates ADD COLUMN compiled_revision INTEGER;
      ALTER TABLE research_templates ADD COLUMN source_digest TEXT;
      ALTER TABLE research_templates ADD COLUMN compiled_digest TEXT;
      ALTER TABLE research_templates ADD COLUMN pdf_hash TEXT;
      ALTER TABLE research_templates ADD COLUMN active_compile_id TEXT;
      ALTER TABLE research_templates ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '[]';
      UPDATE research_templates SET status = 'imported' WHERE status IN ('ready', 'compiling');
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
