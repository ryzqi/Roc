import assert from 'node:assert/strict';
import {test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {PythonEnvironmentLeases} = await importTypeScriptModule('src/main/plugins/research/python-environment-leases.ts', {platform: 'node'});
const signal = () => new AbortController().signal;
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Python readers share a workspace until final verification releases them; queued writer precedes new readers', async () => {
  const leases = new PythonEnvironmentLeases(), events = [];
  const first = await leases.acquire('/project', 'read', signal());
  const second = await leases.acquire('/project', 'read', signal());
  const writer = leases.acquire('/project', 'write', signal()).then(release => {events.push('writer'); return release;});
  const reader = leases.acquire('/project', 'read', signal()).then(release => {events.push('reader'); return release;});
  await tick(); assert.deepEqual(events, []);
  first(); first(); await tick(); assert.deepEqual(events, []);
  second(); const releaseWriter = await writer; assert.deepEqual(events, ['writer']);
  await tick(); assert.deepEqual(events, ['writer']);
  releaseWriter(); const releaseReader = await reader; assert.deepEqual(events, ['writer', 'reader']);
  releaseReader();
});

test('cancelling a queued preparation neither releases a live reader nor blocks following readers', async () => {
  const leases = new PythonEnvironmentLeases(), controller = new AbortController();
  const first = await leases.acquire('/project', 'read', signal());
  const pending = leases.acquire('/project', 'write', controller.signal);
  const rejected = assert.rejects(pending, /cancel preparation/u);
  const following = leases.acquire('/project', 'read', signal());
  controller.abort(new Error('cancel preparation')); await rejected;
  const second = await following;
  let acquired = false;
  const writer = leases.acquire('/project', 'write', signal()).then(release => {acquired = true; return release;});
  first(); await tick(); assert.equal(acquired, false);
  second(); (await writer)();
});

test('workspace locks are independent and cancelled waiters cannot acquire after release', async () => {
  const leases = new PythonEnvironmentLeases(), controller = new AbortController();
  const first = await leases.acquire('/project-a', 'write', signal());
  const other = await leases.acquire('/project-b', 'write', signal());
  const waiting = leases.acquire('/project-a', 'read', controller.signal);
  const rejected = assert.rejects(waiting, /reader cancelled/u);
  controller.abort(new Error('reader cancelled')); await rejected;
  first(); other();
  const fresh = await leases.acquire('/project-a', 'write', signal()); fresh();
  assert.throws(() => leases.acquire('/project-a', 'read', controller.signal), /reader cancelled/u);
});
