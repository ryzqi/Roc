import type { Database as DatabaseConnection } from 'better-sqlite3';

import { applyDatabaseMigrations, type RocDatabaseMigration } from './database-migrations';
import type { RocLogicalDatabaseName } from './database-pragmas';

type Clock = () => string;

export function applyCoreDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applySchema(db, 'core', coreMigrations, now);
}

export function applyAgentDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
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
    name: 'current_core_schema',
    sql: `
CREATE TABLE database_backup_manifests (
        id TEXT PRIMARY KEY,
        backup_dir TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE database_health_checks (
        id TEXT PRIMARY KEY,
        db_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('healthy','degraded','unhealthy')),
        detail_json TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
CREATE TABLE database_maintenance_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('retention','full_health_check')),
        status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        detail_json TEXT NOT NULL,
        error_message TEXT
      );
CREATE TABLE plugin_config (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, key)
      );
CREATE TABLE plugin_secrets (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        ciphertext_base64 TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, key)
      );
CREATE INDEX idx_core_database_maintenance_runs_kind_finished
        ON database_maintenance_runs(kind, finished_at DESC);
CREATE INDEX idx_database_health_checks_db_checked
        ON database_health_checks(db_name, checked_at DESC);
`
  }
];

export const agentMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'current_agent_schema',
    sql: `
CREATE TABLE agent_events (
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
CREATE TABLE agent_notification_metrics (
        code          TEXT PRIMARY KEY,
        failure_count INTEGER NOT NULL,
        updated_at    TEXT NOT NULL
      );
CREATE TABLE agent_outbox (
        sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
        id          TEXT NOT NULL UNIQUE,
        event_type  TEXT NOT NULL CHECK(event_type IN ('run_completed','run_failed','run_cancelled','run_deleted')),
        run_id      TEXT NOT NULL,
        thread_id   TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
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
CREATE TABLE agent_run_event_cursors (
        run_id        TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL,
        FOREIGN KEY(run_id) REFERENCES agent_runs(id)
      );
CREATE TABLE agent_run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
CREATE TABLE agent_run_leases (
        thread_id   TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id),
        FOREIGN KEY(run_id) REFERENCES agent_runs(id)
      );
CREATE TABLE agent_run_telemetry (
        run_id         TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        telemetry_json TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES agent_runs(id)
      );
CREATE TABLE agent_runs (
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
        workflow_hint TEXT, snapshot_json TEXT, snapshot_version INTEGER, snapshot_error_code TEXT, state_version INTEGER NOT NULL DEFAULT 1, run_origin TEXT, dispatch_key TEXT,
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );
CREATE TABLE agent_thread_event_cursors (
        thread_id     TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );
CREATE TABLE agent_threads (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('chat','plan','background')),
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      , research_project_id TEXT);
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
CREATE TABLE context_artifacts (
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
CREATE TABLE langgraph_checkpoint_writes (
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
CREATE TABLE langgraph_checkpoints (
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
CREATE TABLE session_messages (
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
CREATE VIRTUAL TABLE session_messages_fts USING fts5(
        content,
        content='session_messages',
        content_rowid='rowid',
        tokenize='trigram'
      );
CREATE INDEX idx_agent_events_thread_created
        ON agent_events(thread_id, created_at DESC);
CREATE INDEX idx_agent_events_thread_run_sequence
        ON agent_events(thread_id, run_id, sequence ASC);
CREATE INDEX idx_agent_events_thread_sequence
        ON agent_events(thread_id, sequence);
CREATE UNIQUE INDEX idx_agent_events_thread_sequence_unique
        ON agent_events(thread_id, sequence);
CREATE INDEX idx_agent_outbox_run
        ON agent_outbox(run_id, sequence);
CREATE INDEX idx_agent_outbox_sequence
        ON agent_outbox(sequence);
CREATE INDEX idx_agent_pending_interrupts_thread
        ON agent_pending_interrupts(thread_id);
CREATE INDEX idx_agent_run_events_run_sequence
        ON agent_run_events(run_id, sequence);
CREATE UNIQUE INDEX idx_agent_runs_dispatch_key
        ON agent_runs(dispatch_key)
        WHERE dispatch_key IS NOT NULL;
CREATE INDEX idx_agent_runs_thread_run_number
        ON agent_runs(thread_id, run_number DESC);
CREATE INDEX idx_agent_session_messages_thread_created
        ON session_messages(thread_id, created_at);
CREATE INDEX idx_agent_session_messages_workspace_created
        ON session_messages(workspace_hash, created_at);
CREATE INDEX idx_agent_threads_research_project
        ON agent_threads(research_project_id, updated_at DESC);
CREATE INDEX idx_agent_threads_updated
        ON agent_threads(updated_at DESC);
CREATE INDEX idx_agent_tool_effects_run_status
        ON agent_tool_effects(run_id, status);
CREATE INDEX idx_agent_tool_effects_thread_updated
        ON agent_tool_effects(thread_id, updated_at DESC);
CREATE INDEX idx_context_artifacts_thread_created
        ON context_artifacts(thread_id, created_at);
CREATE INDEX idx_langgraph_checkpoints_thread_checkpoint
        ON langgraph_checkpoints(thread_id, checkpoint_ns, checkpoint_id DESC);
CREATE TRIGGER session_messages_ad AFTER DELETE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
          VALUES('delete', old.rowid, old.content);
      END;
CREATE TRIGGER session_messages_ai AFTER INSERT ON session_messages BEGIN
        INSERT INTO session_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
CREATE TRIGGER session_messages_au AFTER UPDATE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
          VALUES('delete', old.rowid, old.content);
        INSERT INTO session_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
`
  },
  {
    version: 2,
    name: 'durable_run_budget_and_revision',
    sql: `
CREATE UNIQUE INDEX idx_agent_runs_single_active ON agent_runs(thread_id)
WHERE status IN ('waiting_next_turn','dispatch_pending','running','recovering','waiting_user');
CREATE TABLE agent_run_inbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  UNIQUE(run_id, submission_id)
);
CREATE TABLE agent_budget_calls (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('model','tool','child')),
  input_hash TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens >= 0),
  actual_tokens INTEGER CHECK(actual_tokens >= 0),
  state TEXT NOT NULL CHECK(state IN ('reserved','settled','unknown')),
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, call_id)
);
CREATE TABLE agent_tool_progress (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL
);
CREATE INDEX idx_agent_tool_progress_run ON agent_tool_progress(run_id, sequence);
CREATE TABLE agent_harness_revisions (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  revision_hash TEXT NOT NULL,
  revision_json TEXT NOT NULL
);
`
  },
  {
    version: 3,
    name: 'prepared_effect_reservations_and_receipts',
    sql: `
ALTER TABLE agent_tool_effects RENAME TO agent_tool_effects_previous;
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
        status TEXT NOT NULL CHECK(status IN ('reserved','in_progress','succeeded','failed_retryable','failed_final','unknown')),
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, execution_path, checkpoint_id, tool_call_id)
      );
INSERT INTO agent_tool_effects SELECT * FROM agent_tool_effects_previous;
DROP TABLE agent_tool_effects_previous;
CREATE INDEX idx_agent_tool_effects_run_status ON agent_tool_effects(run_id, status);
CREATE INDEX idx_agent_tool_effects_thread_updated ON agent_tool_effects(thread_id, updated_at DESC);
CREATE TABLE agent_tool_effect_reconciliations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  execution_path TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  evidence TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','not_applied')),
  created_at TEXT NOT NULL
);
`
  }
];


