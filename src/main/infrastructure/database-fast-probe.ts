import type { Database as DatabaseConnection } from 'better-sqlite3';

import type { DatabasePool } from './database-pool';
import type { RocLogicalDatabaseName } from './database-pragmas';
import {
  applyAgentDatabaseSchema,
  applyCoreDatabaseSchema,
  applyDiagnosticsDatabaseSchema,
  applyMemoryDatabaseSchema,
  applyTaskDatabaseSchema,
  applyWorkspaceDatabaseSchema
} from './database-schemas';

export type ManagedDatabaseDefinition = {
  dbName: RocLogicalDatabaseName;
  backupFileName: string;
  requiredTables: readonly string[];
  open(pool: DatabasePool): DatabaseConnection;
  applySchema(db: DatabaseConnection, now: () => string): void;
};

export type RocDatabaseFastProbeItem = {
  dbName: RocLogicalDatabaseName;
  status: 'healthy' | 'unhealthy';
  schemaVersion: number | null;
  readProbe: 'ok' | 'failed';
  writeLockProbe: 'ok' | 'failed';
  detail: string;
};

export type RocDatabaseFastProbeReport = {
  status: 'healthy' | 'unhealthy';
  databases: RocDatabaseFastProbeItem[];
  checkedAt: string;
};

export const managedDatabaseDefinitions: readonly ManagedDatabaseDefinition[] = [
  {
    dbName: 'core',
    backupFileName: 'core.db',
    requiredTables: [
      'plugin_config',
      'plugin_secrets',
      'database_health_checks',
      'database_backup_manifests',
      'database_maintenance_runs',
      'schema_migrations',
      'schema_metadata'
    ],
    open: (pool) => pool.getCoreConnection(),
    applySchema: applyCoreDatabaseSchema
  },
  {
    dbName: 'agent',
    backupFileName: '@roc-plugin-agent.db',
    requiredTables: [
      'agent_threads',
      'agent_runs',
      'agent_events',
      'session_messages',
      'session_messages_fts',
      'agent_pending_interrupts',
      'agent_run_events',
      'agent_notification_metrics',
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
    backupFileName: '@roc-plugin-memory.db',
    requiredTables: ['langgraph_store_items', 'memory_events', 'memory_auto_audit', 'schema_migrations', 'schema_metadata'],
    open: (pool) => pool.getConnection('@roc/plugin-memory'),
    applySchema: applyMemoryDatabaseSchema
  },
  {
    dbName: 'task',
    backupFileName: '@roc-plugin-task.db',
    requiredTables: [
      'background_tasks',
      'scheduled_task_runs',
      'scheduled_occurrences',
      'thread_deletion_journal',
      'schema_migrations',
      'schema_metadata'
    ],
    open: (pool) => pool.getConnection('@roc/plugin-task'),
    applySchema: applyTaskDatabaseSchema
  },
  {
    dbName: 'plugin:@roc/plugin-workspace',
    backupFileName: '@roc-plugin-workspace.db',
    requiredTables: ['recovery_points', 'schema_migrations', 'schema_metadata'],
    open: (pool) => pool.getConnection('@roc/plugin-workspace'),
    applySchema: applyWorkspaceDatabaseSchema
  },
  {
    dbName: 'plugin:@roc/plugin-diagnostics',
    backupFileName: '@roc-plugin-diagnostics.db',
    requiredTables: ['performance_samples', 'diagnostic_packages', 'schema_migrations', 'schema_metadata'],
    open: (pool) => pool.getConnection('@roc/plugin-diagnostics'),
    applySchema: applyDiagnosticsDatabaseSchema
  }
];

export function runDatabaseFastProbe(input: {
  pool: DatabasePool;
  now: () => string;
}): RocDatabaseFastProbeReport {
  const checkedAt = input.now();
  const now = () => checkedAt;
  const databases = managedDatabaseDefinitions.map((definition) => probeManagedDatabase(input.pool, definition, now));
  return {
    status: databases.some((database) => database.status === 'unhealthy') ? 'unhealthy' : 'healthy',
    databases,
    checkedAt
  };
}

export function readRequiredSchemaVersion(db: DatabaseConnection, dbName: RocLogicalDatabaseName): number {
  const row = db.prepare('SELECT current_version FROM schema_metadata WHERE db_name = ?').get(dbName) as
    | { current_version: number }
    | undefined;
  if (row === undefined) {
    throw new Error(`schema_version_missing:${dbName}`);
  }
  return row.current_version;
}

export function findMissingDatabaseTable(
  db: DatabaseConnection,
  requiredTables: readonly string[]
): string | null {
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

export function requireDatabaseTables(db: DatabaseConnection, requiredTables: readonly string[]): void {
  const missingTable = findMissingDatabaseTable(db, requiredTables);
  if (missingTable !== null) {
    throw new Error(`schema_table_missing:${missingTable}`);
  }
}

function probeManagedDatabase(
  pool: DatabasePool,
  definition: ManagedDatabaseDefinition,
  now: () => string
): RocDatabaseFastProbeItem {
  let schemaVersion: number | null = null;
  let readProbe: RocDatabaseFastProbeItem['readProbe'] = 'failed';
  let transactionStarted = false;
  try {
    const db = definition.open(pool);
    definition.applySchema(db, now);
    schemaVersion = readRequiredSchemaVersion(db, definition.dbName);
    requireDatabaseTables(db, definition.requiredTables);
    db.prepare('SELECT 1').pluck().get();
    readProbe = 'ok';
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    db.prepare('SELECT 1').pluck().get();
    db.exec('ROLLBACK');
    transactionStarted = false;
    return {
      dbName: definition.dbName,
      status: 'healthy',
      schemaVersion,
      readProbe,
      writeLockProbe: 'ok',
      detail: 'ok'
    };
  } catch (error) {
    if (transactionStarted) {
      definition.open(pool).exec('ROLLBACK');
    }
    return {
      dbName: definition.dbName,
      status: 'unhealthy',
      schemaVersion,
      readProbe,
      writeLockProbe: 'failed',
      detail: error instanceof Error ? error.message : 'database_fast_probe_failed'
    };
  }
}
