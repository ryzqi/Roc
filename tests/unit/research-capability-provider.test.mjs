import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

let api;
before(async () => { api = await importTypeScriptModule('tests/fixtures/research-provider-test-api.ts', { platform: 'node' }); });
function fixture(effectReceipt) {
  const registry = new api.CapabilityRegistry();
  const descriptor = {
    name: 'research.fixture.read', version: '1.0.0',
    inputSchema: api.z.strictObject({ text: api.z.string().transform(value => value.trim()) }),
    outputSchema: api.z.string(),
    ...(effectReceipt === undefined ? {} : { effectReceipt })
  };
  registry.declare('fixture', descriptor);
  const observations = [];
  const context = { pluginId: 'fixture', capabilities: registry,
    logger: { info: (...args) => observations.push(args) } };
  return { registry, descriptor, context, observations };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('registry rejects invalid input before construction; simultaneous first calls share one provider', async () => {
  const f = fixture();
  let constructions = 0;
  const provider = new api.ResearchCapabilityProvider(f.context, 'fixture', [f.descriptor], async context => {
    constructions++;
    await turn();
    context.capabilities.register('fixture', f.descriptor, async input => input.text);
    return { ready: true };
  });
  await assert.rejects(f.registry.invoke(f.descriptor.name, { text: 42 }));
  assert.equal(constructions, 0);
  assert.deepEqual(await Promise.all(Array.from({ length: 24 }, () =>
    f.registry.invoke(f.descriptor.name, { text: ' parsed ' }))), Array(24).fill('parsed'));
  assert.equal(constructions, 1);
  assert.equal(f.registry.list()[0], f.descriptor);
  assert.equal(f.observations.length, 1);
  assert.deepEqual(provider.health(), { status: 'healthy' });
  await provider.close();
});

test('ready providers parse once and enter the handler before a caller can mutate shared-reference input', async () => {
  const f = fixture();
  const shared = { text: 'safe' };
  let parses = 0, observed;
  f.descriptor.inputSchema = api.z.custom(value => {
    parses++;
    return typeof value?.text === 'string';
  });
  const provider = new api.ResearchCapabilityProvider(f.context, 'fixture', [f.descriptor], context => {
    context.capabilities.register('fixture', f.descriptor, async input => { observed = input.text; return input.text; });
  });
  await provider.get();
  const result = f.registry.invoke(f.descriptor.name, shared);
  shared.text = 42;
  assert.equal(observed, 'safe');
  assert.equal(await result, 'safe');
  assert.equal(parses, 1);
  await provider.close();
});

test('initialization revalidates shared input after the await and rejects mutation before domain handling', async () => {
  const f = fixture();
  let entered, release, parses = 0, handled = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.descriptor.inputSchema = api.z.custom(value => {
    parses++;
    return typeof value?.text === 'string';
  });
  const provider = new api.ResearchCapabilityProvider(f.context, 'fixture', [f.descriptor], async context => {
    entered(); await gate;
    context.capabilities.register('fixture', f.descriptor, async input => { handled++; return input.text; });
  });
  const shared = { text: 'safe' };
  const rejected = assert.rejects(f.registry.invoke(f.descriptor.name, shared), { name: 'ZodError' });
  await started;
  shared.text = 42;
  release();
  await rejected;
  assert.equal(parses, 2);
  assert.equal(handled, 0);
  assert.equal(provider.health().status, 'healthy');
  await provider.close();
});

test('one cancelled initialization waiter does not cancel the shared provider or dispatch its domain handler', async () => {
  const f = fixture();
  let entered, release, handled = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const provider = new api.ResearchCapabilityProvider(f.context, 'fixture', [f.descriptor], async context => {
    entered(); await gate;
    context.capabilities.register('fixture', f.descriptor, async input => { handled++; return input.text; });
  });
  const controller = new AbortController(), reason = new Error('fixture_cancelled');
  const cancelled = assert.rejects(f.registry.invoke(f.descriptor.name, {text: 'cancelled'}, controller.signal), reason);
  const valid = f.registry.invoke(f.descriptor.name, {text: 'valid'});
  await started;
  controller.abort(reason);
  release();
  await cancelled;
  assert.equal(await valid, 'valid');
  assert.equal(handled, 1);
  await provider.close();
});

test('partial first failure is cleaned once; health remains unhealthy until a successful retry', async () => {
  const f = fixture();
  let attempts = 0, cleanups = 0;
  const failure = new Error('fixture_initialization_failed');
  const provider = new api.ResearchCapabilityProvider(f.context, 'fixture', [f.descriptor], async context => {
    attempts++;
    context.capabilities.register('fixture', f.descriptor, async input => input.text);
    await turn();
    if (attempts === 1) throw failure;
    return attempts;
  }, async () => { cleanups++; await turn(); });
  const first = await Promise.allSettled([provider.get(), provider.get()]);
  assert.ok(first.every(result => result.status === 'rejected' && result.reason === failure));
  assert.equal(cleanups, 1);
  assert.deepEqual(provider.health(), { status: 'unhealthy', reason: 'research_capability_initialization_failed:fixture' });
  assert.equal(await f.registry.invoke(f.descriptor.name, { text: 'retry' }), 'retry');
  assert.equal(attempts, 2);
  assert.deepEqual(provider.health(), { status: 'healthy' });
  await provider.close();
});

test('shutdown aborts and waits in-flight initialization, cleans partial state and blocks late handlers', async () => {
  const f = fixture();
  let release, started, cleanups = 0, handled = 0, signal;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const provider = new api.ResearchCapabilityProvider(f.context, 'fixture', [f.descriptor], async (context, inputSignal) => {
    signal = inputSignal; started();
    await gate;
    context.capabilities.register('fixture', f.descriptor, async () => { handled++; return 'late'; });
  }, async () => { cleanups++; });
  const invocation = assert.rejects(f.registry.invoke(f.descriptor.name, { text: 'late' }), /provider_closed/);
  await entered;
  let closed = false;
  const closing = provider.close().then(() => { closed = true; });
  await turn();
  assert.equal(signal.aborted, true);
  assert.equal(closed, false);
  release();
  await Promise.all([invocation, closing]);
  assert.equal(cleanups, 1);
  assert.equal(handled, 0);
  await assert.rejects(provider.get(), /provider_closed/);
  await assert.rejects(f.registry.invoke(f.descriptor.name, { text: 'again' }), /provider_closed/);
  assert.equal(cleanups, 1);
});

test('deferred handlers preserve the bound operation context and handler-owned receipt timing', async () => {
  const f = fixture('handler');
  let observedContext;
  const provider = new api.ResearchCapabilityProvider(f.context, 'fixture', [f.descriptor], async context => {
    await turn();
    context.capabilities.register('fixture', f.descriptor, async (input, operationContext) => {
      assert.equal(api.getCapabilityOperationContext(), operationContext);
      observedContext = operationContext;
      api.recordCapabilityOperationReceipt(operationContext);
      return input.text;
    });
  });
  const receipts = [];
  const operation = api.createCapabilityOperationContext({
    operationId: 'op', idempotencyKey: 'key', toolCallId: 'call', toolName: 'tool',
    canonicalToolIdentity: 'fixture', toolVersion: '1', attemptId: 'attempt', leaseGeneration: 1,
    recordReceipt: receipt => receipts.push(receipt)
  });
  await api.runWithCapabilityOperationContext(operation, () =>
    assert.rejects(f.registry.invoke(f.descriptor.name, { text: 7 })));
  assert.equal(receipts.length, 0);
  assert.equal(await api.runWithCapabilityOperationContext(operation, () =>
    f.registry.invoke(f.descriptor.name, { text: 'valid' })), 'valid');
  assert.equal(observedContext.operationId, operation.operationId);
  assert.equal(observedContext.capabilityName, f.descriptor.name);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].idempotencyKey, 'key');
  await provider.close();
});

