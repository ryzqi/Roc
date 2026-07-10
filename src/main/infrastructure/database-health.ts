import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type { DatabasePool } from './database-pool';
import {
  findMissingDatabaseTable,
  managedDatabaseDefinitions,
  type ManagedDatabaseDefinition
} from './database-fast-probe';
import type { RocLogicalDatabaseName } from './database-pragmas';

export type RocDatabaseHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export type RocDatabaseHealthItem = {
  dbName: RocLogicalDatabaseName;
  status: RocDatabaseHealthStatus;
  quickCheck: 'ok' | 'failed';
  schemaVersion: number | null;
  detail: string;
};

export type RocDatabaseHealthReport = {
  status: RocDatabaseHealthStatus;
  databases: RocDatabaseHealthItem[];
  checkedAt: string;
};

export function checkRocDatabases(input: { pool: DatabasePool; now: () => string }): RocDatabaseHealthReport {
  const checkedAt = input.now();
  const now = () => checkedAt;
  const databases = managedDatabaseDefinitions.map((database) => checkManagedDatabase(input.pool, database, now));
  const report = {
    status: aggregateStatus(databases),
    databases,
    checkedAt
  };
  persistHealthReport(input.pool.getCoreConnection(), report);
  return report;
}

function checkManagedDatabase(
  pool: DatabasePool,
  database: ManagedDatabaseDefinition,
  now: () => string
): RocDatabaseHealthItem {
  try {
    const db = database.open(pool);
    database.applySchema(db, now);
    const quickCheck = readQuickCheck(db);
    const schemaVersion = readSchemaVersion(db, database.dbName);
    if (quickCheck !== 'ok') {
      return {
        dbName: database.dbName,
        status: 'unhealthy',
        quickCheck: 'failed',
        schemaVersion,
        detail: quickCheck
      };
    }
    if (schemaVersion === null) {
      return {
        dbName: database.dbName,
        status: 'degraded',
        quickCheck: 'ok',
        schemaVersion,
        detail: 'schema_version_missing'
      };
    }
    const missingTable = findMissingDatabaseTable(db, database.requiredTables);
    if (missingTable !== null) {
      return {
        dbName: database.dbName,
        status: 'unhealthy',
        quickCheck: 'ok',
        schemaVersion,
        detail: `schema_table_missing:${missingTable}`
      };
    }
    return {
      dbName: database.dbName,
      status: 'healthy',
      quickCheck: 'ok',
      schemaVersion,
      detail: 'ok'
    };
  } catch (error) {
    return {
      dbName: database.dbName,
      status: 'unhealthy',
      quickCheck: 'failed',
      schemaVersion: null,
      detail: error instanceof Error ? error.message : 'database_health_check_failed'
    };
  }
}

function readQuickCheck(db: DatabaseConnection): string {
  const result = db.prepare('PRAGMA quick_check').pluck().get() as string | undefined;
  if (result === undefined) {
    return 'quick_check_empty';
  }
  return result;
}

function readSchemaVersion(db: DatabaseConnection, dbName: RocLogicalDatabaseName): number | null {
  const row = db.prepare('SELECT current_version FROM schema_metadata WHERE db_name = ?').get(dbName) as
    | { current_version: number }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return row.current_version;
}

function aggregateStatus(items: readonly RocDatabaseHealthItem[]): RocDatabaseHealthStatus {
  if (items.some((item) => item.status === 'unhealthy')) {
    return 'unhealthy';
  }
  if (items.some((item) => item.status === 'degraded')) {
    return 'degraded';
  }
  return 'healthy';
}

function persistHealthReport(coreDb: DatabaseConnection, report: RocDatabaseHealthReport): void {
  const insert = coreDb.prepare(
    `INSERT INTO database_health_checks (id, db_name, status, detail_json, checked_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  coreDb.transaction(() => {
    for (const item of report.databases) {
      insert.run(`health_${randomUUID()}`, item.dbName, item.status, JSON.stringify(item), report.checkedAt);
    }
  })();
}
