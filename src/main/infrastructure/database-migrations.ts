import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';

import { managedDatabaseDefinitions } from './database-fast-probe';
import { DatabasePool } from './database-pool';
import type { RocLogicalDatabaseName } from './database-pragmas';
import { researchExperimentExecutionSchema } from '../../shared/schemas/research-experiments';
import {
  checksumSchemaObjects,
  expectedSchemaObjects,
  initializeDatabaseSchema,
  readSchemaObjects,
  type RocDatabaseSchema
} from './database-schema';
import {
  agentSchema, coreSchema, diagnosticsSchema, memorySchema, researchSchema,
  taskSchema, workspaceSchema
} from './database-schemas';
import { registerExecutionEventFunctions } from './execution-events';

type Migration = {
  dbName: RocLogicalDatabaseName;
  filePath: string;
  fromVersion: number;
  toVersion: number;
};

const currentSchemas: Readonly<Record<string, RocDatabaseSchema>> = {
  core: coreSchema,
  agent: agentSchema,
  memory: memorySchema,
  task: taskSchema,
  'plugin:@roc/plugin-workspace': workspaceSchema,
  'plugin:@roc/plugin-diagnostics': diagnosticsSchema,
  'plugin:@roc/plugin-research': researchSchema
};

/**
 * Frozen checksums of shipped research schemas. An old version number alone
 * must never authorize a conversion of an unrecognized or modified database.
 */
export const researchLegacyChecksums: Readonly<Record<number, string>> = {
  71: '42bea318a7008b4fa5d318308e96dc6a9da7439a3f73b5ed4488970c809c69a6',
  72: 'e3248f5dad091b600713f0e3645a1e01e608a33435ac0bd2c7b6c4d9f91d0365',
  73: 'b790e17f3a05bfc3284c5168a05db0b3fc899d1e94706212999c5e7cd83021ee',
  74: '92df0c54a7ba4deb1e11c4dd7299ac93666e5d528ba00bfd889f39aee94ebb90',
  75: '8beebe3cebc190fff4d75c6dad0d36f8b0d6863ab79e5f1a63e760af8dcdff0d'
};

/**
 * Called under the application's exclusive maintenance lease, BEFORE the
 * DatabasePool and plugins open their connections. No backup is made on an
 * ordinary launch; known old schemas get a native SQLite backup first.
 */
export async function migrateDatabasesOnStartup(rootDir: string): Promise<void> {
  const paths = new DatabasePool(rootDir);
  const plans: Migration[] = [];
  for (const definition of managedDatabaseDefinitions) {
    const filePath = paths.getDatabasePath(definition.dbName);
    if (!existsSync(filePath)) continue;
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      const metadata = readMetadata(db);
      // The normal schema probe still handles empty files and malformed metadata.
      if (metadata === null) continue;
      const target = currentSchemas[definition.dbName];
      if (target === undefined || metadata.name !== definition.dbName) {
        throw new Error(`database_migration_identity_invalid:${definition.dbName}`);
      }
      if (metadata.version === target.version) continue;
      if (metadata.version > target.version) {
        throw new Error(`database_migration_newer_database:${definition.dbName}:${metadata.version}`);
      }
      if (definition.dbName !== 'plugin:@roc/plugin-research'
        || researchLegacyChecksums[metadata.version] === undefined
        || target.version !== 76) {
        throw new Error(`database_migration_unsupported:${definition.dbName}:${metadata.version}`);
      }
      assertKnownResearchSchema(db, metadata.version, metadata.checksum);
      assertResearchHistoryCanBePreserved(db);
      plans.push({ dbName: definition.dbName, filePath, fromVersion: metadata.version, toVersion: target.version });
    } finally {
      db.close();
    }
  }
  if (plans.length === 0) return;

  // The original database is not touched unless every source was checked and
  // every backup completed. Backups remain available for explicit recovery.
  await backupMigrationSources(rootDir, plans);
  for (const plan of plans) {
    const db = new Database(plan.filePath);
    try {
      // Keep the source's persistent journal mode unchanged until migration
      // commits. DatabasePool configures WAL after this pre-startup step.
      registerExecutionEventFunctions(db);
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = FULL');
      if (plan.dbName === 'plugin:@roc/plugin-research') {
        migrateResearchToV76(db, plan.fromVersion);
      }
    } finally {
      db.close();
    }
  }
}

