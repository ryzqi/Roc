# DeepAgents Production Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Roc recover from transient provider `Connection error` failures without losing DeepAgents state, disconnecting the renderer, or repeating completed side effects.

**Architecture:** Keep one `AgentPluginRuntime` path for chat, task detail, and scheduled background task runs. Replace in-memory graph checkpointing with a Roc SQLite checkpointer, add runtime recovery around `agent.streamEvents()`, persist sequenced run events, and make side-effecting tool adapters idempotent before retries can replay from checkpoints.

**Tech Stack:** TypeScript ESM, Electron main/preload/renderer boundaries, React 19, Vitest, `better-sqlite3`, `deepagents@1.10.5`, `@langchain/langgraph@1.4.7`.

## Global Constraints

- User-facing replies and documentation comments are Simplified Chinese unless the file already has a stronger local convention.
- Use DeepAgents/LangGraph native checkpoint and resume semantics; do not rebuild a full prompt and rerun from scratch.
- Keep `thread_id` equal to `TaskRun.threadId` and `run_id` equal to `TaskRun.id`.
- Recover only `provider_network_error`, `provider_request_timeout`, HTTP `408`, `425`, `429`, and `5xx`.
- Do not recover schema, permission, tool contract, cancellation, or user-decision errors.
- Recovery budget is five attempts per run and ten minutes maximum wall-clock time.
- Renderer reload must not cancel main-process runs.
- Background task recovery must preserve saved `workspacePath`, capabilities, MCP servers, skills, memory, and shell cwd semantics.
- `/workspace/` remains a DeepAgents virtual file-tool path; shell execution uses real Windows cwd/workspace paths.
- No prompt-only fixes, compatibility aliases, hidden fallback agents, or second agent runtime.
- SQLite writes that order checkpoint, run events, and tool effects must be transactional.
- Modify `src/shared/ipc.ts` only with `pnpm generate:ipc`, then verify with `pnpm check:ipc`.

---

## File Structure

- Create `src/main/services/deep-agent/sqlite-checkpointer.ts`: Roc-owned LangGraph checkpoint saver backed by `better-sqlite3`.
- Create `tests/main/services/deep-agent/sqlite-checkpointer.test.ts`: persistence and reload coverage for checkpoint `thread_id`.
- Create `src/main/plugins/agent/recovery-policy.ts`: transient failure classification, bounded backoff, and recovery budget decisions.
- Create `tests/main/plugins/agent/recovery-policy.test.ts`: recovery classification and budget tests.
- Create `src/main/plugins/agent/run-event-log.ts`: per-run sequenced `ChatRunEvent` persistence and replay.
- Create `tests/main/plugins/agent/run-event-log.test.ts`: sequence, replay, and dedupe-contract tests.
- Create `src/main/services/deep-agent/tool-effect-store.ts`: idempotency store for side-effecting tool calls.
- Create `tests/main/services/deep-agent/tool-effect-store.test.ts`: reuse, in-progress conflict, and input drift tests.
- Modify `src/main/plugins/agent/schema.ts`: add idempotent tables for checkpoints, run event log, tool effects, and recovery attempts.
- Modify `src/main/services/memory/sqlite-store.ts`: keep Store schema separate; no behavior change unless checkpoint tests prove reusable helpers are needed.
- Modify `src/main/plugins/agent/deep-agent-executor.ts`: inject durable checkpointer, support checkpoint resume, and wrap side-effecting tools.
- Modify `src/main/plugins/agent/runtime.ts`: add recovery state machine, replay persistence, active run lookup, and final failure after exhaustion.
- Modify `src/main/plugins/agent/session-repository.ts`: expose recovery attempt metadata and event replay helpers through focused repository methods.
- Modify `src/main/plugins/agent/index.ts`: wire stores into runtime and add capability descriptors for replay/active-run IPC.
- Modify `src/shared/types/chat.ts`: add `run_recovering`, `run_recovered`, sequenced event envelope types, and replay request/result types.
- Modify `src/shared/ipc.ts`: expose `chat.getRunEvents()` and `chat.getActiveRun()`.
- Modify `src/preload/index.ts`: bridge replay IPC methods.
- Modify `src/main/ipc/register-ipc.ts`: register new chat replay handlers if handlers are declared there after IPC generation.
- Modify `src/renderer/chat-run-state.ts`: add `recovering` status and reducers for recovery events.
- Modify `src/renderer/chat/use-chat-run.ts`: replay persisted events before subscribing live, dedupe by `runId + sequence`, and keep partial text during recovery.
- Modify `tests/main/plugins/agent/runtime.test.ts`: runtime recovery and exhaustion coverage.
- Modify `tests/main/plugins/agent/deep-agent-executor.test.ts`: durable checkpointer wiring and resume shape coverage.
- Modify `tests/main/plugins/agent/deep-agent-executor-streaming.test.ts`: partial text plus transient stream failure recovery.
- Modify `tests/main/deep-agent-error-mapping.test.ts`: prove transient and non-transient failure codes.
- Modify `tests/renderer/use-chat-run.test.ts`: replay, dedupe, and recovery state coverage.
- Modify `tests/main/plugins/task/plugin-background-runs.test.ts`: scheduled background run recovery preserves workspace/capability snapshot.

---

### Task 1: Verify DeepAgents Resume Contract And Add Durable Checkpointer

**Files:**
- Create: `src/main/services/deep-agent/sqlite-checkpointer.ts`
- Create: `tests/main/services/deep-agent/sqlite-checkpointer.test.ts`
- Modify: `src/main/plugins/agent/schema.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor.test.ts`

**Interfaces:**
- Produces: `class RocSqliteCheckpointer` with constructor `(db: DatabaseConnection)`.
- Produces: `applyAgentRecoverySchema(db: DatabaseConnection): void`.
- Consumes: `buildDeepAgent({ checkpointer })` already accepts the checkpointer object.
- Consumes in following tasks: runtime retry reuses the same `thread_id` and `run_id`; executor must not allocate a new checkpointer per run.

