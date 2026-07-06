import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { configureRocDatabaseConnection } from '../../../src/main/infrastructure/database-pragmas';

let db: Database.Database | null = null;

afterEach(() => {
  if (db !== null) {
    db.close();
    db = null;
  }
});

describe('configureRocDatabaseConnection', () => {
  it('enables the shared SQLite production pragmas', () => {
    db = new Database(':memory:');

    const state = configureRocDatabaseConnection(db, {
      databaseName: 'agent',
      busyTimeoutMs: 5000,
      synchronous: 'NORMAL'
    });

    expect(state).toEqual({
      databaseName: 'agent',
      busyTimeoutMs: 5000,
      foreignKeys: 1,
      journalMode: 'memory',
      synchronous: 1
    });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
  });

  it('rejects invalid busy timeout values instead of hiding bad configuration', () => {
    db = new Database(':memory:');
    const openDb = db;

    expect(() =>
      configureRocDatabaseConnection(openDb, {
        databaseName: 'core',
        busyTimeoutMs: 0,
        synchronous: 'NORMAL'
      })
    ).toThrow('database_busy_timeout_invalid');
  });
});
