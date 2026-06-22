# DeepAgents Subagents Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Roc's flat subagent started/completed path with DeepAgents-first structured, streaming, nested subagent events across runtime, persistence, and UI.

**Architecture:** Keep `createDeepAgent()` as the only harness. Add a Roc projection layer that consumes DeepAgents subagent streams and emits one `subagent_event` envelope for chat and task history. Remove all old `subagent_started` / `subagent_completed` reads, writes, tests, and renderer branches.

**Tech Stack:** TypeScript ESM, Electron main/preload/renderer, React 19, Vitest, DeepAgents 1.10.2, LangGraph 1.3.2, zod 4.4.3.

## Global Constraints

- User-facing replies use Simplified Chinese. Keep code identifiers, CLI commands, logs, errors, and protocol fields in original language.
- Use UTF-8 without BOM.
- Preserve `main`, `preload`, `renderer`, and `shared` boundaries.
- `createDeepAgent()` remains the only agent harness.
- No second Roc subagent runtime.
- No old `subagent_started` / `subagent_completed` compatibility path.
- No old subagent history migration.
- No prompt-only permission, path, concurrency, or depth control.
- DeepAgents file tools use virtual `/workspace/`; shell execution uses real Windows workspace path.
- Each task starts with a failing test or compile check, then minimal implementation, then direct verification.

---

## File Structure

Create:

- `src/main/services/deep-agent/subagent-projection.ts`
  - Owns DeepAgents subagent stream projection.
  - Recursively consumes `messages`, `toolCalls`, `subagents`, and `output`.
  - Emits structured `ChatRunEvent` envelopes.

- `tests/main/services/deep-agent/subagent-projection.test.ts`
  - Unit tests for projection ids, nesting, partial transcript, tool calls, output failure, and async status payloads.

Modify:

- `src/shared/types/chat.ts`
  - Add `SubagentIdentity`, `SubagentEventPayload`, `SubagentStatus`, `SubagentExecution`.
  - Replace flat `ChatRunEvent.subagent_event`.

- `src/shared/types/task.ts`
  - Add `subagent_event`.
  - Remove `subagent_started` and `subagent_completed`.

- `src/main/services/deep-agent/types.ts`
  - Change `RuntimeSubagent` from `SubAgent` to `AnySubAgent`.
  - Keep DeepAgents-native type source.

- `src/main/services/deep-agent/stream-consumers.ts`
  - Remove old subagent started/completed implementation.
  - Delegate subagent stream projection to `projectSubagentStream()`.
  - Keep message and tool stream consumers as main-agent helpers.

- `src/main/plugins/agent/runtime.ts`
  - Persist `subagent_event` envelope directly.
  - Stop mapping failed subagents to completed task events.

- `src/main/plugins/task/agent-run-payloads.ts`
  - Accept `subagent_event` from `agent.run.task-event`.
  - Reject old subagent event types by omission.

- `src/renderer/chat-run-state.ts`
  - Store structured subagent nodes by `subagentId`.
  - Apply nested assistant/tool/status events.

- `src/renderer/chat-transcript.ts`
  - Remove old `SubagentPayload`.
  - Build persisted and live subagent blocks from structured events.

- `src/renderer/chat/chat-message-row.tsx`
  - Render subagent tree with nested transcript blocks and explicit statuses.

- `src/renderer/styles/chat.css`
  - Update only subagent activity styles.

- Tests:
  - `tests/renderer/chat-run-state.test.ts`
  - `tests/renderer/use-chat-run.test.ts`
  - `tests/renderer/chat-transcript.test.ts`
  - `tests/renderer/chat-message-row.test.ts`
  - `tests/main/plugins/agent/runtime-streaming.test.ts`
  - `tests/main/plugins/task/plugin-run-states.test.ts`
  - `tests/main/ipc-schema-generation.test.ts` if generated IPC changes require fixture update.

Generated:

- `src/shared/ipc-generated.ts`
  - Update through `pnpm generate:ipc` only after shared type changes.

---

### Task 1: Shared Structured Subagent Contract

**Files:**
- Modify: `src/shared/types/chat.ts`
- Modify: `src/shared/types/task.ts`
- Test: `tests/renderer/chat-run-state.test.ts`
- Generated later: `src/shared/ipc-generated.ts`

**Interfaces:**
- Consumes: existing `ChatAssistantBlock` and DeepAgents exported `AsyncTaskStatus`.
- Produces:
  - `export type SubagentExecution = 'sync' | 'async';`
  - `export type SubagentStatus = 'started' | 'running' | 'completed' | 'failed' | 'cancelled';`
  - `export type SubagentIdentity = { subagentId: string; parentSubagentId: string | null; name: string; depth: number; path: string[]; execution: SubagentExecution; taskInput: string | null; asyncTaskId?: string; };`
  - `export type SubagentEventPayload = ...`
  - `ChatRunEvent` arm `{ type: 'subagent_event'; runId: string; identity: SubagentIdentity; event: SubagentEventPayload; }`
  - `TaskEvent['type']` includes `'subagent_event'` and excludes old subagent types.

- [ ] **Step 1: Write failing type-driven test**

Replace the old flat subagent section in `tests/renderer/chat-run-state.test.ts` with this event shape:

```ts
state = applyChatRunEvent(state, {
  type: 'subagent_event',
  runId: 'chat_stream_mix',
  identity: {
    subagentId: 'subagent-chat_stream_mix-0',
    parentSubagentId: null,
    name: 'research',
    depth: 0,
    path: ['research#0'],
    execution: 'sync',
    taskInput: 'Search docs'
  },
  event: {
    kind: 'started'
  }
});
```

