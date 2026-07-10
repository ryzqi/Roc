# Roc Renderer Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通 chat event 不再更新 AppShell task state，并从 SQLite 查询、renderer 状态到 DOM 渲染全面限制长历史、首屏 bundle、loader 瀑布和内存预算。

**Architecture:** AppShell 用已知 task run id 集合过滤共享 event bus。task history 改为基于 `agent_events.sequence` 的 latest/before/after page contract；renderer hook 负责请求世代、sequence/id 校验和增量合并，`react-virtuoso` 负责变量高度、prepend 锚定和 DOM 上限。Markdown、Settings 与非 chat feature 移出无消息首屏，自动 chunk gate 检查 1.5 MB 预算。PerformanceSample 聚合所有 Electron process 的 private/working set。

**Tech Stack:** React 19 hooks、react-virtuoso、Electron IPC、better-sqlite3 query plan、Vite manifest、Vitest/jsdom、Playwright performance smoke。

## Global Constraints

- 普通 chat 继续只由 `useChatRun()` 的 RAF batching 路径消费；AppShell 不增加第二条 event bus 或 IPC。
- page request 的 `limit` 必填且为 `1..200`；renderer 使用 `100`。
- `cursor: null` 返回最新尾页，`before` 使用严格 `< sequence`，`after` 使用严格 `> sequence`，响应始终按 sequence 升序。
- `PersistedTaskEvent.sequence` 必填；缺失、非整数、非单调、相同 sequence 不同 id 或相同 id 不同 sequence必须显式失败。
- thread 切换使旧请求失效，旧响应不得覆盖新 thread。
- 10k 历史初次只返回 100 events，稳定 DOM message rows `< 300`，prepend p95 `<= 250 ms`。
- 无消息首屏 initial JS + modulepreload 未压缩合计 `<= 1.5 MB`，且不得 preload Markdown、Streamdown、highlight 或 Settings chunk。
- 空数据固定 gate：`mainReady <= 500 ms`、`rendererReady <= 2500 ms`、总 private bytes `<= 450 MB`。
- 1k profile：尾页可交互 `<= 750 ms`、总 private bytes `<= 500 MB`；10k profile 尾页可见 `<= 1000 ms`。
- private bytes 缺失必须报告 `private_bytes_unavailable` 并使 Windows performance gate 失败，不用 working set 替代。
- 本批只在最终 review 和验证后提交一次。

---

### Task 1: Filter AppShell events by known task run ids

**Files:**
- Create: `src/renderer/app/task-run-event-filter.ts`
- Modify: `src/renderer/app/AppShell.tsx:1-151`
- Modify: `tests/renderer/app-shell.test.tsx`
- Create: `tests/renderer/task-run-event-filter.test.ts`

**Interfaces:**
- Consumes: `ChatRunEvent`, task snapshot background thread ids, recent events and selected `TaskDetail.backgroundTask.runId`.
- Produces: `syncKnownTaskRunIds()` and `shouldApplyTaskRunEvent()` used by AppShell.

- [x] **Step 1: Write failing pure filter tests**

```ts
const known = new Set<string>();
expect(shouldApplyTaskRunEvent(known, {
  type: 'run_started',
  runId: 'run-chat',
  mode: 'chat',
  threadId: 'thread-chat',
  providerId: 'provider',
  modelId: 'model',
  createdAt: '2026-07-10T00:00:00.000Z'
})).toBe(false);
expect(known).toEqual(new Set());

expect(shouldApplyTaskRunEvent(known, {
  type: 'run_started',
  runId: 'run-task',
  mode: 'task',
  threadId: 'thread-task',
  providerId: 'provider',
  modelId: 'model',
  createdAt: '2026-07-10T00:00:00.000Z'
})).toBe(true);
expect(known).toEqual(new Set(['run-task']));

expect(shouldApplyTaskRunEvent(known, {
  type: 'assistant_block',
  runId: 'run-chat',
  block: { kind: 'text', blockId: 'text-chat', phase: 'delta', text: 'token' }
})).toBe(false);
```

For a known `run_interrupted`, assert the function returns true and retains the id so a later `run_resumed` is also accepted. For `run_completed` and `run_failed`, assert the id is removed only after the caller applies the event via `completeTaskRunEvent(known, event)`.

- [x] **Step 2: Write a failing AppShell render-count regression**

Subscribe the mocked client, emit 50 ordinary chat `assistant_block` events, and assert the task transcript/render probe remains unchanged. Emit a task `run_started` plus block and assert it updates once. This test must fail on the current handler, which applies every non-start ordinary event.

- [x] **Step 3: Run Task 1 tests and verify RED**

```powershell
pnpm test -- tests/renderer/task-run-event-filter.test.ts tests/renderer/app-shell.test.tsx
```

Expected: FAIL because AppShell only filters non-task `run_started` and cannot classify later ordinary events.

- [x] **Step 4: Implement and wire the run-id set**

Create:

```ts
export function syncKnownTaskRunIds(input: {
  target: Set<string>;
  snapshot: TaskSnapshot;
  taskDetail: TaskDetail | null;
}): void {
  const backgroundThreadIds = new Set(
    input.snapshot.threads
      .filter((thread) => thread.kind === 'background')
      .map((thread) => thread.id)
  );
  for (const event of input.snapshot.recentEvents) {
    if (backgroundThreadIds.has(event.threadId)) {
      input.target.add(event.runId);
    }
  }
  if (input.taskDetail?.backgroundTask !== null && input.taskDetail !== null) {
    input.target.add(input.taskDetail.backgroundTask.runId);
  }
}

export function shouldApplyTaskRunEvent(known: Set<string>, event: ChatRunEvent): boolean {
  if (event.type === 'run_started') {
    if (event.mode !== 'task') {
      return false;
    }
    known.add(event.runId);
    return true;
  }
  return known.has(event.runId);
}

export function completeTaskRunEvent(known: Set<string>, event: ChatRunEvent): void {
  if (event.type === 'run_completed' || event.type === 'run_failed') {
    known.delete(event.runId);
  }
}
```

