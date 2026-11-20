import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const options = {platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/tmp')};
const schemas = await importTypeScriptModule('src/main/infrastructure/database-schemas.ts', options);
const {initializeDatabaseSchema} = await importTypeScriptModule('src/main/infrastructure/database-schema.ts', options);

for (const name of ['core', 'agent', 'memory', 'task', 'workspace', 'diagnostics', 'research']) {
  test(`${name} initializes current tables, constraints and triggers directly and reopens without writes`, () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys=ON');
      const apply = schemas[`apply${name[0].toUpperCase() + name.slice(1)}DatabaseSchema`];
      apply(db, () => '2026-11-09T00:00:00.000Z');
      const metadata = db.prepare('SELECT * FROM schema_metadata').all();
      assert.equal(metadata.length, 1);
      assert.equal(metadata[0].current_version, schemas[`${name}Schema`].version);
      assert.equal(db.prepare("SELECT count(*) FROM sqlite_master WHERE name IN ('schema_migrations','execution_historical_audit','research_execution_input_migrations','research_generations')").pluck().get(), 0);
      const changes = db.prepare('SELECT total_changes()').pluck().get();
      apply(db, () => {throw new Error('reopen_must_not_rewrite_metadata');});
      assert.equal(db.prepare('SELECT total_changes()').pluck().get(), changes);
      assert.deepEqual(db.prepare('SELECT * FROM schema_metadata').all(), metadata);
      assert.deepEqual(db.pragma('integrity_check'), [{integrity_check: 'ok'}]);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {db.close();}
  });
}

test('current core data and metadata survive a real SQLite close and reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roc-current-schema-'));
  let db;
  try {
    const path = join(directory, 'core.db');
    db = new Database(path); schemas.applyCoreDatabaseSchema(db);
    db.prepare('INSERT INTO plugin_config VALUES (?,?,?,?)').run('fixture', 'settings', '{"text":"保留原文"}', 'now');
    const before = db.prepare('SELECT * FROM schema_metadata').all();
    db.close(); db = new Database(path); schemas.applyCoreDatabaseSchema(db);
    assert.equal(db.prepare('SELECT value_json FROM plugin_config').pluck().get(), '{"text":"保留原文"}');
    assert.deepEqual(db.prepare('SELECT * FROM schema_metadata').all(), before);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(), 0);
  } finally {db?.close(); rmSync(directory, {recursive: true, force: true});}
});

test('incompatible DDL and metadata fail without rewriting existing data', () => {
  const mutations = [
    db => db.exec('CREATE TABLE unexpected (value TEXT); INSERT INTO unexpected VALUES (\'saved\')'),
    db => db.exec('DROP INDEX idx_database_health_checks_db_checked'),
    db => db.exec("UPDATE schema_metadata SET current_version=0"),
    db => db.exec("UPDATE schema_metadata SET schema_checksum='invalid'"),
    db => db.exec("UPDATE schema_metadata SET db_name='agent'"),
    db => db.exec('DROP TABLE schema_metadata')
  ];
  for (const mutate of mutations) {
    const db = new Database(':memory:');
    try {
      schemas.applyCoreDatabaseSchema(db); mutate(db);
      const before = db.serialize();
      assert.throws(() => schemas.applyCoreDatabaseSchema(db), /database_schema_current_required/u);
      assert.deepEqual(db.serialize(), before);
    } finally {db.close();}
  }
});

test('unrecognized populated databases are rejected without creating metadata', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE records (value TEXT); INSERT INTO records VALUES (\'saved\')');
    const before = db.serialize();
    assert.throws(() => schemas.applyCoreDatabaseSchema(db), /database_schema_current_required/u);
    assert.deepEqual(db.serialize(), before);
  } finally {db.close();}
});

test('failed initialization rolls back tables and metadata together', () => {
  const db = new Database(':memory:');
  try {
    assert.throws(() => initializeDatabaseSchema(db, {dbName: 'core', schema: schemas.coreSchema,
      now: () => {throw new Error('clock_failed');}}), /clock_failed/u);
    assert.deepEqual(db.prepare('SELECT name FROM sqlite_master').all(), []);
    schemas.applyCoreDatabaseSchema(db);
    assert.equal(db.prepare('SELECT count(*) FROM schema_metadata').pluck().get(), 1);
  } finally {db.close();}
});