Also replace the completion event:

```ts
state = applyChatRunEvent(state, {
  type: 'subagent_event',
  runId: 'chat_stream_mix',
  identity: {
    subagentId: 'subagent-chat_stream_mix-0',
    parentSubagentId: null,
    name: 'research',
    depth: 0,
    path: ['research#0'],
    execution: 'sync',
    taskInput: 'Search docs'
  },
  event: {
    kind: 'completed',
    summary: 'Search docs'
  }
});
```

- [ ] **Step 2: Run compile check and confirm red**

Run: `pnpm typecheck`

Expected: FAIL with TypeScript errors in `tests/renderer/chat-run-state.test.ts` because `ChatRunEvent.subagent_event` still expects `subagent`, `status`, and `summary`.

- [ ] **Step 3: Update shared types**

In `src/shared/types/chat.ts`, add:

```ts
import type { AsyncTaskStatus } from 'deepagents';
```

Add after `ChatAssistantBlock`:

```ts
export type SubagentExecution = 'sync' | 'async';

export type SubagentStatus = 'started' | 'running' | 'completed' | 'failed' | 'cancelled';

export type SubagentIdentity = {
  subagentId: string;
  parentSubagentId: string | null;
  name: string;
  depth: number;
  path: string[];
  execution: SubagentExecution;
  taskInput: string | null;
  asyncTaskId?: string;
};

export type SubagentEventPayload =
  | { kind: 'started' }
  | { kind: 'assistant_block'; block: ChatAssistantBlock }
  | { kind: 'tool_call'; block: Extract<ChatAssistantBlock, { kind: 'tool_call' }> }
  | { kind: 'async_status'; status: AsyncTaskStatus; checkedAt?: string }
  | { kind: 'completed'; summary: string | null }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason?: string };
```

Replace the `ChatRunEvent` subagent arm with:

```ts
  | {
      type: 'subagent_event';
      runId: string;
      identity: SubagentIdentity;
      event: SubagentEventPayload;
    }
```

In `src/shared/types/task.ts`, replace:

```ts
    | 'subagent_started'
    | 'subagent_completed'
```

with:

```ts
    | 'subagent_event'
```

- [ ] **Step 4: Run focused compile check**

Run: `pnpm typecheck`

Expected: FAIL now moves to implementation call sites that still read `event.subagent`, `event.status`, `event.summary`, or old task event types.

- [ ] **Step 5: Commit contract red state only if team policy allows red commits**

Preferred: do not commit a red state. Continue to Task 2 before committing.

---

### Task 2: DeepAgents Subagent Projection Module

**Files:**
- Create: `src/main/services/deep-agent/subagent-projection.ts`
- Modify: `src/main/services/deep-agent/stream-consumers.ts`
- Test: `tests/main/services/deep-agent/subagent-projection.test.ts`
- Test: `tests/main/services/deep-agent/stream-consumers.test.ts`

**Interfaces:**
- Consumes:
  - `ChatRunEvent`, `ChatAssistantBlock`, `SubagentIdentity` from `src/shared/types/chat.ts`
  - `readToolCallId()`, `redactUnknown()` from `src/main/services/deep-agent/stream-tool-utils.ts`
  - `recordUtils.readRecordValue()`, `recordUtils.readAsyncIterable()`, `recordUtils.readNonEmptyString()`
- Produces:
  - `export type SubagentProjectionCallbacks = { emitRuntimeEvent(event: ChatRunEvent): void; emitTodoEvent(candidate: unknown): void; markVisibleOutput?: () => void; recordSessionToolCall?: (name: string, input: unknown, output: unknown) => void; };`
  - `export async function projectSubagentStream(input: { subagents: AsyncIterable<unknown>; runId: string; callbacks: SubagentProjectionCallbacks; }): Promise<void>`

- [ ] **Step 1: Write failing projection tests**

