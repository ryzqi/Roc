import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

async function buildUsageEventModules() {
  const directory = mkdtempSync(join(tmpdir(), 'roc-run-usage-events-'));
  await build({
    entryPoints: {
      chatSchema: 'src/shared/schemas/chat.ts',
      eventLog: 'src/main/plugins/agent/run-event-log.ts',
      eventQueue: 'src/main/plugins/agent/chat-run-event-queue.ts',
      runState: 'src/renderer/assistant/run-state.ts',
      executionEvents: 'src/main/infrastructure/execution-events.ts'
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

function makeUsage(sequence) {
  return {
    tokens: { settled: sequence, unknown: 0, reserved: 10 },
    calls: {
      models: { total: sequence, reserved: 1 },
      tools: { total: 0, reserved: 0 },
      children: { total: 0, reserved: 0 }
    },
  };
}

test('run usage snapshots validate and survive durable event replay', async () => {
  const { directory, chatSchema, eventLog } = await buildUsageEventModules();
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE agent_runs(id TEXT, thread_id TEXT);
      CREATE TABLE agent_threads(id TEXT, research_project_id TEXT);
      CREATE TABLE research_task_executions(kind TEXT, execution_id TEXT, task_id TEXT);
      CREATE TABLE agent_run_events(
      run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL, created_at TEXT NOT NULL,
      event_bytes INTEGER NOT NULL CHECK(event_bytes >= 0), PRIMARY KEY(run_id, sequence));
      CREATE TABLE agent_run_event_cursors(
        run_id TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL,
        retained_count INTEGER NOT NULL DEFAULT 0, retained_bytes INTEGER NOT NULL DEFAULT 0,
        pending_count INTEGER NOT NULL DEFAULT 0, pending_bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE agent_run_event_snapshots(
        run_id TEXT PRIMARY KEY, through_sequence INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
        snapshot_bytes INTEGER NOT NULL CHECK(snapshot_bytes >= 0), updated_at TEXT NOT NULL);
      CREATE TABLE agent_run_event_snapshot_pending(
        run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL,
        event_bytes INTEGER NOT NULL CHECK(event_bytes >= 0), created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence));`);
    const log = new eventLog.AgentRunEventLog(db);
    const event = {
      type: 'run_usage',
      runId: 'run-usage-event',
      threadId: 'thread',
      usage: makeUsage(7)
    };
    assert.deepEqual(chatSchema.chatRunEventSchema.parse(event), event);
    const stored = log.recordRunEvent(event);
    assert.equal(stored.sequence, 1);
    assert.deepEqual(log.listRunEvents({ runId: event.runId, afterSequence: 0 }), [stored]);
    assert.throws(() => chatSchema.chatRunEventSchema.parse({ ...event, usage: { ...event.usage, tokens: { ...event.usage.tokens, settled: -1 } } }));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('renderer run state retains the latest replayed usage snapshot', async () => {
  const { directory, runState } = await buildUsageEventModules();
  try {
    const started = runState.applyChatRunEvent(runState.createEmptyChatRunState(), {
      type: 'run_started', runId: 'run-usage-state', mode: 'run', threadId: 'thread',
      providerId: 'provider', modelId: 'model', createdAt: new Date().toISOString()
    });
    assert.equal(started.usage, null);
    const usage = makeUsage(11);
    const state = runState.applyChatRunEvent(started, {
      type: 'run_usage', runId: 'run-usage-state', threadId: 'thread', usage
    });
    assert.deepEqual(state.usage, usage);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('event queue keeps the latest usage at its chronological queue position', async () => {
  const { directory, eventQueue } = await buildUsageEventModules();
  try {
    const queue = eventQueue.createChatRunEventQueue({ maxEvents: 3 });
    const runStarted = {
      type: 'run_started', runId: 'run-usage-queue', mode: 'run', threadId: 'thread',
      providerId: 'provider', modelId: 'model', createdAt: new Date().toISOString()
    };
    queue.push(runStarted);
    queue.push({ type: 'run_usage', runId: runStarted.runId, threadId: 'thread', usage: makeUsage(1) });
    queue.push({
      type: 'assistant_block', runId: runStarted.runId,
      block: { kind: 'text', blockId: 'text', phase: 'complete', text: 'completed' }
    });
    assert.equal(queue.push({ type: 'run_usage', runId: runStarted.runId, threadId: 'thread', usage: makeUsage(2) }), true);
    assert.equal(queue.stats().queuedEventCount, 3);
    queue.close();
    const events = [];
    for await (const event of queue) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['run_started', 'assistant_block', 'run_usage']);
    assert.equal(events[2].usage.tokens.settled, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('event queue enforces per-event, aggregate byte and count bounds', async () => {
  const { directory, eventQueue } = await buildUsageEventModules();
  try {
    const runStarted = {
      type: 'run_started', runId: 'run-usage-bounds', mode: 'run', threadId: 'thread',
      providerId: 'provider', modelId: 'model', createdAt: '2026-10-30T00:00:00.000Z'
    };
    const eventBytes = Buffer.byteLength(JSON.stringify(runStarted));

    const oversizedQueue = eventQueue.createChatRunEventQueue({
      maxEvents: 4, maxBytes: eventBytes, maxEventBytes: eventBytes - 1
    });
    assert.equal(oversizedQueue.push(runStarted), false);
    await assert.rejects(oversizedQueue[Symbol.asyncIterator]().next(), /chat_run_event_queue_event_too_large/);

    const byteLimitedQueue = eventQueue.createChatRunEventQueue({
      maxEvents: 4, maxBytes: eventBytes + 1, maxEventBytes: eventBytes
    });
    assert.equal(byteLimitedQueue.push(runStarted), true);
    assert.equal(byteLimitedQueue.push(runStarted), false);
    const byteIterator = byteLimitedQueue[Symbol.asyncIterator]();
    assert.equal((await byteIterator.next()).done, false);
    await assert.rejects(byteIterator.next(), /chat_run_event_queue_byte_overflow/);

    const countLimitedQueue = eventQueue.createChatRunEventQueue({ maxEvents: 1 });
    assert.equal(countLimitedQueue.push(runStarted), true);
    assert.equal(countLimitedQueue.push(runStarted), false);
    const countIterator = countLimitedQueue[Symbol.asyncIterator]();
    assert.equal((await countIterator.next()).done, false);
    await assert.rejects(countIterator.next(), /chat_run_event_queue_overflow/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
