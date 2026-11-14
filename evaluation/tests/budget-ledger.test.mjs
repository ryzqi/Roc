import assert from 'node:assert/strict';
import {
  closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBudgetLedger, validateBudgetLedger } from '../lib/budget-ledger.mjs';
import { hash } from '../lib/common.mjs';
import { createProvider, validateProviderOptions } from '../lib/provider.mjs';

// Owned temporary directories and synthetic transport only; no archived runs/settings/models.
const pricing = { schemaVersion: 1, version: 'synthetic-v1', currency: 'USD', rates: [
  { providerId: 'fixture-provider', model: 'fixture-model', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 }
] };
const policy = { maxModelRequests: 3, maxInputTokens: 30, maxOutputTokens: 60, pricing };
const request = (requestId = 'request-1', overrides = {}) => ({
  requestId, trialId: 'trial-1', requestHash: hash({ requestId }), kind: 'chat',
  providerId: 'fixture-provider', model: 'fixture-model', inputTokens: 10, outputTokens: 20, ...overrides
});
const binding = value => ({ trialId: value.trialId, requestHash: value.requestHash });
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const statePath = root => join(root, 'budget-state.json');
const eventsPath = root => join(root, 'events.jsonl');
const readEvents = root => readFileSync(eventsPath(root), 'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
const saveEvents = (root, events) => writeFileSync(eventsPath(root), events.map(event => JSON.stringify(event) + '\n').join(''));
const saveState = (root, state) => writeFileSync(statePath(root), JSON.stringify(state, null, 2) + '\n');
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'roc-budget-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fd = openSync(eventsPath(root), 'wx', 0o600);
  t.after(() => closeSync(fd));
  let sequence = 0;
  const append = payload => {
    const event = { ...payload, sequence: ++sequence, at: '2026-11-14T00:00:00.000Z' };
    writeFileSync(fd, JSON.stringify(event) + '\n');
    fsyncSync(fd);
    return event;
  };
  return { root, append };
}
function dispatch(controller, input = request()) {
  controller.reserve(input);
  controller.dispatch(input.requestId, binding(input));
}
function changeSnapshotAndCheckpoint(root, change) {
  const saved = json(statePath(root));
  change(saved);
  const { stateHash, ...payload } = saved;
  saved.stateHash = hash(payload);
  saveState(root, saved);
  const events = readEvents(root);
  events.findLast(event => event.type === 'budget_checkpoint').stateHash = saved.stateHash;
  saveEvents(root, events);
}

