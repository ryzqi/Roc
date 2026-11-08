import {backfillKnowledgeKeywordsV1} from '../plugins/research/knowledge-keywords';
import type { Database as DatabaseConnection } from 'better-sqlite3';

import { applyDatabaseMigrations, type RocDatabaseMigration } from './database-migrations';
import type { RocLogicalDatabaseName } from './database-pragmas';
import { migrateLiteratureIdentity } from '../plugins/research/literature-identity-migration';
import { migrateLiteratureAliases } from '../plugins/research/literature-alias-migration';
import {migrateHistoricalEvidenceRelationsV21} from '../plugins/research/evidence-relations-migration-v21';

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
  },
  {
    version: 4,
    name: 'durable_task_acceptance',
    sql: `CREATE TABLE agent_task_contracts (
      run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
      contract_json TEXT NOT NULL,
      report_json TEXT,
      handoff_json TEXT
    );`
  },
  {
    version: 5,
    name: 'pilot_profile_runs',
    // P6-04: one row per started pilot run. The grant is durable so retries and restarts see the
    // same extra headroom, and the spent counters live here instead of the JSON settings so two
    // concurrent runs cannot overwrite each other's accounting.
    sql: `CREATE TABLE agent_pilot_runs (
      run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      disclosure TEXT NOT NULL,
      profile TEXT CHECK(profile IN ('read-only','low-side-effect')),
      bucket INTEGER NOT NULL CHECK(bucket >= 0 AND bucket < 100),
      extra_budget_microusd INTEGER NOT NULL CHECK(extra_budget_microusd >= 0),
      allowance_model_calls INTEGER NOT NULL CHECK(allowance_model_calls >= 0),
      allowance_tool_calls INTEGER NOT NULL CHECK(allowance_tool_calls >= 0),
      allowance_tokens INTEGER NOT NULL CHECK(allowance_tokens >= 0),
      spent_model_calls INTEGER NOT NULL DEFAULT 0 CHECK(spent_model_calls >= 0),
      spent_tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(spent_tool_calls >= 0),
      spent_tokens INTEGER NOT NULL DEFAULT 0 CHECK(spent_tokens >= 0),
      state TEXT NOT NULL CHECK(state IN ('active','exhausted','finished','cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE INDEX idx_agent_pilot_runs_created ON agent_pilot_runs(created_at DESC);`
  },
  {
    version: 6,
    name: 'checkpoint_write_task_path',
    // langgraph 1.5 起 pendingWrites 的排序键是 `(task_path, task_id, idx)`：并行 superstep 里
    // 同一 DeltaChannel 的写入必须按任务路径而不是 uuid5 任务 id 重放，否则每次运行的顺序都不同。
    // 旧行落成空字符串（就是根任务的路径），读回时按 task_id/idx 重新排序——升级前是按插入顺序，
    // 那一点不再保留（上游契约要求排序键）。
    sql: `ALTER TABLE langgraph_checkpoint_writes ADD COLUMN task_path TEXT NOT NULL DEFAULT '';`
  },
  {
    version: 7,
    name: 'durable_execution_grants',
    sql: `
CREATE TABLE agent_execution_run_fences (
      run_id TEXT PRIMARY KEY,
      revoked_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );
CREATE TABLE agent_execution_approvals (
      approval_reference TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_dev TEXT NOT NULL,
      workspace_ino TEXT NOT NULL,
      cwd TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      resource_scope_hash TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('issued','consumed','revoked','expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
    );
CREATE UNIQUE INDEX idx_agent_execution_approvals_run_call_live
      ON agent_execution_approvals(run_id, tool_call_id) WHERE status IN ('issued','consumed');
CREATE INDEX idx_agent_execution_approvals_run_status
      ON agent_execution_approvals(run_id, status, expires_at);
CREATE TABLE agent_execution_grants (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      subject TEXT NOT NULL,
      profile TEXT NOT NULL CHECK(profile IN ('isolated_read','isolated_write','trusted_host')),
      workspace_path TEXT NOT NULL,
      workspace_dev TEXT NOT NULL,
      workspace_ino TEXT NOT NULL,
      cwd TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      resource_scope_hash TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      network_policy TEXT NOT NULL CHECK(network_policy IN ('deny','inherit')),
      max_duration_ms INTEGER NOT NULL CHECK(max_duration_ms > 0 AND max_duration_ms <= 120000),
      max_output_bytes INTEGER NOT NULL CHECK(max_output_bytes > 0 AND max_output_bytes <= 1048576),
      approval_reference TEXT,
      status TEXT NOT NULL CHECK(status IN ('issued','consumed','revoked','expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(approval_reference) REFERENCES agent_execution_approvals(approval_reference)
    );
CREATE UNIQUE INDEX idx_agent_execution_grants_run_call_live
      ON agent_execution_grants(run_id, tool_call_id) WHERE status IN ('issued','consumed');
CREATE INDEX idx_agent_execution_grants_run_status
      ON agent_execution_grants(run_id, status, expires_at);
CREATE INDEX idx_agent_execution_grants_expiry
      ON agent_execution_grants(status, expires_at);
`
  },
  {
    version: 8,
    name: 'versioned_run_budget_costs',
    sql: `
ALTER TABLE agent_budget_calls ADD COLUMN reserved_cost_microusd INTEGER CHECK(reserved_cost_microusd IS NULL OR reserved_cost_microusd >= 0);
ALTER TABLE agent_budget_calls ADD COLUMN actual_cost_microusd INTEGER CHECK(actual_cost_microusd IS NULL OR actual_cost_microusd >= 0);
ALTER TABLE agent_budget_calls ADD COLUMN pricing_version TEXT;
ALTER TABLE agent_runs ADD COLUMN budget_stop_reason TEXT;
CREATE INDEX idx_agent_budget_calls_run_kind_state ON agent_budget_calls(run_id, kind, state);
`
  },
  {
    version: 9,
    name: 'lease_fenced_tool_effect_operations',
    sql: `
ALTER TABLE agent_tool_effects ADD COLUMN identity_version INTEGER NOT NULL DEFAULT 0 CHECK(identity_version >= 0);
ALTER TABLE agent_tool_effects ADD COLUMN canonical_tool_identity TEXT;
ALTER TABLE agent_tool_effects ADD COLUMN canonicalization_version TEXT;
ALTER TABLE agent_tool_effects ADD COLUMN tool_version TEXT;
ALTER TABLE agent_tool_effects ADD COLUMN operation_id TEXT;
ALTER TABLE agent_tool_effects ADD COLUMN idempotency_key TEXT;
ALTER TABLE agent_tool_effects ADD COLUMN attempt_id TEXT;
ALTER TABLE agent_tool_effects ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0);
ALTER TABLE agent_tool_effects ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);
ALTER TABLE agent_tool_effects ADD COLUMN receipt_sequence INTEGER NOT NULL DEFAULT 0 CHECK(receipt_sequence >= 0);
ALTER TABLE agent_tool_effects ADD COLUMN receipt_json TEXT;
ALTER TABLE agent_tool_effects ADD COLUMN receipt_hash TEXT;
ALTER TABLE agent_tool_effects ADD COLUMN expected_version TEXT;
ALTER TABLE agent_tool_effects ADD COLUMN result_hash TEXT;
ALTER TABLE agent_tool_effect_reconciliations ADD COLUMN operation_id TEXT;
ALTER TABLE agent_tool_effect_reconciliations ADD COLUMN identity_version INTEGER NOT NULL DEFAULT 0 CHECK(identity_version >= 0);
ALTER TABLE agent_tool_effect_reconciliations ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0);
ALTER TABLE agent_tool_effect_reconciliations ADD COLUMN receipt_json TEXT;
ALTER TABLE agent_tool_effect_reconciliations ADD COLUMN receipt_hash TEXT;
UPDATE agent_tool_effects
SET status = 'failed_retryable', error_json = COALESCE(error_json, '{"code":"agent_tool_effect_not_dispatched_at_migration"}')
WHERE status = 'reserved';
UPDATE agent_tool_effects
SET status = 'unknown', error_json = COALESCE(error_json, '{"code":"agent_tool_effect_interrupted_at_migration"}')
WHERE status = 'in_progress' OR (status = 'failed_retryable' AND reconcile_strategy = 'manual_confirmation');
CREATE UNIQUE INDEX idx_agent_tool_effects_operation_id
  ON agent_tool_effects(operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX idx_agent_tool_effects_run_lease
  ON agent_tool_effects(run_id, status, lease_generation);
`
  },
  {
    version: 10,
    name: 'bounded_chat_run_event_journal',
    sql: `
ALTER TABLE agent_run_events ADD COLUMN event_bytes INTEGER NOT NULL DEFAULT 0 CHECK(event_bytes >= 0);
ALTER TABLE agent_run_event_cursors ADD COLUMN retained_count INTEGER NOT NULL DEFAULT 0 CHECK(retained_count >= 0);
ALTER TABLE agent_run_event_cursors ADD COLUMN retained_bytes INTEGER NOT NULL DEFAULT 0 CHECK(retained_bytes >= 0);
ALTER TABLE agent_run_event_cursors ADD COLUMN pending_count INTEGER NOT NULL DEFAULT 0 CHECK(pending_count >= 0);
ALTER TABLE agent_run_event_cursors ADD COLUMN pending_bytes INTEGER NOT NULL DEFAULT 0 CHECK(pending_bytes >= 0);
UPDATE agent_run_events SET event_bytes = length(CAST(event_json AS BLOB));
UPDATE agent_run_event_cursors
SET retained_count = (SELECT COUNT(*) FROM agent_run_events WHERE agent_run_events.run_id = agent_run_event_cursors.run_id),
    retained_bytes = (SELECT COALESCE(SUM(event_bytes), 0) FROM agent_run_events WHERE agent_run_events.run_id = agent_run_event_cursors.run_id);
CREATE TABLE agent_run_event_snapshots (
        run_id TEXT PRIMARY KEY,
        through_sequence INTEGER NOT NULL CHECK(through_sequence >= 0),
        snapshot_json TEXT NOT NULL,
        snapshot_bytes INTEGER NOT NULL CHECK(snapshot_bytes >= 0),
        updated_at TEXT NOT NULL
      );
CREATE TABLE agent_run_event_snapshot_pending (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        event_json TEXT NOT NULL,
        event_bytes INTEGER NOT NULL CHECK(event_bytes > 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence)
      );
`
  }
];


