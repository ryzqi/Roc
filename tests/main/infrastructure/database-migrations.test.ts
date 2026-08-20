import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyDatabaseMigrations,
  readSchemaMetadata,
  type RocDatabaseMigration
} from '../../../src/main/infrastructure/database-migrations';
import { agentMigrations, coreMigrations, taskMigrations } from '../../../src/main/infrastructure/database-schemas';
import { compileRunCapabilityManifest } from '../../../src/main/plugins/agent/run-capability-manifest';
import { parseRunExecutionSnapshot } from '../../../src/main/plugins/agent/run-execution-snapshot';
import { AgentRunTelemetryRepository } from '../../../src/main/plugins/agent/run-telemetry';
import type { RunExecutionSnapshotV1 } from '../../../src/shared/types';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('database migrations', () => {
  it('applies migrations once in version order and records metadata', () => {
    const migrations: RocDatabaseMigration[] = [
      {
        version: 1,
        name: 'create_first',
        sql: 'CREATE TABLE first_table (id TEXT PRIMARY KEY);'
      },
      {
        version: 2,
        name: 'create_second',
        sql: 'CREATE TABLE second_table (id TEXT PRIMARY KEY);'
      }
    ];

    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations,
      now: () => '2026-07-06T00:00:00.000Z'
    });
    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations,
      now: () => '2026-07-06T00:00:01.000Z'
    });

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'first_table'").pluck().get()).toBe('first_table');
    expect(db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(2);
    expect(readSchemaMetadata(db, 'agent')).toMatchObject({
      dbName: 'agent',
      currentVersion: 2
    });
  });

  it('rejects checksum drift for an already-applied migration', () => {
    applyDatabaseMigrations(db, {
      dbName: 'memory',
      migrations: [{ version: 1, name: 'create_items', sql: 'CREATE TABLE items (id TEXT PRIMARY KEY);' }],
      now: () => '2026-07-06T00:00:00.000Z'
    });

    expect(() =>
      applyDatabaseMigrations(db, {
        dbName: 'memory',
        migrations: [{ version: 1, name: 'create_items', sql: 'CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT);' }],
        now: () => '2026-07-06T00:00:01.000Z'
      })
    ).toThrow('database_migration_checksum_drift');
  });

  it('rejects non-contiguous migration versions', () => {
    expect(() =>
      applyDatabaseMigrations(db, {
        dbName: 'task',
        migrations: [
          { version: 1, name: 'one', sql: 'CREATE TABLE one (id TEXT PRIMARY KEY);' },
          { version: 3, name: 'three', sql: 'CREATE TABLE three (id TEXT PRIMARY KEY);' }
        ],
        now: () => '2026-07-06T00:00:00.000Z'
      })
    ).toThrow('database_migration_version_gap');
  });

  it('applies task migrations through version 4 without changing version order', () => {
    applyDatabaseMigrations(db, {
      dbName: 'task',
      migrations: taskMigrations,
      now: () => '2026-07-10T01:00:00.000Z'
    });

    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE db_name = 'task' ORDER BY version").all()
    ).toEqual([
      { version: 1, name: 'background_task_projection_tables' },
      { version: 2, name: 'thread_deletion_journal' },
      { version: 3, name: 'task_agent_outbox_cursor' },
      { version: 4, name: 'durable_scheduled_occurrences' }
    ]);
    expect(readSchemaMetadata(db, 'task')).toMatchObject({
      dbName: 'task',
      currentVersion: 4
    });
  });

  it('applies core migrations through version 3 without changing version order', () => {
    applyDatabaseMigrations(db, {
      dbName: 'core',
      migrations: coreMigrations,
      now: () => '2026-07-10T01:00:00.000Z'
    });

    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE db_name = 'core' ORDER BY version").all()
    ).toEqual([
      { version: 1, name: 'core_platform_tables' },
      { version: 2, name: 'database_maintenance_runs' },
      { version: 3, name: 'remove_legacy_langsmith_configuration' }
    ]);
    expect(readSchemaMetadata(db, 'core')).toMatchObject({
      dbName: 'core',
      currentVersion: 3
    });
  });

  it('applies agent migrations through version 14 without changing earlier versions', () => {
    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations,
      now: () => '2026-07-10T01:00:00.000Z'
    });

    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE db_name = 'agent' ORDER BY version").all()
    ).toEqual([
      { version: 1, name: 'agent_canonical_runtime_tables' },
      { version: 2, name: 'agent_event_sequence_cursor' },
      { version: 3, name: 'agent_run_execution_snapshot' },
      { version: 4, name: 'agent_run_state_transition' },
      { version: 5, name: 'agent_terminal_outbox' },
      { version: 6, name: 'agent_event_sequence_cursors' },
      { version: 7, name: 'agent_outbox_monotonic_sequence' },
      { version: 8, name: 'agent_notification_metrics' },
      { version: 9, name: 'agent_effect_execution_identity' },
      { version: 10, name: 'agent_pending_interrupt_collection' },
      { version: 11, name: 'agent_pending_interrupt_projection_minimal' },
      { version: 12, name: 'agent_run_telemetry' },
      { version: 13, name: 'agent_langsmith_trace_sessions' },
      { version: 14, name: 'remove_legacy_langsmith_trace_sessions' }
    ]);
    expect(readSchemaMetadata(db, 'agent')).toMatchObject({
      dbName: 'agent',
      currentVersion: 14
    });
  });

  it('removes legacy LangSmith configuration and trace sessions during upgrade', () => {
    const core = new Database(':memory:');
    const agent = new Database(':memory:');
    try {
      applyDatabaseMigrations(core, { dbName: 'core', migrations: coreMigrations.slice(0, 2) });
      core.prepare('INSERT INTO plugin_config (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
        .run('@roc/plugin-agent', 'langsmith.settings', '{}', '2026-07-06T00:00:00.000Z');
      core.prepare('INSERT INTO plugin_secrets (plugin_id, key, ciphertext_base64, updated_at) VALUES (?, ?, ?, ?)')
        .run('@roc/plugin-agent', 'langsmith.apiKey', 'legacy', '2026-07-06T00:00:00.000Z');
      core.prepare('INSERT INTO plugin_config (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
        .run('@roc/plugin-agent', 'other.setting', '{}', '2026-07-06T00:00:00.000Z');
      core.prepare('INSERT INTO plugin_secrets (plugin_id, key, ciphertext_base64, updated_at) VALUES (?, ?, ?, ?)')
        .run('@roc/plugin-agent', 'other.secret', 'current', '2026-07-06T00:00:00.000Z');
      applyDatabaseMigrations(core, { dbName: 'core', migrations: coreMigrations });
      expect(core.prepare('SELECT COUNT(*) FROM plugin_config WHERE key = ?').pluck().get('langsmith.settings')).toBe(0);
      expect(core.prepare('SELECT COUNT(*) FROM plugin_secrets WHERE key = ?').pluck().get('langsmith.apiKey')).toBe(0);
      expect(core.prepare('SELECT COUNT(*) FROM plugin_config WHERE key = ?').pluck().get('other.setting')).toBe(1);
      expect(core.prepare('SELECT COUNT(*) FROM plugin_secrets WHERE key = ?').pluck().get('other.secret')).toBe(1);

      applyDatabaseMigrations(agent, { dbName: 'agent', migrations: agentMigrations.slice(0, 13) });
      agent.prepare(
        `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES ('thread-legacy', 'chat', 'Legacy', 'Legacy', 'waiting_user', '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`
      ).run();
      agent.prepare(
        `INSERT INTO agent_runs
         (id, thread_id, run_number, user_input, status, started_at, enabled_capabilities_json)
         VALUES ('run-legacy', 'thread-legacy', 1, 'Legacy', 'waiting_user', '2026-07-06T00:00:00.000Z', '{}')`
      ).run();
      agent.prepare(
        `INSERT INTO agent_langsmith_trace_sessions
         (run_id, schema_version, session_json, created_at, updated_at)
         VALUES ('run-legacy', 1, '{}', '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`
      ).run();
      applyDatabaseMigrations(agent, { dbName: 'agent', migrations: agentMigrations });
      expect(agent.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_langsmith_trace_sessions'").pluck().get()).toBeUndefined();
    } finally {
      core.close();
      agent.close();
    }
  });

  it('backfills valid V2 runs when migrating the agent database from v11 to v12', () => {
    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations.slice(0, 11),
      now: () => '2026-07-10T01:00:00.000Z'
    });
    db.prepare(
      `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
       VALUES ('thread_telemetry_migration', 'chat', 'Telemetry', 'Telemetry', 'running', ?, ?)`
    ).run('2026-07-10T01:00:00.000Z', '2026-07-10T01:00:00.000Z');
    db.prepare(
      `INSERT INTO agent_runs
       (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
        enabled_capabilities_json, snapshot_json, snapshot_version, state_version, run_origin, dispatch_key)
       VALUES ('run_telemetry_migration', 'thread_telemetry_migration', 1, 'Migrate telemetry',
        'running', ?, NULL, 'openai', 'gpt-test', '{"mcpServers":[],"skills":[]}', ?, 2, 1, 'chat', NULL)`
    ).run(
      '2026-07-10T01:00:00.000Z',
      JSON.stringify({
        schemaVersion: 2,
        runOrigin: 'chat',
        dispatchKey: null,
        capabilityManifest: { manifestHash: 'manifest_migration' },
        model: { providerId: 'openai', modelId: 'gpt-test' }
      })
    );

    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations,
      now: () => '2026-07-10T01:00:01.000Z'
    });

    expect(new AgentRunTelemetryRepository(db).get('run_telemetry_migration')).toMatchObject({
      schemaVersion: 1,
      correlation: {
        runId: 'run_telemetry_migration',
        threadId: 'thread_telemetry_migration',
        runOrigin: 'chat',
        dispatchKey: null,
        snapshotVersion: 2,
        manifestHash: 'manifest_migration',
        providerId: 'openai',
        modelId: 'gpt-test'
      },
      terminal: {
        status: null,
        errorCode: null,
        retryable: null,
        cancelSource: null
      }
    });
  });

  it('backfills valid V1 runs when migrating the agent database from v11 to v12', () => {
    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations.slice(0, 11),
      now: () => '2026-07-10T01:00:00.000Z'
    });
    const capabilityManifest = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      mode: 'chat',
      requestedCapabilities: { mcpServers: [], skills: [] },
      skills: [],
      workflowHint: null
    }).manifest;
    const snapshot = {
      schemaVersion: 1,
      runId: 'run_telemetry_migration_v1',
      threadId: 'thread_telemetry_migration_v1',
      runOrigin: 'chat',
      model: { providerId: 'openai', modelId: 'gpt-test-v1' },
      mode: 'run',
      workspace: null,
      capabilityManifest,
      budget: { contextBudgetTokens: null },
      workflowHint: null,
      explicitSkillIds: [],
      inputMessageId: 'message_telemetry_migration_v1',
      dispatchKey: null
    } satisfies RunExecutionSnapshotV1;
    expect(parseRunExecutionSnapshot(snapshot)).toMatchObject({
      schemaVersion: 2,
      runId: snapshot.runId,
      threadId: snapshot.threadId
    });
    db.prepare(
      `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
       VALUES (?, 'chat', 'Telemetry V1', 'Telemetry V1', 'running', ?, ?)`
    ).run(snapshot.threadId, '2026-07-10T01:00:00.000Z', '2026-07-10T01:00:00.000Z');
    db.prepare(
      `INSERT INTO agent_runs
       (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
        enabled_capabilities_json, snapshot_json, snapshot_version, state_version, run_origin, dispatch_key)
       VALUES (?, ?, 1, 'Migrate V1 telemetry', 'running', ?, NULL, 'openai', 'gpt-test-v1',
        '{"mcpServers":[],"skills":[]}', ?, 1, 1, 'chat', NULL)`
    ).run(snapshot.runId, snapshot.threadId, '2026-07-10T01:00:00.000Z', JSON.stringify(snapshot));

    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations,
      now: () => '2026-07-10T01:00:01.000Z'
    });

    expect(new AgentRunTelemetryRepository(db).get(snapshot.runId)).toMatchObject({
      schemaVersion: 1,
      correlation: {
        runId: snapshot.runId,
        threadId: snapshot.threadId,
        runOrigin: snapshot.runOrigin,
        dispatchKey: snapshot.dispatchKey,
        snapshotVersion: 2,
        manifestHash: capabilityManifest.manifestHash,
        providerId: snapshot.model.providerId,
        modelId: snapshot.model.modelId
      },
      terminal: {
        status: null,
        errorCode: null,
        retryable: null,
        cancelSource: null
      }
    });
  });

  it('migrates the v9 single pending interrupt projection into an ordered collection', () => {
    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations.slice(0, 9),
      now: () => '2026-07-10T01:00:00.000Z'
    });
    db.prepare(
      `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
       VALUES ('thread_interrupt_migration', 'chat', 'Migration', 'Migration', 'waiting_user', ?, ?)`
    ).run('2026-07-10T01:00:00.000Z', '2026-07-10T01:00:00.000Z');
    db.prepare(
      `INSERT INTO agent_runs
       (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
        enabled_capabilities_json, workspace_path, task_source, workflow_hint)
       VALUES ('run_interrupt_migration', 'thread_interrupt_migration', 1, 'Migration', 'waiting_user', ?, NULL,
         'openai', 'gpt-test', '{"mcpServers":[],"skills":[]}', NULL, NULL, NULL)`
    ).run('2026-07-10T01:00:00.000Z');
    db.prepare(
      `INSERT INTO agent_pending_interrupts
       (run_id, thread_id, interrupt_id, payload_json, mode, task_source, workflow_hint,
        workspace_path_state, workspace_path, explicit_skill_ids_json, created_at, updated_at)
       VALUES ('run_interrupt_migration', 'thread_interrupt_migration', 'interrupt-legacy',
         '{"kind":"question","question":"Legacy?"}', 'snapshot', NULL, NULL, 'null', NULL, NULL, ?, ?)`
    ).run('2026-07-10T01:00:00.000Z', '2026-07-10T01:00:00.000Z');

    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations,
      now: () => '2026-07-10T01:00:01.000Z'
    });

    expect(
      db.prepare('SELECT run_id, interrupt_id, position FROM agent_pending_interrupts ORDER BY position').all()
    ).toEqual([{ run_id: 'run_interrupt_migration', interrupt_id: 'interrupt-legacy', position: 0 }]);
    expect(
      (db.prepare('PRAGMA table_info(agent_pending_interrupts)').all() as Array<{ name: string }>).map((column) => column.name)
    ).toEqual(['run_id', 'thread_id', 'interrupt_id', 'position', 'payload_json', 'created_at', 'updated_at']);
    db.prepare(
      `INSERT INTO agent_pending_interrupts
       (run_id, thread_id, interrupt_id, position, payload_json, created_at, updated_at)
       VALUES ('run_interrupt_migration', 'thread_interrupt_migration', 'interrupt-second', 1,
         '{"kind":"question","question":"Second?"}', ?, ?)`
    ).run('2026-07-10T01:00:01.000Z', '2026-07-10T01:00:01.000Z');
    expect(db.prepare('SELECT COUNT(*) FROM agent_pending_interrupts').pluck().get()).toBe(2);
  });

  it('migrates v8 tool effects without treating a restarted effect as still in progress', () => {
    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations.slice(0, 8),
      now: () => '2026-07-10T01:00:00.000Z'
    });
    const insert = db.prepare(
      `INSERT INTO agent_tool_effects
       (run_id, thread_id, tool_call_id, tool_name, input_hash, status, result_json, error_json, created_at, updated_at)
       VALUES (?, 'thread_legacy_effect', ?, 'run_shell_command', 'hash_legacy', ?, NULL, NULL,
         '2026-07-10T01:00:00.000Z', '2026-07-10T01:00:00.000Z')`
    );
    insert.run('run_success', 'call_success', 'success');
    insert.run('run_error', 'call_error', 'error');
    insert.run('run_in_progress', 'call_in_progress', 'in_progress');
    insert.run('run_unknown', 'call_unknown', 'unknown');

    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations,
      now: () => '2026-07-10T01:00:01.000Z'
    });

    expect(
      db.prepare(
        `SELECT run_id, execution_path, checkpoint_id, effect_class, reconcile_strategy, status
         FROM agent_tool_effects
         ORDER BY run_id`
      ).all()
    ).toEqual([
      {
        run_id: 'run_error',
        execution_path: 'legacy-main',
        checkpoint_id: 'legacy-checkpoint',
        effect_class: 'external_call',
        reconcile_strategy: 'manual_confirmation',
        status: 'failed_final'
      },
      {
        run_id: 'run_in_progress',
        execution_path: 'legacy-main',
        checkpoint_id: 'legacy-checkpoint',
        effect_class: 'external_call',
        reconcile_strategy: 'manual_confirmation',
        status: 'unknown'
      },
      {
        run_id: 'run_success',
        execution_path: 'legacy-main',
        checkpoint_id: 'legacy-checkpoint',
        effect_class: 'external_call',
        reconcile_strategy: 'manual_confirmation',
        status: 'succeeded'
      },
      {
        run_id: 'run_unknown',
        execution_path: 'legacy-main',
        checkpoint_id: 'legacy-checkpoint',
        effect_class: 'external_call',
        reconcile_strategy: 'manual_confirmation',
        status: 'unknown'
      }
    ]);
  });

  it('quarantines legacy non-terminal agent runs that have no execution snapshot', () => {
    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations.slice(0, 2),
      now: () => '2026-07-10T01:00:00.000Z'
    });
    db.prepare(
      `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'thread_legacy_run',
      'chat',
      'Legacy run',
      'Legacy run',
      'running',
      '2026-07-10T01:00:00.000Z',
      '2026-07-10T01:00:00.000Z'
    );
    db.prepare(
      `INSERT INTO agent_runs
       (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
        enabled_capabilities_json, workspace_path, task_source, workflow_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'run_legacy_snapshot_missing',
      'thread_legacy_run',
      1,
      'Legacy run',
      'running',
      '2026-07-10T01:00:00.000Z',
      null,
      'legacy-provider',
      'legacy-model',
      '{"mcpServers":[],"skills":[]}',
      null,
      null,
      null
    );

    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations,
      now: () => '2026-07-10T01:00:01.000Z'
    });

    expect(db.prepare('SELECT status, snapshot_error_code FROM agent_runs WHERE id = ?').get('run_legacy_snapshot_missing')).toEqual({
      status: 'interrupted',
      snapshot_error_code: 'legacy_snapshot_missing'
    });
    expect(db.prepare('SELECT status FROM agent_threads WHERE id = ?').pluck().get('thread_legacy_run')).toBe('interrupted');
  });
});