function readMetadata(db: DatabaseConnection): { name: string; version: number; checksum: string } | null {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_metadata'").get() === undefined) return null;
  const rows = db.prepare('SELECT db_name, current_version, schema_checksum FROM schema_metadata').all() as
    Array<{ db_name: string; current_version: number; schema_checksum: string }>;
  if (rows.length !== 1) throw new Error('database_migration_metadata_invalid');
  return { name: rows[0]!.db_name, version: rows[0]!.current_version, checksum: rows[0]!.schema_checksum };
}

function assertKnownResearchSchema(db: DatabaseConnection, version: number, checksum: string): void {
  const expectedChecksum = researchLegacyChecksums[version];
  if (checksum !== expectedChecksum ||
    checksumSchemaObjects('plugin:@roc/plugin-research', version, readSchemaObjects(db)) !== expectedChecksum) {
    throw new Error(`database_migration_source_changed:research:${version}`);
  }
  if (db.pragma('quick_check', { simple: true }) !== 'ok' ||
    (db.pragma('foreign_key_check') as unknown[]).length !== 0) {
    throw new Error('database_migration_source_integrity_failed');
  }
}

function assertResearchHistoryCanBePreserved(db: DatabaseConnection): void {
  const oldTable = 'research_python_environment_selections';
  if (db.prepare('SELECT count(*) FROM ' + oldTable).pluck().get() !== 0) {
    throw new Error('migration_python_receipts_require_archive');
  }
  for (const row of db.prepare(`SELECT e.run_id,e.project_id,e.request_id,e.status,e.snapshot_json,
    r.id AS history_run_id,r.project_id AS history_project_id,r.status AS history_status
    FROM research_experiment_executions e LEFT JOIN research_experiment_runs r ON r.id=e.run_id`).iterate() as
    Iterable<{ run_id: string; project_id: string; request_id: string; status: string; snapshot_json: string;
      history_run_id: string | null; history_project_id: string | null; history_status: string | null }>) {
    const parsed = researchExperimentExecutionSchema.safeParse(readHistoryJson(row.snapshot_json, row.run_id));
    if (!parsed.success || parsed.data.request.engine !== 'typescript') {
      throw new Error(`database_migration_legacy_execution_requires_review:${row.run_id}`);
    }
    const snapshot = parsed.data;
    const runStatus = snapshot.status === 'preparing' ? 'running'
      : snapshot.status === 'interrupted' ? 'failed' : snapshot.status;
    if (snapshot.id !== row.run_id || snapshot.projectId !== row.project_id
      || snapshot.request.projectId !== row.project_id || snapshot.request.requestId !== row.request_id
      || snapshot.status !== row.status || row.history_run_id !== row.run_id
      || row.history_project_id !== row.project_id || row.history_status !== runStatus) {
      throw new Error(`database_migration_legacy_execution_requires_review:${row.run_id}`);
    }
  }
  for (const row of db.prepare(`SELECT r.id,r.environment_json,r.command FROM research_experiment_runs r
    LEFT JOIN research_experiment_executions e ON e.run_id=r.id WHERE e.run_id IS NULL`).iterate() as
    Iterable<{ id: string; environment_json: string; command: string }>) {
    const environment = readHistoryJson(row.environment_json, row.id);
    if (!isHistoryObject(environment)) {
      throw new Error(`database_migration_legacy_execution_requires_review:${row.id}`);
    }
    const engines = [environment.engine, environment.kind];
    if (isHistoryObject(environment.runtime)) engines.push(environment.runtime.kind);
    let command: unknown;
    try { command = JSON.parse(row.command); } catch { command = null; }
    if (engines.some(engine => typeof engine === 'string' && ['python', 'r', 'julia'].includes(engine))
      || Array.isArray(command) && command.slice(0, 2).some(part =>
        typeof part === 'string' && ['python-v1', 'r-v1', 'julia-v1'].includes(part))) {
      throw new Error(`database_migration_legacy_execution_requires_review:${row.id}`);
    }
  }
}

