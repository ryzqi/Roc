import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabasePool } from '../../../src/main/infrastructure/database-pool';
import {
  applyAgentDatabaseSchema,
  applyCoreDatabaseSchema,
  applyDiagnosticsDatabaseSchema,
  applyMemoryDatabaseSchema,
  applyTaskDatabaseSchema,
  applyWorkspaceDatabaseSchema
} from '../../../src/main/infrastructure/database-schemas';
import { checkRocDatabases } from '../../../src/main/infrastructure/database-health';

let root: string;
let pool: DatabasePool;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-database-health-test-'));
  pool = new DatabasePool(root);
});

afterEach(() => {
  pool.closeAll();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('checkRocDatabases', () => {
  it('reports every managed database healthy and persists health rows in core.db', () => {
    applyAllSchemas(pool);
    const getCoreConnection = vi.spyOn(pool, 'getCoreConnection');

    const report = checkRocDatabases({
      pool,
      now: () => '2026-07-06T00:00:00.000Z'
    });

    expect(report.status).toBe('healthy');
    expect(report.checkedAt).toBe('2026-07-06T00:00:00.000Z');
    expect(report.databases.map((item) => item.dbName).sort()).toEqual([
      'agent',
      'core',
      'memory',
      'plugin:@roc/plugin-diagnostics',
      'plugin:@roc/plugin-workspace',
      'task'
    ]);
    expect(report.databases.every((item) => item.quickCheck === 'ok')).toBe(true);
    expect(Object.fromEntries(report.databases.map((item) => [item.dbName, item.schemaVersion]))).toEqual({
      core: 2,
      agent: 8,
      memory: 1,
      task: 3,
      'plugin:@roc/plugin-workspace': 1,
      'plugin:@roc/plugin-diagnostics': 1
    });
    expect(getCoreConnection).toHaveBeenCalled();
    expect(pool.getCoreConnection().prepare('SELECT COUNT(*) FROM database_health_checks').pluck().get()).toBe(6);
  });

  it('marks schema drift unhealthy when a required table is missing', () => {
    applyAllSchemas(pool);
    pool.getConnection('@roc/plugin-task').prepare('DROP TABLE background_tasks').run();

    const report = checkRocDatabases({
      pool,
      now: () => '2026-07-06T00:00:00.000Z'
    });

    expect(report.status).toBe('unhealthy');
    expect(report.databases).toContainEqual(
      expect.objectContaining({
        dbName: 'task',
        status: 'unhealthy',
        detail: 'schema_table_missing:background_tasks'
      })
    );
  });

  it('marks task schema drift unhealthy when the deletion journal is missing', () => {
    applyAllSchemas(pool);
    pool.getConnection('@roc/plugin-task').prepare('DROP TABLE thread_deletion_journal').run();

    const report = checkRocDatabases({
      pool,
      now: () => '2026-07-06T00:00:00.000Z'
    });

    expect(report.status).toBe('unhealthy');
    expect(report.databases).toContainEqual(
      expect.objectContaining({
        dbName: 'task',
        status: 'unhealthy',
        detail: 'schema_table_missing:thread_deletion_journal'
      })
    );
  });
});

function applyAllSchemas(targetPool: DatabasePool): void {
  const now = () => '2026-07-06T00:00:00.000Z';
  applyCoreDatabaseSchema(targetPool.getCoreConnection(), now);
  applyAgentDatabaseSchema(targetPool.getConnection('@roc/plugin-agent'), now);
  applyMemoryDatabaseSchema(targetPool.getConnection('@roc/plugin-memory'), now);
  applyTaskDatabaseSchema(targetPool.getConnection('@roc/plugin-task'), now);
  applyWorkspaceDatabaseSchema(targetPool.getConnection('@roc/plugin-workspace'), now);
  applyDiagnosticsDatabaseSchema(targetPool.getConnection('@roc/plugin-diagnostics'), now);
}
