import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyDatabaseMigrations,
  readSchemaMetadata,
  type RocDatabaseMigration
} from '../../../src/main/infrastructure/database-migrations';
import { agentMigrations, coreMigrations, taskMigrations } from '../../../src/main/infrastructure/database-schemas';

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

  it('applies core migrations through version 2 without changing version order', () => {
    applyDatabaseMigrations(db, {
      dbName: 'core',
      migrations: coreMigrations,
      now: () => '2026-07-10T01:00:00.000Z'
    });

    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE db_name = 'core' ORDER BY version").all()
    ).toEqual([
      { version: 1, name: 'core_platform_tables' },
      { version: 2, name: 'database_maintenance_runs' }
    ]);
    expect(readSchemaMetadata(db, 'core')).toMatchObject({
      dbName: 'core',
      currentVersion: 2
    });
  });

  it('applies agent migrations through version 9 without changing earlier versions', () => {
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
      { version: 9, name: 'agent_effect_execution_identity' }
    ]);
    expect(readSchemaMetadata(db, 'agent')).toMatchObject({
      dbName: 'agent',
      currentVersion: 9
    });
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