export const memoryMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'current_memory_schema',
    sql: `
CREATE TABLE langgraph_store_items (
        namespace_key TEXT NOT NULL,
        namespace_json TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace_key, key)
      );
CREATE TABLE memory_auto_audit (
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
CREATE TABLE memory_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        thread_id TEXT,
        run_id TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE INDEX idx_langgraph_store_items_namespace_key
        ON langgraph_store_items(namespace_key);
CREATE INDEX idx_memory_auto_audit_created
        ON memory_auto_audit(created_at DESC);
CREATE INDEX idx_memory_events_created
        ON memory_events(created_at DESC);
`
  }
];

export const taskMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'current_task_schema',
    sql: `
CREATE TABLE background_tasks (
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
      , task_revision INTEGER NOT NULL DEFAULT 1);
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
CREATE TABLE scheduled_task_runs (
        id TEXT PRIMARY KEY,
        background_task_id TEXT NOT NULL,
        task_run_id TEXT,
        scheduled_at TEXT NOT NULL,
        triggered_at TEXT,
        status TEXT NOT NULL,
        skip_reason TEXT,
        FOREIGN KEY(background_task_id) REFERENCES background_tasks(id)
      );
CREATE TABLE task_agent_outbox_cursors (
        projector_name TEXT PRIMARY KEY,
        last_sequence  INTEGER NOT NULL,
        updated_at     TEXT NOT NULL
      );
CREATE TABLE thread_deletion_journal (
        thread_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('pending','agent_deleted','complete')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
CREATE INDEX idx_scheduled_occurrences_claim_expiry
        ON scheduled_occurrences(status, claim_expires_at);
CREATE INDEX idx_scheduled_occurrences_run
        ON scheduled_occurrences(run_id);
CREATE UNIQUE INDEX idx_scheduled_occurrences_run_unique
        ON scheduled_occurrences(run_id)
        WHERE run_id IS NOT NULL;
CREATE INDEX idx_scheduled_occurrences_task_status_scheduled
        ON scheduled_occurrences(background_task_id, status, scheduled_at DESC);
CREATE INDEX idx_task_plugin_background_tasks_status_updated
        ON background_tasks(status, updated_at DESC);
CREATE INDEX idx_task_plugin_background_tasks_updated
        ON background_tasks(updated_at DESC);
CREATE INDEX idx_task_plugin_scheduled_task_runs_task_status
        ON scheduled_task_runs(background_task_id, status, scheduled_at DESC);
CREATE INDEX idx_task_thread_deletion_journal_state_updated
        ON thread_deletion_journal(state, updated_at);
`
  }
];

