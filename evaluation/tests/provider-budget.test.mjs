import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BudgetController, createProvider, estimateChatInputTokens, validateProviderOptions } from '../lib/provider.mjs';

// Deliberately synthetic prices and transports. These tests never load Roc settings or a model.
const pricing = {
  schemaVersion: 1, version: 'fixture-pricing-v1', currency: 'USD',
  rates: [{ providerId: 'fixture-provider', model: 'model', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 }]
};
const request = (requestId = 'request-1', overrides = {}) => ({
  trialId: 'trial-1', requestId, requestHash: `hash-${requestId}`,
  providerId: 'fixture-provider', model: 'model', inputTokens: 10, outputTokens: 20, ...overrides
});
const binding = value => ({ trialId: value.trialId, requestHash: value.requestHash });
const signal = () => new AbortController().signal;
const config = (budget = {}, overrides = {}) => ({
  model: 'model', providerId: 'fixture-provider', temperature: 0, maxOutputTokens: 20,
  ...validateProviderOptions({ maxInputBytes: 1024, requestTimeoutMs: 1000, taskTimeoutMs: 5000, budget }),
  ...overrides
});
const body = { model: 'model', stream: false, max_tokens: 20, temperature: 0, messages: [] };
const response = usage => ({ choices: [{ message: { role: 'assistant', content: '{}' } }], ...(usage === undefined ? {} : { usage }) });
const knownUsage = { prompt_tokens: 5, completion_tokens: 3 };
const makeProvider = (options = {}, transport = async () => response(knownUsage), dependencies = {}) => {
  const events = [];
  const provider = createProvider(config(options), event => events.push(event), {
    complete: transport, estimateInputTokens: () => 10, ...dependencies
  });
  return { provider, events };
};
function dispatch(controller, input) {
  const reserved = controller.reserve(input);
  controller.dispatch(reserved.requestId, binding(reserved));
  return reserved;
}

test('provider options validate finite nested ceilings and preserve the legacy task timeout', () => {
  assert.equal(validateProviderOptions({ taskTimeoutMs: 5000 }).budget.maxTaskDurationMs, 5000);
  assert.equal(validateProviderOptions({ taskTimeoutMs: 5000, budget: { maxTaskDurationMs: 100 } }).budget.maxTaskDurationMs, 100);
  for (const key of ['maxModelRequests', 'maxInputTokens', 'maxOutputTokens', 'maxTaskDurationMs', 'maxRunDurationMs']) {
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateProviderOptions({ budget: { [key]: value } }));
    }
  }
  for (const value of [-1, NaN, Infinity]) assert.throws(() => validateProviderOptions({ budget: { maxEstimatedCostUsd: value, pricing } }));
  assert.throws(() => validateProviderOptions({ budget: { maxEstimatedCostUsd: 1 } }), /budget_pricing_required/);
  assert.throws(() => validateProviderOptions({ budget: { maxRequests: 1 } }));
  assert.throws(() => validateProviderOptions({ apiKey: 'sensitive' }));
});

test('request/input/output limits admit the exact boundary and reject before dispatch', async () => {
  for (const options of [{ maxModelRequests: 1 }, { maxInputTokens: 10 }, { maxOutputTokens: 20 }]) {
    let calls = 0;
    const { provider, events } = makeProvider(options, async () => { calls++; return response(); });
    await provider.complete(body, signal(), { trialId: 'trial-1', requestId: 'one' });
    assert.equal(calls, 1);
    await assert.rejects(provider.complete(body, signal(), { trialId: 'trial-2', requestId: 'two' }), /budget_max_/);
    assert.equal(calls, 1);
    assert.equal(events.at(-1).type, 'budget_rejected');
    assert.equal(events.at(-1).state, 'rejected');
    assert.match(events.at(-1).reason, /budget_max_/);
    assert.equal(provider.budget.snapshot().requests, 1);
  }
  for (const options of [{ maxModelRequests: 0 }, { maxInputTokens: 9 }, { maxOutputTokens: 19 }]) {
    let calls = 0;
    const { provider } = makeProvider(options, async () => { calls++; return response(knownUsage); });
    await assert.rejects(provider.complete(body, signal()), /budget_max_/);
    assert.equal(calls, 0);
    assert.equal(provider.budget.snapshot().requests, 0);
  }
});