Create `tests/main/services/deep-agent/subagent-projection.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { projectSubagentStream } from '../../../../src/main/services/deep-agent/subagent-projection';
import type { ChatRunEvent } from '../../../../src/shared/types';

describe('projectSubagentStream', () => {
  it('streams nested subagent messages and tool calls with stable identity', async () => {
    const events: ChatRunEvent[] = [];
    await projectSubagentStream({
      runId: 'run_nested',
      subagents: single({
        name: 'research',
        taskInput: 'Search docs',
        messages: single({
          text: single('子代理正文')
        }),
        toolCalls: single({
          callId: 'call-web',
          name: 'web_read',
          input: { url: 'https://example.com' },
          output: 'ok'
        }),
        subagents: single({
          name: 'quote-check',
          taskInput: 'Verify quote',
          output: 'quote ok'
        }),
        output: 'done'
      }),
      callbacks: callbacks(events)
    });

    expect(events.map((event) => event.type)).toEqual([
      'subagent_event',
      'subagent_event',
      'subagent_event',
      'subagent_event',
      'subagent_event',
      'subagent_event',
      'subagent_event'
    ]);
    expect(events[0]).toMatchObject({
      runId: 'run_nested',
      identity: {
        subagentId: 'subagent-run_nested-0',
        parentSubagentId: null,
        name: 'research',
        depth: 0,
        path: ['research#0'],
        execution: 'sync',
        taskInput: 'Search docs'
      },
      event: { kind: 'started' }
    });
    expect(events[1]).toMatchObject({
      identity: { subagentId: 'subagent-run_nested-0' },
      event: {
        kind: 'assistant_block',
        block: {
          kind: 'text',
          blockId: 'subagent-run_nested-0-text',
          phase: 'delta',
          text: '子代理正文'
        }
      }
    });
    expect(events[2]).toMatchObject({
      identity: { subagentId: 'subagent-run_nested-0' },
      event: {
        kind: 'tool_call',
        block: {
          kind: 'tool_call',
          blockId: 'subagent-run_nested-0-tool-call-web',
          callId: 'call-web',
          name: 'web_read',
          phase: 'start',
          input: { url: 'https://example.com' }
        }
      }
    });
    expect(events[4]).toMatchObject({
      identity: {
        subagentId: 'subagent-run_nested-0-0',
        parentSubagentId: 'subagent-run_nested-0',
        name: 'quote-check',
        depth: 1,
        path: ['research#0', 'quote-check#0']
      },
      event: { kind: 'started' }
    });
    expect(events.at(-1)).toMatchObject({
      identity: { subagentId: 'subagent-run_nested-0' },
      event: { kind: 'completed', summary: 'done' }
    });
  });

  it('keeps partial transcript when output rejects', async () => {
    const events: ChatRunEvent[] = [];
    await projectSubagentStream({
      runId: 'run_failed_output',
      subagents: single({
        name: 'research',
        taskInput: 'Search docs',
        messages: single({ text: single('partial') }),
        output: Promise.reject(new Error('remote failed'))
      }),
      callbacks: callbacks(events)
    });

    expect(events).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        kind: 'assistant_block',
        block: expect.objectContaining({ text: 'partial' })
      })
    }));
    expect(events.at(-1)).toMatchObject({
      event: { kind: 'failed', error: 'remote failed' }
    });
  });
});

function callbacks(events: ChatRunEvent[]) {
  return {
    emitRuntimeEvent: vi.fn((event: ChatRunEvent) => events.push(event)),
    emitTodoEvent: vi.fn(),
    markVisibleOutput: vi.fn(),
    recordSessionToolCall: vi.fn()
  };
}

async function* single(value: unknown): AsyncGenerator<unknown> {
  yield value;
}
```

- [ ] **Step 2: Run test and confirm red**

Run: `pnpm test -- tests/main/services/deep-agent/subagent-projection.test.ts`

Expected: FAIL with module-not-found for `subagent-projection`.

- [ ] **Step 3: Implement projection module**

Create `src/main/services/deep-agent/subagent-projection.ts` with this structure:

```ts
import type { ChatAssistantBlock, ChatRunEvent, SubagentEventPayload, SubagentIdentity } from '../../../shared/types';
import * as recordUtils from './record-utils';
import { readToolCallId, redactUnknown } from './stream-tool-utils';
import { redact } from './redact';

export type SubagentProjectionCallbacks = {
  emitRuntimeEvent: (event: ChatRunEvent) => void;
  emitTodoEvent: (candidate: unknown) => void;
  markVisibleOutput?: () => void;
  recordSessionToolCall?: (name: string, input: unknown, output: unknown) => void;
};

type ProjectionContext = {
  runId: string;
  parent: SubagentIdentity | null;
  path: string[];
  ordinal: number;
};

export async function projectSubagentStream(input: {
  subagents: AsyncIterable<unknown>;
  runId: string;
  callbacks: SubagentProjectionCallbacks;
}): Promise<void> {
  await consumeSubagents(input.subagents, {
    runId: input.runId,
    parent: null,
    path: [],
    ordinal: 0
  }, input.callbacks);
}

async function consumeSubagents(
  subagents: AsyncIterable<unknown>,
  context: ProjectionContext,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  let ordinal = 0;
  for await (const subagent of subagents) {
    await consumeOneSubagent(subagent, { ...context, ordinal }, callbacks);
    ordinal += 1;
  }
}

async function consumeOneSubagent(
  subagent: unknown,
  context: ProjectionContext,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  const name = recordUtils.readNonEmptyString(recordUtils.readRecordValue(subagent, 'name')) ?? 'subagent';
  const taskInputValue = await Promise.resolve(recordUtils.readRecordValue(subagent, 'taskInput'));
  const taskInput = recordUtils.readNonEmptyString(taskInputValue) ?? null;
  const path = [...context.path, `${name}#${context.ordinal}`];
  const subagentId = ['subagent', context.runId, ...path.map((item) => item.replace(/[^a-zA-Z0-9_-]/g, '-'))].join('-');
  const asyncTaskId = recordUtils.readNonEmptyString(recordUtils.readRecordValue(subagent, 'taskId')) ?? undefined;
  const identity: SubagentIdentity = {
    subagentId,
    parentSubagentId: context.parent?.subagentId ?? null,
    name,
    depth: context.parent === null ? 0 : context.parent.depth + 1,
    path,
    execution: asyncTaskId === undefined ? 'sync' : 'async',
    taskInput,
    ...(asyncTaskId === undefined ? {} : { asyncTaskId })
  };

  emit(callbacks, context.runId, identity, { kind: 'started' });

  const messages = recordUtils.readAsyncIterable(recordUtils.readRecordValue(subagent, 'messages'));
  const toolCalls = recordUtils.readAsyncIterable(recordUtils.readRecordValue(subagent, 'toolCalls'));
  const nested = recordUtils.readAsyncIterable(recordUtils.readRecordValue(subagent, 'subagents'));
  const projectionTasks: Array<Promise<void>> = [];
  if (messages !== null) {
    projectionTasks.push(consumeMessages(messages, context.runId, identity, callbacks));
  }
  if (toolCalls !== null) {
    projectionTasks.push(consumeToolCalls(toolCalls, context.runId, identity, callbacks));
  }
  if (nested !== null) {
    projectionTasks.push(consumeSubagents(nested, { runId: context.runId, parent: identity, path, ordinal: 0 }, callbacks));
  }
  await Promise.all(projectionTasks);

  try {
    const output = await Promise.resolve(recordUtils.readRecordValue(subagent, 'output'));
    emit(callbacks, context.runId, identity, {
      kind: 'completed',
      summary: typeof output === 'string' && output.length > 0 ? output : taskInput
    });
  } catch (error) {
    emit(callbacks, context.runId, identity, {
      kind: 'failed',
      error: redact(error instanceof Error ? error.message : String(error))
    });
  }
}