export const workspaceMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'current_workspace_schema',
    sql: `
CREATE TABLE recovery_points (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored INTEGER NOT NULL
      );
CREATE INDEX idx_workspace_recovery_points_created
        ON recovery_points(created_at DESC);
`
  }
];

export const diagnosticsMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'current_diagnostics_schema',
    sql: `
CREATE TABLE diagnostic_packages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        includes_json TEXT NOT NULL,
        redacted INTEGER NOT NULL
      );
CREATE TABLE performance_samples (
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
CREATE INDEX idx_performance_samples_sampled
        ON performance_samples(sampled_at DESC);
`
  }
];

export const researchMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'current_research_schema',
    sql: `
CREATE TABLE research_artifact_contents (
        artifact_id TEXT PRIMARY KEY REFERENCES research_artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES research_stage_runs(id),
        output_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE research_artifacts (
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
CREATE TABLE research_claim_revisions (
        claim_id TEXT NOT NULL REFERENCES research_claims(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(claim_id, version)
      );
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
CREATE TABLE research_document_parses (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES research_documents(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('running','ready','failed','cancelled')),
        data_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
CREATE TABLE research_documents (
        id TEXT PRIMARY KEY,
        library_item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0),
        status TEXT NOT NULL CHECK(status IN ('imported','parsing','ready','failed','cancelled')),
        current_parse_id TEXT,
        active_parse_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(library_item_id, source_hash)
      );
CREATE TABLE research_embedding_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        api_key_secret_key TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , revision INTEGER NOT NULL DEFAULT 1);
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
CREATE TABLE research_evidence_source_metadata (
        evidence_id TEXT PRIMARY KEY REFERENCES research_evidence(id) ON DELETE CASCADE, metadata_json TEXT NOT NULL
      );
CREATE TABLE research_experiment_executions (
        run_id TEXT PRIMARY KEY REFERENCES research_experiment_runs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('preparing','running','completed','failed','cancelled','interrupted')),
        snapshot_json TEXT NOT NULL, root_path TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(project_id,request_id)
      );
CREATE TABLE research_experiment_runs (
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
CREATE TABLE research_export_executions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('preparing','ready','failed','cancelled','interrupted')),
        artifact_id TEXT UNIQUE REFERENCES research_artifacts(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL, root_path TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(project_id,request_id)
      );
CREATE TABLE "research_figure_publications" (
        figure_id TEXT PRIMARY KEY REFERENCES research_figures(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE REFERENCES research_figure_runs(run_id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL UNIQUE REFERENCES research_artifacts(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE research_figure_runs (
        run_id TEXT PRIMARY KEY REFERENCES research_experiment_runs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('preparing','running','completed','failed','cancelled','interrupted')),
        snapshot_json TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, request_id)
      );
CREATE TABLE research_figures (
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
CREATE TABLE research_idea_canvas_revisions (
        artifact_id TEXT NOT NULL REFERENCES research_idea_canvases(artifact_id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(artifact_id, version)
      );
CREATE TABLE research_idea_canvases (
        artifact_id TEXT PRIMARY KEY REFERENCES research_artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version >= 1),
        snapshot_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE research_index_files (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, signature TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','missing')),
        source_hash TEXT, indexed_hash TEXT, indexed_chunks INTEGER NOT NULL, parser_key TEXT, embedding_key TEXT NOT NULL,
        payload_json TEXT, error TEXT, active_job_id TEXT, force_needed INTEGER NOT NULL CHECK(force_needed IN (0,1)), updated_at TEXT NOT NULL,
        UNIQUE(project_id,path)
      );
CREATE TABLE research_index_jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES research_index_files(id) ON DELETE CASCADE, path TEXT NOT NULL, generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','cancelled')), error TEXT, snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
CREATE TABLE research_index_projects (
        project_id TEXT PRIMARY KEY REFERENCES research_projects(id) ON DELETE CASCADE,
        options_json TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL,
        workspace_path TEXT, root_path TEXT, archived INTEGER NOT NULL CHECK(archived IN (0,1)),
        phase TEXT NOT NULL, error TEXT, scan_id TEXT, last_scan_at TEXT, embedding_key TEXT NOT NULL,
        scan_requested INTEGER NOT NULL, scan_force INTEGER NOT NULL, active_scan_force INTEGER NOT NULL
      );
CREATE TABLE research_index_sources (
        file_id TEXT NOT NULL REFERENCES research_index_files(id) ON DELETE CASCADE, source_hash TEXT NOT NULL,
        cache_path TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(file_id,source_hash)
      );
CREATE TABLE research_knowledge_chunks (
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
CREATE TABLE research_knowledge_documents (
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
CREATE VIRTUAL TABLE research_knowledge_documents_fts USING fts5(
        title,
        content,
        content='research_knowledge_documents',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
CREATE TABLE research_knowledge_embeddings (
        chunk_id TEXT NOT NULL,
        space_key TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(chunk_id, space_key),
        FOREIGN KEY(chunk_id) REFERENCES research_knowledge_chunks(id) ON DELETE CASCADE
      );
CREATE TABLE research_library (
        id TEXT PRIMARY KEY,
        identity_key TEXT NOT NULL UNIQUE,
        metadata_json TEXT NOT NULL,
        bibliography_json TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        archived INTEGER NOT NULL CHECK(archived IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE research_library_projects (
        item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        PRIMARY KEY(item_id, project_id)
      );
CREATE TABLE research_literature_records (
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
CREATE TABLE research_manuscripts (
        artifact_id TEXT PRIMARY KEY REFERENCES research_artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        sections_json TEXT NOT NULL,
        latex TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        claims_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE research_projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        workspace_path TEXT,
        status TEXT NOT NULL CHECK(status IN ('active','paused','completed','archived')),
        current_stage TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , language TEXT NOT NULL DEFAULT 'zh' CHECK(language IN ('zh','en')), origin_project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL, origin_artifact_id TEXT REFERENCES research_artifacts(id) ON DELETE SET NULL, origin_version INTEGER);
CREATE TABLE research_provenance (
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
CREATE TABLE research_review_cycles (
        project_id TEXT PRIMARY KEY REFERENCES research_projects(id) ON DELETE CASCADE,
        origin_artifact_id TEXT NOT NULL REFERENCES research_artifacts(id),
        manuscript_artifact_id TEXT NOT NULL REFERENCES research_artifacts(id),
        revision_round INTEGER NOT NULL CHECK(revision_round BETWEEN 0 AND 2),
        status TEXT NOT NULL CHECK(status IN ('reviewing','revision_required','accepted')),
        report_artifact_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE research_stage_policies (
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        PRIMARY KEY(project_id, stage)
      );
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
CREATE TABLE research_stage_states (
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
CREATE TABLE research_templates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        status TEXT NOT NULL,
        pdf_path TEXT,
        errors_json TEXT NOT NULL,
        last_compiled_at TEXT,
        updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, compiled_revision INTEGER, source_digest TEXT, compiled_digest TEXT, pdf_hash TEXT, active_compile_id TEXT, diagnostics_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );
CREATE TABLE research_workflow_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES research_projects(id) ON DELETE CASCADE
      );
CREATE TABLE research_workspace_files (
        project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0),
        revision INTEGER NOT NULL,
        owner_run_id TEXT REFERENCES research_stage_runs(id),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, path)
      );
CREATE INDEX idx_research_artifacts_project_stage
        ON research_artifacts(project_id, stage, updated_at DESC);
CREATE INDEX idx_research_claims_artifact ON research_claims(project_id, artifact_id);
CREATE INDEX idx_research_document_parses_document ON research_document_parses(document_id, created_at);
CREATE INDEX idx_research_evidence_project ON research_evidence(project_id, created_at DESC);
CREATE UNIQUE INDEX idx_research_experiment_artifact ON research_experiment_executions(json_extract(snapshot_json, '$.artifactId'))
        WHERE json_extract(snapshot_json, '$.artifactId') IS NOT NULL;
CREATE INDEX idx_research_experiment_executions_project ON research_experiment_executions(project_id,created_at);
CREATE INDEX idx_research_experiment_owner ON research_experiment_executions(json_extract(snapshot_json, '$.ownerRunId'));
CREATE INDEX idx_research_experiment_runs_project
        ON research_experiment_runs(project_id, started_at DESC);
CREATE INDEX idx_research_export_executions_project ON research_export_executions(project_id,created_at);
CREATE INDEX idx_research_export_owner ON research_export_executions(json_extract(snapshot_json, '$.ownerRunId'));
CREATE INDEX idx_research_figure_publications_project ON research_figure_publications(project_id, created_at);
CREATE UNIQUE INDEX idx_research_figure_run_artifact ON research_figure_runs(json_extract(snapshot_json, '$.artifactId'))
        WHERE json_extract(snapshot_json, '$.artifactId') IS NOT NULL;
CREATE INDEX idx_research_figure_run_owner ON research_figure_runs(json_extract(snapshot_json, '$.ownerRunId'));
CREATE INDEX idx_research_figure_runs_project ON research_figure_runs(project_id, created_at);
CREATE INDEX idx_research_figures_project
        ON research_figures(project_id, updated_at DESC);
CREATE INDEX idx_research_index_jobs_file ON research_index_jobs(file_id);
CREATE INDEX idx_research_index_jobs_project ON research_index_jobs(project_id,created_at);
CREATE INDEX idx_research_index_jobs_queue ON research_index_jobs(status,created_at);
CREATE INDEX idx_research_knowledge_chunks_document
        ON research_knowledge_chunks(document_id, chunk_index);
CREATE INDEX idx_research_knowledge_documents_project
        ON research_knowledge_documents(project_id, indexed_at DESC);
CREATE INDEX idx_research_library_citation_key ON research_library(json_extract(bibliography_json, '$.citationKey'));
CREATE INDEX idx_research_library_projects_project ON research_library_projects(project_id, item_id);
CREATE INDEX idx_research_literature_doi
        ON research_literature_records(doi);
CREATE INDEX idx_research_literature_updated
        ON research_literature_records(updated_at DESC);
CREATE UNIQUE INDEX idx_research_projects_origin
        ON research_projects(origin_artifact_id, origin_version)
        WHERE origin_artifact_id IS NOT NULL AND origin_version IS NOT NULL;
CREATE INDEX idx_research_projects_updated
        ON research_projects(updated_at DESC);
CREATE UNIQUE INDEX idx_research_projects_workspace_path
        ON research_projects(workspace_path)
        WHERE workspace_path IS NOT NULL AND trim(workspace_path) != '';
CREATE INDEX idx_research_provenance_subject
        ON research_provenance(subject_type, subject_id);
CREATE INDEX idx_research_stage_runs_project ON research_stage_runs(project_id, stage, status);
CREATE INDEX idx_research_stage_states_project
        ON research_stage_states(project_id, stage);
CREATE INDEX idx_research_templates_project
        ON research_templates(project_id, updated_at DESC);
CREATE INDEX idx_research_workflow_events_project_created
        ON research_workflow_events(project_id, created_at DESC);
CREATE TRIGGER research_knowledge_documents_ad AFTER DELETE ON research_knowledge_documents BEGIN
        INSERT INTO research_knowledge_documents_fts(research_knowledge_documents_fts, rowid, title, content)
          VALUES ('delete', old.rowid, old.title, old.content);
      END;
CREATE TRIGGER research_knowledge_documents_ai AFTER INSERT ON research_knowledge_documents BEGIN
        INSERT INTO research_knowledge_documents_fts(rowid, title, content)
          VALUES (new.rowid, new.title, new.content);
      END;
CREATE TRIGGER research_knowledge_documents_au AFTER UPDATE ON research_knowledge_documents BEGIN
        INSERT INTO research_knowledge_documents_fts(research_knowledge_documents_fts, rowid, title, content)
          VALUES ('delete', old.rowid, old.title, old.content);
        INSERT INTO research_knowledge_documents_fts(rowid, title, content)
          VALUES (new.rowid, new.title, new.content);
      END;
CREATE TRIGGER research_projects_origin_complete
        BEFORE INSERT ON research_projects
        WHEN ((NEW.origin_project_id IS NULL) = 1) + ((NEW.origin_artifact_id IS NULL) = 1) + ((NEW.origin_version IS NULL) = 1) NOT IN (0, 3)
        BEGIN SELECT RAISE(ABORT, 'research_project_origin_invalid'); END;
CREATE TRIGGER research_projects_origin_complete_update
        BEFORE UPDATE OF origin_project_id, origin_artifact_id, origin_version ON research_projects
        WHEN ((NEW.origin_project_id IS NULL) = 1) + ((NEW.origin_artifact_id IS NULL) = 1) + ((NEW.origin_version IS NULL) = 1) NOT IN (0, 3)
        BEGIN SELECT RAISE(ABORT, 'research_project_origin_invalid'); END;
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