agentMigrations.push({
  version: 11,
  name: 'trusted_research_tasks_and_dispatch',
  sql: `
CREATE TABLE research_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX research_tasks_project ON research_tasks(project_id, created_at);
CREATE TABLE research_task_executions (
  kind TEXT NOT NULL, execution_id TEXT NOT NULL, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(kind, execution_id), FOREIGN KEY(task_id) REFERENCES research_tasks(id)
);
CREATE INDEX research_task_execution_task ON research_task_executions(task_id, created_at);
CREATE TABLE agent_research_dispatch_grants (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL, project_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, state TEXT NOT NULL
    CHECK(state IN ('issued','consumed','expired','revoked')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES agent_runs(id)
);
CREATE INDEX agent_research_dispatch_run ON agent_research_dispatch_grants(run_id, state);
`
});

agentMigrations.push({
  version: 12,
  name: 'shared_research_task_budget',
  sql: `
CREATE TABLE research_task_budgets (
  task_id TEXT PRIMARY KEY REFERENCES research_tasks(id), limits_json TEXT NOT NULL,
  stop_reason TEXT, created_at TEXT NOT NULL
);
CREATE TABLE agent_budget_calls_next (
  run_id TEXT NOT NULL, call_id TEXT NOT NULL,
  execution_kind TEXT NOT NULL CHECK(execution_kind IN ('chat','stage')),
  task_id TEXT REFERENCES research_tasks(id),
  kind TEXT NOT NULL CHECK(kind IN ('model','tool','child')), input_hash TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens >= 0),
  actual_tokens INTEGER CHECK(actual_tokens >= 0),
  state TEXT NOT NULL CHECK(state IN ('reserved','settled','unknown')),
  envelope_json TEXT NOT NULL, created_at TEXT NOT NULL,
  reserved_cost_microusd INTEGER CHECK(reserved_cost_microusd IS NULL OR reserved_cost_microusd >= 0),
  actual_cost_microusd INTEGER CHECK(actual_cost_microusd IS NULL OR actual_cost_microusd >= 0),
  pricing_version TEXT, PRIMARY KEY(run_id,call_id)
);
INSERT INTO agent_budget_calls_next
SELECT c.run_id,c.call_id,'chat',
  (SELECT e.task_id FROM research_task_executions e WHERE e.kind = 'chat' AND e.execution_id = c.run_id),
  c.kind,c.input_hash,c.reserved_tokens,c.actual_tokens,c.state,c.envelope_json,c.created_at,
  c.reserved_cost_microusd,c.actual_cost_microusd,c.pricing_version FROM agent_budget_calls c;
DROP TABLE agent_budget_calls;
ALTER TABLE agent_budget_calls_next RENAME TO agent_budget_calls;
CREATE INDEX idx_agent_budget_calls_run_kind_state ON agent_budget_calls(run_id,kind,state);
CREATE INDEX idx_agent_budget_calls_task ON agent_budget_calls(task_id,kind,state);
CREATE TABLE agent_tool_progress_next (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, fingerprint TEXT NOT NULL
);
INSERT INTO agent_tool_progress_next SELECT * FROM agent_tool_progress;
DROP TABLE agent_tool_progress;
ALTER TABLE agent_tool_progress_next RENAME TO agent_tool_progress;
CREATE INDEX idx_agent_tool_progress_run ON agent_tool_progress(run_id,sequence);
`
});

agentMigrations.push({
  version: 13,
  name: 'research_task_lifecycle',
  sql: `
ALTER TABLE research_tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK(status IN ('active','paused','waiting_approval','interrupted','completed','cancelled','failed'));
UPDATE research_tasks SET status = json_extract(snapshot_json,'$.status'), snapshot_json = json_set(snapshot_json,
  '$.schemaVersion', 2, '$.statusReason', NULL, '$.deadlineClock', 'continuous');
`
});

agentMigrations.push({
  version: 14,
  name: 'research_task_events',
  sql: `
CREATE TABLE research_task_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES research_tasks(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('task_created','task_status','execution_linked','call_linked','call_reserved','call_settled','call_unknown')),
  execution_kind TEXT CHECK(execution_kind IN ('chat','stage','experiment','figure','export')),
  execution_id TEXT, call_id TEXT, state TEXT, reason TEXT, created_at TEXT NOT NULL
);
CREATE INDEX research_task_events_task_sequence ON research_task_events(task_id,sequence);
CREATE TRIGGER research_task_created_event AFTER INSERT ON research_tasks BEGIN
  INSERT INTO research_task_events(task_id,event_type,state,reason,created_at)
  VALUES(NEW.id,'task_created',NEW.status,json_extract(NEW.snapshot_json,'$.statusReason'),NEW.created_at);
END;
CREATE TRIGGER research_task_status_event AFTER UPDATE OF status,snapshot_json ON research_tasks
WHEN NEW.status != OLD.status OR json_extract(NEW.snapshot_json,'$.statusReason') IS NOT json_extract(OLD.snapshot_json,'$.statusReason')
BEGIN
  INSERT INTO research_task_events(task_id,event_type,state,reason,created_at)
  VALUES(NEW.id,'task_status',NEW.status,json_extract(NEW.snapshot_json,'$.statusReason'),json_extract(NEW.snapshot_json,'$.updatedAt'));
END;
CREATE TRIGGER research_task_execution_event AFTER INSERT ON research_task_executions BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,created_at)
  VALUES(NEW.task_id,'execution_linked',NEW.kind,NEW.execution_id,NEW.created_at);
END;
CREATE TRIGGER research_task_call_reserved_event AFTER INSERT ON agent_budget_calls
WHEN NEW.task_id IS NOT NULL BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,call_id,state,created_at)
  VALUES(NEW.task_id,'call_reserved',NEW.execution_kind,NEW.run_id,NEW.call_id,NEW.state,NEW.created_at);
END;
CREATE TRIGGER research_task_call_linked_event AFTER UPDATE OF task_id ON agent_budget_calls
WHEN OLD.task_id IS NULL AND NEW.task_id IS NOT NULL BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,call_id,state,created_at)
  VALUES(NEW.task_id,'call_linked',NEW.execution_kind,NEW.run_id,NEW.call_id,NEW.state,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER research_task_call_settled_event AFTER UPDATE OF state ON agent_budget_calls
WHEN NEW.task_id IS NOT NULL AND NEW.state != OLD.state BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,call_id,state,created_at)
  VALUES(NEW.task_id,CASE WHEN NEW.state = 'unknown' THEN 'call_unknown' ELSE 'call_settled' END,
    NEW.execution_kind,NEW.run_id,NEW.call_id,NEW.state,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
`
});

