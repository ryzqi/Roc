// 临时调试脚本：定位 background_task 与 task_thread 归档状态不一致的"幽灵任务"。
// 只读打开 ~/.roc/roc.sqlite。
const path = require('node:path');
const os = require('node:os');

let Database;
try {
  Database = require('better-sqlite3');
} catch (error) {
  console.log('REQUIRE_FAIL', error.code || error.message);
  process.exit(2);
}

const dbPath = path.join(os.homedir(), '.roc', 'roc.sqlite');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const activeTotal = db.prepare("SELECT COUNT(*) AS c FROM background_tasks WHERE status != 'archived'").get();
console.log('ACTIVE_BACKGROUND_TASKS', activeTotal.c);

const ghosts = db
  .prepare(
    `SELECT bt.id, bt.thread_id, bt.status AS bt_status, substr(bt.goal, 1, 50) AS goal,
            bt.updated_at, tt.id AS tt_id, tt.archived_at AS tt_archived_at, tt.status AS tt_status
     FROM background_tasks bt
     LEFT JOIN task_threads tt ON tt.id = bt.thread_id
     WHERE bt.status != 'archived'
       AND (tt.id IS NULL OR tt.archived_at IS NOT NULL)
     ORDER BY bt.updated_at DESC`
  )
  .all();

console.log('GHOST_COUNT', ghosts.length);
console.log(JSON.stringify(ghosts, null, 2));

// getActiveTasks 排序后的首个任务（启动时被选为 primaryTaskId 的候选）
const firstActive = db
  .prepare("SELECT id, thread_id, status FROM background_tasks WHERE status != 'archived' ORDER BY updated_at DESC LIMIT 1")
  .get();
console.log('FIRST_ACTIVE', JSON.stringify(firstActive));

db.close();
