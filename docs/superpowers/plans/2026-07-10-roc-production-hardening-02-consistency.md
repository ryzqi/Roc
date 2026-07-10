# Roc Recoverable Thread Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复 LangGraph checkpointer 的原生删除边界，并让 Roc task/agent 双库的完整 thread 删除可恢复、幂等、可重试且在失败期间不可见。

**Architecture:** `RocSqliteCheckpointer` 只删除自己拥有的 checkpoint 两表。task DB migration v2 增加 `thread_deletion_journal`，TaskRepository 用 `pending -> agent_deleted -> complete` 推进业务删除；任何 journal thread 立即从 task、history、scheduler 和 detail 查询隐藏。task plugin 在 scheduler 启动前恢复所有非 complete journal。

**Tech Stack:** better-sqlite3 transactions、LangGraph BaseCheckpointSaver、TypeScript、Vitest、task plugin lifecycle。

## Global Constraints

- checkpointer 不得删除 `agent_threads`、`agent_runs`、`agent_events`、`session_messages`、interrupt、run event、tool effect 或 context artifact。
- task 插件是完整 thread history 删除的唯一 owner；不建立第二套 queue，不把 journal 放入 agent DB。
- `complete` journal 永久保留为审计与幂等依据；重复删除同一 thread 直接成功。
- 任何存在 journal 的 thread 从 UI、snapshot、detail、background list、active list 和 scheduler 查询隐藏。
- 删除 agent 历史与删除 task projection 分属两个幂等事务，不伪装成跨库原子 transaction。
- 启动恢复单条失败时记录 `attempt_count`、`last_error` 和结构化日志，插件继续启动，但目标保持隐藏。
- migration 只新增 task v2；不修改 task v1 SQL。
- 本批只在最终 review 和验证后提交一次。

---

### Task 1: Restore the checkpointer-owned delete contract

**Files:**
- Modify: `src/main/services/deep-agent/sqlite-checkpointer.ts:1-191`
- Modify: `tests/main/services/deep-agent/sqlite-checkpointer.test.ts:68-102`

**Interfaces:**
- Consumes: LangGraph `BaseCheckpointSaver.deleteThread(threadId)` contract.
- Produces: `RocSqliteCheckpointer.deleteThread(threadId): Promise<void>` that deletes only `langgraph_checkpoint_writes` and `langgraph_checkpoints`.

- [ ] **Step 1: Replace the existing broad-delete assertion with a failing ownership test**

```ts
it('deletes only LangGraph checkpoints and keeps Roc application history', async () => {
  const checkpointer = new RocSqliteCheckpointer(db);
  insertAgentHistoryResidue({
    runId: 'run_delete_thread',
    threadId: 'thread_delete_thread',
    createdAt: '2026-07-06T00:00:00.000Z'
  });

  await checkpointer.deleteThread('thread_delete_thread');

  expect(countRows('langgraph_checkpoints')).toBe(0);
  expect(countRows('langgraph_checkpoint_writes')).toBe(0);
  expect(countRows('agent_threads')).toBe(1);
  expect(countRows('agent_runs')).toBe(1);
  expect(countRows('agent_events')).toBe(1);
  expect(countRows('session_messages')).toBe(1);
  expect(countRows('session_messages_fts')).toBe(1);
  expect(countRows('agent_pending_interrupts')).toBe(1);
  expect(countRows('agent_run_events')).toBe(1);
  expect(countRows('agent_tool_effects')).toBe(1);
  expect(countRows('context_artifacts')).toBe(1);
});
```

- [ ] **Step 2: Run the focused checkpointer test and verify RED**

```powershell
pnpm test -- tests/main/services/deep-agent/sqlite-checkpointer.test.ts
```

Expected: FAIL because the current implementation calls `deleteAgentThreadHistory()` and removes every application row.

- [ ] **Step 3: Implement checkpoint-only deletion**

Remove the application-history import and use one local transaction:

```ts
override async deleteThread(threadId: string): Promise<void> {
  requireStorageKey(threadId, 'agent_checkpoint_thread_id_missing');
  this.db.transaction(() => {
    this.db.prepare('DELETE FROM langgraph_checkpoint_writes WHERE thread_id = ?').run(threadId);
    this.db.prepare('DELETE FROM langgraph_checkpoints WHERE thread_id = ?').run(threadId);
  })();
}
```

- [ ] **Step 4: Run the checkpointer test and verify GREEN**

```powershell
pnpm test -- tests/main/services/deep-agent/sqlite-checkpointer.test.ts
```

Expected: PASS; only the two LangGraph tables reach zero rows.