agentMigrations.push({
  version: 15,
  name: 'research_project_budget',
  sql: `
ALTER TABLE agent_budget_calls ADD COLUMN project_id TEXT;
ALTER TABLE agent_budget_calls ADD COLUMN project_budget_revision INTEGER
  CHECK(project_budget_revision IS NULL OR (project_budget_revision>0 AND project_id IS NOT NULL));
UPDATE agent_budget_calls SET project_id=COALESCE(
  (SELECT project_id FROM research_tasks WHERE id=agent_budget_calls.task_id),
  (SELECT json_extract(snapshot_json,'$.researchProjectId') FROM agent_runs WHERE id=agent_budget_calls.run_id)
);
CREATE INDEX agent_budget_calls_project ON agent_budget_calls(project_id,kind,state);
CREATE TABLE research_project_budget_policies (
  project_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),limits_json TEXT NOT NULL,
  created_at TEXT NOT NULL,PRIMARY KEY(project_id,revision)
);
CREATE TABLE research_project_budget_states (
  project_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,stop_reason TEXT,updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id,revision) REFERENCES research_project_budget_policies(project_id,revision)
);
CREATE TRIGGER research_project_budget_policy_immutable BEFORE UPDATE ON research_project_budget_policies
BEGIN SELECT RAISE(ABORT,'research_project_budget_policy_immutable'); END;
CREATE TRIGGER research_project_budget_policy_retained BEFORE DELETE ON research_project_budget_policies
BEGIN SELECT RAISE(ABORT,'research_project_budget_policy_immutable'); END;
CREATE TRIGGER research_project_budget_call_scope BEFORE UPDATE OF project_id ON agent_budget_calls
WHEN OLD.project_id IS NOT NULL AND NEW.project_id IS NOT OLD.project_id
BEGIN SELECT RAISE(ABORT,'research_project_budget_association_conflict'); END;
CREATE TRIGGER research_project_budget_call_revision BEFORE UPDATE OF project_budget_revision ON agent_budget_calls
WHEN OLD.project_budget_revision IS NOT NULL AND NEW.project_budget_revision IS NOT OLD.project_budget_revision
BEGIN SELECT RAISE(ABORT,'research_project_budget_revision_conflict'); END;
`
});

agentMigrations.push({
  version: 16,
  name: 'research_dispatch_tool_domains',
  sql: `
ALTER TABLE agent_research_dispatch_grants ADD COLUMN tool_name TEXT NOT NULL DEFAULT 'research_run_stage'
  CHECK(tool_name IN ('research_run_stage','research_review_execute_query'));
`
});

agentMigrations.push({
  version: 17,
  name: 'research_review_query_task_events',
  sql: `
DROP TRIGGER research_task_created_event;
DROP TRIGGER research_task_status_event;
DROP TRIGGER research_task_execution_event;
DROP TRIGGER research_task_call_reserved_event;
DROP TRIGGER research_task_call_linked_event;
DROP TRIGGER research_task_call_settled_event;
CREATE TABLE research_task_events_next (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES research_tasks(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('task_created','task_status','execution_linked','call_linked','call_reserved','call_settled','call_unknown')),
  execution_kind TEXT CHECK(execution_kind IN ('chat','stage','experiment','figure','export','review_search')),
  execution_id TEXT, call_id TEXT, state TEXT, reason TEXT, created_at TEXT NOT NULL
);
INSERT INTO research_task_events_next SELECT * FROM research_task_events;
DROP TABLE research_task_events;
ALTER TABLE research_task_events_next RENAME TO research_task_events;
CREATE INDEX research_task_events_task_sequence ON research_task_events(task_id,sequence);
CREATE TRIGGER research_task_created_event AFTER INSERT ON research_tasks BEGIN
  INSERT INTO research_task_events(task_id,event_type,state,reason,created_at)
  VALUES(NEW.id,'task_created',NEW.status,json_extract(NEW.snapshot_json,'$.statusReason'),NEW.created_at);
END;
CREATE TRIGGER research_task_status_event AFTER UPDATE OF status,snapshot_json ON research_tasks
WHEN NEW.status != OLD.status OR json_extract(NEW.snapshot_json,'$.statusReason') IS NOT json_extract(OLD.snapshot_json,'$.statusReason')
BEGIN
  INSERT INTO research_task_events(task_id,event_type,state,reason,created_at)
  VALUES(NEW.id,'task_status',NEW.status,json_extract(NEW.snapshot_json,'$.statusReason'),json_extract(NEW.snapshot_json,'$.updatedAt'));
END;
CREATE TRIGGER research_task_execution_event AFTER INSERT ON research_task_executions BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,created_at)
  VALUES(NEW.task_id,'execution_linked',NEW.kind,NEW.execution_id,NEW.created_at);
END;
CREATE TRIGGER research_task_call_reserved_event AFTER INSERT ON agent_budget_calls
WHEN NEW.task_id IS NOT NULL BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,call_id,state,created_at)
  VALUES(NEW.task_id,'call_reserved',NEW.execution_kind,NEW.run_id,NEW.call_id,NEW.state,NEW.created_at);
END;
CREATE TRIGGER research_task_call_linked_event AFTER UPDATE OF task_id ON agent_budget_calls
WHEN OLD.task_id IS NULL AND NEW.task_id IS NOT NULL BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,call_id,state,created_at)
  VALUES(NEW.task_id,'call_linked',NEW.execution_kind,NEW.run_id,NEW.call_id,NEW.state,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER research_task_call_settled_event AFTER UPDATE OF state ON agent_budget_calls
WHEN NEW.task_id IS NOT NULL AND NEW.state != OLD.state BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,call_id,state,created_at)
  VALUES(NEW.task_id,CASE WHEN NEW.state = 'unknown' THEN 'call_unknown' ELSE 'call_settled' END,
    NEW.execution_kind,NEW.run_id,NEW.call_id,NEW.state,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
`
});

agentMigrations.push({
  version: 18, name: 'research_task_fact_revisions', sql: `
CREATE TABLE research_task_facts (
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0), snapshot_json TEXT NOT NULL,
  PRIMARY KEY(task_id,revision)
);
CREATE TRIGGER research_task_facts_immutable BEFORE UPDATE ON research_task_facts
BEGIN SELECT RAISE(ABORT,'research_task_facts_immutable'); END;
`
});

agentMigrations.push({version: 19, name: 'measured_model_call_observations', sql: `
CREATE INDEX idx_research_task_events_call ON research_task_events(task_id,execution_kind,execution_id,call_id,event_type,created_at)
WHERE call_id IS NOT NULL;
CREATE TABLE agent_budget_call_observations (
  run_id TEXT NOT NULL, call_id TEXT NOT NULL, started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  status TEXT NOT NULL CHECK(status IN ('completed','failed')),
  PRIMARY KEY(run_id,call_id),
  FOREIGN KEY(run_id,call_id) REFERENCES agent_budget_calls(run_id,call_id) ON DELETE CASCADE
);
CREATE TRIGGER agent_budget_call_observations_immutable BEFORE UPDATE ON agent_budget_call_observations
BEGIN SELECT RAISE(ABORT,'agent_budget_call_observations_immutable'); END;
`});