In AppShell keep `const taskRunIdsRef = useRef(new Set<string>());`, synchronize it when task snapshot/detail changes, guard before `setTaskLiveRunState`, apply the event, then remove only completed/failed ids. Refresh task state for completed、failed and interrupted; interrupted remains classified for resumed/recovering/recovered events.

- [x] **Step 5: Run Task 1 tests and verify GREEN**

```powershell
pnpm test -- tests/renderer/task-run-event-filter.test.ts tests/renderer/app-shell.test.tsx
```

Expected: PASS; ordinary chat events do not call the task state setter or task refresh.

### Task 2: Add the sequence page contract and indexed SQL

**Files:**
- Modify: `src/shared/types/task.ts:27-90`
- Modify: `src/shared/ipc.ts:135-142`
- Modify: `src/main/infrastructure/database-schemas.ts` in `agentMigrations`
- Modify: `src/main/plugins/task/contracts.ts`
- Modify: `src/main/plugins/task/agent-task-history.ts`
- Modify: `src/main/plugins/task/task-repository.ts:359-362`
- Modify: `src/main/plugins/task/index.ts:45-65`
- Modify: `src/main/ipc/plugin-capability-adapter.ts`
- Modify: `tests/main/plugins/task/plugin-thread-history.test.ts`
- Modify: `tests/main/infrastructure/database-schemas.test.ts`
- Modify: `tests/main/infrastructure/database-migrations.test.ts`
- Modify: `tests/main/ipc-plugin-adapter.test.ts`

**Interfaces:**
- Consumes: monotonic per-thread `agent_events.sequence`.
- Produces: `PersistedTaskEvent`, `TaskMessageHistoryRequest`, `TaskMessageHistoryPage`, strict schemas and indexed latest/before/after queries.

- [x] **Step 1: Write failing contract and pagination tests**

Use the exact shared types:

```ts
export type PersistedTaskEvent = Omit<TaskEvent, 'sequence'> & { sequence: number };

export type TaskMessageHistoryRequest = {
  threadId: string;
  limit: number;
  cursor:
    | null
    | { direction: 'before'; sequence: number }
    | { direction: 'after'; sequence: number };
};

export type TaskMessageHistoryPage = {
  items: PersistedTaskEvent[];
  oldestSequence: number | null;
  newestSequence: number | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};
```

Seed sequences `1..250` and assert:

```ts
const latest = await invoke({ threadId, limit: 100, cursor: null });
expect(latest.items.map((item) => item.sequence)).toEqual(
  Array.from({ length: 100 }, (_value, index) => index + 151)
);
expect(latest).toMatchObject({ oldestSequence: 151, newestSequence: 250, hasMoreBefore: true, hasMoreAfter: false });

const before = await invoke({ threadId, limit: 100, cursor: { direction: 'before', sequence: 151 } });
expect(before.items.map((item) => item.sequence)).toEqual(
  Array.from({ length: 100 }, (_value, index) => index + 51)
);

const after = await invoke({ threadId, limit: 100, cursor: { direction: 'after', sequence: 200 } });
expect(after.items.map((item) => item.sequence)).toEqual(
  Array.from({ length: 50 }, (_value, index) => index + 201)
);
```

Reject `limit` 0/201, missing cursor, non-positive/non-integer sequence and extra fields. Run `EXPLAIN QUERY PLAN` for all directions and assert detail contains `idx_agent_events_thread_sequence` and does not contain `USE TEMP B-TREE FOR ORDER BY`.

- [x] **Step 2: Run Task 2 tests and verify RED**

```powershell
pnpm test -- tests/main/plugins/task/plugin-thread-history.test.ts tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/database-migrations.test.ts tests/main/ipc-plugin-adapter.test.ts
```

Expected: FAIL because the current capability accepts only `{ threadId }`, returns all `TaskEvent[]`, and lacks a `(thread_id, sequence)` index.

- [x] **Step 3: Add the required agent cursor index migration**

Append an agent migration without editing v1:

```ts
{
  version: 2,
  name: 'agent_event_sequence_cursor',
  sql: `
    CREATE INDEX idx_agent_events_thread_sequence
      ON agent_events(thread_id, sequence);
  `
}
```

This migration is required because the existing `(thread_id, run_id, sequence)` index cannot satisfy a cross-run `ORDER BY sequence` without a temporary sort. Record this as the one design-spec correction before implementation begins.

Update schema/health expectations so agent is version `2` after this batch; core remains `2`, task remains `2`, and the other logical databases remain version `1`.

- [x] **Step 4: Implement strict page schemas**

In `task/contracts.ts`:

```ts
const taskEventTypeSchema = z.enum([
  'message', 'assistant_block', 'agent_update', 'plan', 'tool_call', 'mcp_call',
  'skill_loaded', 'subagent_event', 'hook_started', 'hook_completed', 'agent_execute',
  'file_change', 'git_operation', 'memory_operation', 'approval_requested',
  'approval_decision', 'human_question_requested', 'human_question_answered',
  'recovery_point', 'context_manifest', 'background_task_created',
  'background_task_paused', 'background_task_resumed', 'background_task_cancelled',
  'long_running_promoted', 'guardrail_nudge', 'diagnostic', 'verification', 'error', 'summary'
]);

export const taskEventSchema = z.object({
  id: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  type: taskEventTypeSchema,
  payload: z.unknown(),
  createdAt: z.string().datetime({ offset: true }),
  sequence: z.number().int().positive().optional()
}).strict() satisfies z.ZodType<TaskEvent>;

export const persistedTaskEventSchema = taskEventSchema
  .omit({ sequence: true })
  .extend({ sequence: z.number().int().positive() })
  .strict() satisfies z.ZodType<PersistedTaskEvent>;

const taskMessageCursorSchema = z.discriminatedUnion('direction', [
  z.object({ direction: z.literal('before'), sequence: z.number().int().positive() }).strict(),
  z.object({ direction: z.literal('after'), sequence: z.number().int().positive() }).strict()
]);

export const taskMessageHistoryRequestSchema = z.object({
  threadId: z.string().trim().min(1),
  limit: z.number().int().min(1).max(200),
  cursor: taskMessageCursorSchema.nullable()
}).strict() satisfies z.ZodType<TaskMessageHistoryRequest>;

export const taskMessageHistoryPageSchema = z.object({
  items: z.array(persistedTaskEventSchema),
  oldestSequence: z.number().int().positive().nullable(),
  newestSequence: z.number().int().positive().nullable(),
  hasMoreBefore: z.boolean(),
  hasMoreAfter: z.boolean()
}).strict() satisfies z.ZodType<TaskMessageHistoryPage>;
```