- [ ] **Step 1: Write the failing checkpointer persistence test**

Add this test to `tests/main/services/deep-agent/sqlite-checkpointer.test.ts`:

```ts
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RocSqliteCheckpointer } from '../../../../src/main/services/deep-agent/sqlite-checkpointer';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

describe('RocSqliteCheckpointer', () => {
  it('persists checkpoint data so another instance can read the same thread state', async () => {
    const first = new RocSqliteCheckpointer(db);
    const config = {
      configurable: {
        thread_id: 'thread_recovery_1',
        checkpoint_ns: '',
        checkpoint_id: 'checkpoint_1'
      }
    };
    const checkpoint = {
      v: 1,
      id: 'checkpoint_1',
      ts: '2026-07-03T00:00:00.000Z',
      channel_values: { messages: ['partial'] },
      channel_versions: { messages: 1 },
      versions_seen: {},
      pending_sends: []
    };

    await first.put(config, checkpoint, { source: 'test', step: 1, writes: null, parents: {} }, {});

    const second = new RocSqliteCheckpointer(db);
    const loaded = await second.getTuple({
      configurable: {
        thread_id: 'thread_recovery_1',
        checkpoint_ns: '',
        checkpoint_id: 'checkpoint_1'
      }
    });

    expect(loaded?.checkpoint).toEqual(checkpoint);
    expect(loaded?.config.configurable.thread_id).toBe('thread_recovery_1');
  });
});
```

- [ ] **Step 2: Run the failing checkpointer test**

Run: `pnpm test -- tests/main/services/deep-agent/sqlite-checkpointer.test.ts`

Expected: FAIL because `sqlite-checkpointer.ts` does not exist.

- [ ] **Step 3: Add checkpoint schema**

Add `applyAgentRecoverySchema(db)` to `src/main/plugins/agent/schema.ts` and call it from `applyAgentPluginSchema(db)` after the existing `db.exec()` blocks:

```ts
function applyAgentRecoverySchema(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      checkpoint_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    );

    CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_thread_created
      ON langgraph_checkpoints(thread_id, checkpoint_ns, created_at DESC);

    CREATE TABLE IF NOT EXISTS langgraph_checkpoint_writes (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      channel TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
    );
  `);
}
```

- [ ] **Step 4: Implement `RocSqliteCheckpointer`**

Implement `src/main/services/deep-agent/sqlite-checkpointer.ts` by extending the actual LangGraph saver interface exported by `@langchain/langgraph-checkpoint`. If the package version exposes `BaseCheckpointSaver`, use this class shape:

```ts
import type { RunnableConfig } from '@langchain/core/runnables';
import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { Checkpoint, CheckpointMetadata, CheckpointTuple, PendingWrite } from '@langchain/langgraph-checkpoint';
import type { Database as DatabaseConnection } from 'better-sqlite3';

type CheckpointRow = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint_json: string;
  metadata_json: string;
  created_at: string;
};

