import type { Database as DatabaseConnection } from 'better-sqlite3';

export type RocLogicalDatabaseName = 'core' | 'agent' | 'memory' | 'task' | `plugin:${string}`;

export type RocDatabaseConnectionOptions = {
  databaseName: RocLogicalDatabaseName;
  busyTimeoutMs: number;
  synchronous: 'NORMAL' | 'FULL';
};

export type RocDatabasePragmaState = {
  databaseName: RocLogicalDatabaseName;
  busyTimeoutMs: number;
  foreignKeys: number;
  journalMode: string;
  synchronous: number;
};

export function configureRocDatabaseConnection(
  db: DatabaseConnection,
  input: RocDatabaseConnectionOptions
): RocDatabasePragmaState {
  if (!Number.isInteger(input.busyTimeoutMs)) {
    throw new Error('database_busy_timeout_invalid');
  }
  if (input.busyTimeoutMs <= 0) {
    throw new Error('database_busy_timeout_invalid');
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${input.busyTimeoutMs}`);
  db.pragma(`synchronous = ${input.synchronous}`);

  return {
    databaseName: input.databaseName,
    busyTimeoutMs: input.busyTimeoutMs,
    foreignKeys: Number(db.pragma('foreign_keys', { simple: true })),
    journalMode: String(db.pragma('journal_mode', { simple: true })).toLowerCase(),
    synchronous: Number(db.pragma('synchronous', { simple: true }))
  };
}
