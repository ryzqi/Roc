import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyAgentDatabaseSchema,
  applyCoreDatabaseSchema,
  applyDiagnosticsDatabaseSchema,
  applyMemoryDatabaseSchema,
  applyTaskDatabaseSchema,
  applyWorkspaceDatabaseSchema
} from '../../../src/main/infrastructure/database-schemas';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('target database schemas', () => {
  it('creates core platform metadata tables', () => {
    applyCoreDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(
      expect.arrayContaining([
        'plugin_config',
        'plugin_secrets',
        'database_health_checks',
        'database_backup_manifests',
        'database_maintenance_runs',
        'schema_migrations',
        'schema_metadata'
      ])
    );
    expect(columnNames('database_maintenance_runs')).toEqual([
      'id',
      'kind',
      'status',
      'started_at',
      'finished_at',
      'detail_json',
      'error_message'
    ]);
    expect(indexNames('database_maintenance_runs')).toContain('idx_core_database_maintenance_runs_kind_finished');
  });

  it('creates canonical agent runtime tables without task-owned table names', () => {
    applyAgentDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(
      expect.arrayContaining([
        'agent_threads',
        'agent_runs',
        'agent_events',
        'session_messages',
        'session_messages_fts',
        'agent_pending_interrupts',
        'agent_run_events',
        'agent_run_telemetry',
        'langgraph_checkpoints',
        'langgraph_checkpoint_writes',
        'agent_tool_effects',
        'context_artifacts'
      ])
    );
    expect(tableNames()).not.toContain('task_threads');
    expect(tableNames()).not.toContain('task_runs');
    expect(tableNames()).not.toContain('task_events');
    expect(indexNames('agent_events')).toContain('idx_agent_events_thread_sequence');
  });

  it('creates memory store and audit tables', () => {
    applyMemoryDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(expect.arrayContaining(['langgraph_store_items', 'memory_events', 'memory_auto_audit']));
  });

  it('creates task-owned projection and deletion journal tables in task db', () => {
    applyTaskDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(expect.arrayContaining(['background_tasks', 'scheduled_task_runs', 'thread_deletion_journal']));
    expect(columnNames('thread_deletion_journal')).toEqual([
      'thread_id',
      'state',
      'attempt_count',
      'last_error',
      'created_at',
      'updated_at',
      'completed_at'
    ]);
    expect(indexNames('thread_deletion_journal')).toContain('idx_task_thread_deletion_journal_state_updated');
    expect(tableNames()).not.toContain('task_threads');
    expect(tableNames()).not.toContain('task_runs');
    expect(tableNames()).not.toContain('task_events');
  });

  it('creates workspace private tables under migration control', () => {
    applyWorkspaceDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toContain('recovery_points');
  });

  it('creates diagnostics private tables under migration control', () => {
    applyDiagnosticsDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(expect.arrayContaining(['performance_samples', 'diagnostic_packages']));
  });
});

function tableNames(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all() as Array<{
    name: string;
  }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'));
}

function columnNames(tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function indexNames(tableName: string): string[] {
  return (db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name);
}
