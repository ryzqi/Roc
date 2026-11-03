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

test('table replacement validates foreign keys before committing schema and data together', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const base = [{version: 1, name: 'parent_and_child', sql: `
    CREATE TABLE parents(id TEXT PRIMARY KEY, obsolete TEXT);
    CREATE TABLE children(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id) ON DELETE CASCADE);`}];
  const replacement = {version: 2, name: 'parent_replacement', sql: `
    CREATE TABLE parents_next(id TEXT PRIMARY KEY);
    INSERT INTO parents_next SELECT id FROM parents;
    DROP TABLE parents;
    ALTER TABLE parents_next RENAME TO parents;`,
    rebuild: {dataVersion: 'v1', migrate: database => database.prepare('DELETE FROM parents WHERE id=?').run('parent')}};
  try {
    applyDatabaseMigrations(db, {dbName: 'core', migrations: base});
    db.prepare('INSERT INTO parents VALUES (?,?)').run('parent', 'kept during rollback');
    db.prepare('INSERT INTO children VALUES (?,?)').run('child', 'parent');
    assert.throws(() => applyDatabaseMigrations(db, {dbName: 'core', migrations: [...base, replacement]}),
      /database_migration_foreign_key_invalid/u);
    assert.deepEqual(columnNames(db, 'parents'), ['id', 'obsolete']);
    assert.equal(db.prepare('SELECT COUNT(*) FROM children').pluck().get(), 1);
    assert.deepEqual(ledgerVersions(db), [1]);
    assert.equal(db.pragma('foreign_keys', {simple: true}), 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});

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

test('已记录 migration 名称或 checksum 被改写时，即使最终 schema 相同也要求重建', () => {
  const rewrittenMigrations = [
    [migration(1, 'renamed_widgets', baseMigrations[0].sql), baseMigrations[1]],
    [migration(1, 'widgets', baseMigrations[0].sql.replace('label TEXT', 'label  TEXT')), baseMigrations[1]]
  ];

  for (const migrations of rewrittenMigrations) {
    const db = new Database(':memory:');
    applyDatabaseMigrations(db, { dbName: 'core', migrations: baseMigrations });
    const ledgerBefore = db
      .prepare('SELECT version, name, checksum FROM schema_migrations WHERE db_name = ? ORDER BY version')
      .all('core');

    assert.throws(
      () => applyDatabaseMigrations(db, { dbName: 'core', migrations }),
      /database_schema_rebuild_required/u
    );
    assert.deepEqual(
      db.prepare('SELECT version, name, checksum FROM schema_migrations WHERE db_name = ? ORDER BY version').all('core'),
      ledgerBefore
    );
  }
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



test('real agent v5 upgrades to v6 and adds checkpoint task_path', () => {
  const db = new Database(':memory:');
  const beforeTaskPath = agentMigrations.filter((entry) => entry.version <= 5);
  applyDatabaseMigrations(db, { dbName: 'agent', migrations: beforeTaskPath });
  assert.equal(columnNames(db, 'langgraph_checkpoint_writes').includes('task_path'), false);

  applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations.filter((entry) => entry.version <= 6) });
  assert.equal(columnNames(db, 'langgraph_checkpoint_writes').includes('task_path'), true);
  assert.equal(readSchemaMetadata(db, 'agent').currentVersion, 6);
  db.close();
});

test('real agent v6 upgrades through v15 grant, budget, operation-lease and research identity tables', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyDatabaseMigrations(db, {
    dbName: 'agent',
    migrations: agentMigrations.filter((entry) => entry.version <= 6)
  });
  const before = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_execution_%'").pluck().all();
  assert.deepEqual(before, []);

  applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations });
  const after = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_execution_%' ORDER BY name").pluck().all();
  assert.deepEqual(after, ['agent_execution_approvals', 'agent_execution_grants', 'agent_execution_run_fences']);
  assert.equal(readSchemaMetadata(db, 'agent').currentVersion, 15);
  for (const table of ['research_tasks', 'research_task_executions', 'agent_research_dispatch_grants']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }
  assert.ok(columnNames(db, 'agent_budget_calls').includes('reserved_cost_microusd'));
  assert.ok(columnNames(db, 'agent_budget_calls').includes('actual_cost_microusd'));
  assert.ok(columnNames(db, 'agent_budget_calls').includes('pricing_version'));
  assert.ok(columnNames(db, 'agent_runs').includes('budget_stop_reason'));
  const budgetIndexes = db.prepare('PRAGMA index_list(agent_budget_calls)').all();
  assert.ok(budgetIndexes.some((entry) => entry.name === 'idx_agent_budget_calls_run_kind_state'));
  const effectColumns = columnNames(db, 'agent_tool_effects');
  for (const column of ['identity_version', 'operation_id', 'attempt_id', 'lease_generation', 'receipt_json', 'receipt_hash', 'expected_version', 'result_hash']) {
    assert.ok(effectColumns.includes(column), `agent_tool_effects stores ${column}`);
  }
  const effectIndexes = db.prepare('PRAGMA index_list(agent_tool_effects)').all();
  assert.ok(effectIndexes.some((entry) => entry.name === 'idx_agent_tool_effects_operation_id' && entry.unique === 1 && entry.partial === 1));
  assert.ok(effectIndexes.some((entry) => entry.name === 'idx_agent_tool_effects_run_lease'));
  const reconciliationColumns = columnNames(db, 'agent_tool_effect_reconciliations');
  assert.ok(reconciliationColumns.includes('receipt_json'));
  assert.ok(reconciliationColumns.includes('receipt_hash'));
  for (const table of ['agent_execution_approvals', 'agent_execution_grants']) {
    const columns = columnNames(db, table);
    assert.ok(columns.includes('schema_version'), `${table} stores a grant version`);
    const createSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").pluck().get(table);
    assert.match(createSql, /schema_version INTEGER NOT NULL CHECK\(schema_version = 1\)/u);
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all();
    const activeCallIndex = indexes.find((entry) => entry.name === `idx_${table}_run_call_live`);
    assert.equal(activeCallIndex?.partial, 1, `${table} call id uniqueness must be partial`);
    const indexSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").pluck().get(`idx_${table}_run_call_live`);
    assert.match(indexSql, /WHERE status IN \('issued','consumed'\)/u);
  }
  const grantForeignKeys = db.prepare('PRAGMA foreign_key_list(agent_execution_grants)').all();
  assert.ok(grantForeignKeys.some((entry) => entry.table === 'agent_runs'));
  assert.ok(grantForeignKeys.some((entry) => entry.table === 'agent_threads'));
  db.close();
});