async function consumeMessages(
  messages: AsyncIterable<unknown>,
  runId: string,
  identity: SubagentIdentity,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  for await (const message of messages) {
    const text = recordUtils.readAsyncIterable(recordUtils.readRecordValue(message, 'text'));
    if (text === null) {
      continue;
    }
    for await (const delta of text) {
      if (typeof delta !== 'string' || delta.length === 0) {
        continue;
      }
      emit(callbacks, runId, identity, {
        kind: 'assistant_block',
        block: {
          kind: 'text',
          blockId: `${identity.subagentId}-text`,
          phase: 'delta',
          text: delta
        }
      });
    }
  }
}

async function consumeToolCalls(
  calls: AsyncIterable<unknown>,
  runId: string,
  identity: SubagentIdentity,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  for await (const call of calls) {
    const callId = readToolCallId(call);
    if (callId === null) {
      continue;
    }
    const name = recordUtils.readNonEmptyString(recordUtils.readRecordValue(call, 'name')) ?? 'unknown_tool';
    const input = redactUnknown(await Promise.resolve(recordUtils.readRecordValue(call, 'input')));
    const startBlock: Extract<ChatAssistantBlock, { kind: 'tool_call' }> = {
      kind: 'tool_call',
      blockId: `${identity.subagentId}-tool-${callId}`,
      callId,
      name,
      phase: 'start',
      input
    };
    emit(callbacks, runId, identity, { kind: 'tool_call', block: startBlock });
    callbacks.emitTodoEvent(input);

    try {
      const output = await Promise.resolve(recordUtils.readRecordValue(call, 'output'));
      const endBlock: Extract<ChatAssistantBlock, { kind: 'tool_call' }> = {
        ...startBlock,
        phase: 'end',
        output
      };
      emit(callbacks, runId, identity, { kind: 'tool_call', block: endBlock });
      callbacks.recordSessionToolCall?.(name, input, output);
    } catch (error) {
      emit(callbacks, runId, identity, {
        kind: 'tool_call',
        block: {
          ...startBlock,
          phase: 'error',
          error: redact(error instanceof Error ? error.message : String(error))
        }
      });
    }
  }
}

function emit(
  callbacks: SubagentProjectionCallbacks,
  runId: string,
  identity: SubagentIdentity,
  event: SubagentEventPayload
): void {
  callbacks.markVisibleOutput?.();
  callbacks.emitRuntimeEvent({
    type: 'subagent_event',
    runId,
    identity,
    event
  });
}
```

- [ ] **Step 4: Replace old `consumeSubagentStream()` body**

In `src/main/services/deep-agent/stream-consumers.ts`, import:

```ts
import { projectSubagentStream, type SubagentProjectionCallbacks } from './subagent-projection';
```

Change `StreamConsumerCallbacks.recordTaskEvent` to:

```ts
  recordTaskEvent: (type: 'guardrail_nudge', payload: Record<string, unknown>) => void;