### Task 2: Add task migration v2 and the deletion journal

**Files:**
- Modify: `src/main/infrastructure/database-schemas.ts` in `taskMigrations`
- Create: `src/main/plugins/task/thread-deletion-journal.ts`
- Modify: `tests/main/infrastructure/database-schemas.test.ts`
- Modify: `tests/main/infrastructure/database-migrations.test.ts`
- Create: `tests/main/plugins/task/thread-deletion-journal.test.ts`

**Interfaces:**
- Consumes: task DB connection and a deterministic `now(): string` clock.
- Produces: `ThreadDeletionJournal`, `ThreadDeletionRecord`, and state methods used by TaskRepository.

- [ ] **Step 1: Write failing migration and journal tests**

Assert the exact v2 columns and index:

```ts
expect(columnNames(db, 'thread_deletion_journal')).toEqual([
  'thread_id',
  'state',
  'attempt_count',
  'last_error',
  'created_at',
  'updated_at',
  'completed_at'
]);
expect(indexNames(db, 'thread_deletion_journal')).toContain('idx_task_thread_deletion_journal_state_updated');
```

Test the state machine and idempotent pending insert:

```ts
const journal = new ThreadDeletionJournal(db, () => '2026-07-10T01:00:00.000Z');
expect(journal.ensurePending('thread-1')).toMatchObject({
  threadId: 'thread-1',
  state: 'pending',
  attemptCount: 0,
  lastError: null
});
expect(journal.ensurePending('thread-1').createdAt).toBe('2026-07-10T01:00:00.000Z');

journal.recordFailure('thread-1', new Error('agent delete failed'));
expect(journal.require('thread-1')).toMatchObject({
  state: 'pending',
  attemptCount: 1,
  lastError: 'agent delete failed'
});

journal.markAgentDeleted('thread-1');
journal.markComplete('thread-1');
expect(journal.require('thread-1')).toMatchObject({ state: 'complete' });
expect(journal.listIncomplete()).toEqual([]);
```

Add transition rejection tests: `pending -> complete` and `complete -> agent_deleted` must throw explicit state errors.

- [ ] **Step 2: Run migration and journal tests and verify RED**

```powershell
pnpm test -- tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/database-migrations.test.ts tests/main/plugins/task/thread-deletion-journal.test.ts
```

Expected: FAIL because task migration v2 and journal module do not exist.

- [ ] **Step 3: Add task migration v2 without editing v1**

Append to `taskMigrations`:

