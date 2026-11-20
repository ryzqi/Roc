import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { PerformanceObserverService } = await importTypeScriptModule('src/main/services/performance-observer-service.ts', { platform: 'node' });
const { observeDatabase } = await importTypeScriptModule('src/main/infrastructure/observe-database.ts', { platform: 'node' });

test('observation bounds samples/templates and distinguishes reused process IDs', () => {
  const observer = new PerformanceObserverService({ maxSamples: 3, maxSqlTemplates: 2, sqlSampleEvery: 2 });
  for (let index = 0; index < 8; index++) observer.observeSql('isolated', `hash-${index}`, () => index);
  for (const creationTime of [1, 2]) observer.record({
    phase: 'worker_query', label: 'query', pid: 42, creationTime, workload: 'worker',
    startedAtMs: 0, durationMs: 2, queueWaitMs: 1, workerMs: 2, memoryPeakBytes: 100,
    metadata: {}
  });
  const snapshot = observer.getSnapshot();
  assert.equal(snapshot.samples.length, 3);
  assert.equal(snapshot.sql.length, 2);
  assert.deepEqual(snapshot.operations.filter(item => item.pid === 42).map(item => item.creationTime), [1, 2]);
});

test('native SQLite bind/pluck/raw and transaction variants preserve behavior and rollback', () => {
  const db = new Database(':memory:');
  const observer = new PerformanceObserverService({ sqlSampleEvery: 2 });
  observeDatabase(db, 'fixture', observer);
  try {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, payload TEXT)');
    const insert = db.prepare('INSERT INTO items VALUES (?, ?)');
    const transaction = db.transaction((id) => insert.run(id, 'private-paper-body'));
    transaction.deferred(1);
    transaction.immediate(2);
    transaction.exclusive(3);
    const failed = db.transaction(() => { insert.run(4, 'secret'); insert.run(1, 'duplicate'); });
    assert.throws(failed, { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
    assert.deepEqual(db.prepare('SELECT id FROM items ORDER BY id').pluck().all(), [1, 2, 3]);
    assert.deepEqual(db.prepare('SELECT id FROM items WHERE id = ?').bind(2).raw().get(), [2]);
    assert.equal(db.prepare('SELECT count(*) FROM items').pluck().get(), 3);
    const snapshot = observer.getSnapshot();
    assert.equal(snapshot.sql.find(item => item.calls === 5).failures, 1);
    assert.ok(!JSON.stringify(snapshot).includes('private-paper-body'));
    assert.ok(!JSON.stringify(snapshot).includes('INSERT INTO'));
    assert.ok(!JSON.stringify(snapshot).includes('secret'));
  } finally { db.close(); }
});

test('iterate measures SQLite steps and releases native cursor on early return', () => {
  const db = new Database(':memory:');
  const observer = new PerformanceObserverService({ sqlSampleEvery: 1 });
  observeDatabase(db, 'fixture', observer);
  try {
    const statement = db.prepare('SELECT 1 AS id UNION ALL SELECT 2');
    const iterator = statement.iterate();
    assert.deepEqual(iterator.next().value, { id: 1 });
    assert.equal(statement.busy, true);
    assert.equal(iterator.return().done, true);
    assert.equal(statement.busy, false);
    assert.deepEqual([...statement.iterate()], [{ id: 1 }, { id: 2 }]);
    assert.equal(observer.getSnapshot().sql[0].calls, 4);
  } finally { db.close(); }
});

test('sampled IPC serialization identifies estimates and does not retain response content', () => {
  const observer = new PerformanceObserverService({ ipcSampleEvery: 2 });
  assert.deepEqual(observer.sampleIpcResponse({ secret: 'paper' }), { ipcByteMeasurement: 'unavailable' });
  const estimate = observer.sampleIpcResponse({ secret: 'paper' });
  assert.equal(estimate.ipcByteMeasurement, 'v8_serialized_estimate');
  assert.ok(estimate.ipcTransferBytes > 0 && estimate.ipcEncodeMs >= 0);
  observer.sampleIpcResponse({});
  assert.deepEqual(observer.sampleIpcResponse(() => {}), { ipcByteMeasurement: 'unavailable' });
  assert.ok(!JSON.stringify(observer.getSnapshot()).includes('paper'));
});

test('failed, cancelled and timed-out actions retain the original error and outcome', async () => {
  const observer = new PerformanceObserverService();
  const cancelled = new DOMException('cancelled', 'AbortError');
  const timedOut = new DOMException('deadline', 'TimeoutError');
  assert.throws(() => observer.measure('pdf_parse', 'parse', () => { throw cancelled; }), error => error === cancelled);
  await assert.rejects(observer.measureAsync('worker_query', 'query', async () => { throw timedOut; }), error => error === timedOut);
  assert.deepEqual(observer.getSnapshot().samples.map(item => item.outcome), ['cancelled', 'timed_out']);
});