test('usage settlement releases conservative tokens and keeps measured/accounted costs distinct', () => {
  const controller = new BudgetController({ maxInputTokens: 15, maxOutputTokens: 25, maxEstimatedCostUsd: 0.00005, pricing });
  const first = dispatch(controller, request('first'));
  let snapshot = controller.snapshot();
  assert.equal(snapshot.costUsd, null);
  assert.equal(snapshot.accounted.estimatedCostUsd, 0.00005);
  assert.equal(snapshot.measured.inputTokens, null);
  assert.equal(snapshot.unknownUsageRequests, 1);
  controller.settle(first.requestId, knownUsage);
  snapshot = controller.snapshot();
  assert.equal(snapshot.inputTokens, 5);
  assert.equal(snapshot.outputTokens, 3);
  assert.equal(snapshot.totalTokens, 8);
  assert.equal(snapshot.costUsd, 0.000011);
  assert.equal(snapshot.accounted.estimatedCostUsd, snapshot.costUsd);
  assert.equal(snapshot.pricingRevision, pricing.version);
  controller.reserve(request('second', { inputTokens: 10, outputTokens: 5 }));
  snapshot = controller.snapshot();
  assert.equal(snapshot.accounted.inputTokens, 15);
  assert.equal(snapshot.accounted.outputTokens, 8);
  assert.equal(snapshot.costUsd, null);
  assert.equal(snapshot.knownCostUsd, 0.000011);
  assert.equal(snapshot.measured.estimatedCostUsd, 0.000011);
});

test('monetary admissions compare exact decimal values at a combined 0.1 + 0.2 boundary', () => {
  const controller = new BudgetController({ maxEstimatedCostUsd: 0.3, pricing: {
    ...pricing, rates: [{ ...pricing.rates[0], inputUsdPerMillionTokens: 100000, outputUsdPerMillionTokens: 200000 }]
  } });
  controller.reserve(request('input', { inputTokens: 1, outputTokens: 0 }));
  controller.reserve(request('output', { inputTokens: 0, outputTokens: 1 }));
  assert.equal(controller.snapshot().accounted.estimatedCostUsd, 0.3);
  assert.throws(() => controller.reserve(request('extra', { inputTokens: 1, outputTokens: 0 })), /budget_max_estimated_cost_usd/);
});

test('positive prices that underflow public USD amounts cannot be reported as zero', () => {
  const controller = new BudgetController({ pricing: {
    ...pricing, rates: [{ ...pricing.rates[0], inputUsdPerMillionTokens: Number.MIN_VALUE }]
  } });
  assert.throws(() => controller.reserve(request('tiny', { inputTokens: 1, outputTokens: 0 })), /budget_estimated_cost_invalid/);
  assert.equal(controller.snapshot().requests, 0);
});

test('missing, partial and invalid usage stays unknown and retains the entire reservation', async () => {
  for (const usage of [undefined, {}, { prompt_tokens: 5 }, { prompt_tokens: -1, completion_tokens: 3 },
    { prompt_tokens: 1.5, completion_tokens: 3 }, { prompt_tokens: 5, completion_tokens: Infinity }]) {
    const { provider, events } = makeProvider({ maxInputTokens: 10, maxOutputTokens: 20, pricing }, async () => response(usage));
    await provider.complete(body, signal(), { trialId: 'trial-1', requestId: 'missing' });
    const snapshot = provider.snapshot({ includeBudget: true });
    assert.equal(snapshot.usageState, 'unknown');
    assert.equal(snapshot.unknownRequests, 1);
    assert.equal(snapshot.unknownUsageRequests, 1);
    assert.equal(snapshot.unknownCostRequests, 1);
    assert.equal(snapshot.inputTokens, null);
    assert.equal(snapshot.outputTokens, null);
    assert.equal(snapshot.costUsd, null);
    assert.equal(snapshot.accounted.inputTokens, 10);
    assert.equal(snapshot.accounted.outputTokens, 20);
    assert.equal(snapshot.accounted.estimatedCostUsd, 0.00005);
    assert.deepEqual(provider.snapshot(), { requests: 1, inputTokens: null, outputTokens: null });
    assert.equal(events.find(event => event.type === 'budget_unknown').requestId, 'missing');
    await assert.rejects(provider.complete(body, signal(), { requestId: 'next' }), /budget_max_/);
  }
});