- [x] **Step 5: Implement the three indexed queries**

Add to `AgentTaskHistoryReader`:

```ts
listEventPage(request: TaskMessageHistoryRequest): TaskMessageHistoryPage {
  const rows = request.cursor === null
    ? this.agentDb.prepare(
        `SELECT sequence, id, thread_id, run_id, type, payload_json, created_at
         FROM agent_events
         WHERE thread_id = ?
         ORDER BY sequence DESC
         LIMIT ?`
      ).all(request.threadId, request.limit).reverse()
    : request.cursor.direction === 'before'
      ? this.agentDb.prepare(
          `SELECT sequence, id, thread_id, run_id, type, payload_json, created_at
           FROM agent_events
           WHERE thread_id = ? AND sequence < ?
           ORDER BY sequence DESC
           LIMIT ?`
        ).all(request.threadId, request.cursor.sequence, request.limit).reverse()
      : this.agentDb.prepare(
          `SELECT sequence, id, thread_id, run_id, type, payload_json, created_at
           FROM agent_events
           WHERE thread_id = ? AND sequence > ?
           ORDER BY sequence ASC
           LIMIT ?`
        ).all(request.threadId, request.cursor.sequence, request.limit);

  return buildTaskMessageHistoryPage(this.agentDb, request, rows.map(mapPersistedTaskEvent));
}
```

Map rows without optional sequence:

```ts
type PersistedTaskEventRow = TaskEventRow & { sequence: number };

function mapPersistedTaskEvent(row: PersistedTaskEventRow): PersistedTaskEvent {
  const event = mapTaskEvent({ ...row, rowid: row.sequence });
  if (event.sequence === undefined) {
    throw new Error('task_history_sequence_missing');
  }
  return { ...event, sequence: event.sequence };
}
```

Build page metadata with indexed existence checks:

```ts
function buildTaskMessageHistoryPage(
  db: DatabaseConnection,
  request: TaskMessageHistoryRequest,
  items: PersistedTaskEvent[]
): TaskMessageHistoryPage {
  const oldestSequence = items[0]?.sequence ?? null;
  const newestSequence = items.at(-1)?.sequence ?? null;
  if (oldestSequence !== null && newestSequence !== null) {
    return {
      items,
      oldestSequence,
      newestSequence,
      hasMoreBefore: eventExists(db, request.threadId, '<', oldestSequence),
      hasMoreAfter: eventExists(db, request.threadId, '>', newestSequence)
    };
  }
  if (request.cursor === null) {
    return { items: [], oldestSequence: null, newestSequence: null, hasMoreBefore: false, hasMoreAfter: false };
  }
  return {
    items: [],
    oldestSequence: null,
    newestSequence: null,
    hasMoreBefore: request.cursor.direction === 'after'
      ? eventExists(db, request.threadId, '<', request.cursor.sequence)
      : false,
    hasMoreAfter: request.cursor.direction === 'before'
      ? eventExists(db, request.threadId, '>', request.cursor.sequence)
      : false
  };
}

function eventExists(
  db: DatabaseConnection,
  threadId: string,
  operator: '<' | '>',
  sequence: number
): boolean {
  const value = db.prepare(
    `SELECT EXISTS(SELECT 1 FROM agent_events WHERE thread_id = ? AND sequence ${operator} ?)`
  ).pluck().get(threadId, sequence);
  return value === 1;
}
```

Pass the full request into `buildTaskMessageHistoryPage()`. The operator is chosen only from the closed union above, never from IPC text.

- [x] **Step 6: Wire repository, capability and IPC**

```ts
listThreadMessages(request: TaskMessageHistoryRequest): TaskMessageHistoryPage {
  this.requireVisibleThread(request.threadId);
  return this.agentHistory.listEventPage(request);
}
```

Register `task.thread.messages.list` with the new request/page schemas, change `RocPreloadApi.tasks.getThreadMessages` to return `TaskMessageHistoryPage`, and update the capability adapter/mocks without retaining the array signature.

- [x] **Step 7: Run Task 2 tests and verify GREEN**

```powershell
pnpm test -- tests/main/plugins/task/plugin-thread-history.test.ts tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/database-migrations.test.ts tests/main/ipc-plugin-adapter.test.ts tests/main/ipc-schema-generation.test.ts
```

Expected: PASS; all pages are ascending, strict bounds are correct, and query plans use `idx_agent_events_thread_sequence` without temp sort.

### Task 3: Load bounded persisted history and virtualize transcript rows

**Files:**
- Modify: `package.json` dependencies
- Modify: `pnpm-lock.yaml`
- Create: `src/renderer/chat/use-persisted-thread-history.ts`
- Modify: `src/renderer/chat/chat-view.tsx:80-225`
- Modify: `src/renderer/views/tasks/TaskDetailView.tsx`
- Modify: `src/renderer/chat/chat-transcript-panel.tsx`
- Modify: `src/renderer/chat-transcript.ts`
- Modify: `tests/renderer/features/chat-feature.test.tsx`
- Modify: `tests/renderer/chat-view.queued-task.test.ts`
- Modify: `tests/renderer/chat-transcript-panel.test.tsx`
- Create: `tests/renderer/use-persisted-thread-history.test.tsx`
- Create: `tests/renderer/chat-history-performance.test.tsx`