export class RocSqliteCheckpointer extends BaseCheckpointSaver {
  constructor(private readonly db: DatabaseConnection) {
    super();
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const key = readCheckpointKey(config);
    const row = this.db
      .prepare(
        `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_json, metadata_json, created_at
         FROM langgraph_checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
      )
      .get(key.threadId, key.checkpointNs, key.checkpointId) as CheckpointRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return rowToTuple(row);
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, unknown>
  ): Promise<RunnableConfig> {
    const key = readCheckpointKey(config);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO langgraph_checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_json, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
           parent_checkpoint_id = excluded.parent_checkpoint_id,
           checkpoint_json = excluded.checkpoint_json,
           metadata_json = excluded.metadata_json`
      )
      .run(
        key.threadId,
        key.checkpointNs,
        key.checkpointId,
        key.parentCheckpointId,
        JSON.stringify(checkpoint),
        JSON.stringify(metadata),
        now
      );
    return {
      configurable: {
        thread_id: key.threadId,
        checkpoint_ns: key.checkpointNs,
        checkpoint_id: key.checkpointId
      }
    };
  }

  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const key = readCheckpointKey(config);
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO langgraph_checkpoint_writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO UPDATE SET
         channel = excluded.channel,
         value_json = excluded.value_json`
    );
    this.db.transaction(() => {
      writes.forEach((write, index) => {
        const [channel, value] = write;
        insert.run(key.threadId, key.checkpointNs, key.checkpointId, taskId, index, channel, JSON.stringify(value), now);
      });
    })();
  }
}
```

Also add helpers in the same file:

```ts
function readCheckpointKey(config: RunnableConfig): {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId: string | null;
} {
  const configurable = config.configurable;
  if (configurable === undefined) {
    throw new Error('agent_checkpoint_config_missing');
  }
  const threadId = readString(configurable.thread_id, 'agent_checkpoint_thread_id_missing');
  const checkpointNs = typeof configurable.checkpoint_ns === 'string' ? configurable.checkpoint_ns : '';
  const checkpointId = readString(configurable.checkpoint_id, 'agent_checkpoint_id_missing');
  const parentCheckpointId =
    typeof configurable.parent_checkpoint_id === 'string' && configurable.parent_checkpoint_id.length > 0
      ? configurable.parent_checkpoint_id
      : null;
  return { threadId, checkpointNs, checkpointId, parentCheckpointId };
}

function readString(value: unknown, code: string): string {
  if (typeof value !== 'string') {
    throw new Error(code);
  }
  if (value.length === 0) {
    throw new Error(code);
  }
  return value;
}

function rowToTuple(row: CheckpointRow): CheckpointTuple {
  return {
    config: {
      configurable: {
        thread_id: row.thread_id,
        checkpoint_ns: row.checkpoint_ns,
        checkpoint_id: row.checkpoint_id
      }
    },
    checkpoint: JSON.parse(row.checkpoint_json) as Checkpoint,
    metadata: JSON.parse(row.metadata_json) as CheckpointMetadata,
    parentConfig:
      row.parent_checkpoint_id === null
        ? undefined
        : {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id
            }
          },
    pendingWrites: []
  };
}
```

- [ ] **Step 5: Replace executor-local `MemorySaver`**

Modify `src/main/plugins/agent/deep-agent-executor.ts`:

```ts
-import { Command, MemorySaver } from '@langchain/langgraph';
+import { Command } from '@langchain/langgraph';
...
 export type AgentDeepAgentExecutorOptions = {
   capabilities: RocCapabilityRegistry;
+  checkpointer: unknown;
   getMemorySettings?: () => AppSettings['memory'];
...
 export function createAgentDeepAgentExecutor(options: AgentDeepAgentExecutorOptions): AgentDeepAgentExecutor {
-  const checkpointer = new MemorySaver();
   return {
...
-        checkpointer,
+        checkpointer: options.checkpointer,
```

Modify `src/main/plugins/agent/index.ts` inside `resolveDeepAgentExecutor()`:

```ts
const coreDb = context.database.getCoreConnection();
return createAgentDeepAgentExecutor({
  capabilities: context.capabilities,
  checkpointer: new RocSqliteCheckpointer(coreDb),
  getMemorySettings: option.getMemorySettings,
  hookRuntime: option.hookRuntime,
  paths: option.paths,
  store: new RocSqliteStore(coreDb)
});
```

- [ ] **Step 6: Verify**

Run: `pnpm test -- tests/main/services/deep-agent/sqlite-checkpointer.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

Run: `git add src/main/services/deep-agent/sqlite-checkpointer.ts src/main/plugins/agent/schema.ts src/main/plugins/agent/deep-agent-executor.ts src/main/plugins/agent/index.ts tests/main/services/deep-agent/sqlite-checkpointer.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts; git commit -m "feat: persist deepagents checkpoints"`

---

### Task 2: Add Recovery Policy And Structured Runtime Recovery Events

**Files:**
- Create: `src/main/plugins/agent/recovery-policy.ts`
- Create: `tests/main/plugins/agent/recovery-policy.test.ts`
- Modify: `src/shared/types/chat.ts`
- Modify: `src/main/plugins/agent/runtime.ts`
- Modify: `tests/main/plugins/agent/runtime.test.ts`
- Modify: `tests/main/deep-agent-error-mapping.test.ts`

**Interfaces:**
- Produces: `toRecoveryDecision(input): RecoveryDecision`.
- Produces: `ChatRunEvent` variants `run_recovering` and `run_recovered`.
- Consumes: `toRunFailure(error)` from `src/main/services/deep-agent/error-mapping.ts`.

- [ ] **Step 1: Write recovery policy tests**

Add `tests/main/plugins/agent/recovery-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { toRecoveryDecision } from '../../../../src/main/plugins/agent/recovery-policy';

describe('toRecoveryDecision', () => {
  it('recovers provider network errors inside the attempt and wall-clock budget', () => {
    expect(
      toRecoveryDecision({
        failure: { code: 'provider_network_error', message: 'Connection error.', retryable: true },
        attempt: 1,
        firstFailureAtMs: 1000,
        nowMs: 1100
      })
    ).toMatchObject({ action: 'recover', attempt: 1 });
  });

  it('does not recover schema errors even when retryable is true', () => {
    expect(
      toRecoveryDecision({
        failure: { code: 'tool_input_schema_invalid', message: 'bad schema', retryable: true },
        attempt: 1,
        firstFailureAtMs: 1000,
        nowMs: 1100
      })
    ).toEqual({ action: 'fail', reason: 'non_transient' });
  });

  it('exhausts after five attempts', () => {
    expect(
      toRecoveryDecision({
        failure: { code: 'provider_request_timeout', message: 'timeout', retryable: true },
        attempt: 6,
        firstFailureAtMs: 1000,
        nowMs: 2000
      })
    ).toEqual({ action: 'fail', reason: 'attempts_exhausted' });
  });

  it('exhausts after ten minutes', () => {
    expect(
      toRecoveryDecision({
        failure: { code: 'provider_network_error', message: 'Connection error.', retryable: true },
        attempt: 2,
        firstFailureAtMs: 1000,
        nowMs: 601001
      })
    ).toEqual({ action: 'fail', reason: 'time_exhausted' });
  });
});
```

- [ ] **Step 2: Run the failing policy test**

Run: `pnpm test -- tests/main/plugins/agent/recovery-policy.test.ts`

Expected: FAIL because `recovery-policy.ts` does not exist.

- [ ] **Step 3: Implement recovery policy**

Create `src/main/plugins/agent/recovery-policy.ts`:

```ts
import type { RunFailure } from '../../services/deep-agent/types';

const recoverableCodes = new Set(['provider_network_error', 'provider_request_timeout', 'provider_http_error']);
const recoverableHttpStatuses = new Set([408, 425, 429]);
const maxAttempts = 5;
const maxRecoveryMs = 10 * 60 * 1000;

export type RecoveryDecision =
  | { action: 'recover'; attempt: number; delayMs: number }
  | { action: 'fail'; reason: 'non_transient' | 'attempts_exhausted' | 'time_exhausted' };

export function toRecoveryDecision(input: {
  failure: RunFailure;
  attempt: number;
  firstFailureAtMs: number;
  nowMs: number;
}): RecoveryDecision {
  if (!isRecoverableFailure(input.failure)) {
    return { action: 'fail', reason: 'non_transient' };
  }
  if (input.attempt > maxAttempts) {
    return { action: 'fail', reason: 'attempts_exhausted' };
  }
  if (input.nowMs - input.firstFailureAtMs > maxRecoveryMs) {
    return { action: 'fail', reason: 'time_exhausted' };
  }
  return {
    action: 'recover',
    attempt: input.attempt,
    delayMs: calculateBackoffMs(input.attempt)
  };
}

export function isRecoverableFailure(failure: RunFailure): boolean {
  if (!failure.retryable) {
    return false;
  }
  if (!recoverableCodes.has(failure.code)) {
    return false;
  }
  if (failure.code !== 'provider_http_error') {
    return true;
  }
  const match = /\bHTTP\s+(\d{3})\b/u.exec(failure.message);
  if (match === null) {
    return false;
  }
  const status = Number(match[1]);
  if (recoverableHttpStatuses.has(status)) {
    return true;
  }
  return status >= 500;
}

function calculateBackoffMs(attempt: number): number {
  const baseMs = 500;
  const capped = Math.min(8000, baseMs * 2 ** Math.max(0, attempt - 1));
  return capped + Math.floor(capped * 0.2);
}
```

- [ ] **Step 4: Add recovery event types**

Modify `src/shared/types/chat.ts` inside `ChatRunEvent`:

```ts
  | {
      type: 'run_recovering';
      runId: string;
      threadId: string | null;
      code: string;
      message: string;
      attempt: number;
      nextRetryAt: string;
    }
  | {
      type: 'run_recovered';
      runId: string;
      threadId: string | null;
      attempt: number;
      recoveredAt: string;
    }
```

- [ ] **Step 5: Add runtime recovery loop**

Modify `executeRun()` in `src/main/plugins/agent/runtime.ts` so execution happens through a loop:

```ts
let attempt = 0;
let firstFailureAtMs: number | null = null;
while (this.activeRuns.has(input.runId)) {
  try {
    const execution = await this.executeDeepAgentRun({ ... });
    if (attempt > 0) {
      await this.publishChatRunEvent({
        type: 'run_recovered',
        runId: input.runId,
        threadId: input.threadId,
        attempt,
        recoveredAt: new Date().toISOString()
      });
    }
    ...
    return;
  } catch (error) {
    const failure = toRunFailure(error);
    attempt += 1;
    const nowMs = Date.now();
    if (firstFailureAtMs === null) {
      firstFailureAtMs = nowMs;
    }
    const decision = toRecoveryDecision({ failure, attempt, firstFailureAtMs, nowMs });
    if (decision.action === 'recover') {
      const nextRetryAt = new Date(nowMs + decision.delayMs).toISOString();
      this.options.repository.updateRunStatus({ runId: input.runId, status: 'running' });
      await this.publish('agent.run.recovery.started', {
        runId: input.runId,
        threadId: input.threadId,
        providerId: input.providerId,
        modelId: input.modelId,
        errorCode: failure.code,
        attempt
      });
      await this.publishChatRunEvent({
        type: 'run_recovering',
        runId: input.runId,
        threadId: input.threadId,
        code: failure.code,
        message: failure.message,
        attempt,
        nextRetryAt
      });
      await waitForRecoveryDelay(decision.delayMs, input.abortSignal);
      continue;
    }
    await this.failRun({ input, failure });
    return;
  }
}
```

Add helper in `runtime.ts`:

```ts
function waitForRecoveryDelay(delayMs: number, abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted) {
    throw new Error('chat_run_cancelled');
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    abortSignal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('chat_run_cancelled'));
      },
      { once: true }
    );
  });
}
```

- [ ] **Step 6: Extract final failure emission**

In `runtime.ts`, replace the current catch block with a `failRun()` private method that uses `toRunFailure(error)` fields:

```ts
private async failRun(input: { input: ExecuteRunInput; failure: RunFailure }): Promise<void> {
  this.activeRuns.delete(input.input.runId);
  this.activeRunMetadata.delete(input.input.runId);
  this.abortControllers.delete(input.input.runId);
  this.pendingInterrupts.delete(input.input.runId);
  this.options.repository.updateRunStatus({
    endedAt: new Date().toISOString(),
    runId: input.input.runId,
    status: 'failed'
  });
  await this.emitSessionEndBestEffort({
    runId: input.input.runId,
    threadId: input.input.threadId,
    request: input.input.request,
    status: 'failed',
    error: input.failure.message
  });
  await this.publish('agent.run.failed', {
    runId: input.input.runId,
    threadId: input.input.threadId,
    providerId: input.input.providerId,
    modelId: input.input.modelId,
    error: input.failure.message,
    code: input.failure.code,
    retryable: input.failure.retryable
  });
  await this.publishChatRunEvent({
    type: 'run_failed',
    runId: input.input.runId,
    threadId: input.input.threadId,
    code: input.failure.code,
    diagnostic: input.failure.diagnostic,
    message: input.failure.message,
    retryable: input.failure.retryable,
    suggestion: input.failure.suggestion
  });
}
```

- [ ] **Step 7: Verify runtime recovery**

Run: `pnpm test -- tests/main/plugins/agent/recovery-policy.test.ts tests/main/plugins/agent/runtime.test.ts tests/main/deep-agent-error-mapping.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