test('failed transport retains budget, redacts error details and never replays the same request', async () => {
  let calls = 0;
  const { provider, events } = makeProvider({ maxModelRequests: 2, pricing }, async () => {
    calls++; throw new Error('sensitive endpoint or credential');
  });
  const correlation = { trialId: 'trial-1', requestId: 'failed' };
  await assert.rejects(provider.complete(body, signal(), correlation), /provider_transport_failed/);
  assert.equal(calls, 1);
  const snapshot = provider.snapshot({ includeBudget: true });
  assert.equal(snapshot.accounted.inputTokens, 10);
  assert.equal(snapshot.accounted.outputTokens, 20);
  assert.equal(snapshot.measured.inputTokens, null);
  assert.equal(snapshot.costUsd, null);
  assert.deepEqual(snapshot.replayBlockedRequestIds, ['failed']);
  await assert.rejects(provider.complete(body, signal(), correlation), /budget_request_replay_blocked/);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(events).includes('sensitive'), false);
  // A new explicit request is allowed; the provider itself never retries.
  await assert.rejects(provider.complete(body, signal(), { ...correlation, requestId: 'explicit-new' }), /provider_transport_failed/);
  assert.equal(calls, 2);
});

test('pricing is versioned, validated and exactly bound to the provider/model before any request', () => {
  for (const invalid of [
    { ...pricing, schemaVersion: 2 }, { ...pricing, version: '' }, { ...pricing, currency: 'EUR' },
    { ...pricing, rates: [] }, { ...pricing, rates: [...pricing.rates, ...pricing.rates] },
    { ...pricing, rates: [{ ...pricing.rates[0], inputUsdPerMillionTokens: -1 }] },
    { ...pricing, rates: [{ ...pricing.rates[0], outputUsdPerMillionTokens: Infinity }] }
  ]) assert.throws(() => config({ pricing: invalid }));
  for (const override of [{ providerId: 'other' }, { model: 'other' }]) {
    let calls = 0;
    assert.throws(() => createProvider(config({ maxEstimatedCostUsd: 1, pricing }, override), () => {}, {
      complete: async () => { calls++; return response(knownUsage); }
    }), /budget_pricing_model_missing/);
    assert.equal(calls, 0);
  }
  const unpriced = new BudgetController({});
  dispatch(unpriced, request());
  unpriced.settle('request-1', knownUsage);
  assert.equal(unpriced.snapshot().inputTokens, 5);
  assert.equal(unpriced.snapshot().costUsd, null);
  assert.equal(unpriced.snapshot().unknownCostRequests, 1);
});

test('concurrent provider calls share admissions and reserve before their transport starts', async () => {
  let finish, calls = 0;
  const outstanding = new Promise(resolve => { finish = resolve; });
  const { provider, events } = makeProvider({ maxModelRequests: 2, maxInputTokens: 20, maxOutputTokens: 40 }, async () => {
    calls++;
    assert.equal(events.at(-1).type, 'provider_admitted');
    const latest = events.findLast(event => event.type === 'budget_dispatched');
    assert.equal(latest.requestId, events.at(-1).requestId);
    assert.equal(provider.budget.snapshot().accounted.inputTokens, calls * 10);
    await outstanding;
    return response(knownUsage);
  });
  const first = provider.complete(body, signal(), { trialId: 'a', requestId: 'one' });
  const second = provider.complete(body, signal(), { trialId: 'b', requestId: 'two' });
  await assert.rejects(provider.complete(body, signal(), { trialId: 'c', requestId: 'three' }), /budget_max_model_requests/);
  assert.equal(calls, 2);
  assert.equal(provider.budget.snapshot().pendingRequests, 2);
  assert.deepEqual(provider.snapshot(), { requests: 2, inputTokens: null, outputTokens: null });
  finish();
  await Promise.all([first, second]);
  assert.equal(provider.budget.snapshot().settledRequests, 2);
  assert.equal(provider.budget.snapshot({ trialId: 'a' }).requests, 1);
  assert.equal(provider.budget.snapshot({ trialId: 'a' }).inputTokens, 5);
  assert.equal(provider.budget.snapshot({ trialId: 'b' }).outputTokens, 3);
});