**Interfaces:**
- Consumes: page IPC and `latestPersistedThreadEventId` signal.
- Produces: `usePersistedThreadHistory()` state/actions and a Virtuoso transcript with stable prepend anchoring.

- [x] **Step 1: Add `react-virtuoso` as a direct dependency**

```powershell
pnpm add react-virtuoso
```

Expected: `package.json` and `pnpm-lock.yaml` change; no other dependency upgrades.

- [x] **Step 2: Write failing hook tests for initial/before/after and stale responses**

Use a deferred mock client:

```ts
expect(getThreadMessages).toHaveBeenNthCalledWith(1, {
  threadId: 'thread-a',
  limit: 100,
  cursor: null
});

await result.current.loadOlder();
expect(getThreadMessages).toHaveBeenNthCalledWith(2, {
  threadId: 'thread-a',
  limit: 100,
  cursor: { direction: 'before', sequence: 151 }
});

rerender({ threadId: 'thread-b' });
resolveThreadA(oldPage);
expect(result.current.threadId).toBe('thread-b');
expect(result.current.events).toEqual(threadBPage.items);
```

Trigger a new persisted signal and assert an `after newestSequence` request. Add explicit rejection tests for missing sequence, non-monotonic page, same sequence/different id and same id/different sequence; the hook exposes the exact error rather than clearing to empty history.

Seed 250 events after the current newest sequence and assert the hook follows `hasMoreAfter` through three `after` requests until false; one snapshot signal must not leave the last 150 events unloaded.

- [x] **Step 3: Write failing Virtuoso and 10k DOM tests**

Render `ChatTranscriptPanel` with 10,000 synthetic transcript messages in a fixed `800x600` jsdom viewport and real Virtuoso. Assert:

```ts
expect(container.querySelectorAll('[data-testid^="chat-message-"]').length).toBeLessThan(300);
```

Simulate `startReached`, prepend 100 messages, and assert the first previously visible message key remains visible. Assert the old whole-transcript `ResizeObserver` is not constructed.

- [x] **Step 4: Run Task 3 tests and verify RED**

```powershell
pnpm test -- tests/renderer/use-persisted-thread-history.test.tsx tests/renderer/chat-transcript-panel.test.tsx tests/renderer/chat-history-performance.test.tsx tests/renderer/features/chat-feature.test.tsx
```

Expected: FAIL because ChatView reloads the full array, clears errors to empty, and panel maps every message into DOM.

- [x] **Step 5: Implement page validation and merging in the hook**

Use this public result:

```ts
export type PersistedThreadHistory = {
  threadId: string | null;
  events: PersistedTaskEvent[];
  prependRevision: number;
  hasMoreBefore: boolean;
  loadingInitial: boolean;
  loadingOlder: boolean;
  error: string | null;
  loadOlder(): Promise<void>;
};
```

Increment `prependRevision` only after a validated `before` page is merged. Keep a numeric request generation ref. Every response passes `validatePersistedPage()` before state update. Merge by both id and sequence:

```ts
function mergePersistedEvents(
  current: readonly PersistedTaskEvent[],
  incoming: readonly PersistedTaskEvent[]
): PersistedTaskEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) {
    const sameId = byId.get(event.id);
    if (sameId !== undefined && sameId.sequence !== event.sequence) {
      throw new Error('task_history_event_id_sequence_conflict');
    }
    const sameSequence = bySequence.get(event.sequence);
    if (sameSequence !== undefined && sameSequence.id !== event.id) {
      throw new Error('task_history_sequence_id_conflict');
    }
    byId.set(event.id, event);
    bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}
```

Initial load uses null cursor; `loadOlder` uses oldest. A persisted signal starts an `after` loop: validate/merge the page, advance the cursor to that page's `newestSequence`, and continue while `hasMoreAfter` is true. Thread change increments generation and resets state before requesting the new tail; every iteration checks the generation before applying or issuing the next request.

- [x] **Step 6: Use the hook in chat and task detail**

Replace ChatView's `persistedMessages` effect with the hook. Build persisted transcript only when `history.events` changes; streaming token updates only append/merge live transcript. Pass hook error to the existing inline error surface rather than replacing events with `[]`.

At this batch boundary, add the explicit source field used by batch five:

```ts
export type ChatTranscriptMessage = {
  key: string;
  source: 'persisted' | 'live';
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatPersistedAttachment[];
  reasoning: string | null;
  blocks: ChatTranscriptActivityBlock[];
  interrupt: ChatPendingInterrupt | null;
  isStreaming: boolean;
};
```

All messages built from `PersistedTaskEvent[]` use `source: 'persisted'`; pending user and current `ChatRunState` messages use `source: 'live'`. Batch four does not yet change motion behavior.

TaskDetailView uses the same hook for transcript history; its metadata can continue using `detail.recentEvents`, but rendered transcript uses paged events plus live state.

- [x] **Step 7: Replace full map/ResizeObserver with Virtuoso**

Extend the panel contract explicitly:

```ts
type ChatTranscriptPanelProps = {
  threadId: string | null;
  messages: ChatTranscriptMessage[];
  liveSignal: string;
  prependRevision: number;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  loadOlder(): Promise<void>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
};
```

Use:

```tsx
const virtualIndex = useTranscriptFirstItemIndex({
  threadId,
  messageCount: messages.length,
  prependRevision
});

<Virtuoso
  customScrollParent={scrollContainerRef.current === null ? undefined : scrollContainerRef.current}
  data={messages}
  firstItemIndex={virtualIndex}
  followOutput={isAtBottom ? 'auto' : false}
  itemContent={(_index, message) => (
    <ChatMessageRow message={message} onApprovalDecision={onApprovalDecision} />
  )}
  startReached={() => {
    if (hasMoreBefore && !loadingOlder) {
      void loadOlder();
    }
  }}
/>
```

