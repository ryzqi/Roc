import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyDatabaseMigrations,
  readSchemaMetadata,
  type RocDatabaseMigration
} from '../../../src/main/infrastructure/database-migrations';
import { agentMigrations, coreMigrations, taskMigrations } from '../../../src/main/infrastructure/database-schemas';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('database migrations', () => {
  it('applies migrations once in version order and records metadata', () => {
    const migrations: RocDatabaseMigration[] = [
      {
        version: 1,
        name: 'create_first',
        sql: 'CREATE TABLE first_table (id TEXT PRIMARY KEY);'
      },
      {
        version: 2,
        name: 'create_second',
        sql: 'CREATE TABLE second_table (id TEXT PRIMARY KEY);'
      }
    ];

    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations,
      now: () => '2026-07-06T00:00:00.000Z'
    });
    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations,
      now: () => '2026-07-06T00:00:01.000Z'
    });

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'first_table'").pluck().get()).toBe('first_table');
    expect(db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(2);
    expect(readSchemaMetadata(db, 'agent')).toMatchObject({
      dbName: 'agent',
      currentVersion: 2
    });
  });

  it('rejects checksum drift for an already-applied migration', () => {
    applyDatabaseMigrations(db, {
      dbName: 'memory',
      migrations: [{ version: 1, name: 'create_items', sql: 'CREATE TABLE items (id TEXT PRIMARY KEY);' }],
      now: () => '2026-07-06T00:00:00.000Z'
    });

    expect(() =>
      applyDatabaseMigrations(db, {
        dbName: 'memory',
        migrations: [{ version: 1, name: 'create_items', sql: 'CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT);' }],
        now: () => '2026-07-06T00:00:01.000Z'
      })
    ).toThrow('database_migration_checksum_drift');
  });

  it('rejects non-contiguous migration versions', () => {
    expect(() =>
      applyDatabaseMigrations(db, {
        dbName: 'task',
        migrations: [
          { version: 1, name: 'one', sql: 'CREATE TABLE one (id TEXT PRIMARY KEY);' },
          { version: 3, name: 'three', sql: 'CREATE TABLE three (id TEXT PRIMARY KEY);' }
        ],
        now: () => '2026-07-06T00:00:00.000Z'
      })
    ).toThrow('database_migration_version_gap');
  });

  it('applies task migrations through version 2 without changing version order', () => {
    applyDatabaseMigrations(db, {
      dbName: 'task',
      migrations: taskMigrations,
      now: () => '2026-07-10T01:00:00.000Z'
    });

    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE db_name = 'task' ORDER BY version").all()
    ).toEqual([
      { version: 1, name: 'background_task_projection_tables' },
      { version: 2, name: 'thread_deletion_journal' }
    ]);
    expect(readSchemaMetadata(db, 'task')).toMatchObject({
      dbName: 'task',
      currentVersion: 2
    });
  });

  it('applies core migrations through version 2 without changing version order', () => {
    applyDatabaseMigrations(db, {
      dbName: 'core',
      migrations: coreMigrations,
      now: () => '2026-07-10T01:00:00.000Z'
    });

    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE db_name = 'core' ORDER BY version").all()
    ).toEqual([
      { version: 1, name: 'core_platform_tables' },
      { version: 2, name: 'database_maintenance_runs' }
    ]);
    expect(readSchemaMetadata(db, 'core')).toMatchObject({
      dbName: 'core',
      currentVersion: 2
    });
  });

  it('applies agent migrations through version 2 without changing version 1', () => {
    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations: agentMigrations,
      now: () => '2026-07-10T01:00:00.000Z'
    });

    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE db_name = 'agent' ORDER BY version").all()
    ).toEqual([
      { version: 1, name: 'agent_canonical_runtime_tables' },
      { version: 2, name: 'agent_event_sequence_cursor' }
    ]);
    expect(readSchemaMetadata(db, 'agent')).toMatchObject({
      dbName: 'agent',
      currentVersion: 2
    });
  });
});