Run: `git add src/main/plugins/agent/recovery-policy.ts src/main/plugins/agent/runtime.ts src/shared/types/chat.ts tests/main/plugins/agent/recovery-policy.test.ts tests/main/plugins/agent/runtime.test.ts tests/main/deep-agent-error-mapping.test.ts; git commit -m "feat: recover transient agent run failures"`

---

### Task 3: Persist And Replay Sequenced Chat Run Events

**Files:**
- Create: `src/main/plugins/agent/run-event-log.ts`
- Create: `tests/main/plugins/agent/run-event-log.test.ts`
- Modify: `src/main/plugins/agent/schema.ts`
- Modify: `src/main/plugins/agent/runtime.ts`
- Modify: `src/main/plugins/agent/index.ts`
- Modify: `src/shared/types/chat.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `tests/main/plugins/agent/plugin.test.ts`

**Interfaces:**
- Produces: `recordRunEvent(event: ChatRunEvent): SequencedChatRunEvent`.
- Produces: `listRunEvents({ runId, afterSequence }): SequencedChatRunEvent[]`.
- Produces: `getActiveRun({ threadId }): ActiveChatRun | null`.
- Consumes: renderer applies `SequencedChatRunEvent.event` through the existing reducer.

- [ ] **Step 1: Write event log test**

Add `tests/main/plugins/agent/run-event-log.test.ts`:

```ts
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentRunEventLog } from '../../../../src/main/plugins/agent/run-event-log';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentPluginSchema(db);
});