```ts
{
  version: 2,
  name: 'thread_deletion_journal',
  sql: `
    CREATE TABLE thread_deletion_journal (
      thread_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('pending','agent_deleted','complete')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX idx_task_thread_deletion_journal_state_updated
      ON thread_deletion_journal(state, updated_at);
  `
}
```

- [ ] **Step 4: Implement the journal with explicit transitions**

Create these public contracts:

```ts
export type ThreadDeletionState = 'pending' | 'agent_deleted' | 'complete';

export type ThreadDeletionRecord = {
  threadId: string;
  state: ThreadDeletionState;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export class ThreadDeletionJournal {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  ensurePending(threadId: string): ThreadDeletionRecord;
  find(threadId: string): ThreadDeletionRecord | null;
  require(threadId: string): ThreadDeletionRecord;
  listIncomplete(): ThreadDeletionRecord[];
  listHiddenThreadIds(): Set<string>;
  markAgentDeleted(threadId: string): void;
  markCompleteInCurrentTransaction(threadId: string): void;
  recordFailure(threadId: string, error: unknown): void;
}
```

Use conditional updates so invalid transitions fail:

```ts
const result = this.db.prepare(
  `UPDATE thread_deletion_journal
   SET state = 'agent_deleted', last_error = NULL, updated_at = ?
   WHERE thread_id = ? AND state = 'pending'`
).run(this.now(), threadId);
if (result.changes !== 1) {
  throw new Error('thread_deletion_transition_invalid:pending_to_agent_deleted');
}
```

`recordFailure()` increments `attempt_count`, stores `error.message` or `String(error)`, updates `updated_at`, and never changes `state`. `markCompleteInCurrentTransaction()` requires current state `agent_deleted`, sets `completed_at`, and is called inside the projection-delete transaction.

- [ ] **Step 5: Run Task 2 tests and verify GREEN**

```powershell
pnpm test -- tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/database-migrations.test.ts tests/main/plugins/task/thread-deletion-journal.test.ts
```

Expected: PASS; task schema metadata reports version `2`, checksum tests pass, and invalid journal transitions throw.

### Task 3: Make TaskRepository deletion recoverable and hide journaled threads

**Files:**
- Modify: `src/main/plugins/task/task-repository.ts:1-362`
- Modify: `src/main/plugins/task/task-repository-queries.ts`
- Modify: `src/main/plugins/task/index.ts:86-95`
- Modify: `src/main/infrastructure/database-health.ts` to require the v2 journal table
- Modify: `src/shared/types/task.ts` for the deletion-started refresh event
- Modify: `src/renderer/app/data-loading.ts` to skip a selected task after it becomes hidden
- Modify: `src/renderer/app/AppShell.tsx` to clear hidden task detail navigation
- Verify: `src/main/plugins/task/agent-task-history.ts` remains unchanged
- Modify: `tests/main/plugins/task/task-repository.test.ts`
- Modify: `tests/main/plugins/task/plugin.test.ts`
- Modify: `tests/main/plugins/task/scheduler.test.ts`
- Modify: `tests/main/infrastructure/database-health.test.ts`
- Modify: `tests/renderer/app-shell.test.tsx`
- Verify: `tests/renderer/task-surface-data.test.ts` remains passing
- Verify: `tests/main/plugins/task/plugin-thread-history.test.ts` remains passing without modification

**Interfaces:**
- Consumes: `ThreadDeletionJournal`, `deleteAgentThreadHistory()`, `deleteTaskProjectionForThread()`.
- Produces: `TaskRepository.deleteThread(threadId)`, `listIncompleteThreadDeletions()`, immediate visibility filtering, and initialize-time recovery before `scheduler.start()`.

- [ ] **Step 1: Write failing failure-injection and idempotency tests**

Agent failure case:

```ts
const agentHistory = new AgentTaskHistoryReader(agentDb);
const deleteSpy = vi.spyOn(agentHistory, 'deleteThread')
  .mockImplementationOnce(() => { throw new Error('agent_delete_injected'); });
const repository = new TaskRepository(db, agentHistory, journal);

expect(() => repository.deleteThread(task.threadId)).toThrow('agent_delete_injected');
expect(journal.require(task.threadId)).toMatchObject({
  state: 'pending',
  attemptCount: 1,
  lastError: 'agent_delete_injected'
});
expect(repository.getSnapshot().threads.some((thread) => thread.id === task.threadId)).toBe(false);
expect(repository.listBackgroundTasks()).toEqual([]);

deleteSpy.mockRestore();
expect(repository.deleteThread(task.threadId)).toEqual({ deleted: true, threadId: task.threadId });
expect(journal.require(task.threadId).state).toBe('complete');
```

Projection failure case uses a temporary SQLite trigger:

```ts
db.exec(`
  CREATE TRIGGER fail_background_task_delete
  BEFORE DELETE ON background_tasks
  BEGIN
    SELECT RAISE(ABORT, 'projection_delete_injected');
  END;
`);
expect(() => repository.deleteThread(task.threadId)).toThrow('projection_delete_injected');
expect(journal.require(task.threadId).state).toBe('agent_deleted');
expect(countRows(agentDb, 'agent_threads')).toBe(0);
expect(countRows(db, 'background_tasks')).toBe(1);

db.exec('DROP TRIGGER fail_background_task_delete;');
expect(repository.deleteThread(task.threadId)).toEqual({ deleted: true, threadId: task.threadId });
expect(journal.require(task.threadId).state).toBe('complete');
```

Repeat the completed delete and assert it returns success without recreating rows or incrementing attempts.

- [ ] **Step 2: Write failing visibility tests for every public task surface**

After `journal.ensurePending(threadId)`, assert:

```ts
expect(repository.findBackgroundTask(task.id)).toBeNull();
expect(repository.listBackgroundTasks()).toEqual([]);
expect(repository.listSchedulableBackgroundTasks()).toEqual([]);
expect(repository.getActiveTasks()).toEqual([]);
expect(repository.getSnapshot().threads.map((thread) => thread.id)).not.toContain(threadId);
expect(repository.getSnapshot().recentEvents.map((event) => event.threadId)).not.toContain(threadId);
expect(() => repository.getTaskDetail({ taskId: task.id, schedulerRegistered: true })).toThrow('background_task_not_found');
expect(() => repository.listThreadMessages(threadId)).toThrow('task_thread_not_found');
```

Add a scheduler test proving a journaled running task is never registered or fired.

- [ ] **Step 3: Run repository/plugin tests and verify RED**

```powershell
pnpm test -- tests/main/plugins/task/task-repository.test.ts tests/main/plugins/task/plugin.test.ts tests/main/plugins/task/plugin-thread-history.test.ts tests/main/plugins/task/scheduler.test.ts
```

Expected: FAIL because delete is projection-first, has no journal, and task/history queries expose the target.

- [ ] **Step 4: Inject the journal and implement the recoverable state machine**

Update the constructor:

```ts
constructor(
  private readonly db: DatabaseConnection,
  private readonly agentHistory: AgentTaskHistoryReader,
  private readonly deletionJournal: ThreadDeletionJournal = new ThreadDeletionJournal(db)
) {}
```

Implement delete in state order:

```ts
deleteThread(threadId: string): TaskDeleteThreadResult {
  const existing = this.deletionJournal.find(threadId);
  if (existing?.state === 'complete') {
    return { deleted: true, threadId };
  }
  if (existing === null) {
    this.agentHistory.requireActiveThread(threadId);
    this.deletionJournal.ensurePending(threadId);
  }

  let record = this.deletionJournal.require(threadId);
  if (record.state === 'pending') {
    try {
      this.agentHistory.deleteThread(threadId);
      this.deletionJournal.markAgentDeleted(threadId);
    } catch (error) {
      this.deletionJournal.recordFailure(threadId, error);
      throw error;
    }
    record = this.deletionJournal.require(threadId);
  }

  if (record.state === 'agent_deleted') {
    try {
      this.db.transaction(() => {
        deleteTaskProjectionForThread(this.db, threadId);
        this.deletionJournal.markCompleteInCurrentTransaction(threadId);
      })();
    } catch (error) {
      this.deletionJournal.recordFailure(threadId, error);
      throw error;
    }
  }

  if (this.deletionJournal.require(threadId).state !== 'complete') {
    throw new Error('thread_deletion_state_incomplete');
  }
  return { deleted: true, threadId };
}
```

The targeted catches persist failure state and rethrow; they do not convert failure into success.

- [ ] **Step 5: Filter task DB queries at SQL level**

Add this predicate to background task find/list/schedulable/active queries:

```sql
AND NOT EXISTS (
  SELECT 1
  FROM thread_deletion_journal deletion
  WHERE deletion.thread_id = background_tasks.thread_id
)
```

For `listActiveBackgroundTasks`, use `WHERE status != 'archived' AND NOT EXISTS (SELECT 1 FROM thread_deletion_journal deletion WHERE deletion.thread_id = background_tasks.thread_id)`. For id/run-id queries, use the same full `NOT EXISTS` clause after `WHERE id = ?` or `WHERE run_id = ?`. For schedulable queries, append the same full predicate to the existing status/trigger conditions. Do not filter only in renderer code.

At the repository boundary, filter the separate agent DB snapshot with one hidden set:

```ts
const hiddenThreadIds = this.deletionJournal.listHiddenThreadIds();
const threads = this.agentHistory.readThreads().filter((thread) => !hiddenThreadIds.has(thread.id));
const recentEvents = this.agentHistory.readRecentEvents().filter((event) => !hiddenThreadIds.has(event.threadId));
```

Before `listThreadMessages()`, `getTaskDetail()` and any direct agent-history lookup, reject a hidden thread with the existing not-found domain error.

- [ ] **Step 6: Recover incomplete deletes before the scheduler starts**

Expose:

```ts
listIncompleteThreadDeletions(): ThreadDeletionRecord[] {
  return this.deletionJournal.listIncomplete();
}
```

In task plugin initialize, create the journal, then recover each record before constructing/starting the scheduler:

```ts
const deletionJournal = new ThreadDeletionJournal(db);
const repository = new TaskRepository(
  db,
  new AgentTaskHistoryReader(context.database.getAgentConnection()),
  deletionJournal
);
for (const record of repository.listIncompleteThreadDeletions()) {
  try {
    repository.deleteThread(record.threadId);
  } catch (error) {
    context.logger.warn('Task thread deletion recovery failed.', {
      component: 'task.initialize',
      threadId: record.threadId,
      state: record.state,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
scheduler = new TaskScheduler(repository, {
  startRun: (request) => context.capabilities.invoke('agent.run.start', request)
});
scheduler.start();
```

If a live delete has already created a journal but later fails, unregister linked scheduler entries and publish a dedicated task update:

```ts
{ kind: 'thread_deletion_started', threadId }
```

Do not publish a false `archived` status. The renderer already refreshes task state for every task update, including chat-only threads that have no linked background task id.

- [ ] **Step 7: Add restart-recovery plugin tests**

Seed a `pending` journal plus both DB projections, initialize the plugin, and assert both DBs are cleaned before scheduler status is read. Seed an `agent_deleted` journal plus only task projection and assert initialize finishes the task transaction. Inject one recovery failure and assert plugin initialize resolves, scheduler excludes the hidden task, journal attempt increments, and logger receives the thread id/state.

- [ ] **Step 8: Run Task 3 tests and verify GREEN**

```powershell
pnpm test -- tests/main/plugins/task/thread-deletion-journal.test.ts tests/main/plugins/task/task-repository.test.ts tests/main/plugins/task/plugin.test.ts tests/main/plugins/task/plugin-thread-history.test.ts tests/main/plugins/task/scheduler.test.ts
```

Expected: PASS; both failure points resume correctly, repeated complete delete succeeds, and no public task surface exposes journaled threads.

### Task 4: Review, verify, and commit the consistency batch

**Files:**
- Review: all files changed in Tasks 1-3
- Verify migration metadata and checksum behavior

**Interfaces:**
- Consumes: checkpoint-only delete and the completed journal state machine.
- Produces: one reviewed consistency commit with no generated IPC changes.

- [ ] **Step 1: Run the complete consistency focused suite**

```powershell
pnpm test -- tests/main/services/deep-agent/sqlite-checkpointer.test.ts tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/database-migrations.test.ts tests/main/infrastructure/database-health.test.ts tests/main/plugins/task/thread-deletion-journal.test.ts tests/main/plugins/task/task-repository.test.ts tests/main/plugins/task/plugin.test.ts tests/main/plugins/task/plugin-thread-history.test.ts tests/main/plugins/task/scheduler.test.ts tests/renderer/app-shell.test.tsx tests/renderer/task-surface-data.test.ts
```

Expected: PASS.

- [ ] **Step 2: Review the current diff before committing**

```powershell
git diff -- src/main/infrastructure src/main/plugins/task src/main/services/deep-agent tests/main
```

Review in this order:

1. Critical: checkpointer still reaches application-owned tables or task delete removes projection before agent history.
2. High: any journal state can expose the thread, schedule it, or return success before `complete`.
3. High: failure after agent deletion cannot resume, `complete` is deleted, or repeated deletion depends on a remaining agent thread.
4. High: plugin starts scheduler before recovery or recovery failure aborts the whole plugin.
5. Medium: migration v1 changed, health checks omit the v2 journal, state transition lacks conditional update, or attempt/error audit is lost.

Record findings with file and line. Fix each finding and rerun its direct test. If none exist, record `未发现问题` and note that two SQLite databases still cannot share an atomic transaction; the journal is the recovery mechanism.

- [ ] **Step 3: Run final batch verification**

```powershell
pnpm typecheck
pnpm check:ipc
pnpm test -- tests/main/services/deep-agent/sqlite-checkpointer.test.ts tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/database-migrations.test.ts tests/main/infrastructure/database-health.test.ts tests/main/plugins/task/thread-deletion-journal.test.ts tests/main/plugins/task/task-repository.test.ts tests/main/plugins/task/plugin.test.ts tests/main/plugins/task/plugin-thread-history.test.ts tests/main/plugins/task/scheduler.test.ts tests/renderer/app-shell.test.tsx tests/renderer/task-surface-data.test.ts
git diff --check
```

Expected: every command exit code `0`.

- [ ] **Step 4: Commit only the reviewed consistency batch**

```powershell
$batchFiles = @(
  'src/main/infrastructure/database-schemas.ts'
  'src/main/infrastructure/database-health.ts'
  'src/main/plugins/task/thread-deletion-journal.ts'
  'src/main/plugins/task/task-repository.ts'
  'src/main/plugins/task/task-repository-queries.ts'
  'src/main/plugins/task/index.ts'
  'src/main/services/deep-agent/sqlite-checkpointer.ts'
  'src/shared/types/task.ts'
  'src/renderer/app/data-loading.ts'
  'src/renderer/app/AppShell.tsx'
  'tests/main/infrastructure/database-schemas.test.ts'
  'tests/main/infrastructure/database-migrations.test.ts'
  'tests/main/infrastructure/database-health.test.ts'
  'tests/main/plugins/task/thread-deletion-journal.test.ts'
  'tests/main/plugins/task/task-repository.test.ts'
  'tests/main/plugins/task/plugin.test.ts'
  'tests/main/plugins/task/scheduler.test.ts'
  'tests/main/services/deep-agent/sqlite-checkpointer.test.ts'
  'tests/renderer/app-shell.test.tsx'
  'docs/superpowers/plans/2026-07-10-roc-production-hardening-02-consistency.md'
)
git add -- $batchFiles
git diff --cached --check
git commit -m "fix: make thread deletion recoverable"
```

Expected: commit succeeds and `git status --short` contains no consistency-batch leftovers.
