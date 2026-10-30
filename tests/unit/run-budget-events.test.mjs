import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

async function buildBudgetEventModules() {
  const directory = mkdtempSync(join(tmpdir(), 'roc-run-budget-events-'));
  await build({
    entryPoints: {
      chatSchema: 'src/shared/schemas/chat.ts',
      eventLog: 'src/main/plugins/agent/run-event-log.ts',
      eventQueue: 'src/main/plugins/agent/chat-run-event-queue.ts',
      runState: 'src/renderer/assistant/run-state.ts'
    },
    outdir: directory,
    bundle: true,
    format: 'esm',
    platform: 'node'
  });
  const [chatSchema, eventLog, eventQueue, runState] = await Promise.all([
    import(join(directory, 'chatSchema.js')),
    import(join(directory, 'eventLog.js')),
    import(join(directory, 'eventQueue.js')),
    import(join(directory, 'runState.js'))
  ]);
  return { directory, chatSchema, eventLog, eventQueue, runState };
}

function makeBudget(sequence) {
  return {
    tokens: { limit: 1000, settled: sequence, unknown: 0, reserved: 10, remaining: 990 - sequence },
    calls: {
      models: { limit: 10, total: sequence, reserved: 1 },
      tools: { limit: 20, total: 0, reserved: 0 },
      children: { limit: 2, total: 0, reserved: 0 }
    },
    cost: { state: 'unknown', limitMicrousd: null, settledMicrousd: 0, reservedMicrousd: null },
    pricingCatalogVersion: 'roc-pricing-2026-10-29-v1',
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    stopReason: null
  };
}

test('run budget snapshots validate and survive durable event replay', async () => {
  const { directory, chatSchema, eventLog } = await buildBudgetEventModules();
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE agent_run_events(run_id TEXT, sequence INTEGER, event_json TEXT, created_at TEXT,
      PRIMARY KEY(run_id, sequence)); CREATE TABLE agent_run_event_cursors(run_id TEXT PRIMARY KEY, next_sequence INTEGER);`);
    const log = new eventLog.AgentRunEventLog(db);
    const event = {
      type: 'run_budget',
      runId: 'run-budget-event',
      threadId: 'thread',
      budget: makeBudget(7)
    };
    assert.deepEqual(chatSchema.chatRunEventSchema.parse(event), event);
    const stored = log.recordRunEvent(event);
    assert.equal(stored.sequence, 1);
    assert.deepEqual(log.listRunEvents({ runId: event.runId, afterSequence: 0 }), [stored]);
    assert.throws(() => chatSchema.chatRunEventSchema.parse({ ...event, budget: { ...event.budget, tokens: { ...event.budget.tokens, remaining: -1 } } }));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('renderer run state retains the latest replayed budget snapshot', async () => {
  const { directory, runState } = await buildBudgetEventModules();
  try {
    const started = runState.applyChatRunEvent(runState.createEmptyChatRunState(), {
      type: 'run_started', runId: 'run-budget-state', mode: 'run', threadId: 'thread',
      providerId: 'provider', modelId: 'model', createdAt: new Date().toISOString()
    });
    assert.equal(started.budget, null);
    const budget = makeBudget(11);
    const state = runState.applyChatRunEvent(started, {
      type: 'run_budget', runId: 'run-budget-state', threadId: 'thread', budget
    });
    assert.deepEqual(state.budget, budget);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('event queue keeps the latest budget at its chronological queue position', async () => {
  const { directory, eventQueue } = await buildBudgetEventModules();
  try {
    const queue = eventQueue.createChatRunEventQueue({ maxEvents: 3 });
    const runStarted = {
      type: 'run_started', runId: 'run-budget-queue', mode: 'run', threadId: 'thread',
      providerId: 'provider', modelId: 'model', createdAt: new Date().toISOString()
    };
    queue.push(runStarted);
    queue.push({ type: 'run_budget', runId: runStarted.runId, threadId: 'thread', budget: makeBudget(1) });
    queue.push({
      type: 'assistant_block', runId: runStarted.runId,
      block: { kind: 'text', blockId: 'text', phase: 'complete', text: 'completed' }
    });
    assert.equal(queue.push({ type: 'run_budget', runId: runStarted.runId, threadId: 'thread', budget: makeBudget(2) }), true);
    assert.equal(queue.stats().queuedEventCount, 3);
    queue.close();
    const events = [];
    for await (const event of queue) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['run_started', 'assistant_block', 'run_budget']);
    assert.equal(events[2].budget.tokens.settled, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