```

Replace `consumeSubagentStream()` with:

```ts
export async function consumeSubagentStream(input: {
  subagents: AsyncIterable<unknown>;
  context: StreamConsumerContext;
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  await projectSubagentStream({
    subagents: input.subagents,
    runId: input.context.runId,
    callbacks: input.callbacks satisfies SubagentProjectionCallbacks
  });
}
```

- [ ] **Step 5: Run focused projection tests**

Run: `pnpm test -- tests/main/services/deep-agent/subagent-projection.test.ts tests/main/services/deep-agent/stream-consumers.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/main/services/deep-agent/subagent-projection.ts src/main/services/deep-agent/stream-consumers.ts tests/main/services/deep-agent/subagent-projection.test.ts tests/main/services/deep-agent/stream-consumers.test.ts
git commit -m "feat: project deepagents subagent streams"
```

---

### Task 3: Runtime Persistence Uses Only `subagent_event`

**Files:**
- Modify: `src/main/plugins/agent/runtime.ts`
- Modify: `src/main/plugins/task/agent-run-payloads.ts`
- Test: `tests/main/plugins/agent/runtime-streaming.test.ts`
- Test: `tests/main/plugins/task/plugin-run-states.test.ts`

**Interfaces:**
- Consumes: structured `ChatRunEvent.subagent_event`.
- Produces: `agent.run.task-event` payload with `type: 'subagent_event'` and `payload: { identity, event }`.

- [ ] **Step 1: Write failing runtime persistence test**

Add to `tests/main/plugins/agent/runtime-streaming.test.ts`:

```ts
it('persists structured subagent events without old started/completed task types', async () => {
  const repository = new AgentSessionRepository(db);
  const runtime = new AgentPluginRuntime({
    deepAgentExecutor: {
      execute: async function* (input) {
        yield {
          type: 'subagent_event',
          runId: input.run.id,
          identity: {
            subagentId: 'subagent-runtime-0',
            parentSubagentId: null,
            name: 'research',
            depth: 0,
            path: ['research#0'],
            execution: 'sync',
            taskInput: 'Search docs'
          },
          event: { kind: 'started' }
        } satisfies ChatRunEvent;
        yield createTextBlock(input.run.id, '完成。');
      }
    },
    eventBus,
    modelFactory,
    repository
  });

  const result = await runtime.startRun({
    ...startRequest,
    input: '研究文档',
    mode: 'task'
  });

  await waitForEvent(() =>
    events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
  );

  expect(events).toContainEqual(expect.objectContaining({
    type: 'agent.run.task-event',
    payload: expect.objectContaining({
      runId: result.runId,
      type: 'subagent_event',
      payload: {
        identity: {
          subagentId: 'subagent-runtime-0',
          parentSubagentId: null,
          name: 'research',
          depth: 0,
          path: ['research#0'],
          execution: 'sync',
          taskInput: 'Search docs'
        },
        event: { kind: 'started' }
      }
    })
  }));
  expect(events).not.toContainEqual(expect.objectContaining({
    type: 'agent.run.task-event',
    payload: expect.objectContaining({ type: 'subagent_started' })
  }));
});
```

- [ ] **Step 2: Update task plugin run state test**

In `tests/main/plugins/task/plugin-run-states.test.ts`, replace old event publish payloads with:

```ts
type: 'subagent_event',
payload: {
  identity: {
    subagentId: 'subagent-run_subagent_1-0',
    parentSubagentId: null,
    name: 'research',
    depth: 0,
    path: ['research#0'],
    execution: 'sync',
    taskInput: 'Search docs'
  },
  event: { kind: 'started' }
}
```

and:

```ts
type: 'subagent_event',
payload: {
  identity: {
    subagentId: 'subagent-run_subagent_1-0',
    parentSubagentId: null,
    name: 'research',
    depth: 0,
    path: ['research#0'],
    execution: 'sync',
    taskInput: 'Search docs'
  },
  event: { kind: 'completed', summary: 'Search docs' }
}
```

- [ ] **Step 3: Run tests and confirm red**

Run: `pnpm test -- tests/main/plugins/agent/runtime-streaming.test.ts tests/main/plugins/task/plugin-run-states.test.ts`

Expected: FAIL because runtime and task plugin still emit or accept old subagent task event types.

- [ ] **Step 4: Update runtime persistence**

In `src/main/plugins/agent/runtime.ts`, replace the `event.type === 'subagent_event'` branch with:

```ts
      if (event.type === 'subagent_event') {
        await this.publish('agent.run.task-event', {
          runId: input.run.id,
          threadId: input.run.threadId,
          type: 'subagent_event',
          payload: {
            identity: event.identity,
            event: event.event
          }
        });
      }
```

- [ ] **Step 5: Update task event type allowlist**

In `src/main/plugins/task/agent-run-payloads.ts`, replace:

```ts
    value === 'subagent_started' ||
    value === 'subagent_completed' ||
```

with:

```ts
    value === 'subagent_event' ||
```

- [ ] **Step 6: Run focused tests**

Run: `pnpm test -- tests/main/plugins/agent/runtime-streaming.test.ts tests/main/plugins/task/plugin-run-states.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/main/plugins/agent/runtime.ts src/main/plugins/task/agent-run-payloads.ts tests/main/plugins/agent/runtime-streaming.test.ts tests/main/plugins/task/plugin-run-states.test.ts
git commit -m "fix: persist structured subagent events"
```

---

### Task 4: Renderer Live State And Persisted Transcript

**Files:**
- Modify: `src/renderer/chat-run-state.ts`
- Modify: `src/renderer/chat-transcript.ts`
- Test: `tests/renderer/chat-run-state.test.ts`
- Test: `tests/renderer/chat-transcript.test.ts`
- Test: `tests/renderer/use-chat-run.test.ts`

**Interfaces:**
- Consumes: `SubagentIdentity`, `SubagentEventPayload`, `ChatAssistantBlock`.
- Produces:
  - `ChatRunSubagentNode` with `identity`, `status`, `summary`, `error`, `blocks`, `children`.
  - `ChatTranscriptActivityBlock` arm `{ kind: 'subagent'; identity; status; summary; error; blocks; children; }`.

- [ ] **Step 1: Write failing live state expectation**

In `tests/renderer/chat-run-state.test.ts`, update expected `state.subagents`:

```ts
expect(state.subagents).toEqual([
  {
    identity: {
      subagentId: 'subagent-chat_stream_mix-0',
      parentSubagentId: null,
      name: 'research',
      depth: 0,
      path: ['research#0'],
      execution: 'sync',
      taskInput: 'Search docs'
    },
    status: 'completed',
    summary: 'Search docs',
    error: null,
    blocks: [],
    children: []
  }
]);
```

- [ ] **Step 2: Add persisted transcript test**

Add to `tests/renderer/chat-transcript.test.ts`:

```ts
it('rebuilds structured subagent blocks from persisted subagent_event records', () => {
  const snapshot = createSnapshot({
    threads: [createThread('thread-subagent', '子代理任务', '2026-05-09T08:20:00.000Z')],
    recentEvents: [
      {
        id: 'user-subagent',
        threadId: 'thread-subagent',
        runId: 'run-subagent',
        type: 'message',
        payload: { role: 'user', content: '研究文档' },
        createdAt: '2026-05-09T08:20:00.000Z'
      },
      {
        id: 'subagent-start',
        threadId: 'thread-subagent',
        runId: 'run-subagent',
        type: 'subagent_event',
        payload: {
          identity: {
            subagentId: 'subagent-run-subagent-0',
            parentSubagentId: null,
            name: 'research',
            depth: 0,
            path: ['research#0'],
            execution: 'sync',
            taskInput: 'Search docs'
          },
          event: { kind: 'started' }
        },
        createdAt: '2026-05-09T08:20:01.000Z'
      },
      {
        id: 'subagent-text',
        threadId: 'thread-subagent',
        runId: 'run-subagent',
        type: 'subagent_event',
        payload: {
          identity: {
            subagentId: 'subagent-run-subagent-0',
            parentSubagentId: null,
            name: 'research',
            depth: 0,
            path: ['research#0'],
            execution: 'sync',
            taskInput: 'Search docs'
          },
          event: {
            kind: 'assistant_block',
            block: {
              kind: 'text',
              blockId: 'subagent-run-subagent-0-text',
              phase: 'delta',
              text: '找到资料。'
            }
          }
        },
        createdAt: '2026-05-09T08:20:02.000Z'
      }
    ]
  });

  const messages = buildChatTranscript({
    promotedThreadIds: new Set(),
    chatRunState: createIdleRunState(),
    pendingUserInput: null,
    selectedThreadId: 'thread-subagent',
    taskSnapshot: snapshot
  });

  expect(messages[1]?.blocks[0]).toMatchObject({
    kind: 'subagent',
    identity: { subagentId: 'subagent-run-subagent-0', name: 'research' },
    status: 'running',
    blocks: [
      {
        id: 'subagent-run-subagent-0-text',
        kind: 'text',
        content: '找到资料。'
      }
    ]
  });
});
```

- [ ] **Step 3: Run renderer tests and confirm red**

Run: `pnpm test -- tests/renderer/chat-run-state.test.ts tests/renderer/chat-transcript.test.ts tests/renderer/use-chat-run.test.ts`

Expected: FAIL because renderer state still stores flat subagent states and persisted transcript still reads old event types.

- [ ] **Step 4: Update live state types and reducer**

In `src/renderer/chat-run-state.ts`, replace `ChatRunSubagentState` with:

```ts
export type ChatRunSubagentBlock =
  | {
      id: string;
      kind: 'text';
      content: string;
    }
  | ChatRunActivityBlock;

export type ChatRunSubagentNode = {
  identity: SubagentIdentity;
  status: SubagentStatus;
  summary: string | null;
  error: string | null;
  blocks: ChatRunSubagentBlock[];
  children: ChatRunSubagentNode[];
};
```

Change `ChatRunState.subagents` to:

```ts
  subagents: ChatRunSubagentNode[];
```

Implement helpers:

```ts
function applySubagentEvent(state: ChatRunState, event: Extract<ChatRunEvent, { type: 'subagent_event' }>): ChatRunState {
  return {
    ...state,
    subagents: upsertSubagentNode(state.subagents, event.identity.parentSubagentId, event.identity, event.event)
  };
}

function upsertSubagentNode(
  nodes: readonly ChatRunSubagentNode[],
  parentSubagentId: string | null,
  identity: SubagentIdentity,
  payload: SubagentEventPayload
): ChatRunSubagentNode[] {
  if (parentSubagentId !== null) {
    return nodes.map((node) =>
      node.identity.subagentId === parentSubagentId
        ? { ...node, children: upsertSubagentNode(node.children, null, identity, payload) }
        : { ...node, children: upsertSubagentNode(node.children, parentSubagentId, identity, payload) }
    );
  }
  const existing = nodes.find((node) => node.identity.subagentId === identity.subagentId);
  const next = applySubagentPayload(
    existing ?? {
      identity,
      status: 'started',
      summary: null,
      error: null,
      blocks: [],
      children: []
    },
    payload
  );
  return existing === undefined ? [...nodes, next] : nodes.map((node) => (node === existing ? next : node));
}
```

Make `applySubagentPayload()` map:

- `started` -> `status: 'started'`
- `assistant_block.text` -> append text block by `blockId`
- `tool_call` -> reuse existing `applyToolBlock()` logic for node blocks
- `async_status` -> `status: 'running'`
- `completed` -> `status: 'completed'; summary`
- `failed` -> `status: 'failed'; error`
- `cancelled` -> `status: 'cancelled'`

- [ ] **Step 5: Update transcript builders**

In `src/renderer/chat-transcript.ts`:

- Remove `SubagentPayload`, `isSubagentPayload()`, old `applySubagentBlock()`.
- Add `SubagentEventRecord` guard for payload shape:

```ts
type SubagentEventRecord = {
  identity: SubagentIdentity;
  event: SubagentEventPayload;
};
```

- In `buildPersistedTranscriptMessages()`, replace old event branches with:

```ts
    if (event.type === 'subagent_event' && isSubagentEventRecord(event.payload)) {
      applyStructuredSubagentBlock(getAssistantDraft(drafts, messages, event.runId), event.payload);
      continue;
    }
```

- In `buildLiveActivityBlocks()`, map `chatRunState.subagents` recursively.

- [ ] **Step 6: Run renderer tests**

Run: `pnpm test -- tests/renderer/chat-run-state.test.ts tests/renderer/chat-transcript.test.ts tests/renderer/use-chat-run.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/renderer/chat-run-state.ts src/renderer/chat-transcript.ts tests/renderer/chat-run-state.test.ts tests/renderer/chat-transcript.test.ts tests/renderer/use-chat-run.test.ts
git commit -m "feat: render structured subagent transcript state"
```

---

### Task 5: Subagent Tree UI

**Files:**
- Modify: `src/renderer/chat/chat-message-row.tsx`
- Modify: `src/renderer/styles/chat.css`
- Test: `tests/renderer/chat-message-row.test.ts`
- Test: `tests/renderer/chat-transcript-panel.test.tsx`

**Interfaces:**
- Consumes `ChatTranscriptActivityBlock` subagent arm from Task 4.
- Produces visible UI with `data-testid="chat-activity-subagent"` and nested `data-testid="chat-activity-subagent-child"`.

- [ ] **Step 1: Add failing UI test**

Add to `tests/renderer/chat-message-row.test.ts`:

```tsx
it('renders structured subagent tree with partial transcript and failed status', () => {
  render(
    <ChatMessageRow
      message={{
        key: 'assistant-subagent',
        role: 'assistant',
        content: '',
        reasoning: null,
        approval: null,
        isStreaming: false,
        blocks: [
          {
            id: 'subagent-root',
            kind: 'subagent',
            identity: {
              subagentId: 'subagent-root',
              parentSubagentId: null,
              name: 'research',
              depth: 0,
              path: ['research#0'],
              execution: 'sync',
              taskInput: 'Search docs'
            },
            status: 'failed',
            summary: null,
            error: 'remote failed',
            blocks: [
              {
                id: 'subagent-root-text',
                kind: 'text',
                content: 'partial'
              }
            ],
            children: []
          }
        ]
      }}
    />
  );

  expect(screen.getByTestId('chat-activity-subagent')).toHaveTextContent('research');
  expect(screen.getByTestId('chat-activity-subagent')).toHaveTextContent('failed');
  expect(screen.getByTestId('chat-activity-subagent')).toHaveTextContent('partial');
  expect(screen.getByTestId('chat-activity-subagent')).toHaveTextContent('remote failed');
});
```

- [ ] **Step 2: Run UI test and confirm red**

Run: `pnpm test -- tests/renderer/chat-message-row.test.ts`

Expected: FAIL because current `ChatActivityBlockView` expects `name`, `status`, `summary` only.

- [ ] **Step 3: Implement recursive subagent view**

In `src/renderer/chat/chat-message-row.tsx`, replace current subagent branch with:

```tsx
  if (block.kind === 'subagent') {
    return <SubagentActivityView block={block} />;
  }
```

Add:

```tsx
function SubagentActivityView({ block }: { block: Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }> }): React.JSX.Element {
  return (
    <details className="chat-bubble-activity chat-bubble-subagent" data-testid="chat-activity-subagent" open={block.status === 'failed'}>
      <summary>
        <span>{`子代理 · ${block.identity.name}`}</span>
        <span className={`subagent-status subagent-status--${block.status}`}>{block.status}</span>
      </summary>
      <div className="activity-body subagent-body">
        {block.summary === null ? null : <p>{block.summary}</p>}
        {block.error === null ? null : <pre className="subagent-error">{block.error}</pre>}
        {block.blocks.map((child) => (
          child.kind === 'text' ? (
            <StreamingMarkdownView key={child.id} text={child.content} isStreaming={block.status === 'started'} />
          ) : child.kind === 'reasoning' ? (
            <ReasoningBlock key={child.id} id={child.id} content={child.content} isStreaming={block.status === 'started'} />
          ) : (
            <ToolCallView key={child.id} block={child} />
          )
        ))}
        {block.children.map((child) => (
          <div key={child.id} data-testid="chat-activity-subagent-child">
            <SubagentActivityView block={child} />
          </div>
        ))}
      </div>
    </details>
  );
}
```

- [ ] **Step 4: Update CSS**

In `src/renderer/styles/chat.css`, keep `.chat-bubble-subagent` but add:

```css
.subagent-body {
  display: grid;
  gap: 8px;
}