agentMigrations.push({version: 20, name: 'current_execution_contracts', offlineOnly: true, sql: `
DROP TRIGGER research_task_created_event;
DROP TRIGGER research_task_status_event;
DROP TRIGGER research_task_execution_event;
DROP TRIGGER research_task_call_reserved_event;
DROP TRIGGER research_task_call_linked_event;
DROP TRIGGER research_task_call_settled_event;
CREATE TABLE research_task_events_current (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES research_tasks(id), event_type TEXT NOT NULL,
  execution_kind TEXT, execution_id TEXT, call_id TEXT, state TEXT, reason TEXT, created_at TEXT NOT NULL,
  stream_sequence INTEGER, envelope_json TEXT
);
INSERT INTO research_task_events_current(sequence,task_id,event_type,execution_kind,execution_id,call_id,state,reason,created_at)
SELECT sequence,task_id,event_type,execution_kind,execution_id,call_id,state,reason,created_at FROM research_task_events;
DROP TABLE research_task_events;
ALTER TABLE research_task_events_current RENAME TO research_task_events;
CREATE INDEX research_task_events_task_sequence ON research_task_events(task_id,sequence);
CREATE INDEX idx_research_task_events_call ON research_task_events(task_id,execution_kind,execution_id,call_id,event_type,created_at) WHERE call_id IS NOT NULL;
CREATE UNIQUE INDEX research_task_event_stream_sequence ON research_task_events(task_id,stream_sequence);
CREATE TABLE research_task_event_cursors(task_id TEXT PRIMARY KEY REFERENCES research_tasks(id), next_sequence INTEGER NOT NULL);
CREATE TRIGGER research_task_event_envelope AFTER INSERT ON research_task_events BEGIN
  INSERT INTO research_task_event_cursors(task_id,next_sequence) VALUES(NEW.task_id,1) ON CONFLICT DO NOTHING;
  UPDATE research_task_events SET stream_sequence=(SELECT next_sequence FROM research_task_event_cursors WHERE task_id=NEW.task_id),
    envelope_json=roc_task_event((SELECT next_sequence FROM research_task_event_cursors WHERE task_id=NEW.task_id),NEW.task_id,(SELECT project_id FROM research_tasks WHERE id=NEW.task_id),NEW.execution_id,NEW.event_type,
      json_object('taskId',NEW.task_id,'executionKind',NEW.execution_kind,'executionId',NEW.execution_id,'callId',NEW.call_id,'state',NEW.state,'reason',NEW.reason),NEW.created_at)
    WHERE sequence=NEW.sequence;
  UPDATE research_task_event_cursors SET next_sequence=next_sequence+1 WHERE task_id=NEW.task_id;
  DELETE FROM research_task_events WHERE task_id=NEW.task_id AND stream_sequence < (SELECT next_sequence-10000 FROM research_task_event_cursors WHERE task_id=NEW.task_id);
END;
CREATE TRIGGER research_task_created_event AFTER INSERT ON research_tasks BEGIN
  INSERT INTO research_task_events(task_id,event_type,state,reason,created_at)
  VALUES(NEW.id,'task_created',NEW.status,json_extract(NEW.snapshot_json,'$.statusReason'),NEW.created_at);
END;
CREATE TRIGGER research_task_status_event AFTER UPDATE OF status,snapshot_json ON research_tasks
WHEN NEW.status != OLD.status OR json_extract(NEW.snapshot_json,'$.statusReason') IS NOT json_extract(OLD.snapshot_json,'$.statusReason')
BEGIN
  INSERT INTO research_task_events(task_id,event_type,state,reason,created_at)
  VALUES(NEW.id,'task_status',NEW.status,json_extract(NEW.snapshot_json,'$.statusReason'),json_extract(NEW.snapshot_json,'$.updatedAt'));
END;
CREATE TRIGGER research_task_execution_event AFTER INSERT ON research_task_executions BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,created_at)
  VALUES(NEW.task_id,'execution_linked',NEW.kind,NEW.execution_id,NEW.created_at);
END;
CREATE TRIGGER research_task_call_reserved_event AFTER INSERT ON agent_budget_calls
WHEN NEW.task_id IS NOT NULL BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,call_id,state,created_at)
  VALUES(NEW.task_id,'call_reserved',NEW.execution_kind,NEW.run_id,NEW.call_id,NEW.state,NEW.created_at);
END;
CREATE TRIGGER research_task_call_linked_event AFTER UPDATE OF task_id ON agent_budget_calls
WHEN OLD.task_id IS NULL AND NEW.task_id IS NOT NULL BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,call_id,state,created_at)
  VALUES(NEW.task_id,'call_linked',NEW.execution_kind,NEW.run_id,NEW.call_id,NEW.state,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER research_task_call_settled_event AFTER UPDATE OF state ON agent_budget_calls
WHEN NEW.task_id IS NOT NULL AND NEW.state != OLD.state BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,call_id,state,created_at)
  VALUES(NEW.task_id,CASE WHEN NEW.state = 'unknown' THEN 'call_unknown' ELSE 'call_settled' END,
    NEW.execution_kind,NEW.run_id,NEW.call_id,NEW.state,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TABLE research_task_event_deliveries (event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL);
CREATE TABLE agent_tool_effect_results (
  operation_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL, receipt_hash TEXT NOT NULL
);
CREATE TABLE execution_historical_audit (
  id TEXT PRIMARY KEY, source_table TEXT NOT NULL, source_id TEXT NOT NULL,
  source_version TEXT NOT NULL, raw_json TEXT NOT NULL, raw_hash TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TRIGGER research_task_effect_committed AFTER INSERT ON agent_tool_effect_results BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,state,reason,created_at)
  SELECT e.task_id,'effect_committed',e.kind,e.execution_id,'succeeded',NEW.operation_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM agent_tool_effects f JOIN research_task_executions e ON e.kind='chat' AND e.execution_id=f.run_id WHERE f.operation_id=NEW.operation_id;
END;
`});

agentMigrations.push({version: 21, name: 'research_task_dag', offlineOnly: true, sql: `
CREATE TABLE research_task_graphs (
  task_id TEXT PRIMARY KEY REFERENCES research_tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 0)
);
CREATE TABLE research_task_nodes (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL, execution_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, snapshot_json TEXT NOT NULL
);
CREATE INDEX research_task_nodes_ready ON research_task_nodes(status,task_id);
CREATE TABLE research_task_dependencies (
  task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  prerequisite TEXT NOT NULL REFERENCES research_task_nodes(id),
  dependent TEXT NOT NULL REFERENCES research_task_nodes(id),
  PRIMARY KEY(prerequisite,dependent), CHECK(prerequisite != dependent)
);
`});

