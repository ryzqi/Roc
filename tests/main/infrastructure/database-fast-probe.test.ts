import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDatabaseFastProbe } from '../../../src/main/infrastructure/database-fast-probe';
import { DatabasePool } from '../../../src/main/infrastructure/database-pool';
import { applyDatabaseMigrations } from '../../../src/main/infrastructure/database-migrations';
import {
  agentMigrations,
  applyAgentDatabaseSchema,
  applyTaskDatabaseSchema
} from '../../../src/main/infrastructure/database-schemas';

let root: string;
let pool: DatabasePool;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-database-fast-probe-test-'));
  pool = new DatabasePool(root);
});

afterEach(() => {
  pool.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe('runDatabaseFastProbe', () => {
  it('applies schemas and verifies read and write-lock access without persisting health rows', () => {
    const report = runDatabaseFastProbe({
      pool,
      now: () => '2026-07-10T00:00:00.000Z'
    });

    expect(report.status).toBe('healthy');
    expect(report.databases.map((item) => item.dbName).sort()).toEqual([
      'agent',
      'core',
      'memory',
      'plugin:@roc/plugin-diagnostics',
      'plugin:@roc/plugin-workspace',
      'task'
    ]);
    expect(report.databases.every((item) => item.readProbe === 'ok')).toBe(true);
    expect(report.databases.every((item) => item.writeLockProbe === 'ok')).toBe(true);
    expect(Object.fromEntries(report.databases.map((item) => [item.dbName, item.schemaVersion]))).toEqual({
      core: 2,
      agent: 13,
      memory: 1,
      task: 4,
      'plugin:@roc/plugin-workspace': 1,
      'plugin:@roc/plugin-diagnostics': 1
    });
    expect(pool.getCoreConnection().prepare('SELECT COUNT(*) FROM database_health_checks').pluck().get()).toBe(0);
  });

  it('reports a missing required table as unhealthy without replacing the database file', () => {
    const taskDb = pool.getConnection('@roc/plugin-task');
    applyTaskDatabaseSchema(taskDb, () => '2026-07-10T00:00:00.000Z');
    taskDb.prepare('DROP TABLE thread_deletion_journal').run();
    const taskPath = pool.getDatabasePath('task');

    const report = runDatabaseFastProbe({
      pool,
      now: () => '2026-07-10T00:00:00.000Z'
    });

    expect(report.status).toBe('unhealthy');
    expect(report.databases).toContainEqual(
      expect.objectContaining({
        dbName: 'task',
        readProbe: 'failed',
        writeLockProbe: 'failed',
        detail: 'schema_table_missing:thread_deletion_journal'
      })
    );
    expect(existsSync(taskPath)).toBe(true);
  });

  it('reports missing agent run telemetry as unhealthy', () => {
    const agentDb = pool.getConnection('@roc/plugin-agent');
    const firstReport = runDatabaseFastProbe({
      pool,
      now: () => '2026-07-10T00:00:00.000Z'
    });
    expect(firstReport.status).toBe('healthy');
    agentDb.prepare('DROP TABLE agent_run_telemetry').run();

    const report = runDatabaseFastProbe({
      pool,
      now: () => '2026-07-10T00:00:01.000Z'
    });

    expect(report.status).toBe('unhealthy');
    expect(report.databases).toContainEqual(
      expect.objectContaining({
        dbName: 'agent',
        readProbe: 'failed',
        writeLockProbe: 'failed',
        detail: 'schema_table_missing:agent_run_telemetry'
      })
    );
  });

  it('upgrades a version 2 agent database while preserving orphaned historical run events', () => {
    const agentDb = pool.getConnection('@roc/plugin-agent');
    applyDatabaseMigrations(agentDb, {
      dbName: 'agent',
      migrations: agentMigrations.slice(0, 2),
      now: () => '2026-07-10T00:00:00.000Z'
    });
    agentDb
      .prepare(
        `INSERT INTO agent_run_events (run_id, sequence, event_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run('deleted-run', 1, '{"type":"run_completed"}', '2026-07-10T00:00:00.000Z');

    expect(() => applyAgentDatabaseSchema(agentDb, () => '2026-07-10T00:00:01.000Z')).not.toThrow();
    expect(agentDb.prepare('SELECT COUNT(*) FROM agent_run_events WHERE run_id = ?').pluck().get('deleted-run')).toBe(1);

    const report = runDatabaseFastProbe({
      pool,
      now: () => '2026-07-10T00:00:02.000Z'
    });
    expect(report.databases.find((item) => item.dbName === 'agent')).toMatchObject({
      status: 'healthy',
      schemaVersion: 13
    });
  });
});
