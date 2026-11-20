import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { ChatReplayStore, rendererReplayByteBudget, setRendererResourcePolicy, rendererCachesShouldReclaim, subscribeRendererResourcePolicy,
  rendererPdfShouldReclaim, subscribeRendererPdfPolicy, selectedPdfHiddenGraceMs } =
  await importTypeScriptModule('tests/unit/fixtures/renderer-resource-budget-test-kit.ts', {platform: 'node'});
const event = (runId, sequence, type = 'text_delta') => ({
  runId, sequence, event: {type, runId, text: 'explicit synthetic content', content: 'x'.repeat(1000)}
});

for (const trigger of ['hidden', 'pressure']) {
  test(`${trigger} reclaims completed replay bytes and preserves active events plus recovery watermarks`, () => {
    setRendererResourcePolicy({hidden: false, pressure: false});
    const first = new ChatReplayStore(), second = new ChatReplayStore();
    try {
      first.remember(event('finished', 1));
      first.remember(event('finished', 2, 'run_completed'));
      second.remember(event('active', 1));
      const active = [...second.events('active')];
      assert.ok(rendererReplayByteBudget.snapshot().completedBytes > 0);
      setRendererResourcePolicy({[trigger]: true});
      assert.equal(rendererReplayByteBudget.snapshot().completedBytes, 0);
      assert.deepEqual([...second.events('active')], active);
      assert.equal(first.stats('finished').droppedThroughSequence, 2);
      second.remember(event('active', 2, 'run_completed'));
      assert.equal(rendererReplayByteBudget.snapshot().storedBytes, 0, 'runs finishing while hidden must release immediately');
      assert.equal(second.stats('active').droppedThroughSequence, 2);
      second.remember(event('active', 3, 'run_resumed'));
      assert.equal(second.stats('active').completed, false);
      assert.equal([...second.events('active')][0].sequence, 3);
    } finally {
      first.clear(); second.clear();
      setRendererResourcePolicy({hidden: false, pressure: false});
    }
  });
}

test('resource policy reports recovery only after both hidden and pressure reasons clear', () => {
  setRendererResourcePolicy({hidden: false, pressure: false});
  const states = [];
  const unsubscribe = subscribeRendererResourcePolicy(() => states.push(rendererCachesShouldReclaim()));
  try {
    setRendererResourcePolicy({pressure: true});
    setRendererResourcePolicy({hidden: true});
    setRendererResourcePolicy({pressure: false});
    setRendererResourcePolicy({hidden: false});
    assert.deepEqual(states, [true, false]);
  } finally {unsubscribe(); setRendererResourcePolicy({hidden: false, pressure: false});}
});

test('selected PDF grace has one deadline, reopening cancels it and pressure bypasses it', t => {
  setRendererResourcePolicy({hidden: false, pressure: false});
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [], unsubscribe = subscribeRendererPdfPolicy(() => states.push(rendererPdfShouldReclaim()));
  try {
    setRendererResourcePolicy({hidden: true});
    assert.equal(rendererCachesShouldReclaim(), true);
    assert.equal(rendererPdfShouldReclaim(), false);
    t.mock.timers.tick(selectedPdfHiddenGraceMs - 1000);
    setRendererResourcePolicy({hidden: true});
    t.mock.timers.tick(1000);
    assert.equal(rendererPdfShouldReclaim(), true, 'repeated snapshots must not extend the deadline');
    setRendererResourcePolicy({hidden: false});
    assert.equal(rendererPdfShouldReclaim(), false);
    setRendererResourcePolicy({hidden: true});
    t.mock.timers.tick(10_000);
    setRendererResourcePolicy({hidden: false});
    t.mock.timers.tick(selectedPdfHiddenGraceMs);
    assert.equal(rendererPdfShouldReclaim(), false, 'a canceled timer cannot reclaim a reopened PDF');
    setRendererResourcePolicy({hidden: true, pressure: true});
    assert.equal(rendererPdfShouldReclaim(), true);
    setRendererResourcePolicy({pressure: false});
    assert.equal(rendererPdfShouldReclaim(), false);
    t.mock.timers.tick(selectedPdfHiddenGraceMs);
    assert.equal(rendererPdfShouldReclaim(), true);
    assert.deepEqual(states, [true, false, true, false, true]);
  } finally {
    unsubscribe();
    setRendererResourcePolicy({hidden: false, pressure: false});
    t.mock.timers.reset();
  }
});

test('native and document visibility share the original PDF grace until both are visible', async t => {
  const previous = globalThis.document, document = new EventTarget();
  document.visibilityState = 'visible';
  globalThis.document = document;
  const policy = await importTypeScriptModule('src/renderer/shared/renderer-resource-budget.ts', {platform: 'node'});
  t.mock.timers.enable({apis: ['setTimeout']});
  try {
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    t.mock.timers.tick(20_000);
    policy.setRendererResourcePolicy({hidden: true});
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(policy.rendererCachesShouldReclaim(), true);
    t.mock.timers.tick(10_000);
    assert.equal(policy.rendererPdfShouldReclaim(), true);
    policy.setRendererResourcePolicy({hidden: false});
    assert.equal(policy.rendererPdfShouldReclaim(), false);
    assert.equal(policy.rendererCachesShouldReclaim(), false);
  } finally {
    policy.setRendererResourcePolicy({hidden: false, pressure: false});
    t.mock.timers.reset();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
