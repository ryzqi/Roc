import { createHash } from 'node:crypto';
import Database, { type Database as DatabaseConnection } from 'better-sqlite3';

import type { RocLogicalDatabaseName } from './database-pragmas';
import { registerExecutionEventFunctions } from './execution-events';

export type RocDatabaseSchema = {
  version: number;
  sql: string;
};

type SchemaObjects = ReadonlyMap<string, string>;
const expectedSchemaCache = new Map<string, SchemaObjects>();

/** Initialize empty databases directly; existing databases must already match the current contract. */
export function initializeDatabaseSchema(
  db: DatabaseConnection,
  input: { dbName: RocLogicalDatabaseName; schema: RocDatabaseSchema; now?: () => string }
): void {
  const { dbName, schema } = input;
  if (!Number.isSafeInteger(schema.version) || schema.version < 1 || schema.sql.trim().length === 0) {
    throw new Error('database_schema_invalid');
  }
  registerExecutionEventFunctions(db);
  const expected = expectedSchemaObjects(schema.sql);
  const checksum = createHash('sha256').update(JSON.stringify([dbName, schema.version, [...expected]])).digest('hex');
  const actual = readSchemaObjects(db);
  const metadataExists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_metadata'").get() !== undefined;

  if (actual.size !== 0 || metadataExists) {
    if (!metadataExists || actual.size !== expected.size || [...expected].some(([name, sql]) => actual.get(name) !== sql)) {
      throw new Error('database_schema_current_required');
    }
    const rows = db.prepare('SELECT db_name, current_version, schema_checksum FROM schema_metadata').all() as
      Array<{ db_name: string; current_version: number; schema_checksum: string }>;
    if (rows.length !== 1 || rows[0]?.db_name !== dbName || rows[0].current_version !== schema.version || rows[0].schema_checksum !== checksum) {
      throw new Error('database_schema_current_required');
    }
    return;
  }

  db.transaction(() => {
    db.exec(schema.sql);
    const created = readSchemaObjects(db);
    if (created.size !== expected.size || [...expected].some(([name, sql]) => created.get(name) !== sql)) {
      throw new Error('database_schema_invalid');
    }
    db.exec(`CREATE TABLE schema_metadata (
      db_name TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL,
      schema_checksum TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    const timestamp = (input.now ?? (() => new Date().toISOString()))();
    db.prepare('INSERT INTO schema_metadata VALUES (?, ?, ?, ?, ?)').run(dbName, schema.version, checksum, timestamp, timestamp);
  }).immediate();
}

function expectedSchemaObjects(sql: string): SchemaObjects {
  const cached = expectedSchemaCache.get(sql);
  if (cached !== undefined) return cached;
  const probe = new Database(':memory:');
  try {
    registerExecutionEventFunctions(probe);
    probe.exec(sql);
    const objects = readSchemaObjects(probe);
    expectedSchemaCache.set(sql, objects);
    return objects;
  } finally {
    probe.close();
  }
}

function readSchemaObjects(db: DatabaseConnection): SchemaObjects {
  const shadowTables = new Set(db.prepare("SELECT name FROM pragma_table_list WHERE type = 'shadow'").pluck().all() as string[]);
  const rows = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != 'schema_metadata' ORDER BY name`).all() as
    Array<{ name: string; sql: string }>;
  return new Map(rows.filter(row => !shadowTables.has(row.name)).map(row => [row.name, row.sql.replace(/\s+/gu, ' ').trim()]));
}