`useTranscriptFirstItemIndex()` starts at `1_000_000`, remembers the previous materialized message count, and when `prependRevision` changes decrements by the number of newly materialized message rows, not by raw event count. This preserves anchoring when many assistant events collapse into one transcript row. Move bottom-state tracking to Virtuoso `atBottomStateChange`. Use the Virtuoso handle `scrollToIndex({ index: 'LAST', behavior })` for the manual button. Remove the observer on a single giant `.chat-transcript` node and the direct `messages.map()`.

Implement the helper in `chat-transcript-panel.tsx` and reset it per thread:

```ts
function useTranscriptFirstItemIndex(input: {
  threadId: string | null;
  messageCount: number;
  prependRevision: number;
}): number {
  const state = useRef({
    threadId: input.threadId,
    index: 1_000_000,
    messageCount: input.messageCount,
    prependRevision: input.prependRevision
  });
  if (state.current.threadId !== input.threadId) {
    state.current = {
      threadId: input.threadId,
      index: 1_000_000,
      messageCount: input.messageCount,
      prependRevision: input.prependRevision
    };
  } else {
    if (state.current.prependRevision !== input.prependRevision) {
      const prependedRows = Math.max(0, input.messageCount - state.current.messageCount);
      state.current.index -= prependedRows;
      state.current.prependRevision = input.prependRevision;
    }
    state.current.messageCount = input.messageCount;
  }
  return state.current.index;
}
```

- [x] **Step 8: Add the seeded 1k/10k performance assertions**

In `chat-history-performance.test.tsx`, back the mock client with an in-memory agent DB using the real page query. Measure from hook mount to tail rows rendered:

```ts
expect(profile1000.initialPageSize).toBe(100);
expect(profile1000.interactiveMs).toBeLessThanOrEqual(750);
expect(profile10000.initialPageSize).toBe(100);
expect(profile10000.interactiveMs).toBeLessThanOrEqual(1000);
expect(profile10000.maxDomRows).toBeLessThan(300);
expect(percentile95(profile10000.prependDurationsMs)).toBeLessThanOrEqual(250);
```

Use `performance.now()` and at least 20 prepend samples. Fail with the measured values in the assertion message; do not increase thresholds in the test.

- [x] **Step 9: Run Task 3 tests and verify GREEN**

```powershell
pnpm test -- tests/renderer/use-persisted-thread-history.test.tsx tests/renderer/chat-transcript-panel.test.tsx tests/renderer/chat-history-performance.test.tsx tests/renderer/features/chat-feature.test.tsx tests/renderer/chat-view.queued-task.test.ts tests/renderer/task-detail-view.test.tsx
```

Expected: PASS; initial page is 100, stale responses are ignored, conflicts fail explicitly, prepend preserves position and DOM rows stay below 300.

### Task 4: Move Markdown, Settings and non-chat features out of the initial bundle

**Files:**
- Modify: `src/renderer/main.tsx`
- Modify: `src/renderer/chat/chat-message-row.tsx`
- Modify: `src/renderer/chat/markdown-view.tsx`
- Modify: `src/renderer/chat/streaming-markdown-view.tsx`
- Modify: `src/renderer/chat/code-block.tsx`
- Create: `src/renderer/chat/syntax-highlight.ts`
- Create: `src/renderer/styles/syntax-highlight.css`
- Modify: `src/renderer/app/AppSettingsLayer.tsx`
- Modify: `src/renderer/views/ViewContent.tsx`
- Modify: `electron.vite.config.ts`
- Create: `scripts/check-renderer-chunks.mjs`
- Modify: `package.json` scripts
- Modify: `tests/renderer/bundle-boundaries.test.ts`
- Modify: `tests/renderer/bundle-splitting.test.ts`
- Create: `tests/main/renderer-chunk-budget.test.ts`

**Interfaces:**
- Consumes: Vite dynamic imports and build manifest.
- Produces: lazy feature boundaries, language-specific highlighter loaders and `pnpm check:renderer-chunks`.

- [x] **Step 1: Write failing source-boundary and build-budget tests**

Assert no initial static imports:

```ts
expect(mainSource).not.toContain("import 'highlight.js/styles/github.css'");
expect(messageRowSource).toContain("lazy(() => import('./streaming-markdown-view')");
expect(settingsLayerSource).toContain("lazy(() => import('../features/settings')");
expect(viewContentSource).not.toContain("import { DiagnosticsFeature } from '../features/diagnostics'");
```

The chunk script test builds a fixture manifest/output and asserts failure when the static import graph is `1_500_001` bytes or any statically visited manifest key/file identifies Markdown, Streamdown, highlight or Settings; it passes at exactly `1_500_000` when those modules exist only in `dynamicImports`.

- [x] **Step 2: Run Task 4 unit tests and verify RED**

```powershell
pnpm test -- tests/renderer/bundle-boundaries.test.ts tests/renderer/bundle-splitting.test.ts tests/main/renderer-chunk-budget.test.ts
```

Expected: FAIL because Markdown/Settings/features are statically imported and no automatic budget script exists.

- [x] **Step 3: Lazy-load Markdown only when assistant content exists**

In `chat-message-row.tsx`:

```tsx
const StreamingMarkdownView = lazy(() =>
  import('./streaming-markdown-view').then((module) => ({ default: module.StreamingMarkdownView }))
);
```

Wrap only the non-empty assistant content and rich activity Markdown in the existing loading-neutral `Suspense` fallback. An empty chat renders no Markdown import request.

- [x] **Step 4: Replace global/highlight-all behavior with dynamic core languages**

