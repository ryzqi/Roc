import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';

import {
  managedDatabaseDefinitions,
  readRequiredSchemaVersion,
  requireDatabaseTables,
  runDatabaseFastProbe,
  type ManagedDatabaseDefinition
} from './database-fast-probe';
import { DatabasePool } from './database-pool';
import type { RocLogicalDatabaseName } from './database-pragmas';

export type RocDatabaseBackupManifest = {
  id: string;
  status: 'complete';
  createdAt: string;
  backupDir: string;
  databases: Array<{
    dbName: RocLogicalDatabaseName;
    fileName: string;
    sha256: string;
    schemaVersion: number;
    sizeBytes: number;
  }>;
};

export type RocDatabaseRestoreResult = {
  restored: true;
  currentDataDir: string;
  rollbackDataDir: string;
};

const backupIdPattern = /^[A-Za-z0-9._-]+$/u;
const manifestFileName = 'manifest.json';
const manifestTempFileName = 'manifest.tmp';
const failureFileName = 'failure.json';

export async function backupRocDatabases(input: {
  pool: DatabasePool;
  rootDir: string;
  backupRootDir: string;
  backupId: string;
  now: () => string;
}): Promise<RocDatabaseBackupManifest> {
  if (!backupIdPattern.test(input.backupId)) {
    throw new Error('database_backup_id_invalid');
  }
  const backupDir = resolve(input.backupRootDir, input.backupId);
  if (existsSync(backupDir)) {
    throw new Error('database_backup_exists');
  }
  mkdirSync(backupDir, { recursive: true });

  try {
    const databases: RocDatabaseBackupManifest['databases'] = [];
    for (const definition of managedDatabaseDefinitions) {
      databases.push(await backupManagedDatabase(input.pool, input.rootDir, backupDir, definition));
    }
    const manifest: RocDatabaseBackupManifest = {
      id: input.backupId,
      status: 'complete',
      createdAt: input.now(),
      backupDir,
      databases
    };
    const manifestTempPath = join(backupDir, manifestTempFileName);
    const manifestPath = join(backupDir, manifestFileName);
    writeFileSync(manifestTempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(manifestTempPath, manifestPath);
    persistBackupManifest(input.pool.getCoreConnection(), manifest);
    return manifest;
  } catch (error) {
    rmSync(join(backupDir, manifestTempFileName), { force: true });
    rmSync(join(backupDir, manifestFileName), { force: true });
    writeFileSync(
      join(backupDir, failureFileName),
      `${JSON.stringify({
        id: input.backupId,
        failedAt: input.now(),
        error: error instanceof Error ? error.message : String(error)
      }, null, 2)}\n`,
      'utf8'
    );
    throw error;
  }
}

export async function restoreRocDatabaseBackup(input: {
  rootDir: string;
  backupDir: string;
  generationId: string;
  now: () => string;
}): Promise<RocDatabaseRestoreResult> {
  if (!backupIdPattern.test(input.generationId)) {
    throw new Error('database_restore_generation_invalid');
  }
  const rootDir = resolve(input.rootDir);
  const backupDir = resolve(input.backupDir);
  const manifest = readBackupManifest(backupDir);
  if (resolve(manifest.backupDir) !== backupDir) {
    throw new Error('database_backup_manifest_path_mismatch');
  }
  const restoreEntries = validateRestoreManifest(backupDir, manifest);
  const currentDataDir = join(rootDir, 'data');
  const stagingRootDir = join(rootDir, `.restore-${input.generationId}.staging`);
  const stagingDataDir = join(stagingRootDir, 'data');
  const failedDataDir = join(stagingRootDir, 'data.failed');
  const rollbackDataDir = join(rootDir, `data.rollback-${input.generationId}`);
  if (!existsSync(currentDataDir)) {
    throw new Error('database_restore_current_missing');
  }
  if (existsSync(stagingRootDir) || existsSync(rollbackDataDir)) {
    throw new Error('database_restore_generation_exists');
  }
  mkdirSync(stagingDataDir, { recursive: true });
  const stagingPool = new DatabasePool(stagingRootDir);
  try {
    for (const entry of restoreEntries) {
      const targetPath = stagingPool.getDatabasePath(entry.definition.dbName);
      assertInsideRoot(stagingRootDir, targetPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(entry.sourcePath, targetPath);
    }
    verifyStagingDatabases(stagingPool, input.now);
  } finally {
    stagingPool.closeAll();
  }
  let currentMovedToRollback = false;
  try {
    renameSync(currentDataDir, rollbackDataDir);
    currentMovedToRollback = true;
    renameSync(stagingDataDir, currentDataDir);
    const currentPool = new DatabasePool(rootDir);
    try {
      const report = runDatabaseFastProbe({ pool: currentPool, now: input.now });
      if (report.status !== 'healthy') {
        throw new Error('database_restore_final_probe_failed');
      }
    } finally {
      currentPool.closeAll();
    }
    writeFileSync(
      join(rootDir, 'restore-receipt.json'),
      `${JSON.stringify({
        backupId: manifest.id,
        restoredAt: input.now(),
        rollbackDataDir,
        currentDataDir
      }, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    if (currentMovedToRollback) {
      if (existsSync(currentDataDir)) {
        renameSync(currentDataDir, failedDataDir);
      }
      renameSync(rollbackDataDir, currentDataDir);
    }
    throw error;
  }
  return {
    restored: true,
    currentDataDir,
    rollbackDataDir
  };
}

async function backupManagedDatabase(
  pool: DatabasePool,
  rootDir: string,
  backupDir: string,
  definition: ManagedDatabaseDefinition
): Promise<RocDatabaseBackupManifest['databases'][number]> {
  const db = definition.open(pool);
  const sourcePath = pool.getDatabasePath(definition.dbName);
  assertInsideRoot(rootDir, sourcePath);
  const targetPath = join(backupDir, definition.backupFileName);
  assertInsideRoot(backupDir, targetPath);
  await db.backup(targetPath);
  return {
    dbName: definition.dbName,
    fileName: definition.backupFileName,
    sha256: sha256File(targetPath),
    schemaVersion: readRequiredSchemaVersion(db, definition.dbName),
    sizeBytes: statSync(targetPath).size
  };
}

function persistBackupManifest(coreDb: DatabaseConnection, manifest: RocDatabaseBackupManifest): void {
  coreDb
    .prepare(
      `INSERT INTO database_backup_manifests (id, backup_dir, manifest_json, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(manifest.id, manifest.backupDir, JSON.stringify(manifest), manifest.createdAt);
}

function readBackupManifest(backupDir: string): RocDatabaseBackupManifest {
  const manifestPath = join(backupDir, manifestFileName);
  if (!existsSync(manifestPath)) {
    throw new Error('database_backup_manifest_missing');
  }
  let parsed: Partial<RocDatabaseBackupManifest>;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<RocDatabaseBackupManifest>;
  } catch {
    throw new Error('database_backup_manifest_invalid');
  }
  if (
    typeof parsed.id !== 'string' ||
    parsed.status !== 'complete' ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.backupDir !== 'string'
  ) {
    throw new Error('database_backup_manifest_invalid');
  }
  if (!Array.isArray(parsed.databases)) {
    throw new Error('database_backup_manifest_invalid');
  }
  const databases = parsed.databases.map(readManifestDatabase);
  assertCompleteManifest(databases);
  return {
    id: parsed.id,
    status: parsed.status,
    createdAt: parsed.createdAt,
    backupDir: parsed.backupDir,
    databases
  };
}

function assertCompleteManifest(databases: readonly RocDatabaseBackupManifest['databases'][number][]): void {
  const names = databases.map((database) => database.dbName).sort();
  const expectedNames = managedDatabaseDefinitions.map((database) => database.dbName).sort();
  if (names.length !== expectedNames.length) {
    throw new Error('database_backup_manifest_invalid');
  }
  for (let index = 0; index < expectedNames.length; index += 1) {
    if (names[index] !== expectedNames[index]) {
      throw new Error('database_backup_manifest_invalid');
    }
  }
  for (const definition of managedDatabaseDefinitions) {
    const database = databases.find((item) => item.dbName === definition.dbName);
    if (database === undefined || database.fileName !== definition.backupFileName) {
      throw new Error('database_backup_manifest_invalid');
    }
  }
}

function validateRestoreManifest(
  backupDir: string,
  manifest: RocDatabaseBackupManifest
): Array<{ definition: ManagedDatabaseDefinition; sourcePath: string }> {
  return manifest.databases.map((database) => {
    const definition = managedDatabaseDefinitions.find((item) => item.dbName === database.dbName);
    if (definition === undefined) {
      throw new Error('database_backup_manifest_invalid');
    }
    const sourcePath = join(backupDir, database.fileName);
    assertInsideRoot(backupDir, sourcePath);
    if (!existsSync(sourcePath)) {
      throw new Error('database_backup_file_missing');
    }
    if (statSync(sourcePath).size !== database.sizeBytes) {
      throw new Error('database_backup_size_mismatch');
    }
    if (sha256File(sourcePath) !== database.sha256) {
      throw new Error('database_backup_hash_mismatch');
    }
    const sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      if (readRequiredSchemaVersion(sourceDb, database.dbName) !== database.schemaVersion) {
        throw new Error('database_backup_schema_version_mismatch');
      }
    } finally {
      sourceDb.close();
    }
    return { definition, sourcePath };
  });
}

function verifyStagingDatabases(pool: DatabasePool, now: () => string): void {
  for (const definition of managedDatabaseDefinitions) {
    const db = definition.open(pool);
    definition.applySchema(db, now);
    requireDatabaseTables(db, definition.requiredTables);
    const quickCheck = db.prepare('PRAGMA quick_check').pluck().get() as string | undefined;
    if (quickCheck !== 'ok') {
      throw new Error(`database_restore_quick_check_failed:${definition.dbName}`);
    }
  }
}

function readManifestDatabase(value: unknown): RocDatabaseBackupManifest['databases'][number] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('database_backup_manifest_invalid');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.dbName !== 'string' || !isManagedDbName(record.dbName)) {
    throw new Error('database_backup_manifest_invalid');
  }
  if (
    typeof record.fileName !== 'string' ||
    typeof record.sha256 !== 'string' ||
    typeof record.schemaVersion !== 'number' ||
    typeof record.sizeBytes !== 'number' ||
    !Number.isInteger(record.sizeBytes) ||
    record.sizeBytes <= 0
  ) {
    throw new Error('database_backup_manifest_invalid');
  }
  return {
    dbName: record.dbName,
    fileName: record.fileName,
    sha256: record.sha256,
    schemaVersion: record.schemaVersion,
    sizeBytes: record.sizeBytes
  };
}

function isManagedDbName(value: string): value is RocLogicalDatabaseName {
  return managedDatabaseDefinitions.some((database) => database.dbName === value);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertInsideRoot(rootDir: string, filePath: string): void {
  const relativePath = relative(resolve(rootDir), resolve(filePath));
  if (relativePath.startsWith('..')) {
    throw new Error('database_backup_path_outside_root');
  }
  if (isAbsolute(relativePath)) {
    throw new Error('database_backup_path_outside_root');
  }
}
