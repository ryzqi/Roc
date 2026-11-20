import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

let replay, legacy, encodingCalls = 0;
before(async () => {
  const NativeTextEncoder = globalThis.TextEncoder;
  globalThis.TextEncoder = class extends NativeTextEncoder {
    encode(value) {
      encodingCalls += 1;
      return super.encode(value);
    }
  };
  try {
    replay = await importTypeScriptModule('src/renderer/assistant/replay-tail-store.ts');
  } finally {
    globalThis.TextEncoder = NativeTextEncoder;
  }
  legacy = await importTypeScriptModule('tests/fixtures/chat-replay-legacy.ts');
});

function event(runId, sequence, text = 'x', type = 'assistant_block') {
  return { runId, sequence, createdAt: 'now', event: type === 'assistant_block'
    ? {type, runId, block: {kind: 'text', blockId: 'text', phase: 'delta', text}}
    : {type, runId} };
}
const size = value => Buffer.byteLength(JSON.stringify(value));

test('active FIFO tail matches the frozen implementation through byte and 10k-event eviction', () => {
  const budget = new replay.ReplayByteBudget();
  const current = new replay.ChatReplayStore(budget);
  const old = new legacy.ChatReplayStore(new legacy.ReplayByteBudget());
  encodingCalls = 0;
  for (let sequence = 1; sequence <= 12_050; sequence++) {
    const item = event('active', sequence, `中🙂/${sequence}:`.padEnd(900, 'x'));
    current.remember(item);
    old.remember(item);
  }
  assert.equal(encodingCalls, 12_050, 'the production encoder runs once per ingress event');
  assert.deepEqual([...current.events('active')], [...old.events('active')]);
  const {completed, ...stats} = current.stats('active');
  assert.equal(completed, false);
  assert.deepEqual(stats, old.stats('active'));
  assert.ok(stats.droppedThroughSequence > 0);
  current.clear();
  assert.equal(budget.snapshot().storedBytes, 0);
});

test('64 completed runs share one bounded budget and active events survive completed-tail eviction', () => {
  const budget = new replay.ReplayByteBudget(1200);
  const limits = {activeBytes: 1000, completedBytes: 500};
  const first = new replay.ChatReplayStore(budget, limits);
  const second = new replay.ChatReplayStore(budget, limits);
  const active = event('active', 1, 'active'.repeat(30));
  first.remember(active);
  for (let index = 0; index < 64; index++) {
    second.remember(event(`done-${index}`, 1, 'past'.repeat(40)));
    second.remember(event(`done-${index}`, 2, '', 'run_completed'));
    assert.ok(budget.snapshot().storedBytes <= 1200);
    assert.ok(second.stats(`done-${index}`).storedBytes <= 500);
  }
  assert.deepEqual([...first.events('active')], [active]);
  const oldest = second.stats('done-0');
  assert.equal(oldest.eventCount, 0);
  assert.equal(oldest.droppedThroughSequence, 2, 'global eviction keeps the empty tail watermark');
  second.remember(event('done-64', 1, '', 'run_completed'));
  assert.equal(second.stats('done-0'), null, 'the local run count remains bounded including empty tails');
  const beforeReset = budget.snapshot().storedBytes;
  second.clear();
  assert.ok(budget.snapshot().storedBytes < beforeReset);
  assert.equal(budget.snapshot().storedBytes, size(active));
  first.clear();
  assert.equal(budget.snapshot().tailCount, 0);
});

test('completion tightens the run limit while continuation restores the active limit', () => {
  const budget = new replay.ReplayByteBudget(3000);
  const store = new replay.ChatReplayStore(budget, {activeBytes: 1800, completedBytes: 350});
  store.remember(event('run', 1, '', 'run_started'));
  assert.equal(store.stats('run').completed, false, 'run_started is a flush boundary, not completion');
  for (let sequence = 2; sequence <= 5; sequence++) store.remember(event('run', sequence, 'x'.repeat(200)));
  const activeBytes = store.stats('run').storedBytes;
  store.setCompleted('run', true);
  assert.ok(store.stats('run').storedBytes <= 350);
  store.remember(event('run', 6, '', 'run_continued'));
  store.remember(event('run', 7, 'y'.repeat(800)));
  assert.equal(store.stats('run').completed, false);
  assert.ok(store.stats('run').storedBytes > 350);
  assert.ok(activeBytes > 350);
  store.setCompleted('run', true);
  budget.reclaimCompleted();
  assert.equal(store.stats('run').storedBytes, 0);
  assert.equal(store.stats('run').droppedThroughSequence, 7);
  assert.equal(budget.snapshot().storedBytes, 0);
  store.remember(event('run', 8, '', 'run_resumed'));
  assert.equal(store.stats('run').completed, false);
  assert.deepEqual([...store.events('run')].map(item => item.sequence), [8]);
  store.clear();
});

test('oversized ingress and mutated event objects cannot corrupt saved byte accounting', () => {
  const budget = new replay.ReplayByteBudget(1000);
  const store = new replay.ChatReplayStore(budget, {activeBytes: 600, completedBytes: 300});
  const mutable = event('run', 1, 'short');
  store.remember(mutable);
  const originalBytes = size(mutable);
  mutable.event.block.text = 'mutated'.repeat(1000);
  assert.equal(budget.snapshot().storedBytes, originalBytes);
  store.remember(event('run', 2, 'huge'.repeat(1000)));
  assert.equal(budget.snapshot().storedBytes, 0);
  assert.deepEqual([...store.events('run')], []);
  assert.equal(store.stats('run').droppedThroughSequence, 2);
  store.clear();
  store.remember(event('new', 1));
  assert.ok(budget.snapshot().storedBytes > 0, 'clear does not permanently dispose a StrictMode store');
  store.clear();
});