test('initialization and every mutation/rejection commit event -> snapshot -> checkpoint synchronously', t => {
  const { root, append } = fixture(t);
  const controller = openBudgetLedger(root, policy, payload => {
    if (payload.type === 'budget_checkpoint') {
      const saved = json(statePath(root)), events = readEvents(root);
      assert.equal(saved.stateHash, payload.stateHash);
      assert.equal(saved.anchorSequence, events.at(-1).sequence);
      assert.equal(saved.anchorHash, hash(events.at(-1)));
      assert.equal(payload.anchorHash, saved.anchorHash);
    }
    return append(payload);
  }, { now: () => 1000 });
  dispatch(controller);
  controller.settle('request-1', { inputTokens: 5, outputTokens: 3 });
  assert.throws(() => controller.dispatch('request-1', binding(request())), /budget_request_replay_blocked/);
  const saved = validateBudgetLedger(root, policy, readEvents(root));
  assert.equal(saved.requests, 1);
  assert.equal(saved.inputTokens, 5);
  assert.equal(saved.costUsd, 0.000011);
  assert.equal(readEvents(root).at(-2).type, 'budget_rejected');
  assert.equal(readEvents(root).at(-1).type, 'budget_checkpoint');
  assert.equal(lstatSync(statePath(root)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(root).filter(name => name.endsWith('.tmp')), []);
});

test('validate is read-only and permits nonbudget journal events around complete transactions', t => {
  const { root, append } = fixture(t);
  append({ type: 'run_plan', planHash: hash('synthetic') });
  const controller = openBudgetLedger(root, policy, append, { now: () => 1000 });
  controller.reserve(request());
  append({ type: 'trial_state', trialId: 'trial-1' });
  const before = [readFileSync(statePath(root)), readFileSync(eventsPath(root))];
  const previous = readEvents(root), original = structuredClone(previous);
  assert.equal(validateBudgetLedger(root, policy, previous).reservations[0].state, 'reserved');
  assert.deepEqual(previous, original);
  assert.deepEqual([readFileSync(statePath(root)), readFileSync(eventsPath(root))], before);
  assert.throws(() => openBudgetLedger(root, policy, append), /budget_ledger_already_exists/);
});

test('checkpoint state hash and anchor drift are rejected', async t => {
  for (const field of ['stateHash', 'anchorHash', 'anchorSequence']) await t.test(field, t => {
    const { root, append } = fixture(t);
    openBudgetLedger(root, policy, append, { now: () => 1000 }).reserve(request());
    const events = readEvents(root), checkpoint = events.at(-1);
    checkpoint[field] = field === 'anchorSequence' ? checkpoint[field] - 1 : '0'.repeat(64);
    saveEvents(root, events);
    assert.throws(() => validateBudgetLedger(root, policy), /budget_checkpoint_changed/);
  });
});

test('a durable event without its checkpoint, even before unrelated events, cannot resume', async t => {
  for (const unrelated of [false, true]) await t.test(String(unrelated), t => {
    const { root, append } = fixture(t);
    openBudgetLedger(root, policy, append, { now: () => 1000 }).reserve(request());
    const events = readEvents(root).slice(0, -1);
    if (unrelated) events.push({ type: 'trial_state', sequence: events.length + 1, at: '2026-11-14T00:00:00.000Z' });
    saveEvents(root, events);
    const before = readFileSync(statePath(root));
    assert.throws(() => openBudgetLedger(root, policy, append, { previousEvents: events }), /budget_checkpoint_missing/);
    assert.deepEqual(readFileSync(statePath(root)), before);
  });
});

test('stale saved snapshot, orphan checkpoint, and drift in an earlier checkpoint fail closed', async t => {
  for (const mode of ['stale', 'orphan', 'earlier']) await t.test(mode, t => {
    const { root, append } = fixture(t);
    const controller = openBudgetLedger(root, policy, append, { now: () => 1000 });
    const initial = json(statePath(root));
    controller.reserve(request());
    const events = readEvents(root);
    if (mode === 'stale') saveState(root, initial);
    if (mode === 'orphan') {
      events.push({ ...events.at(-1), sequence: events.length + 1 });
      saveEvents(root, events);
    }
    if (mode === 'earlier') {
      events[1].anchorHash = '0'.repeat(64);
      saveEvents(root, events);
    }
    assert.throws(() => validateBudgetLedger(root, policy), /budget_(checkpoint_changed|event_invalid)/);
  });
});

test('rehashing both saved state and checkpoint cannot change a last reservation event', async t => {
  for (const field of ['requestId', 'requestHash', 'reserved', 'measured', 'reason']) await t.test(field, t => {
    const { root, append } = fixture(t);
    const controller = openBudgetLedger(root, policy, append, { now: () => 1000 });
    dispatch(controller);
    controller.unknown('request-1', 'transport_failed');
    changeSnapshotAndCheckpoint(root, saved => {
      const reservation = saved.reservations[0];
      if (field === 'requestId') {
        reservation.requestId = 'changed';
        saved.replayBlockedRequestIds = ['changed'];
      }
      if (field === 'requestHash') reservation.requestHash = hash('different');
      if (field === 'reason') reservation.reason = 'different_reason';
      if (field === 'reserved') reservation.reserved.inputTokens = 9;
      if (field === 'measured') reservation.measured.inputTokens = 1;
    });
    assert.throws(() => validateBudgetLedger(root, policy), /budget_snapshot_(invalid|reservations_changed)/);
  });
});

test('aggregate accounting, fixed snapshot hash, policy and pricing revision drift are rejected', async t => {
  for (const mode of ['aggregate', 'elapsed', 'hash', 'policy', 'pricing']) await t.test(mode, t => {
    const { root, append } = fixture(t);
    openBudgetLedger(root, policy, append, { now: () => 1000 }).reserve(request());
    if (mode === 'aggregate') changeSnapshotAndCheckpoint(root, saved => { saved.accounted.inputTokens = 0; });
    if (mode === 'elapsed') changeSnapshotAndCheckpoint(root, saved => { saved.elapsedMs++; });
    if (mode === 'hash') {
      const saved = json(statePath(root)); saved.elapsedMs++; saveState(root, saved);
    }
    const changedPolicy = mode === 'policy' ? { ...policy, maxModelRequests: 4 }
      : mode === 'pricing' ? { ...policy, pricing: { ...pricing, version: 'synthetic-v2' } } : policy;
    assert.throws(() => validateBudgetLedger(root, changedPolicy), /budget_snapshot_(invalid|hash_changed|policy_changed|reservations_changed)/);
  });
});

test('unknown usage and its reservation survive restore without refunds or replay', t => {
  const { root, append } = fixture(t);
  const options = { ...policy, maxModelRequests: 1 };
  const input = request('rerank', { kind: 'rerank', outputTokens: 0 });
  const controller = openBudgetLedger(root, options, append, { now: () => 1000 });
  dispatch(controller, input);
  controller.settle(input.requestId, { inputTokens: 12 });
  const before = validateBudgetLedger(root, options);
  const restored = openBudgetLedger(root, options, append, { previousEvents: readEvents(root), now: () => 1100 });
  const saved = validateBudgetLedger(root, options), reservation = saved.reservations[0];
  assert.deepEqual(reservation, before.reservations[0]);
  assert.equal(saved.accounted.inputTokens, 12);
  assert.equal(saved.knownInputTokens, 12);
  assert.equal(saved.inputTokens, null);
  assert.equal(saved.unknownRequests, 1);
  assert.equal(saved.elapsedMs, 100);
  assert.throws(() => restored.reserve(input), /budget_request_replay_blocked/);
  assert.throws(() => restored.reserve(request('extra', { inputTokens: 0, outputTokens: 0 })), /budget_max_model_requests/);
  assert.equal(readEvents(root).filter(event => event.type === 'budget_dispatched').length, 1);
  validateBudgetLedger(root, options);
});

test('settlement overrun durably records the charge and rejection before failing', t => {
  const { root, append } = fixture(t);
  const options = { ...policy, maxInputTokens: 10 };
  const controller = openBudgetLedger(root, options, append, { now: () => 1000 });
  dispatch(controller);
  assert.throws(() => controller.settle('request-1', { inputTokens: 11, outputTokens: 2 }), /budget_max_input_tokens/);
  const saved = validateBudgetLedger(root, options);
  assert.equal(saved.accounted.inputTokens, 11);
  assert.equal(saved.settledRequests, 1);
  assert.deepEqual(readEvents(root).slice(-4).map(event => event.type),
    ['budget_settled', 'budget_checkpoint', 'budget_rejected', 'budget_checkpoint']);
});

test('restore checkpoints dispatched as unknown, counts downtime and never replays transport', t => {
  const { root, append } = fixture(t);
  const options = { ...policy, maxRunDurationMs: 150 };
  const controller = openBudgetLedger(root, options, append, { now: () => 1000 });
  dispatch(controller, request('one'));
  dispatch(controller, request('two'));
  controller.reserve(request('reserved'));
  const originalBytes = readFileSync(statePath(root));
  const previous = readEvents(root);
  assert.equal(validateBudgetLedger(root, options, previous).dispatchedRequests, 2);
  assert.deepEqual(readFileSync(statePath(root)), originalBytes);
  const restored = openBudgetLedger(root, options, append, { previousEvents: previous, now: () => 1100 });
  const saved = validateBudgetLedger(root, options);
  assert.equal(saved.elapsedMs, 100);
  assert.equal(saved.requests, 3);
  assert.equal(saved.unknownRequests, 2);
  assert.equal(saved.pendingRequests, 1);
  assert.equal(saved.accounted.inputTokens, 30);
  assert.deepEqual(saved.replayBlockedRequestIds, ['one', 'two']);
  assert.equal(saved.reservations[0].reason, 'resume_usage_unknown');
  assert.equal(readEvents(root).at(-2).type, 'budget_restored');
  for (const id of ['one', 'two']) {
    assert.throws(() => restored.reserve(request(id)), /budget_request_replay_blocked/);
    assert.throws(() => restored.dispatch(id, binding(request(id))), /budget_request_replay_blocked/);
  }
  assert.equal(readEvents(root).filter(event => event.type === 'budget_dispatched').length, 2);
  restored.dispatch('reserved', binding(request('reserved')));
  const expired = openBudgetLedger(root, options, append, { previousEvents: readEvents(root), now: () => 1200 });
  assert.throws(() => expired.reserve(request('new')), /budget_max_run_duration/);
  assert.equal(validateBudgetLedger(root, options).elapsedMs, 200);
});

function providerWithBudget(budget, record, complete) {
  const config = { model: 'fixture-model', providerId: 'fixture-provider', temperature: 0, maxOutputTokens: 20,
    ...validateProviderOptions({ maxInputBytes: 1024, taskTimeoutMs: 5000, requestTimeoutMs: 1000 }) };
  return createProvider(config, record, { budget, complete, estimateInputTokens: () => 10 });
}
const body = { model: 'fixture-model', stream: false, max_tokens: 20, temperature: 0, messages: [] };

test('transport starts only after dispatched snapshot and durable checkpoint both exist', async t => {
  const { root, append } = fixture(t);
  const budget = openBudgetLedger(root, policy, append, { now: () => 1000 });
  let calls = 0;
  const provider = providerWithBudget(budget, append, async () => {
    calls++;
    const events = readEvents(root), saved = validateBudgetLedger(root, policy);
    assert.equal(events.at(-1).type, 'provider_admitted');
    assert.equal(events.at(-2).type, 'budget_checkpoint');
    assert.equal(events.at(-3).type, 'budget_dispatched');
    assert.equal(saved.reservations[0].state, 'dispatched');
    return { choices: [{ message: { role: 'assistant', content: '{}' } }], usage: { inputTokens: 5, outputTokens: 3 } };
  });
  await provider.complete(body, new AbortController().signal, { trialId: 'trial-1', requestId: 'provider-request' });
  assert.equal(calls, 1);
  assert.equal(validateBudgetLedger(root, policy).settledRequests, 1);
});

test('checkpoint append failure poisons admission, leaves a crash gap and exposes no error secrets', async t => {
  const { root, append } = fixture(t);
  let breakCheckpoint = false, calls = 0;
  const budget = openBudgetLedger(root, policy, payload => {
    if (payload.type === 'budget_dispatched') breakCheckpoint = true;
    if (breakCheckpoint && payload.type === 'budget_checkpoint') throw new Error('secret-test-sentinel');
    return append(payload);
  }, { now: () => 1000 });
  const provider = providerWithBudget(budget, append, async () => { calls++; });
  await assert.rejects(provider.complete(body, new AbortController().signal), /budget_journal_failed/);
  await assert.rejects(provider.complete(body, new AbortController().signal), /budget_journal_failed/);
  assert.equal(calls, 0);
  assert.equal(budget.snapshot().accounted.inputTokens, 10);
  assert.equal(json(statePath(root)).reservations[0].state, 'dispatched');
  assert.throws(() => validateBudgetLedger(root, policy), /budget_checkpoint_missing/);
  assert.equal(readFileSync(eventsPath(root), 'utf8').includes('secret-test-sentinel'), false);
});

test('async or malformed append receipts cannot dispatch', async t => {
  for (const mode of ['async', 'sequence', 'at', 'payload']) await t.test(mode, async t => {
    const { root, append } = fixture(t);
    let breakAppend = false, calls = 0;
    const budget = openBudgetLedger(root, policy, payload => {
      const event = append(payload);
      if (!breakAppend) return event;
      if (mode === 'async') return Promise.resolve(event);
      if (mode === 'sequence') return { ...event, sequence: 0 };
      if (mode === 'at') return { ...event, at: null };
      return { ...event, trialId: 'changed' };
    }, { now: () => 1000 });
    breakAppend = true;
    const provider = providerWithBudget(budget, append, async () => { calls++; });
    await assert.rejects(provider.complete(body, new AbortController().signal), /budget_journal_failed/);
    assert.equal(calls, 0);
    assert.throws(() => validateBudgetLedger(root, policy), /budget_checkpoint_missing/);
  });
});

test('arbitrary rejection context is not copied into durable budget events', t => {
  const { root, append } = fixture(t);
  let now = 1000;
  const options = { ...policy, maxRunDurationMs: 1 };
  const budget = openBudgetLedger(root, options, append, { now: () => now });
  now++;
  assert.throws(() => budget.checkRunDuration({ trialId: 'trial-1', secret: 'secret-test-sentinel',
    headers: { authorization: 'secret-test-sentinel' } }), /budget_max_run_duration/);
  assert.equal(readFileSync(eventsPath(root), 'utf8').includes('secret-test-sentinel'), false);
  assert.equal(validateBudgetLedger(root, options).elapsedMs, 1);
});

test('torn journal/snapshot, partial temporary files and stale supplied events cannot resume', async t => {
  for (const mode of ['journal', 'snapshot', 'partial', 'supplied']) await t.test(mode, t => {
    const { root, append } = fixture(t);
    openBudgetLedger(root, policy, append, { now: () => 1000 });
    const previous = readEvents(root);
    if (mode === 'journal') writeFileSync(eventsPath(root), readFileSync(eventsPath(root), 'utf8').trimEnd());
    if (mode === 'snapshot') writeFileSync(statePath(root), readFileSync(statePath(root), 'utf8').trimEnd());
    if (mode === 'partial') writeFileSync(join(root, 'budget-state.json.synthetic.tmp'), '{"partial":');
    if (mode === 'supplied') previous.pop();
    assert.throws(() => validateBudgetLedger(root, policy, previous), /budget_(journal_(torn_write|changed)|snapshot_(torn_write|partial))/);
  });
});

test('sealed roots and snapshot links are refused without changing files or appending', async t => {
  for (const mode of ['sealed', 'link']) await t.test(mode, t => {
    const { root, append } = fixture(t);
    openBudgetLedger(root, policy, append, { now: () => 1000 });
    if (mode === 'sealed') writeFileSync(join(root, 'seal.json'), '{}\n');
    else {
      const outside = join(root, 'synthetic-outside.json');
      writeFileSync(outside, 'owned-test-sentinel\n');
      rmSync(statePath(root));
      symlinkSync(outside, statePath(root));
    }
    const before = readFileSync(eventsPath(root));
    assert.throws(() => validateBudgetLedger(root, policy), /budget_(run_sealed|ledger_file_invalid)/);
    assert.throws(() => openBudgetLedger(root, policy, append, { previousEvents: readEvents(root) }), /budget_(run_sealed|ledger_file_invalid)/);
    assert.deepEqual(readFileSync(eventsPath(root)), before);
    if (mode === 'link') assert.equal(readFileSync(join(root, 'synthetic-outside.json'), 'utf8'), 'owned-test-sentinel\n');
  });
});