test('reservations bind trial, request content, model and token bounds; returned data cannot mutate them', () => {
  const controller = new BudgetController({});
  const input = request();
  const reserved = controller.reserve(input);
  reserved.reserved.inputTokens = 0;
  assert.equal(controller.reserve(input).reserved.inputTokens, 10);
  assert.equal(controller.snapshot().requests, 1);
  for (const override of [{ trialId: 'other' }, { requestHash: 'changed' }, { model: 'other' }, { inputTokens: 0 }, { providerId: 'other' }]) {
    assert.throws(() => controller.reserve({ ...input, ...override }), /budget_request_binding_changed/);
  }
  assert.throws(() => controller.reserve({ ...input, kind: 'embedding' }), /budget_request_binding_changed/);
  assert.throws(() => controller.dispatch(input.requestId, { ...binding(input), trialId: 'other' }), /budget_request_binding_changed/);
  controller.dispatch(input.requestId, binding(input));
  assert.throws(() => controller.dispatch(input.requestId, binding(input)), /budget_request_replay_blocked/);
});

test('generic embedding calls with no output tokens share limits and require explicit input usage', () => {
  const controller = new BudgetController({ maxInputTokens: 10, maxOutputTokens: 0, pricing });
  const embedding = request('embedding', { kind: 'embedding', inputTokens: 10, outputTokens: 0 });
  dispatch(controller, embedding);
  controller.settle('embedding', { outputTokens: 0 });
  let snapshot = controller.snapshot({ trialId: embedding.trialId });
  assert.equal(snapshot.inputTokens, null);
  assert.equal(snapshot.accounted.inputTokens, 10);
  assert.equal(snapshot.accounted.outputTokens, 0);
  assert.equal(snapshot.costUsd, null);
  assert.equal(snapshot.reservations[0].kind, 'embedding');
  controller.reconcile('embedding', { inputTokens: 4, outputTokens: 0 }, binding(embedding));
  snapshot = controller.snapshot({ trialId: embedding.trialId });
  assert.equal(snapshot.inputTokens, 4);
  assert.equal(snapshot.outputTokens, 0);
  assert.equal(snapshot.costUsd, 0.000004);
  assert.equal(snapshot.unknownUsageRequests, 0);
});

test('generic rerank reservations charge aggregate input for one dispatch and preserve kind on restore', () => {
  const options = { maxModelRequests: 1, maxInputTokens: 13, maxOutputTokens: 0 };
  const controller = new BudgetController(options);
  const input = request('rerank', { kind: 'rerank', inputTokens: 3 + 5 + 5, outputTokens: 0 });
  dispatch(controller, input);
  controller.unknown(input.requestId, 'reranker_usage_missing');
  const restored = new BudgetController(options);
  restored.restore(JSON.parse(JSON.stringify(controller.snapshot())));
  assert.equal(restored.snapshot().requests, 1);
  assert.equal(restored.snapshot().accounted.inputTokens, 13);
  assert.equal(restored.snapshot().inputTokens, null);
  assert.equal(restored.snapshot().reservations[0].kind, 'rerank');
  assert.throws(() => restored.reserve(request('next', { kind: 'rerank', inputTokens: 0, outputTokens: 0 })), /budget_max_model_requests/);
});

