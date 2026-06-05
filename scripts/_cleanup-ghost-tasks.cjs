// 一次性维护脚本：将与 thread 归档状态不一致的"幽灵" background_tasks 对齐为 archived。
//
// 通用化定义（与 task-repository 中"活动后台任务"的定义互补）：
//   幽灵任务 = status != 'archived' 且其 thread 缺失或已归档（archived_at IS NOT NULL）。
// 此类任务会被旧 getActiveTasks 误当成活动任务，启动时触发 task detail failed。
//
// 安全措施：
//   1. 执行前用 SQLite 在线备份 API 生成一致性快照 roc.sqlite.bak-<时间戳>（可整文件回滚）。
//   2. UPDATE 在事务中执行。
//   3. 执行后断言幽灵任务数 = 0，否则非零退出。
//   4. 无幽灵任务时直接退出，不备份、不写入（幂等）。
//
// 用法（请在 Roc 应用已关闭时执行）：
//   node scripts/_cleanup-ghost-tasks.cjs

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let Database;
try {
  Database = require('better-sqlite3');
} catch (error) {
  console.error('REQUIRE_FAIL', error.code || error.message);
  process.exit(2);
}

// 幽灵判定（单表上下文：UPDATE / COUNT，FROM background_tasks 无别名）。
// 与 task-repository.listActiveBackgroundTasks 的 EXISTS(...archived_at IS NULL) 互补。
const GHOST_FILTER = `
  status != 'archived'
  AND NOT EXISTS (
    SELECT 1
    FROM task_threads
    WHERE task_threads.id = background_tasks.thread_id
      AND task_threads.archived_at IS NULL
  )
`;

// 幽灵判定（LEFT JOIN 展示上下文：bt = background_tasks, tt = task_threads）。与 GHOST_FILTER 等价。
const GHOST_FILTER_JOINED = `
  bt.status != 'archived'
  AND (tt.id IS NULL OR tt.archived_at IS NOT NULL)
`;

async function main() {
  const dbPath = path.join(os.homedir(), '.roc', 'roc.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error('DB_NOT_FOUND', dbPath);
    process.exit(2);
  }

  const db = new Database(dbPath, { fileMustExist: true });

  const beforeGhosts = db
    .prepare(
      `SELECT bt.id, bt.thread_id, bt.status AS bt_status, substr(bt.goal, 1, 50) AS goal,
              tt.id AS tt_id, tt.archived_at AS tt_archived_at, tt.status AS tt_status
       FROM background_tasks bt
       LEFT JOIN task_threads tt ON tt.id = bt.thread_id
       WHERE ${GHOST_FILTER_JOINED}
       ORDER BY bt.updated_at DESC`
    )
    .all();
  console.log('GHOST_COUNT_BEFORE', beforeGhosts.length);
  console.log(JSON.stringify(beforeGhosts, null, 2));

  if (beforeGhosts.length === 0) {
    console.log('NOTHING_TO_CLEAN');
    db.close();
    return;
  }

  // 1) 一致性备份快照
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.bak-${stamp}`;
  await db.backup(backupPath);
  console.log('BACKUP_WRITTEN', backupPath);

  // 2) 事务内对齐：把幽灵任务的 status 改为 archived，与其 thread 状态一致
  const now = new Date().toISOString();
  const update = db.prepare(
    `UPDATE background_tasks
     SET status = 'archived', updated_at = ?
     WHERE ${GHOST_FILTER}`
  );
  const info = db.transaction(() => update.run(now))();
  console.log('ROWS_ARCHIVED', info.changes);

  // 3) 断言幽灵任务清零
  const afterCount = db
    .prepare(`SELECT COUNT(*) AS c FROM background_tasks WHERE ${GHOST_FILTER}`)
    .get().c;
  console.log('GHOST_COUNT_AFTER', afterCount);
  db.close();

  if (afterCount !== 0) {
    console.error('ASSERT_FAILED: ghost tasks remain');
    process.exit(1);
  }
  console.log('CLEANUP_OK');
}

main().catch((error) => {
  console.error('CLEANUP_ERROR', error && error.stack ? error.stack : String(error));
  process.exit(1);
});