function readHistoryJson(json: string, runId: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (cause) {
    throw new Error(`database_migration_legacy_execution_requires_review:${runId}`, { cause });
  }
}

function isHistoryObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function migrateResearchToV76(db: DatabaseConnection, fromVersion: number): void {
  const dbName = 'plugin:@roc/plugin-research';
  const target = researchSchema;
  const current = expectedSchemaObjects(target.sql);
  const targetChecksum = checksumSchemaObjects(dbName, target.version, current);
  const template = new Database(':memory:');
  let creationOrder: Array<{ name: string; sql: string }>;
  try {
    registerExecutionEventFunctions(template);
    template.exec(target.sql);
    creationOrder = template.prepare('SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid')
      .all() as Array<{ name: string; sql: string }>;
  } finally {
    template.close();
  }

  db.transaction(() => {
    const metadata = readMetadata(db);
    if (metadata?.version !== fromVersion) throw new Error('database_migration_source_version_changed');
    assertKnownResearchSchema(db, fromVersion, metadata.checksum);
    assertResearchHistoryCanBePreserved(db);
    const before = readSchemaObjects(db);
    const obsolete = 'research_python_environment_selections';
    for (const [name, sql] of before) {
      if (name !== obsolete && current.get(name) !== sql) {
        throw new Error(`database_migration_unexpected_schema_object:${name}`);
      }
    }
    db.exec('DROP TABLE research_python_environment_selections');
    for (const { name, sql } of creationOrder) {
      if (current.has(name) && !before.has(name)) db.exec(sql);
    }
    db.prepare('UPDATE schema_metadata SET current_version=?,schema_checksum=?,updated_at=? WHERE db_name=?')
      .run(target.version, targetChecksum, new Date().toISOString(), dbName);
    initializeDatabaseSchema(db, { dbName, schema: target });
    if (db.pragma('quick_check', { simple: true }) !== 'ok' ||
      (db.pragma('foreign_key_check') as unknown[]).length !== 0) {
      throw new Error('database_migration_target_integrity_failed');
    }
  }).immediate();
}

async function backupMigrationSources(rootDir: string, plans: readonly Migration[]): Promise<void> {
  const directory = join(rootDir, 'schema-backups', `upgrade-${Date.now()}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const backups = [];
    for (const plan of plans) {
      const fileName = `${plan.dbName.replaceAll(/[^a-z0-9-]/giu, '-')}.db`;
      const backupPath = join(directory, fileName);
      const source = new Database(plan.filePath, { readonly: true, fileMustExist: true });
      try {
        await source.backup(backupPath);
      } finally {
        source.close();
      }
      const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
      try {
        const metadata = readMetadata(backup);
        if (metadata?.name !== plan.dbName || metadata.version !== plan.fromVersion ||
          metadata.checksum !== researchLegacyChecksums[plan.fromVersion] ||
          checksumSchemaObjects(plan.dbName, plan.fromVersion, readSchemaObjects(backup)) !== metadata.checksum ||
          backup.pragma('integrity_check', { simple: true }) !== 'ok') {
          throw new Error('database_migration_backup_verification_failed');
        }
      } finally {
        backup.close();
      }
      backups.push({ dbName: plan.dbName, fromVersion: plan.fromVersion, toVersion: plan.toVersion, fileName });
    }
    const manifest = join(directory, 'manifest.json');
    writeFileSync(manifest + '.tmp', JSON.stringify({ status: 'complete', createdAt: new Date().toISOString(), backups }, null, 2));
    renameSync(manifest + '.tmp', manifest);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