test('actual usage overruns remain accounted and block further admissions', () => {
  const controller = new BudgetController({ maxInputTokens: 10 });
  dispatch(controller, request());
  assert.throws(() => controller.settle('request-1', { inputTokens: 11, outputTokens: 2 }), /budget_max_input_tokens/);
  assert.equal(controller.snapshot().accounted.inputTokens, 11);
  assert.equal(controller.snapshot().inputTokens, 11);
  assert.throws(() => controller.reserve(request('next', { inputTokens: 0, outputTokens: 0 })), /budget_max_input_tokens/);
});

test('a reserved request cannot dispatch after another request settles above the shared budget', () => {
  const events = [];
  const controller = new BudgetController({ maxInputTokens: 20 }, event => events.push(event));
  const first = request('first'), second = request('second');
  dispatch(controller, first);
  controller.reserve(second);
  assert.throws(() => controller.settle(first.requestId, { inputTokens: 11, outputTokens: 2 }), /budget_max_input_tokens/);
  assert.throws(() => controller.dispatch(second.requestId, binding(second)), /budget_max_input_tokens/);
  const snapshot = controller.snapshot();
  assert.equal(snapshot.accounted.inputTokens, 21);
  assert.equal(snapshot.reservations[1].state, 'reserved');
  assert.equal(events.filter(event => event.type === 'budget_dispatched').length, 1);
  assert.equal(events.at(-1).requestId, second.requestId);
  assert.equal(events.at(-1).state, 'rejected');
});

test('snapshot/restore conservatively retains pending charges and permits only undispatched bindings', () => {
  let now = 1000;
  const options = { maxModelRequests: 3, maxInputTokens: 30, maxOutputTokens: 60, maxRunDurationMs: 1000, pricing };
  const controller = new BudgetController(options, () => {}, { now: () => now });
  const undispatched = request('reserved'), unresolved = request('dispatched'), settled = request('settled');
  controller.reserve(undispatched);
  dispatch(controller, unresolved);
  dispatch(controller, settled);
  controller.settle(settled.requestId, knownUsage);
  now += 100;
  const state = JSON.parse(JSON.stringify(controller.snapshot()));
  now += 100;
  const events = [];
  const restored = new BudgetController(options, event => events.push(event), { now: () => now });
  restored.restore(state);
  let snapshot = restored.snapshot();
  assert.equal(snapshot.elapsedMs, 200);
  assert.equal(snapshot.requests, 3);
  assert.equal(snapshot.accounted.inputTokens, 25);
  assert.equal(snapshot.accounted.outputTokens, 43);
  assert.equal(snapshot.unknownRequests, 1);
  assert.equal(events.at(-1).type, 'budget_unknown');
  assert.equal(events.at(-1).reason, 'resume_usage_unknown');
  assert.throws(() => restored.reserve(unresolved), /budget_request_replay_blocked/);
  assert.throws(() => restored.reserve(settled), /budget_request_replay_blocked/);
  assert.throws(() => restored.reserve(request('extra')), /budget_max_model_requests/);
  assert.equal(restored.reserve(undispatched).requestNumber, 1);
  restored.dispatch(undispatched.requestId, binding(undispatched));
  assert.throws(() => restored.reconcile(unresolved.requestId, knownUsage, { ...binding(unresolved), requestHash: 'wrong' }), /binding_changed/);
  restored.reconcile(unresolved.requestId, knownUsage, binding(unresolved));
  restored.settle(undispatched.requestId, knownUsage);
  snapshot = restored.snapshot();
  assert.equal(snapshot.inputTokens, 15);
  assert.equal(snapshot.outputTokens, 9);
  assert.equal(snapshot.unknownUsageRequests, 0);
  assert.equal(snapshot.unknownCostRequests, 0);
  assert.equal(snapshot.costUsd, 0.000033);
  assert.throws(() => restored.restore(state), /budget_restore_requires_empty_controller/);
});

