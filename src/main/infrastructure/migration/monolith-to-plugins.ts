import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';

import { DatabasePool } from '../database-pool';

type MigrationInput = {
  sourceDatabasePath: string;
  targetDir?: string;
};

type MigrationResult = {
  targetDir: string;
  backupPath: string;
};

type TableChecksum = {
  rows: number;
  checksum: string;
};

const pluginTables: Record<string, readonly string[]> = {
  '@roc/plugin-agent': ['task_threads', 'task_runs', 'task_events', 'session_messages', 'session_messages_fts'],
  '@roc/plugin-task': ['background_tasks', 'scheduled_task_runs'],
  '@roc/plugin-memory': ['memory_flush_marks'],
  '@roc/plugin-mcp': ['mcp_servers'],
  '@roc/plugin-skills': ['skills'],
  '@roc/plugin-diagnostics': ['performance_samples', 'diagnostic_packages', 'recovery_points']
};

export function migrateMonolithToPlugins(input: MigrationInput): MigrationResult {
  const targetDir = resolveTargetDir(input);
  if (existsSync(targetDir)) {
    throw new Error('migration_target_exists');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backupPath = `${input.sourceDatabasePath}.phase1-backup-${timestamp}`;
  copyFileSync(input.sourceDatabasePath, backupPath);
  mkdirSync(targetDir, { recursive: true });

  const sourceDb = new Database(input.sourceDatabasePath, { readonly: true, fileMustExist: true });
  const databasePool = new DatabasePool(targetDir);
  try {
    const checksumByPlugin: Record<string, Record<string, TableChecksum>> = {};
    for (const [pluginId, tables] of Object.entries(pluginTables)) {
      const pluginDb = databasePool.getConnection(pluginId);
      checksumByPlugin[pluginId] = copyPluginTables(sourceDb, pluginDb, tables);
    }
    recordMigrationRun({
      coreDb: databasePool.getCoreConnection(),
      sourceDatabasePath: input.sourceDatabasePath,
      targetDir,
      backupPath,
      checksumByPlugin
    });
  } finally {
    sourceDb.close();
    databasePool.closeAll();
  }

  return { targetDir, backupPath };
}

function resolveTargetDir(input: MigrationInput): string {
  if (input.targetDir !== undefined) {
    return input.targetDir;
  }
  return join(dirname(input.sourceDatabasePath), 'plugin-data-next');
}

function copyPluginTables(
  sourceDb: DatabaseConnection,
  pluginDb: DatabaseConnection,
  tables: readonly string[]
): Record<string, TableChecksum> {
  const regularTables = tables.filter((table) => table !== 'session_messages_fts');
  const virtualTables = tables.filter((table) => table === 'session_messages_fts');
  pluginDb.pragma('foreign_keys = OFF');
  for (const table of regularTables) {
    pluginDb.exec(readCreateSql(sourceDb, 'table', table));
  }
  for (const table of virtualTables) {
    pluginDb.exec(readCreateSql(sourceDb, 'table', table));
  }
  for (const sql of readSchemaSqlForTables(sourceDb, 'index', regularTables)) {
    pluginDb.exec(sql);
  }
  for (const sql of readSchemaSqlForTables(sourceDb, 'trigger', regularTables)) {
    pluginDb.exec(sql);
  }

  const checksumByTable: Record<string, TableChecksum> = {};
  for (const table of regularTables) {
    const rows = readRows(sourceDb, table);
    insertRows(pluginDb, table, rows);
    checksumByTable[table] = {
      rows: rows.length,
      checksum: checksumRows(rows)
    };
  }
  pluginDb.pragma('foreign_keys = ON');
  return checksumByTable;
}

function readCreateSql(sourceDb: DatabaseConnection, type: 'table', name: string): string {
  const sql = sourceDb
    .prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ? AND sql IS NOT NULL')
    .pluck()
    .get(type, name);
  if (typeof sql !== 'string') {
    throw new Error(`migration_schema_missing:${name}`);
  }
  return normalizeCreateSql(name, sql);
}

function readSchemaSqlForTables(sourceDb: DatabaseConnection, type: 'index' | 'trigger', tableNames: readonly string[]): string[] {
  if (tableNames.length === 0) {
    return [];
  }
  const placeholders = tableNames.map(() => '?').join(', ');
  return sourceDb
    .prepare(
      `SELECT sql
       FROM sqlite_schema
       WHERE type = ?
         AND tbl_name IN (${placeholders})
         AND sql IS NOT NULL
       ORDER BY name`
    )
    .pluck()
    .all(type, ...tableNames) as string[];
}

function readRows(sourceDb: DatabaseConnection, table: string): Record<string, unknown>[] {
  return sourceDb.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY rowid`).all() as Record<string, unknown>[];
}

function insertRows(pluginDb: DatabaseConnection, table: string, rows: readonly Record<string, unknown>[]): void {
  if (rows.length === 0) {
    return;
  }
  const columns = Object.keys(rows[0]!);
  const columnSql = columns.map((column) => quoteIdentifier(column)).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const statement = pluginDb.prepare(`INSERT INTO ${quoteIdentifier(table)} (${columnSql}) VALUES (${placeholders})`);
  const insertAll = pluginDb.transaction((inputRows: readonly Record<string, unknown>[]) => {
    for (const row of inputRows) {
      statement.run(...columns.map((column) => row[column]));
    }
  });
  insertAll(rows);
}

function checksumRows(rows: readonly Record<string, unknown>[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function recordMigrationRun(input: {
  coreDb: DatabaseConnection;
  sourceDatabasePath: string;
  targetDir: string;
  backupPath: string;
  checksumByPlugin: Record<string, Record<string, TableChecksum>>;
}): void {
  input.coreDb.exec(`
    CREATE TABLE IF NOT EXISTS migration_runs (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      target_dir TEXT NOT NULL,
      backup_path TEXT NOT NULL,
      checksum_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const createdAt = new Date().toISOString();
  input.coreDb
    .prepare(
      `INSERT INTO migration_runs (id, source_path, target_dir, backup_path, checksum_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      `migration_${createdAt}`,
      input.sourceDatabasePath,
      input.targetDir,
      input.backupPath,
      JSON.stringify(input.checksumByPlugin),
      createdAt
    );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}

function normalizeCreateSql(table: string, sql: string): string {
  if (table === 'background_tasks') {
    return sql.replace(/,\s*FOREIGN KEY\(thread_id\) REFERENCES task_threads\(id\)/u, '');
  }
  return sql;
}