// Keep historical migration checksums stable while accepting the execution broker's isolated effects.
agentMigrations.push({version: 22, name: 'isolated_execution_effects', sql: `
DROP TRIGGER research_task_effect_committed;
CREATE TABLE agent_tool_effects_next (
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  execution_path TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  effect_class TEXT NOT NULL CHECK(effect_class IN ('external_call','host_execution','network_read','workspace_mutation','isolated_execution')),
  reconcile_strategy TEXT NOT NULL CHECK(reconcile_strategy IN ('retry_safe','manual_confirmation')),
  status TEXT NOT NULL CHECK(status IN ('reserved','in_progress','succeeded','failed_retryable','failed_final','unknown')),
  result_json TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  identity_version INTEGER NOT NULL DEFAULT 0 CHECK(identity_version >= 0),
  canonical_tool_identity TEXT, canonicalization_version TEXT, tool_version TEXT,
  operation_id TEXT, idempotency_key TEXT, attempt_id TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  receipt_sequence INTEGER NOT NULL DEFAULT 0 CHECK(receipt_sequence >= 0),
  receipt_json TEXT, receipt_hash TEXT, expected_version TEXT, result_hash TEXT,
  PRIMARY KEY (run_id, execution_path, checkpoint_id, tool_call_id)
);
INSERT INTO agent_tool_effects_next SELECT * FROM agent_tool_effects;
DROP TABLE agent_tool_effects;
ALTER TABLE agent_tool_effects_next RENAME TO agent_tool_effects;
CREATE INDEX idx_agent_tool_effects_run_status ON agent_tool_effects(run_id, status);
CREATE INDEX idx_agent_tool_effects_thread_updated ON agent_tool_effects(thread_id, updated_at DESC);
CREATE UNIQUE INDEX idx_agent_tool_effects_operation_id ON agent_tool_effects(operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX idx_agent_tool_effects_run_lease ON agent_tool_effects(run_id, status, lease_generation);
CREATE TRIGGER research_task_effect_committed AFTER INSERT ON agent_tool_effect_results BEGIN
  INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,state,reason,created_at)
  SELECT e.task_id,'effect_committed',e.kind,e.execution_id,'succeeded',NEW.operation_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM agent_tool_effects f JOIN research_task_executions e ON e.kind='chat' AND e.execution_id=f.run_id WHERE f.operation_id=NEW.operation_id;
END;
`});

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
  },
  {
    version: 2,
    name: 'experience_records',
    sql: `
CREATE TABLE experience_records (
        id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version >= 1),
        status TEXT NOT NULL CHECK(status IN ('active','quarantined','revoked')),
        cue TEXT NOT NULL,
        lesson TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
        evidence_json TEXT NOT NULL,
        adoption_json TEXT NOT NULL,
        counterexamples_json TEXT NOT NULL,
        invalidation_json TEXT NOT NULL,
        project_scope_hash TEXT,
        task_hash TEXT NOT NULL,
        cue_task_index INTEGER NOT NULL CHECK(cue_task_index >= 0),
        execution_revision TEXT NOT NULL,
        improvement_revision TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
CREATE TABLE experience_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL,
        record_version INTEGER,
        type TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE INDEX idx_experience_records_latest
        ON experience_records(id, version DESC);
CREATE INDEX idx_experience_events_record
        ON experience_events(record_id, sequence);
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
  },
  {
    version: 2,
    name: 'research_derivation_generation',
    // 派生代际标记（提案 §8「无向后兼容」）：记录本库已完成到哪一代派生契约。
    // 只是开关，不存派生数据；切换本身在 document-repository 的事务里完成。
    sql: `
CREATE TABLE research_generations (
        name TEXT PRIMARY KEY,
        contract_version INTEGER NOT NULL,
        switched_at TEXT NOT NULL
      );
`
  },
  {
    version: 3,
    name: 'research_evidence_reference_state',
    // 证据引用失效（提案 §8.4）：旧代际或重新解析后被换代删除的块，其证据行打上失效标记。
    // 只加一列 NULL —— 追加式变化，旧库可直接升级。
    sql: `
ALTER TABLE research_evidence ADD COLUMN invalidated_at TEXT;
`
  },
  {
    version: 4,
    name: 'literature_search_and_import_operations',
    sql: `
CREATE TABLE research_literature_searches (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT,
  request_json TEXT NOT NULL, result_json TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX research_literature_search_owner ON research_literature_searches(owner, project_id);
CREATE TABLE research_literature_imports (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL,
  run_id TEXT, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  frozen_json TEXT NOT NULL, result_json TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner, scope_project, request_id)
);
`
  },
  {
    version: 5,
    name: 'research_knowledge_chunk_fts',
    sql: `
CREATE VIRTUAL TABLE research_knowledge_chunks_fts USING fts5(
  content,
  content='research_knowledge_chunks',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER research_knowledge_chunks_ai AFTER INSERT ON research_knowledge_chunks BEGIN
  INSERT INTO research_knowledge_chunks_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;
CREATE TRIGGER research_knowledge_chunks_ad AFTER DELETE ON research_knowledge_chunks BEGIN
  INSERT INTO research_knowledge_chunks_fts(research_knowledge_chunks_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER research_knowledge_chunks_au AFTER UPDATE ON research_knowledge_chunks BEGIN
  INSERT INTO research_knowledge_chunks_fts(research_knowledge_chunks_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO research_knowledge_chunks_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;
INSERT INTO research_knowledge_chunks_fts(research_knowledge_chunks_fts)
  VALUES ('rebuild');
`
  }
];

researchMigrations.push({
  version: 6,
  name: 'research_stage_task_identity',
  sql: `
ALTER TABLE research_stage_runs ADD COLUMN task_id TEXT;
CREATE INDEX research_stage_task ON research_stage_runs(task_id);
UPDATE research_stage_runs SET snapshot_json = json_set(snapshot_json, '$.taskId', NULL);
`
});

researchMigrations.push({
  version: 7,
  name: 'literature_search_execution_receipts',
  sql: `
CREATE TABLE research_literature_search_executions (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT, run_id TEXT,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','complete','partial','failed','cancelled','interrupted')),
  search_id TEXT, error_code TEXT, created_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX research_literature_execution_scope ON research_literature_search_executions(owner, project_id, created_at);
CREATE INDEX research_literature_execution_run ON research_literature_search_executions(run_id);
CREATE TABLE research_literature_request_receipts (
  execution_id TEXT NOT NULL REFERENCES research_literature_search_executions(id) ON DELETE CASCADE,
  source TEXT NOT NULL, attempt INTEGER NOT NULL CHECK (attempt > 0),
  state TEXT NOT NULL CHECK (state IN ('dispatched','received','unknown')),
  receipt_json TEXT NOT NULL, PRIMARY KEY (execution_id,source,attempt)
);
`
});

researchMigrations.push({
  version: 8,
  name: 'canonical_literature_identity',
  rebuild: {dataVersion: 'canonical_literature_identity_v1', migrate: migrateLiteratureIdentity},
  sql: `
CREATE TABLE research_library_next (
  id TEXT PRIMARY KEY, identity_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL, bibliography_json TEXT NOT NULL, sources_json TEXT NOT NULL,
  revision INTEGER NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO research_library_next SELECT * FROM research_library;
DROP TABLE research_library;
ALTER TABLE research_library_next RENAME TO research_library;
CREATE INDEX idx_research_library_identity ON research_library(identity_key);
CREATE INDEX idx_research_library_citation_key ON research_library(json_extract(bibliography_json, '$.citationKey'));
`
});

researchMigrations.push({
  version: 9,
  name: 'literature_declared_alias_index',
  data: {dataVersion: 'literature_declared_alias_index_v1', migrate: migrateLiteratureAliases},
  sql: `
CREATE TABLE research_library_aliases (
  item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
  identity TEXT NOT NULL, PRIMARY KEY(item_id,identity)
);
CREATE INDEX idx_research_library_alias_identity ON research_library_aliases(identity,item_id);
`
});

researchMigrations.push({
  version: 10,
  name: 'literature_provider_identifier_observations',
  sql: `
CREATE TABLE research_library_provider_identifiers (
  item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES research_literature_search_executions(id),
  source TEXT NOT NULL, rank INTEGER NOT NULL CHECK(rank>0),
  metadata_hash TEXT NOT NULL, external_id TEXT NOT NULL, retrieved_at TEXT NOT NULL,
  raw_json TEXT NOT NULL, mapped_json TEXT NOT NULL,
  PRIMARY KEY(item_id,execution_id,source,rank),
  UNIQUE(execution_id,source,rank)
);
CREATE INDEX idx_research_library_provider_identifiers_item
  ON research_library_provider_identifiers(item_id,retrieved_at,execution_id,source,rank);
`
});

researchMigrations.push({
  version: 11, name: 'literature_provider_review_observations',
  sql: `
CREATE TABLE research_library_provider_reviews (
  item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES research_literature_search_executions(id),
  source TEXT NOT NULL, rank INTEGER NOT NULL CHECK(rank>0),
  retrieved_at TEXT NOT NULL, record_json TEXT NOT NULL,
  PRIMARY KEY(item_id,execution_id,source,rank), UNIQUE(execution_id,source,rank)
);
CREATE INDEX idx_research_library_provider_reviews_item
  ON research_library_provider_reviews(item_id,retrieved_at,execution_id,source,rank);
`
});

researchMigrations.push({
  version: 12, name: 'literature_complete_captured_search_pools',
  sql: `
CREATE TABLE research_literature_search_pools (
  execution_id TEXT PRIMARY KEY REFERENCES research_literature_search_executions(id),
  pool_json TEXT NOT NULL
);
`
});

researchMigrations.push({
  version: 13, name: 'zotero_owned_immutable_previews',
  sql: `
CREATE TABLE research_zotero_previews (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT, run_id TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, snapshot_json TEXT NOT NULL
);
CREATE INDEX idx_research_zotero_previews_scope
  ON research_zotero_previews(owner,project_id,created_at,id);
`
});

researchMigrations.push({
  version: 14, name: 'zotero_import_object_versions',
  sql: `
CREATE TABLE research_zotero_objects (
  server_id TEXT NOT NULL, library_kind TEXT NOT NULL CHECK(library_kind IN ('user','group')),
  library_id INTEGER NOT NULL, item_key TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES research_library(id), object_version INTEGER NOT NULL CHECK(object_version>=0),
  item_hash TEXT NOT NULL, imported_at TEXT NOT NULL,
  PRIMARY KEY(server_id,library_kind,library_id,item_key)
);
CREATE TABLE research_zotero_object_versions (
  server_id TEXT NOT NULL, library_kind TEXT NOT NULL, library_id INTEGER NOT NULL, item_key TEXT NOT NULL,
  object_version INTEGER NOT NULL, item_id TEXT NOT NULL REFERENCES research_library(id),
  item_hash TEXT NOT NULL, preview_id TEXT NOT NULL REFERENCES research_zotero_previews(id),
  item_json TEXT NOT NULL, captured_at TEXT NOT NULL, imported_at TEXT NOT NULL,
  PRIMARY KEY(server_id,library_kind,library_id,item_key,object_version),
  FOREIGN KEY(server_id,library_kind,library_id,item_key)
    REFERENCES research_zotero_objects(server_id,library_kind,library_id,item_key)
);
CREATE INDEX idx_research_zotero_objects_item ON research_zotero_objects(item_id);
CREATE TABLE research_zotero_import_observations (
  operation_id TEXT NOT NULL REFERENCES research_literature_imports(id),
  server_id TEXT NOT NULL, library_kind TEXT NOT NULL, library_id INTEGER NOT NULL, item_key TEXT NOT NULL,
  object_version INTEGER NOT NULL, library_version INTEGER NOT NULL CHECK(library_version>=object_version),
  preview_id TEXT NOT NULL REFERENCES research_zotero_previews(id),
  captured_at TEXT NOT NULL, imported_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,server_id,library_kind,library_id,item_key),
  FOREIGN KEY(server_id,library_kind,library_id,item_key,object_version)
    REFERENCES research_zotero_object_versions(server_id,library_kind,library_id,item_key,object_version)
);
`
});

researchMigrations.push({
  version: 15, name: 'zotero_reviewed_page_checkpoints',
  sql: `
CREATE TABLE research_zotero_syncs (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL, scope_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','paused','completed','reset_required')),
  revision INTEGER NOT NULL CHECK(revision>=0), state_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_research_zotero_syncs_active ON research_zotero_syncs(scope_key)
  WHERE status IN ('active','paused');
CREATE TABLE research_zotero_sync_checkpoints (
  scope_key TEXT PRIMARY KEY, sync_id TEXT NOT NULL REFERENCES research_zotero_syncs(id),
  library_version INTEGER NOT NULL CHECK(library_version>=0), updated_at TEXT NOT NULL
);
CREATE TABLE research_zotero_sync_pages (
  sync_id TEXT NOT NULL REFERENCES research_zotero_syncs(id),
  source_offset INTEGER NOT NULL CHECK(source_offset>=0),
  preview_id TEXT NOT NULL REFERENCES research_zotero_previews(id),
  decisions_json TEXT NOT NULL, acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(sync_id,source_offset), UNIQUE(preview_id)
);
CREATE TABLE research_zotero_sync_seen (
  sync_id TEXT NOT NULL REFERENCES research_zotero_syncs(id), item_key TEXT NOT NULL,
  object_version INTEGER NOT NULL CHECK(object_version>=0),
  source_offset INTEGER NOT NULL CHECK(source_offset>=0),
  PRIMARY KEY(sync_id,item_key),
  FOREIGN KEY(sync_id,source_offset) REFERENCES research_zotero_sync_pages(sync_id,source_offset)
);
`
});

researchMigrations.push({
  version: 16, name: 'zotero_owned_source_state_observations',
  sql: `
CREATE TABLE research_zotero_source_states (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES research_literature_imports(id),
  server_id TEXT NOT NULL, library_kind TEXT NOT NULL CHECK(library_kind IN ('user','group')), library_id INTEGER NOT NULL,
  item_key TEXT NOT NULL, collection_key TEXT,
  state_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
  FOREIGN KEY(operation_id,server_id,library_kind,library_id,item_key)
    REFERENCES research_zotero_import_observations(operation_id,server_id,library_kind,library_id,item_key)
);
CREATE INDEX idx_research_zotero_source_states_scope ON research_zotero_source_states
  (owner,scope_project,operation_id,server_id,library_kind,library_id,item_key,collection_key);
`
});

researchMigrations.push({
  version: 17, name: 'zotero_owned_attachment_inspections',
  sql: `
CREATE TABLE research_zotero_attachment_inspections (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES research_literature_imports(id),
  server_id TEXT NOT NULL, library_kind TEXT NOT NULL CHECK(library_kind IN ('user','group')), library_id INTEGER NOT NULL,
  item_key TEXT NOT NULL, attachment_key TEXT NOT NULL, inspection_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
  FOREIGN KEY(operation_id,server_id,library_kind,library_id,item_key)
    REFERENCES research_zotero_import_observations(operation_id,server_id,library_kind,library_id,item_key)
);
CREATE INDEX idx_research_zotero_attachment_inspections_scope ON research_zotero_attachment_inspections
  (owner,scope_project,operation_id,server_id,library_kind,library_id,item_key,attachment_key);
`
});

researchMigrations.push({
  version: 18, name: 'zotero_scoped_selected_file_input_grants',
  sql: `
CREATE TABLE research_zotero_attachment_grants (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL,
  request_id TEXT NOT NULL, inspection_id TEXT NOT NULL REFERENCES research_zotero_attachment_inspections(id),
  grant_json TEXT NOT NULL, granted_at TEXT NOT NULL,
  UNIQUE(owner,scope_project,request_id)
);
`
});

researchMigrations.push({
  version: 19, name: 'zotero_owned_attachment_document_receipts',
  sql: `
CREATE TABLE research_zotero_attachment_imports (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope_project TEXT NOT NULL, request_id TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES research_zotero_attachment_grants(id),
  document_id TEXT NOT NULL REFERENCES research_documents(id), receipt_json TEXT NOT NULL, imported_at TEXT NOT NULL,
  UNIQUE(owner,scope_project,request_id)
);
`
});

researchMigrations.push({
  version: 20, name: 'immutable_evidence_document_source_locators',
  sql: `
CREATE TABLE research_evidence_source_locators (
  evidence_id TEXT PRIMARY KEY REFERENCES research_evidence(id) ON DELETE CASCADE,
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  captured_at TEXT NOT NULL
);
`
});

researchMigrations.push({
  version: 21, name: 'versioned_claim_evidence_relations',
  sql: `
CREATE TABLE research_evidence_relations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES research_claims(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES research_evidence(id),
  claim_version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('supports','contradicts','qualifies','depends_on','supersedes','historical')),
  status TEXT NOT NULL CHECK(status IN ('proposed','confirmed','rejected','invalidated','historical')),
  version INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_research_evidence_relations_claim ON research_evidence_relations(project_id,claim_id,status);
CREATE INDEX idx_research_evidence_relations_source ON research_evidence_relations(evidence_id,status);
CREATE TABLE research_evidence_relation_revisions (
  relation_id TEXT NOT NULL REFERENCES research_evidence_relations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(relation_id,version)
);
`,
  data: {dataVersion: 'historical-evidence-associations-v21/1', migrate: migrateHistoricalEvidenceRelationsV21}
});

researchMigrations.push({
  version: 22, name: 'document_source_migration_proposals',
  sql: `
CREATE TABLE research_source_migration_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES research_evidence(id),
  document_id TEXT NOT NULL REFERENCES research_documents(id),
  target_parse_id TEXT NOT NULL REFERENCES research_document_parses(id),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(evidence_id,target_parse_id)
);
CREATE INDEX idx_research_source_migration_evidence ON research_source_migration_proposals(project_id,evidence_id);
CREATE INDEX idx_research_evidence_locator_document ON research_evidence_source_locators(json_extract(locator_json,'$.documentId'));
`
});

researchMigrations.push({
  version: 23, name: 'human_source_migration_decisions',
  sql: `
CREATE TABLE research_source_migration_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES research_source_migration_proposals(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
`
});

researchMigrations.push({
  version: 24, name: 'explicit_source_replacement_lineage',
  sql: `
CREATE TABLE research_source_replacements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES research_evidence(id),
  target_evidence_id TEXT NOT NULL REFERENCES research_evidence(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(project_id,evidence_id,target_evidence_id)
);
CREATE INDEX idx_research_source_replacement_source ON research_source_replacements(project_id,evidence_id);
`
});

researchMigrations.push({
  version: 25, name: 'measured_document_coordinate_snapshots',
  sql: `
ALTER TABLE research_document_parses ADD COLUMN coordinate_snapshot_hash TEXT;
CREATE TABLE research_document_parse_coordinates (
  parse_id TEXT PRIMARY KEY REFERENCES research_document_parses(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES research_documents(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_research_document_coordinate_document ON research_document_parse_coordinates(document_id,parse_id);
`
});

researchMigrations.push({
  version: 26, name: 'fixed_document_user_annotations',
  sql: `
CREATE TABLE research_document_annotations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES research_documents(id),
  parse_id TEXT NOT NULL REFERENCES research_document_parses(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE INDEX idx_research_document_annotations_parse ON research_document_annotations(project_id,document_id,parse_id);
CREATE TABLE research_document_annotation_captures (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  annotation_id TEXT NOT NULL UNIQUE REFERENCES research_document_annotations(id),
  request_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES research_evidence(id),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
`
});

researchMigrations.push({
  version: 27, name: 'immutable_systematic_review_protocols',
  sql: `
CREATE TABLE research_review_protocol_versions (
  id TEXT PRIMARY KEY,
  protocol_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  parent_version_id TEXT REFERENCES research_review_protocol_versions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  freeze_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(protocol_id,version),
  UNIQUE(project_id,request_id)
);
CREATE INDEX idx_review_protocol_project ON research_review_protocol_versions(project_id,protocol_id,version);
CREATE TABLE research_review_protocol_freezes (
  version_id TEXT PRIMARY KEY REFERENCES research_review_protocol_versions(id),
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
`
});

researchMigrations.push({
  version: 28, name: 'frozen_protocol_search_execution_lineage',
  sql: `
CREATE TABLE research_review_searches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  protocol_version_id TEXT NOT NULL REFERENCES research_review_protocol_versions(id),
  database_index INTEGER NOT NULL,
  query_index INTEGER NOT NULL,
  retry_of TEXT REFERENCES research_review_searches(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','cancelling','complete','partial','failed','cancelled','interrupted')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  receipt_hash TEXT,
  cancellation_hash TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(retry_of)
);
CREATE INDEX idx_review_search_version ON research_review_searches(project_id,protocol_version_id,database_index,query_index);
CREATE TABLE research_review_search_cancellations (
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  review_search_id TEXT NOT NULL UNIQUE REFERENCES research_review_searches(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  PRIMARY KEY(project_id,request_id)
);
`
});

researchMigrations.push({
  version: 29, name: 'fixed_systematic_review_corpora',
  sql: `
CREATE TABLE research_review_corpora (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  protocol_version_id TEXT NOT NULL REFERENCES research_review_protocol_versions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE INDEX idx_review_corpus_version ON research_review_corpora(project_id,protocol_version_id);
`
});

researchMigrations.push({
  version: 30, name: 'human_systematic_review_deduplication',
  sql: `
ALTER TABLE research_review_corpora ADD COLUMN dedup_freeze_hash TEXT;
CREATE TABLE research_review_duplicate_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  pair_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  parent_id TEXT REFERENCES research_review_duplicate_decisions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,pair_key,version)
);
CREATE TABLE research_review_deduplication_freezes (
  corpus_id TEXT PRIMARY KEY REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
`
});

researchMigrations.push({
  version: 31, name: 'fixed_systematic_review_screening_reviewers',
  sql: `
ALTER TABLE research_review_corpora ADD COLUMN screening_plan_hash TEXT;
CREATE TABLE research_review_screening_plans (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL UNIQUE REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
`
});

researchMigrations.push({
  version: 32, name: 'separate_systematic_review_decisions_and_suggestions',
  sql: `
CREATE TABLE research_review_screening_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  hit_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  parent_id TEXT REFERENCES research_review_screening_decisions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,phase,hit_id,reviewer_id,version)
);
CREATE TABLE research_review_screening_suggestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  hit_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE INDEX idx_review_screening_suggestions ON research_review_screening_suggestions(corpus_id,phase,hit_id);
`
});

researchMigrations.push({
  version: 33, name: 'human_systematic_review_screening_arbitration',
  sql: `
CREATE TABLE research_review_screening_arbitrations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  hit_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  parent_id TEXT REFERENCES research_review_screening_arbitrations(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,phase,hit_id,version)
);
`
});

researchMigrations.push({
  version: 34, name: 'frozen_systematic_review_title_screening',
  sql: `
ALTER TABLE research_review_screening_plans ADD COLUMN title_freeze_hash TEXT;
CREATE TABLE research_review_screening_freezes (
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(corpus_id,phase),
  UNIQUE(project_id,request_id)
);
`
});

researchMigrations.push({
  version:35,name:'explicit_systematic_review_fulltext_sources',
  sql:`
CREATE TABLE research_review_fulltext_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  hit_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  parent_id TEXT REFERENCES research_review_fulltext_bindings(id),
  document_id TEXT REFERENCES research_documents(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,hit_id,version)
);
`
});

researchMigrations.push({
  version:36,name:'fixed_systematic_review_fulltext_authority',
  sql:'ALTER TABLE research_review_screening_plans ADD COLUMN full_freeze_hash TEXT;'
});

researchMigrations.push({
  version:37,name:'source_bound_systematic_review_extraction',
  sql:`
CREATE TABLE research_review_extractions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  hit_id TEXT NOT NULL,
  binding_id TEXT NOT NULL REFERENCES research_review_fulltext_bindings(id),
  version INTEGER NOT NULL CHECK(version > 0),
  parent_id TEXT REFERENCES research_review_extractions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,hit_id,version)
);
`
});

researchMigrations.push({
  version:38,name:'frozen_study_design_quality_framework',
  sql:`
ALTER TABLE research_review_extractions ADD COLUMN quality_plan_hash TEXT;
CREATE TABLE research_review_quality_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  hit_id TEXT NOT NULL,
  extraction_id TEXT NOT NULL UNIQUE REFERENCES research_review_extractions(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
`
});

researchMigrations.push({
  version:39,name:'research_review_human_quality_assessment',
  sql:`
ALTER TABLE research_review_quality_plans ADD COLUMN assessment_head_hash TEXT;
CREATE TABLE research_review_quality_assessments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES research_review_quality_plans(id),
  version INTEGER NOT NULL CHECK(version>0),
  parent_id TEXT REFERENCES research_review_quality_assessments(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(plan_id,version)
);
`
});

researchMigrations.push({
  version:40,name:'research_review_human_study_report_membership',
  sql:`
ALTER TABLE research_review_screening_plans ADD COLUMN study_group_head_hash TEXT;
CREATE TABLE research_review_study_groupings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL REFERENCES research_review_corpora(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version>0),
  parent_id TEXT REFERENCES research_review_study_groupings(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id),
  UNIQUE(corpus_id,version)
);
`
});

researchMigrations.push({
  version: 41, name: 'owned_review_query_dispatch',
  sql: `
ALTER TABLE research_review_searches ADD COLUMN owner_hash TEXT;
CREATE TABLE research_review_search_owners (
  review_search_id TEXT PRIMARY KEY REFERENCES research_review_searches(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL
);
`
});

researchMigrations.push({
  version: 42, name: 'project_python_environment_selections',
  sql: `
CREATE TABLE research_python_environment_selections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, request_id)
);
`
});

researchMigrations.push({
  version: 43, name: 'immutable_project_notebooks',
  sql: `
CREATE TABLE research_notebooks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  source_bytes BLOB NOT NULL CHECK(length(source_bytes)<=8388608),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, request_id)
);
`
});

researchMigrations.push({
  version:44,name:'immutable_human_experiment_results',
  sql:`
CREATE TABLE research_experiment_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES research_experiment_executions(run_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE INDEX research_experiment_results_run ON research_experiment_results(project_id,run_id);
`
});

researchMigrations.push({
  version: 45, name: 'human_idea_method_plan_timeline',
  sql: `
CREATE TABLE research_idea_plan_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_idea_canvases(artifact_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  freeze_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id, version),
  UNIQUE(project_id, request_id)
);
CREATE TABLE research_idea_plan_freezes (
  version_id TEXT PRIMARY KEY REFERENCES research_idea_plan_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, request_id)
);
`
});

researchMigrations.push({
  version: 46, name: 'human_frozen_idea_outcomes',
  sql: `
CREATE TABLE research_idea_outcomes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_idea_canvases(artifact_id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL REFERENCES research_idea_plan_freezes(version_id),
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(plan_version_id, version),
  UNIQUE(project_id, request_id)
);
`
});

researchMigrations.push({
  version: 47, name: 'human_citation_directness_timeline',
  sql: `
CREATE TABLE research_citation_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES research_claims(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES research_evidence(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(claim_id,evidence_id,version),
  UNIQUE(project_id,request_id)
);
CREATE INDEX research_citation_reviews_artifact ON research_citation_reviews(artifact_id);
`
});

researchMigrations.push({
  version: 48, name: 'human_scientific_consistency_timeline',
  sql: `
CREATE TABLE research_consistency_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id,version),
  UNIQUE(project_id,request_id)
);
CREATE INDEX research_consistency_reviews_artifact ON research_consistency_reviews(artifact_id);
`
});

researchMigrations.push({
  version: 49, name: 'human_figure_data_consistency_timeline',
  sql: `
CREATE TABLE research_figure_consistency_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id,version),
  UNIQUE(project_id,request_id)
);
CREATE INDEX research_figure_consistency_reviews_artifact ON research_figure_consistency_reviews(artifact_id);
`
});

researchMigrations.push({
  version: 50, name: 'human_review_response_matrix_timeline',
  sql: `
CREATE TABLE research_response_matrices (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id,version),
  UNIQUE(project_id,request_id)
);
CREATE INDEX research_response_matrices_artifact ON research_response_matrices(artifact_id);
`
});

researchMigrations.push({
  version: 51, name: 'human_journal_compliance_timeline',
  sql: `