test('restore rejects policy/pricing changes, malformed state and duplicate reservations', () => {
  const options = { maxModelRequests: 2, pricing };
  const controller = new BudgetController(options);
  controller.reserve(request());
  const state = controller.snapshot();
  for (const changed of [{ ...options, maxModelRequests: 3 }, { ...options, pricing: { ...pricing, version: 'new' } }]) {
    assert.throws(() => new BudgetController(changed).restore(state), /budget_snapshot_policy_changed/);
  }
  for (const malformed of [
    { ...state, schemaVersion: 2 }, { ...state, elapsedMs: -1 }, { ...state, nextRequestNumber: 0 },
    { ...state, reservations: [...state.reservations, ...state.reservations] },
    { ...state, reservations: [{ ...state.reservations[0], state: 'settled' }] },
    { ...state, reservations: [{ ...state.reservations[0], reserved: { ...state.reservations[0].reserved, estimatedCostUsd: 0 } }] }
  ]) assert.throws(() => new BudgetController(options).restore(malformed), /budget_snapshot_invalid/);
  assert.throws(() => new BudgetController(options).restore(controller.snapshot({ trialId: 'trial-1' })), /budget_snapshot_invalid/);
});

test('reconciliation with missing/conflicting usage never refunds previously reported usage', () => {
  const controller = new BudgetController({});
  const input = request();
  dispatch(controller, input);
  controller.settle(input.requestId, { prompt_tokens: 11 });
  controller.reconcile(input.requestId, {}, binding(input));
  assert.equal(controller.snapshot().knownInputTokens, 11);
  assert.equal(controller.snapshot().accounted.inputTokens, 11);
  assert.throws(() => controller.reconcile(input.requestId, { inputTokens: 10, outputTokens: 1 }, binding(input)), /budget_usage_reconciliation_changed/);
  assert.equal(controller.snapshot().accounted.inputTokens, 11);
});

test('run/task duration checks enforce exact boundaries and restore includes downtime without clock refunds', () => {
  let now = 1000;
  const options = { maxRunDurationMs: 100, maxTaskDurationMs: 50 };
  const controller = new BudgetController(options, () => {}, { now: () => now });
  controller.reserve(request());
  now = 1049;
  assert.deepEqual(controller.checkTaskDuration('trial-1'), { elapsedMs: 49, remainingMs: 1 });
  now = 1050;
  assert.throws(() => controller.dispatch('request-1', binding(request())), /budget_max_task_duration/);
  now = 1099;
  assert.deepEqual(controller.checkRunDuration(), { elapsedMs: 99, remainingMs: 1 });
  const state = controller.snapshot();
  now = 1080;
  const restored = new BudgetController(options, () => {}, { now: () => now });
  restored.restore(state);
  assert.equal(restored.checkRunDuration().elapsedMs, 99);
  now = 1100;
  assert.throws(() => restored.checkRunDuration(), /budget_max_run_duration/);
  const expired = new BudgetController(options, () => {}, { now: () => 1200 });
  expired.restore(state);
  assert.throws(() => expired.reserve(request('next')), /budget_max_run_duration/);
});

test('duration and pricing rejection events retain the request and trial correlation', () => {
  let now = 1000;
  const events = [];
  const controller = new BudgetController({ maxRunDurationMs: 100, maxTaskDurationMs: 50 }, event => events.push(event), { now: () => now });
  const input = request();
  controller.reserve(input);
  now += 50;
  assert.throws(() => controller.dispatch(input.requestId, binding(input)), /budget_max_task_duration/);
  assert.equal(events.at(-1).requestId, input.requestId);
  assert.equal(events.at(-1).trialId, input.trialId);
  assert.equal(events.at(-1).requestHash, input.requestHash);
  now += 50;
  const next = request('next', { trialId: 'trial-2' });
  assert.throws(() => controller.reserve(next), /budget_max_run_duration/);
  assert.equal(events.at(-1).requestId, next.requestId);
  assert.equal(events.at(-1).trialId, next.trialId);
  assert.equal(events.at(-1).requestHash, next.requestHash);
  const priced = new BudgetController({ maxEstimatedCostUsd: 1, pricing }, event => events.push(event));
  const missing = request('unpriced', { providerId: 'missing-provider' });
  assert.throws(() => priced.reserve(missing), /budget_pricing_model_missing/);
  assert.equal(events.at(-1).requestId, missing.requestId);
  assert.equal(events.at(-1).trialId, missing.trialId);
  assert.equal(events.at(-1).requestHash, missing.requestHash);
});

