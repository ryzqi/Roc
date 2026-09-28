import { createHash } from 'node:crypto';
import Database, { type Database as DatabaseConnection } from 'better-sqlite3';

import type { RocLogicalDatabaseName } from './database-pragmas';

export type RocDatabaseMigration = {
  version: number;
  name: string;
  sql: string;
};

export type RocSchemaMetadata = {
  dbName: RocLogicalDatabaseName;
  currentVersion: number;
  schemaChecksum: string;
  createdAt: string;
  updatedAt: string;
};

export function applyDatabaseMigrations(
  db: DatabaseConnection,
  input: {
    dbName: RocLogicalDatabaseName;
    migrations: readonly RocDatabaseMigration[];
    now?: () => string;
  }
): void {
  const now = input.now === undefined ? () => new Date().toISOString() : input.now;
  ensureLedgerTables(db);
  validateMigrationList(input.migrations);
  const applied = readAppliedMigrations(db, input.dbName);
  if (schemaObjectsMatch(db, input.migrations)) {
    if (!appliedMigrationsMatch(applied, input.migrations)) {
      recordCurrentMigrations(db, input.dbName, input.migrations, now);
    }
    return;
  }
  if (applied.size !== 0 || readSchemaObjectsFromDatabase(db).size !== 0) {
    throw new Error('database_schema_rebuild_required');
  }
  const applyCurrent = db.transaction(() => {
    for (const migration of input.migrations) {
      db.exec(migration.sql);
    }
    writeCurrentMigrationRows(db, input.dbName, input.migrations, now);
  });
  applyCurrent();
}

export function readSchemaMetadata(db: DatabaseConnection, dbName: RocLogicalDatabaseName): RocSchemaMetadata | null {
  ensureLedgerTables(db);
  const row = db
    .prepare(
      `SELECT db_name, current_version, schema_checksum, created_at, updated_at
       FROM schema_metadata
       WHERE db_name = ?`
    )
    .get(dbName) as
    | {
        db_name: RocLogicalDatabaseName;
        current_version: number;
        schema_checksum: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    dbName: row.db_name,
    currentVersion: row.current_version,
    schemaChecksum: row.schema_checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function ensureLedgerTables(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      db_name    TEXT NOT NULL,
      version    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY(db_name, version)
    );

    CREATE TABLE IF NOT EXISTS schema_metadata (
      db_name         TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL,
      schema_checksum TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
  `);
}

function validateMigrationList(migrations: readonly RocDatabaseMigration[]): void {
  let expected = 1;
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new Error('database_migration_version_gap');
    }
    if (migration.name.trim().length === 0) {
      throw new Error('database_migration_name_empty');
    }
    if (migration.sql.trim().length === 0) {
      throw new Error('database_migration_sql_empty');
    }
    expected += 1;
  }
}

function readAppliedMigrations(
  db: DatabaseConnection,
  dbName: RocLogicalDatabaseName
): Map<number, { name: string; checksum: string }> {
  const rows = db
    .prepare('SELECT version, name, checksum FROM schema_migrations WHERE db_name = ? ORDER BY version ASC')
    .all(dbName) as Array<{ version: number; name: string; checksum: string }>;
  return new Map(rows.map((row) => [row.version, { name: row.name, checksum: row.checksum }]));
}

function appliedMigrationsMatch(
  applied: ReadonlyMap<number, { name: string; checksum: string }>,
  migrations: readonly RocDatabaseMigration[]
): boolean {
  if (applied.size !== migrations.length) {
    return false;
  }
  return migrations.every((migration) => {
    const existing = applied.get(migration.version);
    return existing !== undefined && existing.name === migration.name && existing.checksum === checksumMigration(migration);
  });
}

function recordCurrentMigrations(
  db: DatabaseConnection,
  dbName: RocLogicalDatabaseName,
  migrations: readonly RocDatabaseMigration[],
  now: () => string
): void {
  const record = db.transaction(() => {
    writeCurrentMigrationRows(db, dbName, migrations, now);
  });
  record();
}

function writeCurrentMigrationRows(
  db: DatabaseConnection,
  dbName: RocLogicalDatabaseName,
  migrations: readonly RocDatabaseMigration[],
  now: () => string
): void {
  db.prepare('DELETE FROM schema_migrations WHERE db_name = ?').run(dbName);
  for (const migration of migrations) {
    db.prepare(
      `INSERT INTO schema_migrations (db_name, version, name, checksum, applied_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(dbName, migration.version, migration.name, checksumMigration(migration), now());
  }
  writeMetadata(db, dbName, migrations, now());
}

function schemaObjectsMatch(db: DatabaseConnection, migrations: readonly RocDatabaseMigration[]): boolean {
  const expected = readSchemaObjects(migrations.map((migration) => migration.sql).join('\n'));
  const actual = readSchemaObjectsFromDatabase(db);
  if (expected.size !== actual.size) {
    return false;
  }
  for (const [name, sql] of expected) {
    if (actual.get(name) !== sql) {
      return false;
    }
  }
  return true;
}

function readSchemaObjects(sql: string): Map<string, string> {
  const probe = new Database(':memory:');
  try {
    probe.exec(sql);
    return readSchemaObjectsFromDatabase(probe);
  } finally {
    probe.close();
  }
}

function readSchemaObjectsFromDatabase(db: DatabaseConnection): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'schema_%'
       ORDER BY name`
    )
    .all() as Array<{ name: string; sql: string }>;
  return new Map(
    rows
      .filter((row) => !row.name.includes('_fts_'))
      .map((row) => [row.name, normalizeSchemaSql(row.sql)])
  );
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function writeMetadata(
  db: DatabaseConnection,
  dbName: RocLogicalDatabaseName,
  migrations: readonly RocDatabaseMigration[],
  timestamp: string
): void {
  const currentVersion = migrations.length;
  const schemaChecksum = checksumText(migrations.map(checksumMigration).join('\n'));
  const existing = db.prepare('SELECT created_at FROM schema_metadata WHERE db_name = ?').get(dbName) as
    | { created_at: string }
    | undefined;
  const createdAt = existing === undefined ? timestamp : existing.created_at;
  db.prepare(
    `INSERT INTO schema_metadata (db_name, current_version, schema_checksum, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(db_name) DO UPDATE SET
       current_version = excluded.current_version,
       schema_checksum = excluded.schema_checksum,
       updated_at = excluded.updated_at`
  ).run(dbName, currentVersion, schemaChecksum, createdAt, timestamp);
}

function checksumMigration(migration: RocDatabaseMigration): string {
  return checksumText(`${migration.version}\n${migration.name}\n${migration.sql}`);
}

function checksumText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
