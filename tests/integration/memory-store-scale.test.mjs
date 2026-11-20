import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { RocSqliteStore } = await importTypeScriptModule('src/main/services/memory/sqlite-store.ts', {
  platform: 'node', external: ['@langchain/langgraph'], tempDir: resolve('.runtime/performance')
});

test('indexed namespace ranges visit only the selected subtree and filter before paging', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE langgraph_store_items(namespace_key TEXT, namespace_json TEXT, key TEXT,
    value_json TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(namespace_key,key))`);
  const insert = db.prepare('INSERT INTO langgraph_store_items VALUES(?,?,?,?,?,?)');
  db.transaction(() => {
    for (let id = 0; id < 10000; id++) {
      const namespace = ['project', `p${id % 100}`, 'memory'];
      insert.run(namespace.join('\x1f'), JSON.stringify(namespace), String(id).padStart(5, '0'),
        JSON.stringify({ id }), '2026-11-14', '2026-11-14');
    }
  })();
  let visitedRows = 0;
  const prepare = db.prepare;
  db.prepare = function (sql) {
    const statement = prepare.call(db, sql);
    if (sql.includes('FROM langgraph_store_items')) {
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...args) { for (const row of iterate(...args)) { visitedRows++; yield row; } };
    }
    return statement;
  };
  try {
    const store = new RocSqliteStore(db);
    const result = await store.search(['project', 'p7'], { filter: { id: { $gte: 9000 } }, offset: 2, limit: 3 });
    assert.deepEqual(result.map(item => item.value.id), [9207, 9307, 9407]);
    assert.equal(visitedRows, 100);
    const plan = prepare.call(db, `EXPLAIN QUERY PLAN SELECT key FROM langgraph_store_items
      WHERE namespace_key = ? OR (namespace_key >= ? AND namespace_key < ?) ORDER BY namespace_key,key`)
      .all('project\x1fp7', 'project\x1fp7\x1f', 'project\x1fp7\x20');
    assert.ok(plan.some(row => /SEARCH.*INDEX/u.test(row.detail)));
    assert.ok(!plan.some(row => /^SCAN langgraph_store_items$/u.test(row.detail)));
    assert.deepEqual(await store.listNamespaces({ prefix: ['project', 'p7'] }), [['project', 'p7', 'memory']]);
    assert.equal(visitedRows, 101);
  } finally { db.close(); }
});
