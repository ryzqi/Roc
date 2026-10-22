import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * Schema 迁移的「就地升级」路径。
 *
 * 为什么需要这份单测：`pnpm database:migrate` 的说明是「就地升级 schema」，但
 * `applyDatabaseMigrations` 原来只有两条路——对象与清单逐字一致就只补 ledger，或者空库从头跑；
 * **已应用一部分**的库一律抛 `database_schema_rebuild_required`。也就是说加一列就得丢掉整库
 * 数据，而 langgraph 1.5 的 `task_path` 正好是一次加列。
 *
 * 这里钉住四件事：
 *   1. 追加式迁移（`ALTER TABLE … ADD COLUMN`）能在老库上就地跑完，ledger 与 metadata 一起前进；
 *   2. 已应用的 migration 被改写（名字或 checksum 变了）仍然要求重建——不猜起点；
 *   3. 没有 ledger 的「来历不明」库仍然要求重建；
 *   4. 待应用的迁移跑完却对不上清单时整体回滚，不留半升级的库。
 */
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const bundleOptions = {
  platform: 'node',
  external: ['better-sqlite3'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
};
const { applyDatabaseMigrations, readSchemaMetadata } = await importTypeScriptModule(
  'src/main/infrastructure/database-migrations.ts',
  bundleOptions
);
const { agentMigrations } = await importTypeScriptModule(
  'src/main/infrastructure/database-schemas.ts',
  bundleOptions
);

function migration(version, name, sql) {
  return { version, name, sql };
}

const baseMigrations = [
  migration(1, 'widgets', 'CREATE TABLE widgets (id TEXT PRIMARY KEY, label TEXT NOT NULL);'),
  migration(2, 'widget_notes', 'CREATE TABLE widget_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);')
];
const additiveMigration = migration(
  3,
  'widget_owner',
  "ALTER TABLE widgets ADD COLUMN owner TEXT NOT NULL DEFAULT '';"
);

const columnNames = (db, table) =>
  db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .pluck()
    .all();

const ledgerVersions = (db) =>
  db.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all();

test('空库从头跑完全部迁移', () => {
  const db = new Database(':memory:');
  applyDatabaseMigrations(db, {
    dbName: 'core',
    migrations: [...baseMigrations, additiveMigration]
  });
  assert.deepEqual(columnNames(db, 'widgets'), ['id', 'label', 'owner']);
  assert.deepEqual(ledgerVersions(db), [1, 2, 3]);
  assert.equal(readSchemaMetadata(db, 'core').currentVersion, 3);
});

test('追加式迁移在已应用的库上就地跑完（不再要求重建）', () => {
  const db = new Database(':memory:');
  applyDatabaseMigrations(db, { dbName: 'core', migrations: baseMigrations });
  assert.deepEqual(columnNames(db, 'widgets'), ['id', 'label']);

  applyDatabaseMigrations(db, {
    dbName: 'core',
    migrations: [...baseMigrations, additiveMigration]
  });
  assert.deepEqual(columnNames(db, 'widgets'), ['id', 'label', 'owner']);
  assert.deepEqual(ledgerVersions(db), [1, 2, 3]);
  assert.equal(readSchemaMetadata(db, 'core').currentVersion, 3);

  // 再跑一次是纯 no-op。
  applyDatabaseMigrations(db, {
    dbName: 'core',
    migrations: [...baseMigrations, additiveMigration]
  });
  assert.deepEqual(ledgerVersions(db), [1, 2, 3]);
});

test('已经是最新的库只补 ledger，不动 schema', () => {
  const db = new Database(':memory:');
  const migrations = [...baseMigrations, additiveMigration];
  applyDatabaseMigrations(db, { dbName: 'core', migrations });
  db.prepare('DELETE FROM schema_migrations WHERE db_name = ?').run('core');

  applyDatabaseMigrations(db, { dbName: 'core', migrations });
  assert.deepEqual(ledgerVersions(db), [1, 2, 3]);
  assert.deepEqual(columnNames(db, 'widgets'), ['id', 'label', 'owner']);
});

test('已应用的 migration 被改写时要求重建', () => {
  const db = new Database(':memory:');
  applyDatabaseMigrations(db, { dbName: 'core', migrations: baseMigrations });

  // 真正的守门者是事务里那次最终形状校对：把它删掉也会抛。这里的 `rewritten` 预检只是快失败
  // （不用先跑迁移再发现不对）。两边都应该抛同一个错，所以断言只看错误。
  const rewritten = [
    baseMigrations[0],
    migration(2, 'widget_notes', 'CREATE TABLE widget_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, extra TEXT);')
  ];
  assert.throws(
    () => applyDatabaseMigrations(db, { dbName: 'core', migrations: rewritten }),
    /database_schema_rebuild_required/u
  );
});

test('没有 ledger 的来历不明库要求重建', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE widgets (id TEXT PRIMARY KEY);');
  assert.throws(
    () => applyDatabaseMigrations(db, { dbName: 'core', migrations: baseMigrations }),
    /database_schema_rebuild_required/u
  );
});

test('待应用的迁移跑完对不上清单时整体回滚', () => {
  const db = new Database(':memory:');
  applyDatabaseMigrations(db, { dbName: 'core', migrations: baseMigrations });
  // 库里多了一个清单没声明的对象：追加的迁移跑完后仍然对不上，必须回滚而不是留下半升级状态。
  db.exec('CREATE TABLE stray_objects (id TEXT PRIMARY KEY);');

  assert.throws(
    () =>
      applyDatabaseMigrations(db, {
        dbName: 'core',
        migrations: [...baseMigrations, additiveMigration]
      }),
    /database_schema_rebuild_required/u
  );

  // 回滚：列没加、ledger 没前进。
  assert.deepEqual(ledgerVersions(db), [1, 2]);
  assert.deepEqual(columnNames(db, 'widgets'), ['id', 'label']);
});

test('真实的 agent 库：v5 就地升到 v6，checkpoint writes 多出 task_path', () => {
  const db = new Database(':memory:');
  const beforeTaskPath = agentMigrations.filter((entry) => entry.version <= 5);
  applyDatabaseMigrations(db, { dbName: 'agent', migrations: beforeTaskPath });
  assert.equal(
    columnNames(db, 'langgraph_checkpoint_writes').includes('task_path'),
    false
  );

  applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations });
  assert.equal(columnNames(db, 'langgraph_checkpoint_writes').includes('task_path'), true);
  assert.equal(readSchemaMetadata(db, 'agent').currentVersion, agentMigrations.length);
});