Remove the global highlight CSS import and `rehype-highlight`. In `syntax-highlight.ts` import `highlight.js/lib/core` and map only these aliases/loaders: JavaScript, TypeScript, JSON, Bash, PowerShell, Python, Markdown, SQL, XML/HTML and CSS.

```ts
const languageLoaders: Record<string, () => Promise<{ default: LanguageFn }>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  js: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  ts: () => import('highlight.js/lib/languages/typescript'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  shell: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  python: () => import('highlight.js/lib/languages/python'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  sql: () => import('highlight.js/lib/languages/sql'),
  xml: () => import('highlight.js/lib/languages/xml'),
  html: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css')
};
```

`highlightCode(language, code)` returns escaped plaintext for unknown languages and never imports the full language registry. `CodeBlock` loads/highlights in an effect keyed by language/code and renders the returned HTML inside its existing `<pre>` shell. Import `syntax-highlight.css` from the dynamic highlighter module so the CSS is not initial.

- [x] **Step 5: Lazy-load Settings and all non-chat feature modules**

Keep the Settings presence owner in `AppSettingsLayer` but lazy import `SettingsFeature`; batch five will move `AnimatePresence` into this same owner. In `ViewContent.tsx`, replace static value imports for tasks, workspace, MCP, skills, memory and diagnostics with `lazy()` imports; keep type-only imports static. Chat remains the only eager feature.

- [x] **Step 6: Add the build manifest and chunk gate**

Set renderer `build.manifest = true`. `scripts/check-renderer-chunks.mjs` reads `dist/renderer/.vite/manifest.json`, finds the `isEntry` record for `src/renderer/main.tsx`, recursively traverses only `imports` (never `dynamicImports`), sums each visited JS file's `statSync().size`, and fails above `1_500_000`. It rejects any statically visited manifest key or output basename matching `/markdown|streamdown|highlight|settings/iu`, and separately verifies `dist/renderer/index.html` modulepreload entries are a subset of the same static graph.

Add:

```json
"check:renderer-chunks": "node scripts/check-renderer-chunks.mjs"
```

- [x] **Step 7: Run build and verify the real output gate**

```powershell
pnpm build
pnpm check:renderer-chunks
```

Expected: both exit code `0`; initial total is printed and is `<= 1500000`, with no forbidden modulepreload.

### Task 5: Parallelize independent loaders and aggregate process memory

**Files:**
- Modify: `src/renderer/app/data-loading.ts:33-70,158-185`
- Modify: `tests/renderer/workspace-surfaces.test.ts`
- Create: `tests/renderer/data-loading-concurrency.test.ts`
- Modify: `src/shared/types/app.ts:42-77`
- Modify: `src/main/plugins/diagnostics/performance-adapter.ts:72-158`
- Modify: `src/renderer/app/empty-states.ts`
- Modify: `src/renderer/views/diagnostics/PerformancePanel.tsx`
- Modify: `tests/main/plugins/diagnostics/performance-adapter.test.ts`
- Modify: `scripts/smoke-performance.mjs`
- Modify: `tests/smoke/performance-smoke.mjs`
- Create: `tests/smoke/performance-profile-seed.test.ts`

**Interfaces:**
- Consumes: existing independent IPC promises and Electron process metrics.
- Produces: concurrent loaders plus `totalPrivateBytesMb`, `totalWorkingSetMb`, `memoryMeasurement` and private-byte budget semantics.

- [x] **Step 1: Write failing loader start-order tests**

Use deferred promises and assert independent calls begin before either resolves:

```ts
const loading = loadWorkspaceData(workspace, {}, client);
expect(client.api.files.listTree).toHaveBeenCalledTimes(1);
expect(client.api.git.status).toHaveBeenCalledTimes(1);
expect(client.api.git.listBranches).not.toHaveBeenCalled();

resolveFileTree(fileTree);
expect(client.api.files.readPreview).toHaveBeenCalledTimes(1);
expect(client.api.git.listBranches).not.toHaveBeenCalled();

resolveGitStatus(gitStatus);
expect(client.api.git.listBranches).toHaveBeenCalledTimes(1);
await loading;
```

For operations, assert listBackgroundTasks, samplePerformance and runChecks all start synchronously; createDiagnosticPackage waits only for background task result.

- [x] **Step 2: Write failing memory aggregation tests**

```ts
expect(sample).toMatchObject({
  totalPrivateBytesMb: 420,
  totalWorkingSetMb: 510,
  memoryMeasurement: 'complete',
  exceedsBudget: false
});
```

Use a `400 MB` request and assert `exceedsBudget: true`. Set one process `privateBytesKb` undefined/null and assert `totalPrivateBytesMb: null`, `memoryMeasurement: 'private_bytes_unavailable'`, and `exceedsBudget: true` so unmeasurable samples cannot pass.

- [x] **Step 3: Run Task 5 tests and verify RED**

```powershell
pnpm test -- tests/renderer/data-loading-concurrency.test.ts tests/main/plugins/diagnostics/performance-adapter.test.ts
```

Expected: FAIL because loaders are serial and budget compares only main process RSS.

- [x] **Step 4: Start independent loader branches together**

For workspace:

```ts
const fileTreePromise = api.files.listTree({ relativePath: '' });
const gitStatusPromise = api.git.status();
const fileTree = unwrap<FileTreeResult>('file tree', await fileTreePromise);
const filePreviewPromise = loadWorkspaceFilePreview(client, fileTree, options);
const gitResult = await gitStatusPromise;
const gitBranchesPromise = gitResult.ok ? api.git.listBranches() : Promise.resolve(null);
const filePreview = await filePreviewPromise;
const pdfPreviewPromise = loadWorkspacePdfWorkbenchPreview(client, filePreview, options);
```

Continue only the true dependencies: selected diff waits for git status/selection; PDF waits for file preview. Preserve existing error messages.

For operations:

