import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

function createEventLogSchema(db) {
  db.exec(`CREATE TABLE agent_run_events(
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
}

test('event log preserves exact retention, rollback recovery, sparse restore and replay pages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roc-event-log-'));
  const db = new Database(':memory:');
  try {
    const outfile = join(dir, 'log.mjs');
    await build({ entryPoints: ['src/main/plugins/agent/run-event-log.ts'], outfile, bundle: true, format: 'esm', platform: 'node' });
    const { AgentRunEventLog } = await import(outfile);
    createEventLogSchema(db);
    const log = new AgentRunEventLog(db);
    const event = { type: 'assistant_block', runId: 'run', block: { kind: 'text', blockId: 'text', phase: 'delta', text: 'x' } };
    const rollback = db.transaction(() => { log.recordRunEvent(event); throw new Error('rollback'); });
    assert.throws(rollback, /rollback/);
    assert.equal(log.recordRunEvent(event).sequence, 1);
    for (let i = 0; i < 10010; i++) log.recordRunEvent(event);
    const all = log.listRunEvents({ runId: 'run', afterSequence: 0 });
    assert.equal(all.length, 10000);
    assert.equal(all[0].sequence, 12);
    const durableReplay = log.replayRunEvents({ runId: 'run', afterSequence: 0, limit: 500 });
    assert.equal(durableReplay.kind, 'events');
    assert.equal(durableReplay.events[0].sequence, 1);
    const pages = [];
    let cursor = 0;
    while (true) {
      const page = log.listRunEvents({ runId: 'run', afterSequence: cursor, limit: 500 });
      pages.push(...page);
      if (page.length < 500) break;
      cursor = page.at(-1).sequence;
    }
    assert.deepEqual(pages, all);
    log.restoreRunEvent({ runId: 'sparse', sequence: 20000, eventJson: JSON.stringify({ ...event, runId: 'sparse' }), createdAt: 'now' });
    assert.equal(log.recordRunEvent({ ...event, runId: 'sparse' }).sequence, 20001);
    assert.equal(log.listRunEvents({ runId: 'sparse', afterSequence: 0 }).length, 2);
    const gapReplay = log.replayRunEvents({ runId: 'sparse', afterSequence: 0, limit: 500 });
    assert.equal(gapReplay.kind, 'replay_gap');
    assert.equal(gapReplay.snapshot.throughSequence, 19999);
    assert.equal(gapReplay.snapshot.historyComplete, false);
    assert.deepEqual(gapReplay.events.map((item) => item.sequence), [20000, 20001]);
    log.deleteForRunIds(['run']);
    assert.equal(log.recordRunEvent(event).sequence, 1);
    assert.equal(log.listRunEvents({ runId: 'run', afterSequence: 0 }).length, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('event log byte bounds, snapshot compaction and rollback are atomic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roc-event-log-bounds-'));
  const db = new Database(':memory:');
  try {
    const outfile = join(dir, 'log.mjs');
    await build({ entryPoints: ['src/main/plugins/agent/run-event-log.ts'], outfile, bundle: true, format: 'esm', platform: 'node' });
    const { AgentRunEventLog } = await import(outfile);
    createEventLogSchema(db);

    const log = new AgentRunEventLog(db, {
      maxEvents: 2,
      maxBytes: 1024,
      maxEventBytes: 512,
      maxPendingEvents: 1,
      maxPendingBytes: 1024,
      maxSnapshotBytes: 4096
    });
    const started = {
      type: 'run_started', runId: 'bounded', mode: 'run', threadId: 'thread',
      providerId: 'provider', modelId: 'model', createdAt: '2026-10-30T00:00:00.000Z'
    };
    const block = (text) => ({
      type: 'assistant_block', runId: 'bounded',
      block: { kind: 'text', blockId: `block-${text}`, phase: 'end', text }
    });
    log.recordRunEvent(started);
    log.recordRunEvent(block('one'));
    log.recordRunEvent(block('two'));
    log.recordRunEvent(block('three'));

    const compacted = log.replayRunEvents({ runId: 'bounded', afterSequence: 0, limit: 500 });
    assert.equal(compacted.kind, 'replay_gap');
    assert.equal(compacted.snapshot.throughSequence, 2);
    assert.equal(compacted.snapshot.historyComplete, true);
    assert.deepEqual(compacted.events.map((item) => item.sequence), [3, 4]);
    const cursor = db.prepare('SELECT retained_count, retained_bytes, pending_count, pending_bytes FROM agent_run_event_cursors WHERE run_id = ?').get('bounded');
    assert.ok(cursor.retained_count <= 2);
    assert.ok(cursor.retained_bytes <= 1024);
    assert.equal(cursor.pending_count, 0);
    assert.equal(cursor.pending_bytes, 0);

    const byteBoundedLog = new AgentRunEventLog(db, {
      maxEvents: 100,
      maxBytes: 500,
      maxEventBytes: 300,
      maxPendingEvents: 10,
      maxPendingBytes: 2000,
      maxSnapshotBytes: 4096
    });
    byteBoundedLog.recordRunEvent({ ...started, runId: 'byte-bounded' });
    for (let index = 0; index < 8; index += 1) {
      byteBoundedLog.recordRunEvent({
        type: 'assistant_block', runId: 'byte-bounded',
        block: { kind: 'text', blockId: `byte-${index}`, phase: 'end', text: 'x'.repeat(100) }
      });
    }
    const byteCursor = db.prepare('SELECT retained_bytes, pending_count, pending_bytes FROM agent_run_event_cursors WHERE run_id = ?').get('byte-bounded');
    assert.ok(byteCursor.retained_bytes <= 500);
    assert.ok(byteCursor.pending_count > 0);
    assert.ok(byteCursor.pending_bytes <= 2000);
    const byteReplay = byteBoundedLog.replayRunEvents({ runId: 'byte-bounded', afterSequence: 0, limit: 500 });
    assert.equal(byteReplay.kind, 'events');
    assert.equal(byteReplay.events.length, 9);

    const oversized = new AgentRunEventLog(db, { maxEvents: 2, maxBytes: 1024, maxEventBytes: 128 });
    assert.throws(() => oversized.recordRunEvent({
      type: 'assistant_block', runId: 'oversized',
      block: { kind: 'text', blockId: 'large', phase: 'delta', text: 'x'.repeat(512) }
    }), /agent_run_event_payload_too_large/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_run_event_cursors WHERE run_id = ?').get('oversized').count, 0);

    const rollbackLog = new AgentRunEventLog(db, {
      maxEvents: 1,
      maxBytes: 1024,
      maxEventBytes: 512,
      maxPendingEvents: 1,
      maxPendingBytes: 1024,
      maxSnapshotBytes: 1
    });
    rollbackLog.recordRunEvent({ ...started, runId: 'rollback-snapshot' });
    rollbackLog.recordRunEvent({ ...block('one'), runId: 'rollback-snapshot' });
    assert.throws(() => rollbackLog.recordRunEvent({ ...block('two'), runId: 'rollback-snapshot' }), /agent_run_event_snapshot_too_large/);
    const rollbackCursor = db.prepare('SELECT next_sequence, retained_count, pending_count FROM agent_run_event_cursors WHERE run_id = ?').get('rollback-snapshot');
    assert.deepEqual(rollbackCursor, { next_sequence: 3, retained_count: 1, pending_count: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_run_events WHERE run_id = ?').get('rollback-snapshot').count, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('event log reopens a persisted snapshot and replay tail after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roc-event-log-restart-'));
  const databasePath = join(dir, 'agent.db');
  let db = new Database(databasePath);
  try {
    const outfile = join(dir, 'log.mjs');
    await build({ entryPoints: ['src/main/plugins/agent/run-event-log.ts'], outfile, bundle: true, format: 'esm', platform: 'node' });
    const { AgentRunEventLog } = await import(outfile);
    createEventLogSchema(db);
    const options = {
      maxEvents: 2, maxBytes: 1024, maxEventBytes: 512,
      maxPendingEvents: 1, maxPendingBytes: 1024, maxSnapshotBytes: 4096
    };
    const log = new AgentRunEventLog(db, options);
    const started = {
      type: 'run_started', runId: 'restart', mode: 'run', threadId: 'thread',
      providerId: 'provider', modelId: 'model', createdAt: '2026-10-30T00:00:00.000Z'
    };
    const textEvent = (text) => ({
      type: 'assistant_block', runId: 'restart',
      block: { kind: 'text', blockId: `block-${text}`, phase: 'end', text }
    });
    log.recordRunEvent(started);
    log.recordRunEvent(textEvent('snapshot'));
    log.recordRunEvent(textEvent('tail-one'));
    log.recordRunEvent(textEvent('tail-two'));
    const beforeRestart = log.replayRunEvents({ runId: 'restart', afterSequence: 0, limit: 500 });
    assert.equal(beforeRestart.kind, 'replay_gap');
    assert.equal(beforeRestart.snapshot.throughSequence, 2);
    assert.deepEqual(beforeRestart.events.map((event) => event.sequence), [3, 4]);

    db.close();
    db = new Database(databasePath);
    const reopenedLog = new AgentRunEventLog(db, options);
    const afterRestart = reopenedLog.replayRunEvents({ runId: 'restart', afterSequence: 0, limit: 500 });
    assert.equal(afterRestart.kind, 'replay_gap');
    assert.equal(afterRestart.snapshot.throughSequence, 2);
    assert.equal(afterRestart.snapshot.state.runId, 'restart');
    assert.equal(afterRestart.snapshot.historyComplete, true);
    assert.deepEqual(afterRestart.events.map((event) => event.sequence), [3, 4]);
  } finally {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('event and snapshot storage faults fail closed and roll back sequence state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roc-event-log-fault-'));
  const db = new Database(':memory:');
  try {
    const outfile = join(dir, 'log.mjs');
    await build({ entryPoints: ['src/main/plugins/agent/run-event-log.ts'], outfile, bundle: true, format: 'esm', platform: 'node' });
    const { AgentRunEventLog } = await import(outfile);
    createEventLogSchema(db);
    const eventLog = new AgentRunEventLog(db);
    const event = (runId) => ({
      type: 'run_started', runId, mode: 'run', threadId: 'thread',
      providerId: 'provider', modelId: 'model', createdAt: '2026-10-30T00:00:00.000Z'
    });
    db.exec(`CREATE TRIGGER reject_event_insert BEFORE INSERT ON agent_run_events
      WHEN NEW.run_id = 'event-fault'
      BEGIN SELECT RAISE(ABORT, 'injected_event_insert_failure'); END;`);
    assert.throws(() => eventLog.recordRunEvent(event('event-fault')), /injected_event_insert_failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_run_events WHERE run_id = ?').get('event-fault').count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_run_event_cursors WHERE run_id = ?').get('event-fault').count, 0);
    db.exec('DROP TRIGGER reject_event_insert');
    assert.equal(eventLog.recordRunEvent(event('event-fault')).sequence, 1);

    const snapshotLog = new AgentRunEventLog(db, {
      maxEvents: 1, maxBytes: 1024, maxEventBytes: 512,
      maxPendingEvents: 1, maxPendingBytes: 1024, maxSnapshotBytes: 4096
    });
    const textEvent = (text) => ({
      type: 'assistant_block', runId: 'snapshot-fault',
      block: { kind: 'text', blockId: `fault-${text}`, phase: 'end', text }
    });
    snapshotLog.recordRunEvent(event('snapshot-fault'));
    snapshotLog.recordRunEvent(textEvent('one'));
    db.exec(`CREATE TRIGGER reject_snapshot_insert BEFORE INSERT ON agent_run_event_snapshots
      WHEN NEW.run_id = 'snapshot-fault'
      BEGIN SELECT RAISE(ABORT, 'injected_snapshot_insert_failure'); END;`);
    assert.throws(() => snapshotLog.recordRunEvent(textEvent('two')), /injected_snapshot_insert_failure/);
    const cursor = db.prepare('SELECT next_sequence, retained_count, pending_count FROM agent_run_event_cursors WHERE run_id = ?').get('snapshot-fault');
    assert.deepEqual(cursor, { next_sequence: 3, retained_count: 1, pending_count: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_run_event_snapshots WHERE run_id = ?').get('snapshot-fault').count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_run_events WHERE run_id = ?').get('snapshot-fault').count, 1);
    db.exec('DROP TRIGGER reject_snapshot_insert');
    assert.equal(snapshotLog.recordRunEvent(textEvent('two')).sequence, 3);
    const replay = snapshotLog.replayRunEvents({ runId: 'snapshot-fault', afterSequence: 0, limit: 500 });
    assert.equal(replay.kind, 'replay_gap');
    assert.equal(replay.snapshot.throughSequence, 2);
    assert.deepEqual(replay.events.map((item) => item.sequence), [3]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
