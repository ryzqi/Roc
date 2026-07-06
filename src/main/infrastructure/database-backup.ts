import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import { DatabasePool } from './database-pool';
import type { RocLogicalDatabaseName } from './database-pragmas';

export type RocDatabaseBackupManifest = {
  id: string;
  createdAt: string;
  backupDir: string;
  databases: Array<{
    dbName: RocLogicalDatabaseName;
    fileName: string;
    sha256: string;
    schemaVersion: number;
  }>;
};

export type RocDatabaseRestoreResult = {
  restored: true;
};

type ManagedBackupDatabase = {
  dbName: RocLogicalDatabaseName;
  fileName: string;
  open(pool: DatabasePool): DatabaseConnection;
};

const backupIdPattern = /^[A-Za-z0-9._-]+$/u;
const manifestFileName = 'manifest.json';
const managedDatabases: ManagedBackupDatabase[] = [
  {
    dbName: 'core',
    fileName: 'core.db',
    open: (pool) => pool.getCoreConnection()
  },
  {
    dbName: 'agent',
    fileName: '@roc-plugin-agent.db',
    open: (pool) => pool.getConnection('@roc/plugin-agent')
  },
  {
    dbName: 'memory',
    fileName: '@roc-plugin-memory.db',
    open: (pool) => pool.getConnection('@roc/plugin-memory')
  },
  {
    dbName: 'task',
    fileName: '@roc-plugin-task.db',
    open: (pool) => pool.getConnection('@roc/plugin-task')
  },
  {
    dbName: 'plugin:@roc/plugin-workspace',
    fileName: '@roc-plugin-workspace.db',
    open: (pool) => pool.getConnection('@roc/plugin-workspace')
  },
  {
    dbName: 'plugin:@roc/plugin-diagnostics',
    fileName: '@roc-plugin-diagnostics.db',
    open: (pool) => pool.getConnection('@roc/plugin-diagnostics')
  }
];

export function backupRocDatabases(input: {
  rootDir: string;
  backupRootDir: string;
  backupId: string;
  now: () => string;
}): RocDatabaseBackupManifest {
  if (!backupIdPattern.test(input.backupId)) {
    throw new Error('database_backup_id_invalid');
  }
  const backupDir = join(input.backupRootDir, input.backupId);
  if (existsSync(backupDir)) {
    throw new Error('database_backup_exists');
  }
  mkdirSync(backupDir, { recursive: true });

  const pool = new DatabasePool(input.rootDir);
  try {
    const databases = managedDatabases.map((database) => backupManagedDatabase(pool, input.rootDir, backupDir, database));
    const manifest: RocDatabaseBackupManifest = {
      id: input.backupId,
      createdAt: input.now(),
      backupDir,
      databases
    };
    writeFileSync(join(backupDir, manifestFileName), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    persistBackupManifest(pool.getCoreConnection(), manifest);
    return manifest;
  } finally {
    pool.closeAll();
  }
}

export function restoreRocDatabaseBackup(input: { rootDir: string; backupDir: string }): RocDatabaseRestoreResult {
  const manifest = readBackupManifest(input.backupDir);
  const pool = new DatabasePool(input.rootDir);
  try {
    const restoreEntries = manifest.databases.map((database) => validateRestoreEntry(input.rootDir, input.backupDir, pool, database));
    for (const entry of restoreEntries) {
      const targetPath = entry.targetPath;
      mkdirSync(dirname(targetPath), { recursive: true });
      rmSync(targetPath, { force: true });
      rmSync(`${targetPath}-wal`, { force: true });
      rmSync(`${targetPath}-shm`, { force: true });
      copyFileSync(entry.sourcePath, targetPath);
    }
    return { restored: true };
  } finally {
    pool.closeAll();
  }
}

function validateRestoreEntry(
  rootDir: string,
  backupDir: string,
  pool: DatabasePool,
  database: RocDatabaseBackupManifest['databases'][number]
): { sourcePath: string; targetPath: string } {
  const targetPath = pool.getDatabasePath(database.dbName);
  assertInsideRoot(rootDir, targetPath);
  const sourcePath = join(backupDir, database.fileName);
  assertInsideRoot(backupDir, sourcePath);
  if (!existsSync(sourcePath)) {
    throw new Error('database_backup_file_missing');
  }
  if (sha256File(sourcePath) !== database.sha256) {
    throw new Error('database_backup_hash_mismatch');
  }
  return { sourcePath, targetPath };
}

function backupManagedDatabase(
  pool: DatabasePool,
  rootDir: string,
  backupDir: string,
  database: ManagedBackupDatabase
): RocDatabaseBackupManifest['databases'][number] {
  const db = database.open(pool);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const sourcePath = pool.getDatabasePath(database.dbName);
  assertInsideRoot(rootDir, sourcePath);
  const targetPath = join(backupDir, database.fileName);
  copyFileSync(sourcePath, targetPath);
  const schemaVersion = readSchemaVersion(db, database.dbName);
  if (schemaVersion === null) {
    throw new Error('database_backup_schema_version_missing');
  }
  return {
    dbName: database.dbName,
    fileName: database.fileName,
    sha256: sha256File(targetPath),
    schemaVersion
  };
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
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<RocDatabaseBackupManifest>;
  if (typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'string' || typeof parsed.backupDir !== 'string') {
    throw new Error('database_backup_manifest_invalid');
  }
  if (!Array.isArray(parsed.databases)) {
    throw new Error('database_backup_manifest_invalid');
  }
  const databases = parsed.databases.map(readManifestDatabase);
  assertCompleteManifest(databases);
  return {
    id: parsed.id,
    createdAt: parsed.createdAt,
    backupDir: parsed.backupDir,
    databases
  };
}

function assertCompleteManifest(databases: readonly RocDatabaseBackupManifest['databases'][number][]): void {
  const names = databases.map((database) => database.dbName).sort();
  const expectedNames = managedDatabases.map((database) => database.dbName).sort();
  if (names.length !== expectedNames.length) {
    throw new Error('database_backup_manifest_invalid');
  }
  for (let index = 0; index < expectedNames.length; index += 1) {
    if (names[index] !== expectedNames[index]) {
      throw new Error('database_backup_manifest_invalid');
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
  if (typeof record.fileName !== 'string' || typeof record.sha256 !== 'string' || typeof record.schemaVersion !== 'number') {
    throw new Error('database_backup_manifest_invalid');
  }
  return {
    dbName: record.dbName,
    fileName: record.fileName,
    sha256: record.sha256,
    schemaVersion: record.schemaVersion
  };
}

function isManagedDbName(value: string): value is RocLogicalDatabaseName {
  return managedDatabases.some((database) => database.dbName === value);
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
