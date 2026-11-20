import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const options = { platform: 'node', external: ['@langchain/langgraph'], tempDir: resolve('.runtime/performance') };
const { RocSqliteStore } = await importTypeScriptModule('src/main/services/memory/sqlite-store.ts', options);
const { RocSqliteStore: LegacyStore } = await importTypeScriptModule('tests/fixtures/performance/legacy-memory-store.ts', options);

function fixture(Store, populated = true) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE langgraph_store_items(namespace_key TEXT, namespace_json TEXT, key TEXT,
    value_json TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(namespace_key,key))`);
  const insert = db.prepare('INSERT INTO langgraph_store_items VALUES(?,?,?,?,?,?)');
  const namespaces = [['a'], ['a', 'b'], ['a', 'bc'], ['a', 'b', 'c'], ['a/b'], ['A'], ['é'], ['中文', '记忆'], ['😀'], ['z']];
  if (populated) for (const namespace of namespaces) for (let index = 0; index < 4; index++) {
    const value = { number: index % 2 === 0 ? index : String(index), first: index, text: 'İstanbul 中文 ÉVIDENCE 😀',
      object: index % 2 === 0 ? { b: 2, a: 1 } : { a: 1, b: 2 }, array: [1, null, true], boolean: index % 2 === 0, nullable: null };
    insert.run(namespace.join('\x1f'), JSON.stringify(namespace), `key-${index}`, JSON.stringify(value),
      '2026-11-14T00:00:00.000Z', '2026-11-14T00:00:00.000Z');
  }
  return { db, store: new Store(db) };
}

async function capture(store, operation) {
  try { return { output: JSON.parse(JSON.stringify((await store.batch([operation]))[0])) }; }
  catch (error) { return { error: { name: error.name, message: error.message } }; }
}

test('frozen legacy search parity: operators, JSON order, lazy errors, Unicode and pagination', async () => {
  const legacy = fixture(LegacyStore), current = fixture(RocSqliteStore);
  try {
    const filters = [undefined, {}, { missing: undefined }, { nullable: null }, { boolean: true }, { array: [1, null, true] },
      { object: { $eq: { b: 2, a: 1 } } }, { object: { $ne: { a: 1, b: 2 } } },
      ...['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'].flatMap(operator => [
        { number: { [operator]: 2 } }, { number: { [operator]: '2' } }, { missing: { [operator]: undefined } }]),
      { first: { $eq: -1 }, number: { $unsupported: 2 } }, { number: { $unsupported: 2 } }, null];
    const operations = [];
    for (const namespacePrefix of [[], ['a'], ['a', 'b'], ['a', 'bc'], ['中文'], ['😀'], ['absent']]) {
      for (const filter of filters) operations.push({ namespacePrefix, filter, query: '中文', offset: 1, limit: 3 });
      for (const query of ['', 'évidence', 'İSTANBUL', '😀', 'object', '"b":2,"a":1', 'absent', null, 2]) {
        operations.push({ namespacePrefix, query, limit: 100 });
      }
    }
    for (const [offset, limit] of [[0, 0], [1, 2], [100, 2], [-1, 0], [0, -1], [1.5, 10], [0, Infinity], [1e20, 1]]) {
      operations.push({ namespacePrefix: ['a'], offset, limit });
    }
    operations.push({ namespacePrefix: ['bad.label'] }, { namespacePrefix: ['a\x1fb'] }, { namespacePrefix: null });
    for (const operation of operations) assert.deepEqual(await capture(current.store, operation), await capture(legacy.store, operation),
      `search parity ${JSON.stringify(operation)}`);
  } finally { current.db.close(); legacy.db.close(); }
});

test('frozen legacy namespace parity: wildcard/suffix/depth/locale ordering and lazy errors', async () => {
  for (const populated of [true, false]) {
    const legacy = fixture(LegacyStore, populated), current = fixture(RocSqliteStore, populated);
    try {
      const conditions = [undefined, [], [{ matchType: 'prefix', path: ['a'] }],
        [{ matchType: 'prefix', path: ['a', '*'] }], [{ matchType: 'suffix', path: ['*', 'c'] }],
        [{ matchType: 'prefix', path: ['a'] }, { matchType: 'suffix', path: ['b'] }],
        [{ matchType: 'prefix', path: ['absent'] }, { matchType: 'unsupported', path: ['bad.label'] }],
        [{ matchType: 'unsupported', path: ['a'] }], [{ matchType: 'prefix', path: ['bad.label'] }]];
      for (const matchConditions of conditions) for (const maxDepth of [undefined, 1, 2, 0, -1, 1.5]) {
        const operation = { matchConditions, maxDepth, offset: 1, limit: 3 };
        assert.deepEqual(await capture(current.store, operation), await capture(legacy.store, operation),
          `namespace parity ${JSON.stringify(operation)} populated=${populated}`);
      }
      for (const operation of [{ namespacePrefix: [], filter: { n: { $unsupported: 1 } }, offset: -1 },
        { namespacePrefix: [], query: null, limit: -1 }, { matchConditions: [], limit: -1 }]) {
        assert.deepEqual(await capture(current.store, operation), await capture(legacy.store, operation));
      }
    } finally { current.db.close(); legacy.db.close(); }
  }
});
