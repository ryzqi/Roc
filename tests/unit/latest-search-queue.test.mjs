import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const {LatestSearchQueue} = await importTypeScriptModule('src/renderer/literature/latest-search-queue.ts', {platform: 'node'});

function fixture() {
  const calls = [], finished = [], started = [];
  const queue = new LatestSearchQueue(request => new Promise(resolve => calls.push({request, resolve})),
    identity => started.push(identity), ticket => finished.push(ticket));
  return {queue, calls, finished, started};
}
const ok = data => ({ok: true, data});
const drain = async () => {await Promise.resolve(); await Promise.resolve();};

test('only one request runs while burst updates retain the latest waiting search and settle superseded callers', async () => {
  const f = fixture();
  f.queue.activate('first');
  const first = f.queue.run('first', 'first');
  f.queue.activate('middle');
  const middle = f.queue.run('middle', 'middle');
  f.queue.activate('latest');
  const latest = f.queue.run('latest', 'latest');
  assert.deepEqual(f.calls.map(call => call.request), ['first']);
  assert.equal(await first, null);
  assert.equal(await middle, null);
  f.calls[0].resolve(ok('old evidence'));
  await drain();
  assert.deepEqual(f.calls.map(call => call.request), ['first', 'latest']);
  assert.deepEqual(f.finished, []);
  f.calls[1].resolve(ok('current evidence'));
  const ticket = await latest;
  assert.equal(ticket.outcome.data, 'current evidence');
  assert.equal(f.queue.isCurrent(ticket), true);
  assert.equal(f.finished.length, 1);
});

test('explicit search coalesces with debounce and deduplicates only in the current generation', async () => {
  const f = fixture();
  f.queue.activate('query');
  const automatic = f.queue.run('query', 'automatic');
  const explicit = f.queue.run('query', 'explicit', true);
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve(ok('evidence'));
  assert.deepEqual(await explicit, await automatic);
  assert.equal(await f.queue.run('query', 'duplicate automatic'), null);
  f.queue.activate(null);
  f.queue.activate('query');
  const newGeneration = f.queue.run('query', 'new generation');
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve(ok('new generation receipt'));
  assert.equal((await newGeneration).outcome.data, 'new generation receipt');
  const retry = f.queue.run('query', 'fresh explicit', true);
  assert.equal(f.calls.length, 3);
  f.calls[2].resolve(ok('new receipt'));
  assert.equal((await retry).outcome.data, 'new receipt');
});

test('empty, composition, hidden, project and unmount invalidation discard late success/error and pending Ask receipts', async () => {
  for (const reason of ['empty', 'composition', 'hidden', 'project', 'unmount']) {
    const f = fixture();
    f.queue.activate('query');
    const pending = f.queue.run('query', reason, true);
    f.queue.invalidate();
    assert.equal(await pending, null, reason);
    f.calls[0].resolve(reason === 'hidden' ? {ok: false, error: 'old failure'} : ok('old success'));
    await drain();
    assert.deepEqual(f.finished, [], reason);
  }
});

test('reopening the same key does not revalidate a pre-cleanup request and current failures remain retryable', async () => {
  const f = fixture();
  f.queue.activate('query');
  const old = f.queue.run('query', 'pre-cleanup');
  f.queue.invalidate();
  f.queue.activate('query');
  const current = f.queue.run('query', 'after-cleanup');
  assert.equal(await old, null);
  f.calls[0].resolve(ok('old same-key receipt'));
  await drain();
  assert.equal(f.finished.length, 0);
  f.calls[1].resolve({ok: false, error: 'current failure'});
  assert.equal((await current).outcome.error, 'current failure');
  assert.equal(f.finished.length, 1);
  assert.equal(await f.queue.run('query', 'duplicate automatic failure'), null);
  const retry = f.queue.run('query', 'retry', true);
  assert.equal(f.calls.length, 3);
  f.calls[2].resolve(ok('retried'));
  const accepted = await retry;
  f.queue.invalidate();
  assert.equal(f.queue.isCurrent(accepted), false);
});

test('unexpected executor rejection and synchronous throw release the slot and keep later searches operable', async () => {
  let reject, call = 0;
  const finished = [];
  const queue = new LatestSearchQueue(request => {
    call++;
    if (request === 'reject') return new Promise((_, fail) => {reject = fail;});
    if (request === 'throw') throw new Error('synchronous failure');
    return Promise.resolve(ok(request));
  }, () => {}, ticket => finished.push(ticket));
  queue.activate('first');
  const first = queue.run('first', 'reject');
  queue.activate('second');
  const second = queue.run('second', 'recovered');
  reject(new Error('asynchronous failure'));
  assert.equal(await first, null);
  assert.equal((await second).outcome.data, 'recovered');
  queue.activate('third');
  const third = await queue.run('third', 'throw');
  assert.equal(third.outcome.error, 'synchronous failure');
  queue.activate('last');
  assert.equal((await queue.run('last', 'after throw')).outcome.data, 'after throw');
  assert.equal(call, 4);
  assert.equal(finished.length, 3);
});
