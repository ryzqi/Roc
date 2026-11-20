import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

let api;
before(async () => { api = await importTypeScriptModule('tests/fixtures/research-provider-test-api.ts', { platform: 'node' }); });
const turn = () => new Promise(resolve => setImmediate(resolve));
function failures(error) {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
}

test('one lifecycle waits startup during shutdown and releases services acquired after the close request', async () => {
  const lifecycle = new api.ResearchPluginLifecycle(), order = [];
  let release, starts = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const startup = lifecycle.initialize(async () => {
    starts++;
    await gate;
    lifecycle.own('stageRuntime', { shutdown: async () => { order.push('parent'); } });
    lifecycle.ownBackgroundServices(['cards', 'wiki', 'knowledge'].map(name => ({
      shutdown: async () => { order.push(name); }
    })));
    lifecycle.own('reviewSearch', { shutdown: async () => { order.push('review'); } });
    lifecycle.own('library', { shutdown: async () => { order.push('library'); } });
  });
  assert.equal(lifecycle.initialize(async () => { throw new Error('duplicate_startup'); }), startup);
  assert.equal(starts, 1);
  const rejectedStartup = assert.rejects(startup, /research_capability_provider_closed/);
  let finished = false;
  const closing = lifecycle.shutdown().then(() => { finished = true; });
  await turn();
  assert.equal(finished, false);
  assert.deepEqual(order, []);
  await assert.rejects(lifecycle.initialize(async () => {}), /research_capability_provider_closed/);
  release();
  await Promise.all([rejectedStartup, closing]);
  assert.deepEqual(order, ['parent', 'cards', 'wiki', 'knowledge', 'review', 'library']);
  assert.deepEqual(lifecycle.health(), { status: 'unhealthy', reason: 'research_plugin_not_initialized' });
  await lifecycle.shutdown();
  assert.equal(order.length, 6);
});

test('parent abort precedes actual provider closure and every background/root cleanup is attempted after failures', async () => {
  const lifecycle = new api.ResearchPluginLifecycle(), order = [], controller = new AbortController();
  const registry = new api.CapabilityRegistry();
  const descriptor = {
    name: 'research.fixture.lifecycle', version: '1.0.0',
    inputSchema: api.z.strictObject({}), outputSchema: api.z.string()
  };
  registry.declare('fixture', descriptor);
  const context = { pluginId: 'fixture', capabilities: registry, logger: { info() {} } };
  const parentReason = new Error('actual_parent_abort'), childFailure = new Error('child_cleanup_failed');
  const cardFailure = new Error('cards_cleanup_failed'), reviewFailure = new Error('review_cleanup_failed');
  let provider, pendingTool;
  await lifecycle.initialize(async () => {
    provider = lifecycle.provide(context, 'documents', [descriptor], child => {
      child.capabilities.register('fixture', descriptor, async () => await new Promise((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      }));
    }, async () => {
      assert.equal(controller.signal.aborted, true);
      order.push('child');
      throw childFailure;
    });
    lifecycle.own('stageRuntime', { shutdown: async () => {
      order.push('parent-abort');
      controller.abort(parentReason);
      await pendingTool;
    } });
    lifecycle.ownBackgroundServices([
      { shutdown: async () => { order.push('cards'); throw cardFailure; } },
      { shutdown: async () => { order.push('wiki'); } },
      { shutdown: async () => { order.push('knowledge'); } }
    ]);
    lifecycle.own('reviewSearch', { shutdown: async () => { order.push('review'); throw reviewFailure; } });
    lifecycle.own('literature', { shutdown: async () => { order.push('literature'); } });
    lifecycle.own('library', { shutdown: async () => { order.push('library'); } });
  });
  await provider.get();
  pendingTool = assert.rejects(registry.invoke(descriptor.name, {}), parentReason);
  await turn();
  await assert.rejects(lifecycle.shutdown(), error => {
    assert.equal(error.message, 'research_shutdown_failed');
    assert.deepEqual(failures(error), [cardFailure, reviewFailure, childFailure]);
    return true;
  });
  await pendingTool;
  assert.deepEqual(order, ['parent-abort', 'cards', 'wiki', 'knowledge', 'review', 'literature', 'child', 'library']);
  await assert.rejects(registry.invoke(descriptor.name, {}), /research_capability_provider_closed/);
  await lifecycle.shutdown();
  assert.equal(order.length, 8);
});

test('failed startup keeps its original error and owns partial eager services for later cleanup', async () => {
  const lifecycle = new api.ResearchPluginLifecycle(), failure = new Error('partial_startup_failed');
  let stops = 0;
  const service = { shutdown: async () => { stops++; } };
  const startup = lifecycle.initialize(async () => {
    assert.equal(lifecycle.own('library', service), service);
    assert.throws(() => lifecycle.own('library', service), /research_service_already_owned/);
    throw failure;
  });
  await assert.rejects(startup, failure);
  assert.equal(lifecycle.initialize(async () => {}), startup);
  assert.deepEqual(lifecycle.health(), { status: 'unhealthy', reason: 'research_plugin_not_initialized' });
  await lifecycle.shutdown();
  assert.equal(stops, 1);
});
