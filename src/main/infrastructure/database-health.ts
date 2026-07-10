import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import { DatabasePool } from './database-pool';
import type { RocLogicalDatabaseName } from './database-pragmas';
import {
  applyAgentDatabaseSchema,
  applyCoreDatabaseSchema,
  applyDiagnosticsDatabaseSchema,
  applyMemoryDatabaseSchema,
  applyTaskDatabaseSchema,
  applyWorkspaceDatabaseSchema
} from './database-schemas';

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

type ManagedDatabase = {
  dbName: RocLogicalDatabaseName;
  requiredTables: string[];
  open(pool: DatabasePool): DatabaseConnection;
  applySchema(db: DatabaseConnection, now: () => string): void;
};

const managedDatabases: ManagedDatabase[] = [
  {
    dbName: 'core',
    requiredTables: [
      'plugin_config',
      'plugin_secrets',
      'database_health_checks',
      'database_backup_manifests',
      'schema_migrations',
      'schema_metadata'
    ],
    open: (pool) => pool.getCoreConnection(),
    applySchema: applyCoreDatabaseSchema
  },
  {
    dbName: 'agent',
    requiredTables: [
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
      'context_artifacts',
      'schema_migrations',
      'schema_metadata'
    ],
    open: (pool) => pool.getConnection('@roc/plugin-agent'),
    applySchema: applyAgentDatabaseSchema
  },
  {
    dbName: 'memory',
    requiredTables: ['langgraph_store_items', 'memory_events', 'memory_auto_audit', 'schema_migrations', 'schema_metadata'],
    open: (pool) => pool.getConnection('@roc/plugin-memory'),
    applySchema: applyMemoryDatabaseSchema
  },
  {
    dbName: 'task',
    requiredTables: [
      'background_tasks',
      'scheduled_task_runs',
      'thread_deletion_journal',
      'schema_migrations',
      'schema_metadata'
    ],
    open: (pool) => pool.getConnection('@roc/plugin-task'),
    applySchema: applyTaskDatabaseSchema
  },
  {
    dbName: 'plugin:@roc/plugin-workspace',
    requiredTables: ['recovery_points', 'schema_migrations', 'schema_metadata'],
    open: (pool) => pool.getConnection('@roc/plugin-workspace'),
    applySchema: applyWorkspaceDatabaseSchema
  },
  {
    dbName: 'plugin:@roc/plugin-diagnostics',
    requiredTables: ['performance_samples', 'diagnostic_packages', 'schema_migrations', 'schema_metadata'],
    open: (pool) => pool.getConnection('@roc/plugin-diagnostics'),
    applySchema: applyDiagnosticsDatabaseSchema
  }
];

export function checkRocDatabases(input: { rootDir: string; now: () => string }): RocDatabaseHealthReport {
  const checkedAt = input.now();
  const pool = new DatabasePool(input.rootDir);
  try {
    const now = () => checkedAt;
    const databases = managedDatabases.map((database) => checkManagedDatabase(pool, database, now));
    const report = {
      status: aggregateStatus(databases),
      databases,
      checkedAt
    };
    persistHealthReport(pool.getCoreConnection(), report);
    return report;
  } finally {
    pool.closeAll();
  }
}

function checkManagedDatabase(
  pool: DatabasePool,
  database: ManagedDatabase,
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
    const missingTable = findMissingTable(db, database.requiredTables);
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

function findMissingTable(db: DatabaseConnection, requiredTables: readonly string[]): string | null {
  const existingTables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
  for (const tableName of requiredTables) {
    if (!existingTables.has(tableName)) {
      return tableName;
    }
  }
  return null;
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