.subagent-status {
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-muted);
}

.subagent-status--failed {
  color: var(--danger);
}

.subagent-error {
  white-space: pre-wrap;
  margin: 0;
  color: var(--danger);
}
```

- [ ] **Step 5: Run UI tests**

Run: `pnpm test -- tests/renderer/chat-message-row.test.ts tests/renderer/chat-transcript-panel.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/renderer/chat/chat-message-row.tsx src/renderer/styles/chat.css tests/renderer/chat-message-row.test.ts tests/renderer/chat-transcript-panel.test.tsx
git commit -m "feat: show structured subagent activity"
```

---

### Task 6: AsyncSubAgent Definition Support

**Files:**
- Modify: `src/main/services/deep-agent/types.ts`
- Modify: `src/main/services/deep-agent/tools.ts`
- Modify: `src/main/services/deep-agent/agent-builder.ts`
- Test: `tests/main/services/deep-agent/tools.test.ts`

**Interfaces:**
- Consumes DeepAgents `AnySubAgent`, `AsyncSubAgent`, and local reserved async task tool names.
- Produces `RuntimeSubagent = AnySubAgent`.
- Produces `validateRuntimeSubagents(subagents: readonly RuntimeSubagent[]): void`.

- [ ] **Step 1: Add failing tests for async subagent and reserved names**

Create or extend `tests/main/services/deep-agent/tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AsyncSubAgent } from 'deepagents';
import { createRunSubagents, validateRuntimeSubagents } from '../../../../src/main/services/deep-agent/tools';

