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
        'schema_migrations',
        'schema_metadata'
      ])
    );
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
        'langgraph_checkpoints',
        'langgraph_checkpoint_writes',
        'agent_tool_effects',
        'context_artifacts'
      ])
    );
    expect(tableNames()).not.toContain('task_threads');
    expect(tableNames()).not.toContain('task_runs');
    expect(tableNames()).not.toContain('task_events');
  });

  it('creates memory store and audit tables', () => {
    applyMemoryDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(expect.arrayContaining(['langgraph_store_items', 'memory_events', 'memory_auto_audit']));
  });

  it('creates only background task projection tables in task db', () => {
    applyTaskDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(expect.arrayContaining(['background_tasks', 'scheduled_task_runs']));
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