test('descriptor substitution and incomplete initialization fail before a handler can run', async () => {
  for (const incomplete of [false, true]) {
    const f = fixture();
    const provider = new api.ResearchCapabilityProvider(f.context, 'fixture', [f.descriptor], context => {
      if (!incomplete) context.capabilities.register('fixture',
        { ...f.descriptor, inputSchema: api.z.strictObject({ text: api.z.string() }) }, async () => 'bad');
    });
    await assert.rejects(provider.get(), incomplete ? /provider_incomplete/ : /descriptor_mismatch/);
    assert.equal(provider.health().status, 'unhealthy');
    await provider.close();
  }
});

test('a failed cleanup is visible and cannot be retried into duplicate service instances', async () => {
  const f = fixture();
  let attempts = 0;
  const provider = new api.ResearchCapabilityProvider(f.context, 'fixture', [f.descriptor], () => {
    attempts++; throw new Error('first');
  }, async () => { throw new Error('cleanup'); });
  await assert.rejects(provider.get(), /cleanup_failed/);
  await assert.rejects(provider.get(), /cleanup_failed/);
  assert.equal(attempts, 1);
  assert.equal(provider.health().status, 'unhealthy');
  await assert.rejects(provider.close(), /cleanup_failed/);
});

test('shutdown awaits dependencies in order and still attempts every cleanup after failures', async () => {
  const order = [];
  const service = (name, fail = false) => ({ shutdown: async () => {
    order.push(`${name}:start`); await turn(); order.push(`${name}:end`);
    if (fail) throw new Error(name);
  } });
  await assert.rejects(api.shutdownResearchServices([service('parent', true), null, service('child')]), error => {
    assert.equal(error.errors.length, 1);
    return error.message === 'research_shutdown_failed';
  });
  assert.deepEqual(order, ['parent:start', 'parent:end', 'child:start', 'child:end']);
});
