import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';

const bundleOptions = {platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/database-migration')};
const [{researchSchema}, {initializeDatabaseSchema}] = await Promise.all([
  importTypeScriptModule('src/main/infrastructure/database-schemas.ts', bundleOptions),
  importTypeScriptModule('src/main/infrastructure/database-schema.ts', bundleOptions)
]);
export const targetSchema = researchSchema;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const quote = name => '"' + name.replaceAll('"', '""') + '"';
export const manifest = JSON.parse(readFileSync(new URL('./schemas/manifest.json', import.meta.url), 'utf8'));
assert.equal(targetSchema.version, manifest.targetVersion, 'migration_target_version_changed');

export function historicalSchema(version) {
  const pin = manifest.snapshots.find(value => value.version === version);
  assert.ok(pin, 'migration_source_version_unsupported');
  const sql = readFileSync(new URL('./schemas/' + pin.filename, import.meta.url), 'utf8');
  assert.equal(sha256(sql), pin.sha256, 'migration_frozen_schema_changed');
  return {version, sql};
}

export function validateSchema(db, schema) {
  // Never let the empty-database initializer accept an empty source as history.
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_metadata'").get(), 'migration_identity_missing');
  initializeDatabaseSchema(db, {dbName: 'plugin:@roc/plugin-research', schema});
}

export function initializeTarget(db) {
  initializeDatabaseSchema(db, {dbName: 'plugin:@roc/plugin-research', schema: targetSchema});
}

export function validateHistorical(db) {
  const rows = db.prepare('SELECT * FROM schema_metadata').all();
  assert.equal(rows.length, 1, 'migration_identity_invalid');
  const schema = historicalSchema(rows[0].current_version);
  validateSchema(db, schema);
  checkIntegrity(db);
  return schema;
}

export function checkIntegrity(db) {
  assert.deepEqual(db.pragma('integrity_check'), [{integrity_check: 'ok'}], 'migration_integrity_failed');
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'migration_foreign_keys_failed');
}

export function businessTables(db) {
  // Strict schema validation precedes this introspection. Ordinary tables are
  // authoritative; FTS virtual/shadow tables are rebuilt from those sources.
  return db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' " +
    "AND name NOT LIKE 'sqlite_%' AND name!='schema_metadata' ORDER BY name").pluck().all();
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
const valuesQuery = (db, table) => `SELECT rowid,${columns(db, table).map(quote).join(',')} FROM ${quote(table)} ORDER BY rowid`;
const encode = row => JSON.stringify(row.map(value => Buffer.isBuffer(value) ? ['blob', value.toString('hex')]
  : typeof value === 'bigint' ? ['integer', value.toString()] : [typeof value, value]));

export function fingerprintTable(db, table) {
  const hash = createHash('sha256'); let count = 0;
  const names = columns(db, table); hash.update(JSON.stringify(['rowid', ...names]) + '\n');
  for (const row of db.prepare(valuesQuery(db, table)).raw().safeIntegers().iterate()) {
    hash.update(encode(row) + '\n'); count++;
  }
  return {count, sha256: hash.digest('hex'), columns: names};
}

export function compareBusiness(source, target) {
  const original = businessTables(source), current = businessTables(target), tables = {};
  for (const name of original) {
    assert.ok(current.includes(name), `migration_table_missing:${name}`);
    const before = fingerprintTable(source, name), after = fingerprintTable(target, name);
    assert.deepEqual(after, before, `migration_content_changed:${name}`);
    tables[name] = before;
  }
  const addedTables = current.filter(name => !original.includes(name));
  for (const name of addedTables) assert.equal(fingerprintTable(target, name).count, 0, `migration_new_table_populated:${name}`);
  return {tables, addedTables};
}

const externalFts = ['research_knowledge_chunks_fts', 'research_knowledge_documents_fts', 'research_wiki_fts'];
export function rebuildFts(db) {
  for (const name of externalFts) db.exec(`INSERT INTO ${quote(name)}(${quote(name)}) VALUES('rebuild')`);
  // The keywords' tokenizer-normalized values are copied exactly from history;
  // rebuilding its postings must not retokenize content using a newer policy.
  db.exec("INSERT INTO research_knowledge_keywords(research_knowledge_keywords) VALUES('rebuild')");
  db.exec(`DELETE FROM research_scientific_fts;
    INSERT INTO research_scientific_fts(generation_id,chunk_id,content)
      SELECT generation_id,id,embedding_text FROM research_scientific_chunks WHERE retrieval=1 ORDER BY rowid`);
  for (const name of [...externalFts, 'research_knowledge_keywords', 'research_scientific_fts']) {
    db.exec(`INSERT INTO ${quote(name)}(${quote(name)},rank) VALUES('integrity-check',1)`);
  }
}

export function convertHistorical(source, target) {
  validateHistorical(source);
  initializeTarget(target);
  target.pragma('foreign_keys=OFF');
  target.transaction(() => {
    const triggers = target.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    for (const {name} of triggers) target.exec(`DROP TRIGGER ${quote(name)}`);
    // Insert explicit columns and rowid, preserving locator strings, immutable
    // snapshots, job status, vectors and the FTS external-content join keys.
    for (const table of [...businessTables(source), 'research_knowledge_keywords']) {
      const names = columns(source, table);
      assert.deepEqual(columns(target, table), names, `migration_columns_changed:${table}`);
      const insert = target.prepare(`INSERT INTO ${quote(table)}(rowid,${names.map(quote).join(',')}) ` +
        `VALUES(${Array(names.length + 1).fill('?').join(',')})`);
      for (const row of source.prepare(valuesQuery(source, table)).raw().safeIntegers().iterate()) insert.run(...row);
    }
    rebuildFts(target);
    for (const {sql} of triggers) target.exec(sql);
    checkIntegrity(target);
  })();
  target.pragma('foreign_keys=ON');
  validateSchema(target, targetSchema);
  return compareBusiness(source, target);
}

export function verifyPair(sourcePath, targetPath) {
  const source = new Database(sourcePath, {readonly: true, fileMustExist: true});
  let target;
  try {
    const from = validateHistorical(source);
    target = new Database(targetPath, {readonly: true, fileMustExist: true});
    validateSchema(target, targetSchema); checkIntegrity(target);
    const result = compareBusiness(source, target);
    assert.deepEqual(fingerprintTable(target, 'research_knowledge_keywords'),
      fingerprintTable(source, 'research_knowledge_keywords'), 'migration_keywords_changed');
    return {fromVersion: from.version, toVersion: targetSchema.version, ...result};
  } finally {target?.close(); source.close();}
}