CREATE TABLE research_journal_compliance (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES research_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id,version),
  UNIQUE(project_id,request_id)
);
CREATE INDEX research_journal_compliance_artifact ON research_journal_compliance(artifact_id);
`
});

researchMigrations.push({
  version: 52, name: 'immutable_scholarly_relation_snapshots',
  sql: `
CREATE TABLE research_scholarly_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES research_library(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE INDEX research_scholarly_item ON research_scholarly_snapshots(project_id,item_id);
`
});

researchMigrations.push({
  version: 53, name: 'immutable_research_resource_observations',
  sql: `
CREATE TABLE research_resource_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  doi TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE INDEX research_resource_doi ON research_resource_observations(project_id,doi);
`
});

researchMigrations.push({
  version: 54, name: 'explicit_research_resource_associations',
  sql: `
CREATE TABLE research_resource_associations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  resource_id TEXT NOT NULL REFERENCES research_resource_observations(id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('literature','experiment')),
  target_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE INDEX research_resource_association_resource ON research_resource_associations(project_id,resource_id);
CREATE INDEX research_resource_association_target ON research_resource_associations(project_id,target_kind,target_id);
`
});

researchMigrations.push({
  version: 55, name: 'immutable_huggingface_revision_observations',
  sql: `
CREATE TABLE research_hf_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('model','dataset')),
  repo TEXT NOT NULL,
  revision TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
