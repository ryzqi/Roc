import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDatabaseFastProbe } from '../../../src/main/infrastructure/database-fast-probe';
import { DatabasePool } from '../../../src/main/infrastructure/database-pool';
import { applyTaskDatabaseSchema } from '../../../src/main/infrastructure/database-schemas';

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
      agent: 3,
      memory: 1,
      task: 2,
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
});