```ts
const backgroundTasksPromise = api.tasks.listBackgroundTasks();
const performancePromise = api.diagnostics.samplePerformance({ mode, memoryBudgetMb: 450 });
const checksPromise = api.diagnostics.runChecks();
const backgroundTasks = unwrap<BackgroundTask[]>('background tasks', await backgroundTasksPromise);
const diagnosticPackagePromise = backgroundTasks[0] === undefined
  ? Promise.resolve(null)
  : api.diagnostics.createDiagnosticPackage({
      taskId: backgroundTasks[0].id,
      errorSummary: '后台任务诊断请求'
    });
const [performanceResult, checksResult, packageResult] = await Promise.all([
  performancePromise,
  checksPromise,
  diagnosticPackagePromise
]);
```

- [x] **Step 5: Compute process totals once and use private bytes for the gate**

Extend `PerformanceSample`:

```ts
totalPrivateBytesMb: number | null;
totalWorkingSetMb: number;
memoryMeasurement: 'complete' | 'private_bytes_unavailable';
```

After `readElectronMetrics()`:

```ts
const totalWorkingSetMb = electron.processMetrics.reduce(
  (total, metric) => total + metric.memory.workingSetSizeMb,
  0
);
const privateValues = electron.processMetrics.map((metric) => metric.memory.privateBytesMb);
const memoryMeasurement = privateValues.some((value) => value === null)
  ? 'private_bytes_unavailable'
  : 'complete';
const totalPrivateBytesMb = memoryMeasurement === 'complete'
  ? privateValues.reduce((total, value) => {
      if (value === null) {
        throw new Error('performance_private_bytes_contract_broken');
      }
      return total + value;
    }, 0)
  : null;
const exceedsBudget = memoryMeasurement !== 'complete' || totalPrivateBytesMb > request.memoryBudgetMb;
```

Keep main `rssMb` as diagnostics only. Recompute the aggregate in `getLatestPerformanceSample()` from current Electron metrics; no silent working-set fallback.

Set the pre-load placeholder in `emptyOperationsData()` to `totalPrivateBytesMb: null`, `totalWorkingSetMb: 0`, `memoryMeasurement: 'private_bytes_unavailable'`, and `exceedsBudget: true`; the diagnostics loading state, not a fabricated zero-private measurement, represents “not sampled yet”.

- [x] **Step 6: Enforce fixed budgets in performance smoke**

Change the empty sample request to `memoryBudgetMb: 450`. Assert:

```js
if (sample.memoryMeasurement !== 'complete' || typeof sample.totalPrivateBytesMb !== 'number') {
  throw new Error('performance_private_bytes_unavailable');
}
if (sample.totalPrivateBytesMb > sample.memoryBudgetMb) {
  throw new Error(`performance_private_bytes_budget_exceeded:${sample.totalPrivateBytesMb}`);
}
const mainReadySample = sample.timing.samples.find((item) => item.phase === 'main_ready');
if (mainReadySample === undefined) {
  throw new Error('performance_main_ready_sample_missing');
}
const mainReadyMs = mainReadySample.durationMs;
if (mainReadyMs > 500 || rendererReadyMs > 2500) {
  throw new Error(`performance_ready_budget_exceeded:${mainReadyMs}:${rendererReadyMs}`);
}
```

Remove soft-warning treatment for the fixed gates; keep diagnostic output for RSS and working set.

Before rebuilding `better-sqlite3` for Electron, `scripts/smoke-performance.mjs` creates unique empty/1k/10k data roots and runs:

```powershell
$env:ROC_PERFORMANCE_PROFILE_ROOTS = $profileRootsJson
pnpm test -- tests/smoke/performance-profile-seed.test.ts
```

The seed test uses the real `DatabasePool` and schema functions to create one chat thread per non-empty root, one run, and exactly 1,000 or 10,000 monotonic `agent_events` rows. With no environment variable, the same test creates/cleans temporary roots so normal `pnpm test` remains deterministic.

After Electron ABI preparation, `performance-smoke.mjs` launches each root separately. For 1k/10k it clicks the seeded history row, measures until the latest marker is visible, samples process memory, and asserts:

```js
assertLessThanOrEqual('profile-1k-interactive-ms', profile1000.interactiveMs, 750);
assertLessThanOrEqual('profile-1k-private-mb', profile1000.sample.totalPrivateBytesMb, 500);
assertLessThanOrEqual('profile-10k-interactive-ms', profile10000.interactiveMs, 1000);
if (profile10000.domMessageRows >= 300) {
  throw new Error(`profile_10k_dom_rows_exceeded:${profile10000.domMessageRows}`);
}
```

The 10k Playwright flow also scrolls to the top for at least 20 page prepends and records p95 `<= 250 ms`, complementing the jsdom/Virtuoso test with a real Electron renderer measurement. All roots are removed in the smoke `finally` block after the Electron app exits; the wrapper restores Node ABI afterward.

- [x] **Step 7: Run Task 5 tests and verify GREEN**

```powershell
pnpm test -- tests/renderer/data-loading-concurrency.test.ts tests/renderer/workspace-surfaces.test.ts tests/main/plugins/diagnostics/performance-adapter.test.ts tests/smoke/performance-profile-seed.test.ts
```

Expected: PASS; independent promises start together and private-byte absence cannot pass budget evaluation.

### Task 6: Generate IPC, review, verify, and commit the renderer performance batch

**Files:**
- Modify generated: `src/shared/ipc-schema.json`
- Modify generated: `src/shared/ipc-generated.ts`
- Review: all files changed in Tasks 1-5

**Interfaces:**
- Consumes: final history page and PerformanceSample contracts.
- Produces: synchronized IPC, built chunk gate, performance smoke and one reviewed commit.

- [x] **Step 1: Generate and check IPC**

```powershell
pnpm generate:ipc
pnpm check:ipc
```

Expected: both exit code `0`; task history returns a page and performance sample includes aggregate fields.

- [x] **Step 2: Run the complete renderer performance focused suite**