CREATE INDEX research_hf_revision ON research_hf_observations(project_id,kind,repo,revision);
`
});

researchMigrations.push({
  version: 56, name: 'reviewed_huggingface_download_receipts',
  sql: `
CREATE TABLE research_hf_downloads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES research_hf_observations(id),
  authorization_json TEXT NOT NULL CHECK(json_valid(authorization_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled','interrupted')),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  UNIQUE(project_id,request_id)
);
CREATE INDEX research_hf_download_observation ON research_hf_downloads(project_id,observation_id);
`
});

researchMigrations.push({
  version: 57, name: 'immutable_public_openreview_observations',
  sql: `
CREATE TABLE research_openreview_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  query_json TEXT NOT NULL CHECK(json_valid(query_json)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
`
});

researchMigrations.push({
  version: 58, name: 'versioned_literature_monitors',
  sql: `
CREATE TABLE research_monitors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, query_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE TABLE research_monitor_versions (
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(monitor_id,version)
);
CREATE TABLE research_monitor_requests (
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL, request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(project_id,request_id)
);
CREATE TABLE research_monitor_checks (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  query_version INTEGER NOT NULL, control_revision INTEGER NOT NULL,
  check_key TEXT NOT NULL, status TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), UNIQUE(monitor_id,check_key)
);
CREATE UNIQUE INDEX research_monitor_one_running ON research_monitor_checks(monitor_id) WHERE status='running';
CREATE TABLE research_monitor_checkpoints (
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  query_version INTEGER NOT NULL, source TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(monitor_id,query_version,source)
);
CREATE TABLE research_monitor_seen (
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  query_version INTEGER NOT NULL, source TEXT NOT NULL, identity TEXT NOT NULL,
  first_check_id TEXT NOT NULL REFERENCES research_monitor_checks(id),
  PRIMARY KEY(monitor_id,query_version,source,identity)
);
CREATE TABLE research_monitor_alerts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES research_monitors(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL REFERENCES research_monitor_checks(id),
  query_version INTEGER NOT NULL, source TEXT NOT NULL, identity TEXT NOT NULL, kind TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  ack_json TEXT CHECK(ack_json IS NULL OR json_valid(ack_json)), UNIQUE(monitor_id,identity,kind)
);
`
});

researchMigrations.push({
  version: 59, name: 'reviewed_zenodo_preparations',
  sql: `
CREATE TABLE research_zenodo_preparations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id)
);
`
});

researchMigrations.push({
  version: 60, name: 'reviewed_zenodo_remote_operations',
  sql: `
