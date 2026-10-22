import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * 检查点写入的顺序契约。
 *
 * langgraph 1.5 起，一个 superstep 里的 pendingWrites 必须按 `(task_path, task_id, idx)` 排序，
 * 与活执行应用写入的顺序一致。旧实现按 `rowid`（= 插入顺序）读回来：并行 superstep 下任务 id
 * 是含检查点 id 的 uuid5，于是同一批并行写入的顺序每次运行都可能不同，重放出来的状态也就跟着变。
 *
 * 这里钉住三件事：
 *   1. 读回顺序由排序键决定，不是插入顺序（故意乱序插入）；
 *   2. 同一任务内的写入按 `idx`；
 *   3. 字符串比较是**码点序**（等于 SQLite 默认 BINARY 的 UTF-8 字节序），不是 JS 的 UTF-16 码元序
 *      —— 用星平面字符与 BMP 末尾字符区分这两种顺序。
 *
 * 行级事实（列存不存在、备份能不能恢复）由 `database-migrations.test.mjs` 守。
 */
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const bundleOptions = {
  platform: 'node',
  external: ['better-sqlite3'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
};
const { RocSqliteCheckpointer } = await importTypeScriptModule(
  'src/main/services/deep-agent/sqlite-checkpointer.ts',
  bundleOptions
);
const { agentMigrations } = await importTypeScriptModule(
  'src/main/infrastructure/database-schemas.ts',
  bundleOptions
);
const { applyDatabaseMigrations } = await importTypeScriptModule(
  'src/main/infrastructure/database-migrations.ts',
  bundleOptions
);

const threadId = 'thread-order';

function createCheckpointer() {
  const db = new Database(':memory:');
  applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations });
  return { db, checkpointer: new RocSqliteCheckpointer(db) };
}

async function seedCheckpoint(checkpointer) {
  const checkpointId = 'ck1';
  await checkpointer.put(
    { configurable: { thread_id: threadId, checkpoint_ns: '' } },
    {
      v: 1,
      id: checkpointId,
      ts: new Date().toISOString(),
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
      updated_channels: []
    },
    { source: 'loop', step: 0, parents: {} },
    {}
  );
  return { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpointId } };
}

const pendingOrder = (tuple) =>
  tuple.pendingWrites.map(([taskId, channel, value]) => `${taskId}:${channel}:${value}`);

test('pendingWrites 按 (task_path, task_id, idx) 读回，而不是插入顺序', async () => {
  const { checkpointer } = createCheckpointer();
  const config = await seedCheckpoint(checkpointer);

  // 故意按「路径倒序」插入：读回顺序必须与插入顺序相反。
  await checkpointer.putWrites(config, [['channel', 'from-later-path']], 'task-b', 'path-2');
  await checkpointer.putWrites(config, [['channel', 'from-root']], 'task-c', '');
  await checkpointer.putWrites(config, [['channel', 'from-earlier-path']], 'task-a', 'path-1');

  const tuple = await checkpointer.getTuple(config);
  assert.deepEqual(pendingOrder(tuple), [
    'task-c:channel:from-root',
    'task-a:channel:from-earlier-path',
    'task-b:channel:from-later-path'
  ]);
});

test('同一任务内的写入按 idx 排序（不是插入顺序）', async () => {
  const { checkpointer } = createCheckpointer();
  const config = await seedCheckpoint(checkpointer);

  // 先把普通写入（idx 0/1）插进去，再补一条特殊通道写入（idx -3，rowid 最大）。
  // 按 idx 排的话特殊写入排最前，按 rowid 排的话排最后——两者在此分岔。
  await checkpointer.putWrites(
    config,
    [
      ['second', 'B'],
      ['first', 'A']
    ],
    'task-a',
    'path-1'
  );
  await checkpointer.putWrites(config, [['__interrupt__', 'I']], 'task-a', 'path-1');

  const tuple = await checkpointer.getTuple(config);
  assert.deepEqual(pendingOrder(tuple), [
    'task-a:__interrupt__:I',
    'task-a:second:B',
    'task-a:first:A'
  ]);
});

test('任务路径按码点序比较（不是 UTF-16 码元序）', async () => {
  const { checkpointer } = createCheckpointer();
  const config = await seedCheckpoint(checkpointer);

  // U+FFFF 与 U+1F600：码点序里 BMP 末尾在前；UTF-16 码元序会把星平面字符（0xD83D…）排前面。
  await checkpointer.putWrites(config, [['channel', 'astral']], 'task-b', '\u{1F600}');
  await checkpointer.putWrites(config, [['channel', 'bmp-last']], 'task-a', '\uFFFF');

  const tuple = await checkpointer.getTuple(config);
  assert.deepEqual(pendingOrder(tuple), ['task-a:channel:bmp-last', 'task-b:channel:astral']);
});

test('没有 taskPath 的写入落成根任务路径', async () => {
  const { db, checkpointer } = createCheckpointer();
  const config = await seedCheckpoint(checkpointer);

  await checkpointer.putWrites(config, [['channel', 'root']], 'task-a');

  assert.equal(
    db
      .prepare('SELECT task_path FROM langgraph_checkpoint_writes WHERE task_id = ?')
      .pluck()
      .get('task-a'),
    ''
  );
});

test('恢复旧形状的备份时补齐 task_path，且不丢写入', async () => {
  const { checkpointer: target, db: targetDb } = createCheckpointer();

  // 模拟升级前的备份：同样的两张表，但没有 task_path 列。
  const old = new Database(':memory:');
  old.exec(`
    CREATE TABLE langgraph_checkpoints (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      checkpoint_type TEXT NOT NULL,
      checkpoint_blob BLOB NOT NULL,
      metadata_type TEXT NOT NULL,
      metadata_blob BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE langgraph_checkpoint_writes (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      channel TEXT NOT NULL,
      value_type TEXT NOT NULL,
      value_blob BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  old
    .prepare(
      `INSERT INTO langgraph_checkpoint_writes
        (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value_blob, created_at)
       VALUES (?, '', 'ck1', 'task-a', 0, 'channel', 'json', ?, ?)`
    )
    .run(threadId, Buffer.from('"restored"', 'utf8'), new Date().toISOString());

  target.restoreFrom(old);

  assert.deepEqual(
    targetDb.prepare('SELECT task_id, task_path FROM langgraph_checkpoint_writes').all(),
    [{ task_id: 'task-a', task_path: '' }]
  );
});