```powershell
pnpm test -- tests/renderer/task-run-event-filter.test.ts tests/renderer/app-shell.test.tsx tests/main/plugins/task/plugin-thread-history.test.ts tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/database-migrations.test.ts tests/main/ipc-plugin-adapter.test.ts tests/main/ipc-schema-generation.test.ts tests/renderer/use-persisted-thread-history.test.tsx tests/renderer/chat-transcript-panel.test.tsx tests/renderer/chat-history-performance.test.tsx tests/renderer/features/chat-feature.test.tsx tests/renderer/chat-view.queued-task.test.ts tests/renderer/task-detail-view.test.tsx tests/renderer/bundle-boundaries.test.ts tests/renderer/bundle-splitting.test.ts tests/main/renderer-chunk-budget.test.ts tests/renderer/data-loading-concurrency.test.ts tests/renderer/workspace-surfaces.test.ts tests/main/plugins/diagnostics/performance-adapter.test.ts tests/smoke/performance-profile-seed.test.ts
```

Expected: PASS.

- [x] **Step 3: Review the current diff before committing**

```powershell
git diff -- src/main src/preload src/renderer src/shared scripts tests package.json pnpm-lock.yaml electron.vite.config.ts
```

Review in this order:

1. Critical: sequence page can skip/duplicate events, old thread responses can overwrite new state, or live/persisted effects remount/replay.
2. High: AppShell still applies ordinary chat events or removes task run id before terminal state is applied.
3. High: SQL uses a temp sort/full history, limit can exceed 200, or missing sequence is silently normalized.
4. High: Virtuoso can render all 10k rows, prepend loses scroll anchor, or live rows disappear outside virtualization.
5. High: initial preload contains Markdown/Settings/highlight, or chunk script measures compressed/log output instead of real files.
6. High: private bytes unavailable can pass, budget still uses RSS/working set, or fixed smoke thresholds became warnings.
7. Medium: loader parallelization violates a real dependency or changes existing error output.

Record findings with file and line. Fix every finding and rerun its direct test. If none exist, record `未发现问题` and note that performance thresholds remain hardware-sensitive but are fixed by the approved spec.

- [x] **Step 4: Run final batch verification**

```powershell
pnpm typecheck
pnpm check:ipc
pnpm build
pnpm check:renderer-chunks
pnpm smoke:performance
git diff --check
```

Expected: every command exit code `0`; performance smoke reports complete private-byte measurement and passes empty、1k、10k fixed budgets, DOM cap and prepend p95.

- [x] **Step 5: Commit only the reviewed renderer performance batch**

```powershell
$batchFiles = @(
  'package.json'
  'pnpm-lock.yaml'
  'electron.vite.config.ts'
  'scripts/check-renderer-chunks.mjs'
  'scripts/smoke-performance.mjs'
  'src/main/infrastructure/database-schemas.ts'
  'src/main/ipc/plugin-capability-adapter.ts'
  'src/main/plugins/diagnostics/performance-adapter.ts'
  'src/main/plugins/task/agent-task-history.ts'
  'src/main/plugins/task/contracts.ts'
  'src/main/plugins/task/index.ts'
  'src/main/plugins/task/task-repository.ts'
  'src/renderer/app/AppSettingsLayer.tsx'
  'src/renderer/app/AppShell.tsx'
  'src/renderer/app/data-loading.ts'
  'src/renderer/app/empty-states.ts'
  'src/renderer/app/task-run-event-filter.ts'
  'src/renderer/chat-transcript.ts'
  'src/renderer/chat/chat-message-row.tsx'
  'src/renderer/chat/chat-transcript-panel.tsx'
  'src/renderer/chat/chat-view.tsx'
  'src/renderer/chat/code-block.tsx'
  'src/renderer/chat/markdown-view.tsx'
  'src/renderer/chat/streaming-markdown-view.tsx'
  'src/renderer/chat/syntax-highlight.ts'
  'src/renderer/chat/use-persisted-thread-history.ts'
  'src/renderer/main.tsx'
  'src/renderer/styles/syntax-highlight.css'
  'src/renderer/views/diagnostics/PerformancePanel.tsx'
  'src/renderer/views/tasks/TaskDetailView.tsx'
  'src/renderer/views/ViewContent.tsx'
  'src/shared/ipc.ts'
  'src/shared/ipc-schema.json'
  'src/shared/ipc-generated.ts'
  'src/shared/types/app.ts'
  'src/shared/types/task.ts'
  'tests/main/infrastructure/database-migrations.test.ts'
  'tests/main/infrastructure/database-schemas.test.ts'
  'tests/main/ipc-plugin-adapter.test.ts'
  'tests/main/plugins/diagnostics/performance-adapter.test.ts'
  'tests/main/plugins/task/plugin-thread-history.test.ts'
  'tests/main/renderer-chunk-budget.test.ts'
  'tests/renderer/app-shell.test.tsx'
  'tests/renderer/bundle-boundaries.test.ts'
  'tests/renderer/bundle-splitting.test.ts'
  'tests/renderer/chat-history-performance.test.tsx'
  'tests/renderer/chat-transcript-panel.test.tsx'
  'tests/renderer/chat-view.queued-task.test.ts'
  'tests/renderer/data-loading-concurrency.test.ts'
  'tests/renderer/features/chat-feature.test.tsx'
  'tests/renderer/task-detail-view.test.tsx'
  'tests/renderer/task-run-event-filter.test.ts'
  'tests/renderer/use-persisted-thread-history.test.tsx'
  'tests/renderer/workspace-surfaces.test.ts'
  'tests/smoke/performance-profile-seed.test.ts'
  'tests/smoke/performance-smoke.mjs'
)
git add -- $batchFiles
git diff --cached --check
git commit -m "perf: bound renderer history and startup cost"
```

Expected: commit succeeds and `git status --short` contains no renderer-performance leftovers.