CREATE TABLE research_zenodo_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  preparation_id TEXT NOT NULL REFERENCES research_zenodo_preparations(id),
  request_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  status TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_id), UNIQUE(project_id,preparation_id)
);
CREATE TABLE research_zenodo_publication_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL REFERENCES research_zenodo_operations(id),
  request_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE(operation_id,request_id)
);
`
});

researchMigrations.push({version: 61, name: 'stage_execution_contract', offlineOnly: true, sql: `
CREATE TABLE execution_historical_audit (
  id TEXT PRIMARY KEY, source_table TEXT NOT NULL, source_id TEXT NOT NULL,
  source_version TEXT NOT NULL, raw_json TEXT NOT NULL, raw_hash TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE research_execution_outbox (
  event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  delivered_at TEXT, error TEXT
);
CREATE TRIGGER research_workflow_semantic_outbox AFTER INSERT ON research_workflow_events
WHEN NEW.type IN ('approval_granted','approval_requested','approval_rejected') BEGIN
  INSERT INTO research_execution_outbox(event_id,task_id,project_id,event_type,payload_json,payload_hash,created_at)
  SELECT NEW.id || ':' || task_id,task_id,NEW.project_id,
    CASE WHEN NEW.type='approval_granted' AND NEW.stage='planning' THEN 'plan_approved' ELSE 'quality_gate' END,
    json_object('sourceEventId',NEW.id,'stage',NEW.stage,'decision',NEW.type,'facts',json(NEW.payload_json)),
    roc_payload_hash(json_object('sourceEventId',NEW.id,'stage',NEW.stage,'decision',NEW.type,'facts',json(NEW.payload_json))),NEW.created_at
  FROM research_stage_runs WHERE project_id=NEW.project_id AND stage=NEW.stage AND task_id IS NOT NULL GROUP BY task_id;
END;
CREATE TRIGGER research_claim_review_outbox AFTER UPDATE OF status ON research_evidence_relations
WHEN NEW.status IN ('confirmed','rejected') AND NEW.status!=OLD.status BEGIN
  INSERT INTO research_execution_outbox(event_id,task_id,project_id,event_type,payload_json,payload_hash,created_at)
  SELECT NEW.id || ':' || NEW.version || ':' || r.task_id,r.task_id,NEW.project_id,'claim_reviewed',
    NEW.snapshot_json,roc_payload_hash(NEW.snapshot_json),NEW.updated_at
  FROM research_stage_runs r JOIN research_claims c ON c.id=NEW.claim_id
  JOIN research_artifacts a ON a.id=c.artifact_id
  WHERE r.project_id=NEW.project_id AND r.stage=a.stage AND r.task_id IS NOT NULL GROUP BY r.task_id;
END;
CREATE TRIGGER research_source_invalidation_outbox AFTER UPDATE OF invalidated_at ON research_evidence
WHEN NEW.invalidated_at IS NOT NULL AND OLD.invalidated_at IS NULL BEGIN
  INSERT INTO research_execution_outbox(event_id,task_id,project_id,event_type,payload_json,payload_hash,created_at)
  SELECT NEW.id || ':' || NEW.invalidated_at || ':' || task_id,task_id,NEW.project_id,'source_invalidated',
    json_object('evidenceId',NEW.id,'sourceVersion',NEW.source_version,'contentHash',NEW.content_hash),
    roc_payload_hash(json_object('evidenceId',NEW.id,'sourceVersion',NEW.source_version,'contentHash',NEW.content_hash)),NEW.invalidated_at
  FROM research_stage_runs WHERE project_id=NEW.project_id AND task_id IS NOT NULL GROUP BY task_id;
END;
`});

researchMigrations.push({version: 62, name: 'required_stage_skill_manifest', offlineOnly: true, sql: `
CREATE TRIGGER research_stage_skill_pin_required BEFORE INSERT ON research_stage_runs
WHEN json_type(NEW.context_json,'$.skillPin') IS NOT 'object'
BEGIN SELECT RAISE(ABORT,'research_stage_skill_pin_required'); END;
`});

researchMigrations.push({version: 63, name: 'frozen_search_query_identity', offlineOnly: true, sql: `
CREATE UNIQUE INDEX research_literature_frozen_query ON research_literature_search_executions(
  project_id, json_extract(request_json,'$.strategy.artifactId'),
  json_extract(request_json,'$.strategy.contentHash'), json_extract(request_json,'$.strategy.queryId')
) WHERE json_type(request_json,'$.strategy.queryId')='text';
`});

researchMigrations.push({version: 64, name: 'task_node_commit_receipts', offlineOnly: true, sql: `
CREATE TABLE research_node_output_receipts (
  execution_id TEXT PRIMARY KEY REFERENCES research_stage_runs(id),
  lease_json TEXT NOT NULL CHECK(json_valid(lease_json)),
  output_json TEXT NOT NULL CHECK(json_valid(output_json))
);
CREATE TABLE research_node_decision_receipts (
  node_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id),
  output_hash TEXT NOT NULL, output_revision INTEGER NOT NULL,
  accepted INTEGER NOT NULL CHECK(accepted IN (0,1))
);
`});

researchMigrations.push({version: 65, name: 'reading_notes_and_academic_radar', sql: `
CREATE TABLE research_reading_notes (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE INDEX research_reading_notes_project ON research_reading_notes(project_id,updated_at);
CREATE TABLE research_reading_highlights (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 document_id TEXT NOT NULL, source_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE INDEX research_reading_highlights_document ON research_reading_highlights(project_id,document_id,source_hash);
CREATE TABLE research_radar_feeds (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE TABLE research_radar_articles (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 feed_id TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE INDEX research_radar_articles_feed ON research_radar_articles(project_id,feed_id);
CREATE TABLE research_radar_recommendations (
 project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
 cache_key TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(project_id,cache_key)
);
`});

researchMigrations.push({version: 66, name: 'durable_source_embedding_jobs', sql: `
CREATE TABLE research_knowledge_jobs (
 document_id TEXT PRIMARY KEY REFERENCES research_knowledge_documents(id) ON DELETE CASCADE,
 generation TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','blocked','failed','ready')),
 attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX research_knowledge_jobs_pending ON research_knowledge_jobs(status,updated_at,document_id);
INSERT INTO research_knowledge_jobs(document_id,generation,status,updated_at)
 SELECT id,lower(hex(randomblob(16))),'queued',indexed_at FROM research_knowledge_documents
 WHERE id LIKE 'library:%' OR id LIKE 'document:%' OR source_type='experiment';
`});

researchMigrations.push({version: 67, name: 'knowledge_positional_han_keywords', sql: `
CREATE VIRTUAL TABLE research_knowledge_keywords USING fts5(content,title);
CREATE TRIGGER research_knowledge_keywords_delete AFTER DELETE ON research_knowledge_chunks BEGIN
 DELETE FROM research_knowledge_keywords WHERE rowid=old.rowid;
END;
`, data: {dataVersion:'knowledge-positional-han-v1',migrate:backfillKnowledgeKeywordsV1}});

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