afterEach(() => {
  db.close();
});

describe('AgentRunEventLog', () => {
  it('assigns increasing per-run sequence numbers and replays after a sequence', () => {
    const log = new AgentRunEventLog(db);
    const first = log.recordRunEvent({
      type: 'run_started',
      runId: 'run_1',
      mode: 'chat',
      threadId: 'thread_1',
      providerId: 'openai',
      modelId: 'openai:gpt-4.1',
      createdAt: '2026-07-03T00:00:00.000Z'
    });
    const second = log.recordRunEvent({
      type: 'assistant_block',
      runId: 'run_1',
      block: {
        kind: 'text',
        blockId: 'text-run_1',
        phase: 'delta',
        text: 'partial'
      }
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(log.listRunEvents({ runId: 'run_1', afterSequence: 1 })).toEqual([second]);
  });
});
```

- [ ] **Step 2: Add schema and implementation**

Add table to `applyAgentRecoverySchema(db)`:

```sql
CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_sequence
  ON agent_run_events(run_id, sequence);
```

Create `src/main/plugins/agent/run-event-log.ts`:

```ts
import type { Database as DatabaseConnection } from 'better-sqlite3';

import type { ChatRunEvent, SequencedChatRunEvent } from '../../../shared/types';

type EventRow = {
  run_id: string;
  sequence: number;
  event_json: string;
  created_at: string;
};

export class AgentRunEventLog {
  constructor(private readonly db: DatabaseConnection) {}

  recordRunEvent(event: ChatRunEvent): SequencedChatRunEvent {
    const nextSequence = this.nextSequence(event.runId);
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_run_events (run_id, sequence, event_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(event.runId, nextSequence, JSON.stringify(event), createdAt);
    return { runId: event.runId, sequence: nextSequence, event, createdAt };
  }

  listRunEvents(input: { runId: string; afterSequence: number }): SequencedChatRunEvent[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, sequence, event_json, created_at
         FROM agent_run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence ASC`
      )
      .all(input.runId, input.afterSequence) as EventRow[];
    return rows.map(rowToSequencedEvent);
  }

  private nextSequence(runId: string): number {
    const row = this.db
      .prepare('SELECT MAX(sequence) AS max_sequence FROM agent_run_events WHERE run_id = ?')
      .get(runId) as { max_sequence: number | null } | undefined;
    if (row === undefined) {
      return 1;
    }
    if (row.max_sequence === null) {
      return 1;
    }
    return row.max_sequence + 1;
  }
}

function rowToSequencedEvent(row: EventRow): SequencedChatRunEvent {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    event: JSON.parse(row.event_json) as ChatRunEvent,
    createdAt: row.created_at
  };
}
```

- [ ] **Step 3: Add shared types**

Add to `src/shared/types/chat.ts`:

```ts
export type SequencedChatRunEvent = {
  runId: string;
  sequence: number;
  event: ChatRunEvent;
  createdAt: string;
};

export type ChatRunEventsReplayRequest = {
  runId: string;
  afterSequence: number;
};

export type ChatRunEventsReplayResult = {
  runId: string;
  events: SequencedChatRunEvent[];
};

export type ActiveChatRun = {
  runId: string;
  threadId: string;
  status: 'running' | 'recovering' | 'waiting_user';
};
```

- [ ] **Step 4: Persist before publishing live events**

Inject `AgentRunEventLog` into `AgentPluginRuntimeOptions` and change `publishChatRunEvent()`:

```ts
private async publishChatRunEvent(payload: ChatRunEvent): Promise<void> {
  const sequenced = this.options.runEventLog.recordRunEvent(payload);
  await this.publish(agentChatRunEventType, sequenced);
}
```

Keep the event bus payload as `SequencedChatRunEvent`. Update tests to read `payload.event` when needed.

- [ ] **Step 5: Add IPC contract**

Modify `src/shared/ipc.ts` chat section:

```ts
getRunEvents: (request: ChatRunEventsReplayRequest) => Promise<IpcResult<ChatRunEventsReplayResult>>;
getActiveRun: (request: { threadId: string }) => Promise<IpcResult<ActiveChatRun | null>>;
onRunEvent: (callback: (event: SequencedChatRunEvent) => void) => () => void;
```

Modify `src/preload/index.ts` chat bridge:

```ts
getRunEvents: (request) => ipcRenderer.invoke(ipcChannels.chatGetRunEvents, request),
getActiveRun: (request) => ipcRenderer.invoke(ipcChannels.chatGetActiveRun, request),
```

- [ ] **Step 6: Generate and verify IPC**

Run: `pnpm generate:ipc`

Expected: `src/shared/ipc-generated.ts` and `src/shared/ipc-schema.json` update with `chatGetRunEvents` and `chatGetActiveRun`.

Run: `pnpm check:ipc`

Expected: PASS.

- [ ] **Step 7: Verify**

Run: `pnpm test -- tests/main/plugins/agent/run-event-log.test.ts tests/main/plugins/agent/plugin.test.ts tests/main/plugins/agent/runtime.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

Run: `git add src/main/plugins/agent/run-event-log.ts src/main/plugins/agent/schema.ts src/main/plugins/agent/runtime.ts src/main/plugins/agent/index.ts src/shared/types/chat.ts src/shared/ipc.ts src/shared/ipc-generated.ts src/shared/ipc-schema.json src/preload/index.ts tests/main/plugins/agent/run-event-log.test.ts tests/main/plugins/agent/plugin.test.ts tests/main/plugins/agent/runtime.test.ts; git commit -m "feat: replay sequenced agent run events"`

---

### Task 4: Add Renderer Replay, Dedupe, And Recovery State

**Files:**
- Modify: `src/renderer/chat-run-state.ts`
- Modify: `src/renderer/chat/use-chat-run.ts`
- Modify: `tests/renderer/chat-run-state.test.ts`
- Modify: `tests/renderer/use-chat-run.test.ts`

**Interfaces:**
- Consumes: `SequencedChatRunEvent` from preload.
- Produces: `ChatRunState.status` includes `recovering`.
- Produces: `useChatRun()` dedupes by `runId + sequence`.

- [ ] **Step 1: Write reducer tests**

Add cases to `tests/renderer/chat-run-state.test.ts`:

```ts
it('keeps partial assistant text while recovering and returns to running after recovered', () => {
  let state = applyChatRunEvent(createEmptyChatRunState(), {
    type: 'run_started',
    runId: 'run_1',
    mode: 'chat',
    threadId: 'thread_1',
    providerId: 'openai',
    modelId: 'openai:gpt-4.1',
    createdAt: '2026-07-03T00:00:00.000Z'
  });
  state = applyChatRunEvent(state, {
    type: 'assistant_block',
    runId: 'run_1',
    block: { kind: 'text', blockId: 'text-run_1', phase: 'delta', text: 'partial' }
  });
  state = applyChatRunEvent(state, {
    type: 'run_recovering',
    runId: 'run_1',
    threadId: 'thread_1',
    code: 'provider_network_error',
    message: 'Connection error.',
    attempt: 1,
    nextRetryAt: '2026-07-03T00:00:01.000Z'
  });

  expect(state.status).toBe('recovering');
  expect(state.assistantMessage).toBe('partial');

  state = applyChatRunEvent(state, {
    type: 'run_recovered',
    runId: 'run_1',
    threadId: 'thread_1',
    attempt: 1,
    recoveredAt: '2026-07-03T00:00:02.000Z'
  });

  expect(state.status).toBe('running');
});
```

- [ ] **Step 2: Update reducer state**

Modify `src/renderer/chat-run-state.ts`:

```ts
status: 'idle' | 'running' | 'recovering' | 'waiting_user' | 'completed' | 'failed';
recoveryAttempt: number | null;
```

Handle new events:

```ts
if (event.type === 'run_recovering') {
  return {
    ...state,
    threadId: event.threadId,
    status: 'recovering',
    errorCode: event.code,
    errorMessage: event.message,
    recoveryAttempt: event.attempt
  };
}

if (event.type === 'run_recovered') {
  return {
    ...state,
    threadId: event.threadId,
    status: 'running',
    recoveryAttempt: null
  };
}
```

- [ ] **Step 3: Update hook to unwrap sequenced events**

Modify `src/renderer/chat/use-chat-run.ts` so pending buffers store sequenced events:

```ts
type SeenRunSequences = Map<string, number>;

function shouldApplySequencedEvent(seen: SeenRunSequences, event: SequencedChatRunEvent): boolean {
  const previous = seen.get(event.runId);
  if (previous !== undefined && event.sequence <= previous) {
    return false;
  }
  seen.set(event.runId, event.sequence);
  return true;
}
```

Apply `sequenced.event` through `applyChatRunEventBatch()`.

- [ ] **Step 4: Replay before live subscription**

In `useEffect()`, call:

```ts
const active = await client.api.chat.getActiveRun({ threadId: state.threadId });
if (active.ok && active.value !== null) {
  const lastSequence = lastSequenceByRunIdRef.current.get(active.value.runId);
  const afterSequence = lastSequence === undefined ? 0 : lastSequence;
  const replay = await client.api.chat.getRunEvents({ runId: active.value.runId, afterSequence });
  if (replay.ok) {
    replay.value.events.forEach(queueSequencedEvent);
  } else {
    setErrorMessage(replay.error.message);
  }
}
```

Use the existing `RocClient` result shape in tests; if `IpcResult` uses `{ ok: false, error }`, assert the sync error does not cancel the run.

- [ ] **Step 5: Verify renderer tests**

Run: `pnpm test -- tests/renderer/chat-run-state.test.ts tests/renderer/use-chat-run.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Run: `git add src/renderer/chat-run-state.ts src/renderer/chat/use-chat-run.ts tests/renderer/chat-run-state.test.ts tests/renderer/use-chat-run.test.ts; git commit -m "feat: replay and dedupe chat run events"`

---

### Task 5: Add Tool Effect Idempotency For Side-Effecting Tools

**Files:**
- Create: `src/main/services/deep-agent/tool-effect-store.ts`
- Create: `tests/main/services/deep-agent/tool-effect-store.test.ts`
- Modify: `src/main/plugins/agent/schema.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `src/main/services/deep-agent/command-tool.ts`
- Modify: `src/main/services/deep-agent/background-task-tools.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`
- Modify: `tests/main/services/deep-agent/command-tool.test.ts`

**Interfaces:**
- Produces: `AgentToolEffectStore`.
- Produces: `createIdempotentTool(tool, context, store, classification)`.
- Consumes: tool call metadata containing a stable `tool_call_id`; if absent, fail side-effecting execution with `agent_tool_effect_call_id_missing`.

- [ ] **Step 1: Write idempotency tests**

Create `tests/main/services/deep-agent/tool-effect-store.test.ts`:

```ts
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentToolEffectStore } from '../../../../src/main/services/deep-agent/tool-effect-store';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentPluginSchema(db);
});

afterEach(() => {
  db.close();
});

describe('AgentToolEffectStore', () => {
  it('returns a stored successful result for the same tool call and input hash', () => {
    const store = new AgentToolEffectStore(db);
    store.start({ runId: 'run_1', threadId: 'thread_1', toolCallId: 'call_1', toolName: 'run_shell_command', inputHash: 'hash_1' });
    store.finishSuccess({ runId: 'run_1', toolCallId: 'call_1', result: { ok: true } });

    expect(
      store.readReusable({ runId: 'run_1', toolCallId: 'call_1', inputHash: 'hash_1' })
    ).toEqual({ status: 'success', result: { ok: true } });
  });

  it('fails when the same tool call id has a different input hash', () => {
    const store = new AgentToolEffectStore(db);
    store.start({ runId: 'run_1', threadId: 'thread_1', toolCallId: 'call_1', toolName: 'delete_file', inputHash: 'hash_1' });

    expect(() => store.readReusable({ runId: 'run_1', toolCallId: 'call_1', inputHash: 'hash_2' })).toThrow('agent_tool_effect_input_drift');
  });
});
```

- [ ] **Step 2: Add schema**

Add table to `applyAgentRecoverySchema(db)`:

```sql
CREATE TABLE IF NOT EXISTS agent_tool_effects (
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in_progress','success','error','unknown')),
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_effects_thread_updated
  ON agent_tool_effects(thread_id, updated_at DESC);
```

- [ ] **Step 3: Implement store**

Create `src/main/services/deep-agent/tool-effect-store.ts` with SHA-256 input hashing:

```ts
import { createHash } from 'node:crypto';
import type { Database as DatabaseConnection } from 'better-sqlite3';

export function hashToolInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export class AgentToolEffectStore {
  constructor(private readonly db: DatabaseConnection) {}

  start(input: { runId: string; threadId: string; toolCallId: string; toolName: string; inputHash: string }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_tool_effects
         (run_id, thread_id, tool_call_id, tool_name, input_hash, status, result_json, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'in_progress', NULL, NULL, ?, ?)`
      )
      .run(input.runId, input.threadId, input.toolCallId, input.toolName, input.inputHash, now, now);
  }

  readReusable(input: { runId: string; toolCallId: string; inputHash: string }): { status: 'success'; result: unknown } | null {
    const row = this.db
      .prepare(
        `SELECT input_hash, status, result_json
         FROM agent_tool_effects
         WHERE run_id = ? AND tool_call_id = ?`
      )
      .get(input.runId, input.toolCallId) as { input_hash: string; status: string; result_json: string | null } | undefined;
    if (row === undefined) {
      return null;
    }
    if (row.input_hash !== input.inputHash) {
      throw new Error('agent_tool_effect_input_drift');
    }
    if (row.status === 'in_progress') {
      throw new Error('agent_tool_effect_in_progress');
    }
    if (row.status === 'success') {
      if (row.result_json === null) {
        throw new Error('agent_tool_effect_result_missing');
      }
      return { status: 'success', result: JSON.parse(row.result_json) as unknown };
    }
    return null;
  }

  finishSuccess(input: { runId: string; toolCallId: string; result: unknown }): void {
    this.finish({ runId: input.runId, toolCallId: input.toolCallId, status: 'success', resultJson: JSON.stringify(input.result), errorJson: null });
  }

  finishError(input: { runId: string; toolCallId: string; error: unknown }): void {
    this.finish({ runId: input.runId, toolCallId: input.toolCallId, status: 'error', resultJson: null, errorJson: JSON.stringify(input.error) });
  }

  private finish(input: { runId: string; toolCallId: string; status: string; resultJson: string | null; errorJson: string | null }): void {
    this.db
      .prepare(
        `UPDATE agent_tool_effects
         SET status = ?, result_json = ?, error_json = ?, updated_at = ?
         WHERE run_id = ? AND tool_call_id = ?`
      )
      .run(input.status, input.resultJson, input.errorJson, new Date().toISOString(), input.runId, input.toolCallId);
  }
}
```

- [ ] **Step 4: Wrap side-effecting tools**

In `deep-agent-executor.ts`, pass an `AgentToolEffectStore` into tool creation and wrap:

```ts
const sideEffectingTools = new Set([
  'delete_file',
  'run_shell_command',
  'propose_background_task',
  'schedule_background_task',
  'update_background_task',
  'cancel_background_task'
]);
```

MCP tools are side-effecting unless metadata explicitly marks them read-only. `web_read`, `web_search`, `ask_user`, and filesystem read/list/search tools remain read-only.

- [ ] **Step 5: Verify**

Run: `pnpm test -- tests/main/services/deep-agent/tool-effect-store.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/services/deep-agent/command-tool.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Run: `git add src/main/services/deep-agent/tool-effect-store.ts src/main/plugins/agent/schema.ts src/main/plugins/agent/deep-agent-executor.ts src/main/services/deep-agent/command-tool.ts src/main/services/deep-agent/background-task-tools.ts tests/main/services/deep-agent/tool-effect-store.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/services/deep-agent/command-tool.test.ts; git commit -m "feat: make agent tool effects idempotent"`

---

### Task 6: Prove Stream Failure Recovery Preserves Partial Output

**Files:**
- Modify: `tests/main/plugins/agent/deep-agent-executor-streaming.test.ts`
- Modify: `tests/main/plugins/agent/runtime.test.ts`
- Modify: `src/main/plugins/agent/runtime.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`

**Interfaces:**
- Consumes: Task 1 checkpointer and Task 2 runtime recovery loop.
- Produces: integration proof for `Connection error` after partial assistant text.

- [ ] **Step 1: Write integration test**

Add a runtime test that uses an executor failing once after a partial event:

```ts
it('recovers a transient Connection error after partial assistant text without clearing output', async () => {
  let calls = 0;
  const repository = new AgentSessionRepository(db);
  const runtime = new AgentPluginRuntime({
    deepAgentExecutor: {
      execute: async function* (input) {
        calls += 1;
        if (calls === 1) {
          yield {
            type: 'assistant_block',
            runId: input.run.id,
            block: { kind: 'text', blockId: `text-${input.run.id}`, phase: 'delta', text: 'partial ' }
          };
          throw new Error('Connection error.');
        }
        yield {
          type: 'assistant_block',
          runId: input.run.id,
          block: { kind: 'text', blockId: `text-${input.run.id}`, phase: 'delta', text: 'done' }
        };
      }
    },
    eventBus,
    modelFactory,
    repository
  });

  const result = await runtime.startRun(startRequest);
  await waitForEvent(() =>
    events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
  );

  const runEvents = events.filter((event) => event.type === 'agent.chat.run-event').map((event) => readChatRunEvent(event.payload));
  expect(runEvents.map((event) => event?.type)).toContain('run_recovering');
  expect(runEvents.map((event) => event?.type)).toContain('run_recovered');
  expect(repository.getRun(result.runId).status).toBe('completed');
  expect(calls).toBe(2);
});
```

- [ ] **Step 2: Make `Connection error` classify as network**

If `toRunFailure(new Error('Connection error.'))` is not `provider_network_error`, update `classifyProviderRequestFailure()` tests and implementation in `src/main/services/provider-request-retry.ts` so exact messages containing `Connection error` map to `network`.

- [ ] **Step 3: Ensure recovery does not emit final failure before exhaustion**

Update runtime assertions so first transient error emits `run_recovering` only, then successful retry emits `run_recovered` and `run_completed`.

- [ ] **Step 4: Verify**

Run: `pnpm test -- tests/main/plugins/agent/runtime.test.ts tests/main/plugins/agent/deep-agent-executor-streaming.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/main/plugins/agent/runtime.ts src/main/plugins/agent/deep-agent-executor.ts src/main/services/provider-request-retry.ts tests/main/plugins/agent/runtime.test.ts tests/main/plugins/agent/deep-agent-executor-streaming.test.ts; git commit -m "test: cover transient stream recovery"`

---

### Task 7: Extend Recovery To Scheduled Background Runs

**Files:**
- Modify: `src/main/plugins/task/plugin-background-runs.ts` if present, otherwise modify `src/main/plugins/task/index.ts`
- Modify: `src/main/plugins/task/scheduler.ts`
- Modify: `src/main/plugins/task/task-repository.ts`
- Modify: `tests/main/plugins/task/plugin-background-runs.test.ts`
- Modify: `tests/main/plugins/task/scheduler.test.ts`

**Interfaces:**
- Consumes: existing background task create/run path through `agent.run.start`.
- Produces: scheduled run status remains active during `run_recovering` and only records failed after final `run_failed`.

- [ ] **Step 1: Locate scheduled run start path**

Run: `rg "runBackground|scheduled_task_runs|agent.run.start|lastRunStatus" src/main/plugins/task tests/main/plugins/task`

Expected: identify the exact method that calls `agent.run.start` for scheduled tasks.

- [ ] **Step 2: Write background recovery test**

In `tests/main/plugins/task/plugin-background-runs.test.ts`, add a test that starts a scheduled run and feeds these chat events through the plugin event bus:

```ts
const events = [
  { type: 'run_started', runId, mode: 'task', threadId, providerId: 'openai', modelId: 'openai:gpt-4.1', createdAt },
  { type: 'run_recovering', runId, threadId, code: 'provider_network_error', message: 'Connection error.', attempt: 1, nextRetryAt },
  { type: 'run_recovered', runId, threadId, attempt: 1, recoveredAt },
  { type: 'run_completed', runId, threadId, providerId: 'openai', modelId: 'openai:gpt-4.1', createdAt, durationMs: 100, summary: 'done', assistantMessage: 'done' }
];
```

Assert:

```ts
expect(repository.getBackgroundTask(taskId).lastRunStatus).toBe('completed');
expect(agentStartRequest.workspacePath).toBe(savedTask.workspacePath);
expect(agentStartRequest.enabledCapabilities).toEqual(savedTask.enabledCapabilities);
```

- [ ] **Step 3: Treat recovery as non-terminal in task event handling**

Where the task plugin maps chat run events to scheduled run status, add:

```ts
if (event.type === 'run_recovering') {
  return;
}
if (event.type === 'run_recovered') {
  return;
}
```

Only `run_completed`, `run_failed`, and cancellation should settle a scheduled run.

- [ ] **Step 4: Verify**

Run: `pnpm test -- tests/main/plugins/task/plugin-background-runs.test.ts tests/main/plugins/task/scheduler.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/main/plugins/task src/shared/types/chat.ts tests/main/plugins/task/plugin-background-runs.test.ts tests/main/plugins/task/scheduler.test.ts; git commit -m "feat: keep background runs active during recovery"`

---

### Task 8: Production Verification And Risk Audit

**Files:**
- Modify only files changed by Tasks 1-7 if verification finds defects.
- Do not commit `task_plan.md`, `findings.md`, or `progress.md` unless the user explicitly asks.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified implementation with no IPC drift, type errors, or whitespace errors.

- [ ] **Step 1: Run targeted recovery test set**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/runtime.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/deep-agent-executor-streaming.test.ts tests/main/deep-agent-error-mapping.test.ts tests/renderer/use-chat-run.test.ts tests/main/plugins/task/plugin-background-runs.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run contract and type verification**

Run:

```powershell
pnpm typecheck
pnpm check:ipc
git diff --check
```

Expected: all PASS.

- [ ] **Step 3: Run broader build and tests because persistence and IPC changed**

Run:

```powershell
pnpm build
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Inspect workspace diff**

Run:

```powershell
git status --short
git diff --stat
git diff -- docs/superpowers/specs/2026-07-03-deepagents-production-recovery-design.md
```

Expected: implementation files changed; committed spec remains unchanged; untracked `task_plan.md`, `findings.md`, and `progress.md` remain uncommitted unless separately requested.

- [ ] **Step 5: Final commit**

Run:

```powershell
git add src tests docs/superpowers/plans/2026-07-03-deepagents-production-recovery.md
git commit -m "feat: harden deepagents recovery"
```

Expected: commit created after all required verification passes.

---

## Self-Review

**Spec coverage:** The plan covers durable checkpoints in Task 1, transient recovery state in Task 2, IPC event replay in Task 3, renderer recovery state in Task 4, tool effect idempotency in Task 5, `Connection error` stream recovery in Task 6, background task recovery in Task 7, and production verification in Task 8.

**No-placeholder scan:** The plan avoids unresolved placeholder instructions. Every task has file paths, concrete interfaces, commands, and expected results.

**Type consistency:** `SequencedChatRunEvent`, `ChatRunEventsReplayRequest`, `ChatRunEventsReplayResult`, and `ActiveChatRun` are introduced before renderer usage. `run_recovering` and `run_recovered` are introduced before reducer and task-plugin usage. `RocSqliteCheckpointer`, `AgentRunEventLog`, and `AgentToolEffectStore` are introduced before runtime/executor wiring.
