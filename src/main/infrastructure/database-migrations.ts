import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';

import { managedDatabaseDefinitions } from './database-fast-probe';
import { DatabasePool } from './database-pool';
import { configureRocDatabaseConnection, type RocLogicalDatabaseName } from './database-pragmas';
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
      configureRocDatabaseConnection(db, {
        databaseName: plan.dbName, busyTimeoutMs: 5000, synchronous: 'FULL'
      });
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
  if (db.pragma('quick_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length !== 0) {
    throw new Error('database_migration_source_integrity_failed');
  }
}

function assertResearchHistoryCanBePreserved(db: DatabaseConnection): void {
  const oldTable = 'research_python_environment_selections';
  if (db.prepare('SELECT count(*) FROM ' + oldTable).pluck().get() !== 0) {
    throw new Error('migration_python_receipts_require_archive');
  }
  for (const row of db.prepare('SELECT run_id,snapshot_json FROM research_experiment_executions').iterate() as
    Iterable<{ run_id: string; snapshot_json: string }>) {
    const snapshot = JSON.parse(row.snapshot_json) as { request?: { engine?: string } };
    if (['python', 'r', 'julia'].includes(snapshot.request?.engine ?? '')) {
      throw new Error(`database_migration_legacy_execution_requires_review:${row.run_id}`);
    }
  }
  for (const row of db.prepare(`SELECT r.id,r.environment_json,r.command FROM research_experiment_runs r
    LEFT JOIN research_experiment_executions e ON e.run_id=r.id WHERE e.run_id IS NULL`).iterate() as
    Iterable<{ id: string; environment_json: string; command: string }>) {
    const environment = JSON.parse(row.environment_json) as { runtime?: { kind?: string }; engine?: string };
    let command: unknown;
    try { command = JSON.parse(row.command); } catch { command = null; }
    if (['r', 'julia'].includes(environment.runtime?.kind ?? environment.engine ?? '')
      || Array.isArray(command) && ['r-v1', 'julia-v1'].includes(command[0])) {
      throw new Error(`database_migration_legacy_execution_requires_review:${row.id}`);
    }
  }
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
    if (db.pragma('quick_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length !== 0) {
      throw new Error('database_migration_target_integrity_failed');
    }
  }).immediate();
}

async function backupMigrationSources(rootDir: string, plans: readonly Migration[]): Promise<void> {
  const directory = join(rootDir, 'schema-backups', `upgrade-${Date.now()}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
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
      if (metadata?.version !== plan.fromVersion ||
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
}