describe('runtime subagents', () => {
  it('accepts DeepAgents AsyncSubAgent definitions', () => {
    const asyncAgent: AsyncSubAgent = {
      name: 'remote-research',
      description: 'Run long research on an Agent Protocol server.',
      graphId: 'research_graph',
      url: 'http://127.0.0.1:2024'
    };

    expect(() => validateRuntimeSubagents([asyncAgent])).not.toThrow();
  });

  it('rejects async task tool name collisions', () => {
    expect(() =>
      validateRuntimeSubagents([
        {
          name: 'start_async_task',
          description: 'Invalid collision.',
          graphId: 'bad_graph'
        }
      ])
    ).toThrow('subagent_name_reserved:start_async_task');
  });
});
```

- [ ] **Step 2: Run test and confirm red**

Run: `pnpm test -- tests/main/services/deep-agent/tools.test.ts`

Expected: FAIL because `validateRuntimeSubagents()` is missing and `RuntimeSubagent` only supports `SubAgent`.

- [ ] **Step 3: Update runtime subagent type**

In `src/main/services/deep-agent/types.ts`, replace:

```ts
import type { ExecuteResponse, SubAgent } from 'deepagents';
```

with:

```ts
import type { AnySubAgent, ExecuteResponse } from 'deepagents';
```

Replace:

```ts
export type RuntimeSubagent = SubAgent;
```

with:

```ts
export type RuntimeSubagent = AnySubAgent;
```

- [ ] **Step 4: Add subagent validation**

In `src/main/services/deep-agent/tools.ts`, add:

```ts
const asyncTaskToolNames = [
  'start_async_task',
  'check_async_task',
  'update_async_task',
  'cancel_async_task',
  'list_async_tasks'
] as const;