test('real agent v8 effect rows migrate conservatively and preserve reconciliation history', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const versionEight = agentMigrations.filter((entry) => entry.version <= 8);
  applyDatabaseMigrations(db, { dbName: 'agent', migrations: versionEight });

  const insertEffect = db.prepare(`INSERT INTO agent_tool_effects (
    run_id, thread_id, execution_path, checkpoint_id, tool_call_id, tool_name, input_hash,
    effect_class, reconcile_strategy, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [runId, strategy, status] of [
    ['run-in-progress', 'retry_safe', 'in_progress'],
    ['run-manual-retry', 'manual_confirmation', 'failed_retryable'],
    ['run-reserved', 'retry_safe', 'reserved'],
    ['run-succeeded', 'retry_safe', 'succeeded']
  ]) {
    insertEffect.run(
      runId,
      `thread-${runId}`,
      'main',
      'checkpoint-1',
      `call-${runId}`,
      'write_file',
      `hash-${runId}`,
      'workspace_mutation',
      strategy,
      status,
      '2026-10-30T00:00:00.000Z',
      '2026-10-30T00:00:00.000Z'
    );
  }
  db.prepare(`INSERT INTO agent_tool_effect_reconciliations (
    run_id, execution_path, checkpoint_id, tool_call_id, input_hash, evidence, outcome, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'run-in-progress',
    'main',
    'checkpoint-1',
    'call-run-in-progress',
    'hash-run-in-progress',
    'operator inspected remote receipt',
    'not_applied',
    '2026-10-30T00:00:00.000Z'
  );

  applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations });
  assert.equal(readSchemaMetadata(db, 'agent').currentVersion, 15);
  assert.deepEqual(
    db.prepare('SELECT run_id, status FROM agent_tool_effects ORDER BY run_id').all(),
    [
      { run_id: 'run-in-progress', status: 'unknown' },
      { run_id: 'run-manual-retry', status: 'unknown' },
      { run_id: 'run-reserved', status: 'failed_retryable' },
      { run_id: 'run-succeeded', status: 'succeeded' }
    ]
  );
  assert.equal(db.prepare('SELECT identity_version FROM agent_tool_effects WHERE run_id = ?').pluck().get('run-in-progress'), 0);
  assert.equal(db.prepare('SELECT count(*) FROM agent_tool_effect_reconciliations').pluck().get(), 1);
  db.close();
});