test('durable callback failure prevents transport and cannot refund or roll back reservations', async () => {
  let calls = 0;
  const provider = createProvider(config(), event => {
    if (event.type === 'budget_reserved') throw new Error('disk write failed');
  }, { complete: async () => { calls++; return response(knownUsage); }, estimateInputTokens: () => 10 });
  await assert.rejects(provider.complete(body, signal()), /budget_journal_failed/);
  assert.equal(calls, 0);
  assert.equal(provider.budget.snapshot().accounted.inputTokens, 10);
  await assert.rejects(provider.complete(body, signal()), /budget_journal_failed/);
  assert.equal(calls, 0);
});

test('an asynchronous journal callback cannot admit a transport even when its promise resolves', async () => {
  let calls = 0;
  const provider = createProvider(config(), async () => {}, {
    complete: async () => { calls++; return response(knownUsage); }, estimateInputTokens: () => 10
  });
  await assert.rejects(provider.complete(body, signal()), /budget_journal_failed/);
  assert.equal(calls, 0);
  assert.equal(provider.budget.snapshot().accounted.inputTokens, 10);
});

test('timeouts and cancellation after dispatch remain unknown; cancellation before admission is free', async () => {
  const { provider } = makeProvider({ maxRunDurationMs: 15 }, async () => new Promise(() => {}), { now: () => 1000 });
  await assert.rejects(provider.complete(body, signal(), { requestId: 'timeout' }), /provider_transport_failed/);
  assert.equal(provider.budget.snapshot().unknownRequests, 1);
  assert.equal(provider.budget.snapshot().accounted.outputTokens, 20);
  const cancelled = new AbortController();
  cancelled.abort();
  const other = makeProvider().provider;
  await assert.rejects(other.complete(body, cancelled.signal));
  assert.equal(other.budget.snapshot().requests, 0);
});

test('known provider usage/event behavior remains exact; unknown defaults are explicit and legacy totals require opt-in', async () => {
  const events = []; let calls = 0;
  const legacy = { model: 'model', temperature: 0, ...validateProviderOptions({ maxInputBytes: 1024, requestTimeoutMs: 1000, taskTimeoutMs: 5000 }) };
  const oldBody = { ...body, max_tokens: 4096 };
  const provider = createProvider(legacy, event => events.push(event), { complete: async () => {
    assert.equal(events.at(-1).type, 'provider_admitted');
    calls++;
    return response({ prompt_tokens: 10, completion_tokens: 10 });
  } });
  await provider.complete(oldBody, signal());
  await provider.complete(oldBody, signal());
  assert.equal(calls, 2);
  assert.deepEqual(provider.snapshot(), { requests: 2, inputTokens: 20, outputTokens: 20 });
  await assert.rejects(provider.complete({ ...oldBody, model: 'wrong' }, signal()), /binding_changed/);
  await assert.rejects(provider.complete({ ...oldBody, messages: [{ role: 'user', content: 'x'.repeat(1024) }] }, signal()), /input_limit/);
  assert.equal(calls, 2);
  assert.ok(estimateChatInputTokens(oldBody) >= Buffer.byteLength(JSON.stringify(oldBody)));
  const failing = makeProvider({}, async () => { throw new Error('sensitive'); }).provider;
  await assert.rejects(failing.complete(body, signal()), /transport_failed/);
  assert.deepEqual(failing.snapshot(), { requests: 1, inputTokens: null, outputTokens: null });
  assert.deepEqual(failing.snapshot({ legacy: true }), { requests: 1, inputTokens: 0, outputTokens: 0 });
  assert.equal(failing.snapshot({ includeBudget: true, legacy: true }).usageState, 'unknown');
});