const reservedSubagentNames = new Set<string>(asyncTaskToolNames);

export function validateRuntimeSubagents(subagents: readonly RuntimeSubagent[]): void {
  const seen = new Set<string>();
  for (const subagent of subagents) {
    if (reservedSubagentNames.has(subagent.name)) {
      throw new Error(`subagent_name_reserved:${subagent.name}`);
    }
    if (seen.has(subagent.name)) {
      throw new Error(`subagent_name_duplicate:${subagent.name}`);
    }
    seen.add(subagent.name);
    if (subagent.description.trim().length === 0) {
      throw new Error(`subagent_description_empty:${subagent.name}`);
    }
    if ('graphId' in subagent && subagent.graphId.trim().length === 0) {
      throw new Error(`subagent_graph_id_empty:${subagent.name}`);
    }
  }
}
```

At end of `createRunSubagents()` before return:

```ts
  validateRuntimeSubagents(subagents);
```

- [ ] **Step 5: Run tests**

Run: `pnpm test -- tests/main/services/deep-agent/tools.test.ts`

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS or only renderer failures from unimplemented prior tasks if task order was not followed. If task order was followed, PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/main/services/deep-agent/types.ts src/main/services/deep-agent/tools.ts tests/main/services/deep-agent/tools.test.ts
git commit -m "feat: accept validated async subagents"
```

---

### Task 7: IPC Generation And Legacy Cleanup

**Files:**
- Modify: `src/shared/ipc-generated.ts` through generation.
- Modify tests containing old strings.
- Test: repository-wide grep and strict unused scan.

**Interfaces:**
- Consumes all previous tasks.
- Produces no old subagent event references outside spec and plan docs.

- [ ] **Step 1: Generate IPC schema**

Run: `pnpm generate:ipc`

Expected: `src/shared/ipc-generated.ts` updates if schema changed.

- [ ] **Step 2: Run cleanup grep**

Run:

```powershell
rg -n "subagent_started|subagent_completed|SubagentPayload|ChatRunSubagentState|event\\.subagent|event\\.status|event\\.summary" src tests
```

Expected: no matches. If matches remain, remove them by replacing with structured `identity` / `event` usage from Tasks 1-5.

- [ ] **Step 3: Run IPC check**

Run: `pnpm check:ipc`

Expected: PASS.

- [ ] **Step 4: Run strict unused scan**

Run: `pnpm exec tsc --noEmit -p tsconfig.json --noUnusedLocals --noUnusedParameters`

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run:

```powershell
pnpm typecheck
pnpm test
git diff --check
```

Expected: all PASS.

- [ ] **Step 6: Commit cleanup**

```powershell
git add src tests
git commit -m "refactor: remove legacy subagent events"
```

---

## Self-Review Checklist

- Spec coverage:
  - DeepAgents-first harness: Task 2 keeps projection under existing DeepAgent executor; Task 6 keeps DeepAgents `AnySubAgent`.
  - Structured event model: Task 1.
  - Streaming recursive projection: Task 2.
  - Runtime persistence: Task 3.
  - Renderer live and persisted state: Task 4.
  - UI tree and error display: Task 5.
  - AsyncSubAgent acceptance and reserved name guard: Task 6.
  - No compatibility and cleanup: Task 7.
- Placeholder scan:
  - No open-ended placeholder steps.
  - Each task has exact files, commands, and expected results.
- Type consistency:
  - Shared types from Task 1 feed projection, runtime, renderer, and UI tasks.
  - `subagent_event` envelope shape is identical in chat events and task events.
