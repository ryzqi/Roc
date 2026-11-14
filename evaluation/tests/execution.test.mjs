import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { EvaluationError, fileInventory, hash, journal, readJson, sha256, sourceIdentity } from '../lib/common.mjs';
import { validateBudgetLedger } from '../lib/budget-ledger.mjs';
import {
  inspectResumable, openExecution, executionPolicy, readGrade, storeGrade,
  validateVerifiedSeal, verifiedSeal, withinTrial
} from '../lib/execution.mjs';
import {
  discardUndispatched, durableJson, inspectTrialSeal, loadRunPlan, readEvents,
  scheduleTrials, sealTrial, TrialLifecycle
} from '../lib/lifecycle.mjs';
import { createProvider, validateProviderOptions } from '../lib/provider.mjs';

// Every mutable run, link target and subprocess belongs to this test file.
// Transports are supplied functions; no settings, archived runs or model host are used.
const pricing = { schemaVersion: 1, version: 'execution-fixture-v1', currency: 'USD', rates: [
  { providerId: 'fixture-provider', model: 'fixture-model', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 }
] };
const body = {
  model: 'fixture-model', stream: false, max_tokens: 20, temperature: 0,
  messages: [{ role: 'user', content: 'synthetic execution test' }]
};
const scored = { status: 'scored', metrics: { score: 1 }, checks: [{ id: 'synthetic-result', passed: true }] };
const response = () => ({
  choices: [{ message: { role: 'assistant', content: '{}' } }],
  usage: { inputTokens: 4, outputTokens: 2 }
});
const signal = () => new AbortController().signal;
const eventsPath = root => join(root, 'events.jsonl');
const statePath = root => join(root, 'budget-state.json');
const saveJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const saveEvents = (root, events) => writeFileSync(eventsPath(root), events
  .map((event, index) => JSON.stringify({ ...event, sequence: index + 1 }) + '\n').join(''));
let frozenSource;

function manifest(options = {}) {
  const provider = {
    model: 'fixture-model', providerId: 'fixture-provider', temperature: 0, maxOutputTokens: 20,
    ...validateProviderOptions({
      maxInputBytes: 1024, requestTimeoutMs: 10000, taskTimeoutMs: options.taskTimeoutMs ?? 30000,
      budget: { maxModelRequests: 20, pricing, ...options.budget }
    })
  };
  return {
    schemaVersion: 1, suite: 'roc-harness', repeats: options.repeats ?? 1,
    selection: options.selection ?? [
      { id: 'task-a', clusterId: 'cluster-a' }, { id: 'task-b', clusterId: 'cluster-b' }
    ],
    provider, executionPolicy: executionPolicy(provider, options.maxConcurrentTrials ?? 2),
    source: frozenSource ??= sourceIdentity()
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded(promise, label, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture_timeout_${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function ownedArea(t) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'roc-execution-test-'));
  const root = join(parent, 'run'), journals = new Set(), children = [];
  t.after(async () => {
    for (const handle of journals) handle.close();
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all(children.map(({ exit }) => bounded(exit, 'owned_child_cleanup', 5000)));
    rmSync(parent, { recursive: true, force: true });
  });
  return {
    parent, root,
    openJournal(resume = false) {
      const handle = journal(eventsPath(root), { resume });
      journals.add(handle);
      return handle;
    },
    track(child) {
      const exit = new Promise(resolve => {
        child.once('exit', (code, terminationSignal) => resolve({ code, signal: terminationSignal }));
        child.once('error', error => resolve({ error }));
      });
      children.push({ child, exit });
      return exit;
    }
  };
}

function fixture(t, options = {}) {
  const area = ownedArea(t), savedManifest = manifest(options);
  mkdirSync(area.root, { mode: 0o700 });
  durableJson(join(area.root, 'manifest.json'), savedManifest);
  const handle = area.openJournal();
  handle.append({ type: 'run_started', startedAtMs: Date.now() });
  const execution = openExecution(area.root, savedManifest, handle);
  return { ...area, manifest: savedManifest, journal: handle, execution, transports: 0 };
}

function providerFor(f, complete = async () => { f.transports++; return response(); }) {
  return createProvider(f.manifest.provider, f.execution.append, {
    budget: f.execution.budget, estimateInputTokens: () => 10, complete
  });
}

async function prepareVerified(f, trial = f.execution.plan.trials[0]) {
  const directory = join(f.root, trial.trialId);
  mkdirSync(directory, { mode: 0o700 });
  let startedAtMs;
  await withinTrial(f.execution, trial, signal(), async (taskSignal, startedAt) => {
    startedAtMs = startedAt;
    f.execution.lifecycle.transition(trial, 'dispatched');
    await providerFor(f).complete(body, taskSignal, { trialId: trial.trialId, requestId: `request-${trial.trialId}` });
    durableJson(join(directory, 'answer.json'), { value: trial.taskId });
    durableJson(join(directory, 'runtime-verification.json'), { verified: true, trialId: trial.trialId });
    f.execution.lifecycle.transition(trial, 'completed');
    verifiedSeal(directory, f.execution.lifecycle, trial);
  });
  return { trial, directory, startedAtMs };
}

test('scorers cannot override the frozen trial identity or write a misleading grade', async t => {
  const f = fixture(t), { trial, directory, startedAtMs } = await prepareVerified(f);
  for (const [key, value] of Object.entries({
    trialId: 'trial-substituted-0', taskId: 'substituted-task', clusterId: 'substituted-cluster',
    repeat: trial.repeat + 1, traceId: hash('substituted-trace').slice(0, 32)
  })) {
    readonlyReject(f.root, () => storeGrade(f.root, f.execution, trial, { ...scored, [key]: value }, startedAtMs),
      /grade_trial_identity_invalid/);
  }
  assert.equal(existsSync(join(directory, 'grade.json')), false);
  assert.equal(f.execution.lifecycle.state(trial.trialId), 'verified');
});

async function orphan(t, { withSeal = true } = {}) {
  const f = fixture(t), verified = await prepareVerified(f);
  f.execution.lifecycle = new TrialLifecycle(f.execution.plan, event => {
    if (event.type === 'trial_state' && event.to === 'graded') {
      throw new EvaluationError('state', 'fixture_crash_before_graded_event');
    }
    return f.execution.append(event);
  }, readEvents(eventsPath(f.root)));
  assert.throws(() => storeGrade(f.root, f.execution, verified.trial, scored, verified.startedAtMs),
    /fixture_crash_before_graded_event/);
  assert.equal(f.execution.lifecycle.state(verified.trial.trialId), 'verified');
  assert.equal(readGrade(f.root, f.execution, verified.trial), null);
  if (!withSeal) rmSync(join(verified.directory, 'trial-evidence.json'));
  f.execution.lifecycle = new TrialLifecycle(f.execution.plan, f.execution.append, readEvents(eventsPath(f.root)));
  return { ...f, ...verified, saved: readJson(join(verified.directory, 'grade.json')) };
}

// Include byte hashes and directory metadata, but exclude atime changed by reads.
// A symlink is inventoried as a link definition, never traversed.
function treeSnapshot(root) {
  const entries = [];
  function visit(path) {
    const stat = lstatSync(path);
    const entry = { path: relative(root, path) || '.', mode: stat.mode, mtimeMs: stat.mtimeMs };
    if (stat.isSymbolicLink()) entry.link = readlinkSync(path);
    else if (stat.isFile()) { entry.bytes = stat.size; entry.sha256 = sha256(readFileSync(path)); }
    else if (stat.isDirectory()) entry.children = readdirSync(path).sort();
    else entry.special = true;
    entries.push(entry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of entry.children) visit(join(path, name));
    }
  }
  visit(root);
  return entries;
}

function readonlyReject(root, execute, expected, failureClass = 'state') {
  const before = treeSnapshot(root);
  try {
    assert.throws(execute, error => {
      assert.match(error.message, expected);
      if (failureClass !== null) assert.equal(error.failureClass, failureClass);
      return true;
    });
  } finally { assert.deepEqual(treeSnapshot(root), before, 'rejection must not mutate evidence or create an owner claim'); }
}

const moduleURL = name => JSON.stringify(new URL(`../lib/${name}.mjs`, import.meta.url).href);
const childProgram = `
  import { journal, readJson, hash } from ${moduleURL('common')};
  import { inspectResumable, openExecution, withinTrial } from ${moduleURL('execution')};
  import { readEvents } from ${moduleURL('lifecycle')};
  import { validateBudgetLedger } from ${moduleURL('budget-ledger')};
  import { createProvider } from ${moduleURL('provider')};
  import { join } from 'node:path';
  const [root, mode, serialized = '{}'] = process.argv.slice(1);
  const options = JSON.parse(serialized);
  if (options.clock !== undefined) Date.now = () => options.clock;
  const manifest = readJson(join(root, 'manifest.json'));
  if (mode === 'initialize') {
    const handle = journal(join(root, 'events.jsonl'));
    try {
      handle.append({ type: 'run_started', startedAtMs: Date.now() });
      const execution = openExecution(root, manifest, handle);
      if (options.dispatch) {
        const trial = execution.plan.trials[0];
        execution.lifecycle.transition(trial, 'admitted', { startedAtMs: Date.now() });
        execution.lifecycle.transition(trial, 'dispatched');
        execution.budget.reserve(options.request);
        execution.budget.dispatch(options.request.requestId, options.request);
      }
    } finally { handle.close(); }
  } else {
    const checked = inspectResumable(root);
    if (mode === 'claim') {
      process.send({ type: 'ready', prefixHash: hash(checked.events) });
      await new Promise(resolve => process.once('message', resolve));
      let handle;
      try {
        handle = journal(join(root, 'events.jsonl'), { resume: true });
        openExecution(root, checked.manifest, handle, checked.events);
        process.send({ type: 'result', ok: true, owner: readJson(join(root, 'execution-owner.json')) });
      } catch (error) {
        process.send({ type: 'result', ok: false, code: error.message, failureClass: error.failureClass });
      } finally { handle?.close(); }
      await new Promise(resolve => process.once('disconnect', resolve));
    } else {
      const handle = journal(join(root, 'events.jsonl'), { resume: true });
      try {
        const execution = openExecution(root, checked.manifest, handle, checked.events);
        let transports = 0, callbacks = 0, replayError = null, durationError = null;
        if (options.replay) {
          const provider = createProvider(manifest.provider, execution.append, {
            budget: execution.budget, estimateInputTokens: () => 10,
            complete: async () => { transports++; throw new Error('fixture_unexpected_transport'); }
          });
          try { await provider.complete(options.body, new AbortController().signal, options.request); }
          catch (error) { replayError = { code: error.message, failureClass: error.failureClass }; }
        }
        if (options.checkDuration) {
          try {
            await withinTrial(execution, execution.plan.trials[0], new AbortController().signal,
              async () => { callbacks++; });
          } catch (error) { durationError = { code: error.message, failureClass: error.failureClass }; }
        }
        const state = validateBudgetLedger(root, manifest.executionPolicy.budget, readEvents(join(root, 'events.jsonl')));
        process.stdout.write(JSON.stringify({ state, transports, callbacks, replayError, durationError }));
      } finally { handle.close(); }
    }
  }
`;

function childRun(root, mode, options = {}) {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', childProgram, root, mode, JSON.stringify(options)],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  return output ? JSON.parse(output) : null;
}

function deadFixture(t, options = {}, initialize = {}) {
  const area = ownedArea(t), savedManifest = manifest(options);
  mkdirSync(area.root, { mode: 0o700 });
  durableJson(join(area.root, 'manifest.json'), savedManifest);
  childRun(area.root, 'initialize', initialize);
  return { ...area, manifest: savedManifest };
}

function cloneRun(t, original) {
  const area = ownedArea(t);
  cpSync(original, area.root, { recursive: true, dereference: false, errorOnExist: true, force: false });
  return area;
}

function resumer(area) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childProgram, area.root, 'claim'],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exit = area.track(child), messages = [], waiting = [];
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
  child.on('message', message => {
    const index = waiting.findIndex(waiter => waiter.type === message.type);
    if (index < 0) messages.push(message);
    else waiting.splice(index, 1)[0].resolve(message);
  });
  child.on('exit', code => {
    for (const waiter of waiting.splice(0)) waiter.reject(new Error(`fixture_resumer_exit_${code}: ${stderr}`));
  });
  return {
    child, exit,
    take(type) {
      const index = messages.findIndex(message => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return bounded(new Promise((resolve, reject) => waiting.push({ type, resolve, reject })), `resumer_${type}`);
    },
    async close() {
      if (child.connected) child.disconnect();
      const result = await bounded(exit, 'resumer_exit');
      assert.deepEqual(result, { code: 0, signal: null });
    }
  };
}

test('actual max-2 execution pool preserves private trial evidence and correlation when completions reorder', { timeout: 30000 }, async t => {
  const f = fixture(t, { repeats: 2 }), trials = f.execution.plan.trials;
  const gates = trials.map(() => deferred()), started = trials.map(() => deferred());
  const admitted = [], completed = [];
  let active = 0, peak = 0;
  const provider = providerFor(f, async (requestBody, taskSignal, correlation) => {
    const index = trials.findIndex(trial => trial.trialId === correlation.trialId);
    const trial = trials[index];
    assert.deepEqual(requestBody, body);
    assert.equal(correlation.requestId, `request-${trial.trialId}`);
    assert.equal(correlation.requestHash, hash(body));
    const history = readEvents(eventsPath(f.root));
    const dispatched = history.findLast(event => event.type === 'budget_dispatched');
    const checkpoint = history.find(event => event.sequence === dispatched.sequence + 1);
    assert.equal(dispatched.requestId, correlation.requestId);
    assert.equal(checkpoint.type, 'budget_checkpoint');
    assert.equal(checkpoint.anchorHash, hash(dispatched));
    assert.equal(validateBudgetLedger(f.root, f.manifest.executionPolicy.budget, history).stateHash, checkpoint.stateHash);
    assert.equal(history.at(-1).type, 'provider_admitted');
    assert.equal(taskSignal.aborted, false);
    admitted.push(trial.trialId);
    peak = Math.max(peak, ++active);
    started[index].resolve();
    try { await gates[index].promise; return response(); }
    finally { active--; }
  });
  const scheduled = scheduleTrials(trials, {
    maxConcurrentTrials: 2, signal: signal(),
    execute: trial => withinTrial(f.execution, trial, signal(), async (taskSignal, startedAtMs) => {
      const directory = join(f.root, trial.trialId);
      mkdirSync(directory, { mode: 0o700 });
      f.execution.lifecycle.transition(trial, 'dispatched');
      await provider.complete(body, taskSignal, { trialId: trial.trialId, requestId: `request-${trial.trialId}` });
      durableJson(join(directory, 'answer.json'), { taskId: trial.taskId, repeat: trial.repeat, traceId: trial.traceId });
      f.execution.lifecycle.transition(trial, 'completed');
      verifiedSeal(directory, f.execution.lifecycle, trial);
      const result = storeGrade(f.root, f.execution, trial, scored, startedAtMs);
      completed.push(trial.trialId);
      return result;
    })
  });
  try {
    await bounded(Promise.all([started[0].promise, started[1].promise]), 'first_pool');
    assert.deepEqual(admitted, trials.slice(0, 2).map(trial => trial.trialId));
    gates[1].resolve();
    await bounded(started[2].promise, 'next_pool');
    assert.deepEqual(completed, [trials[1].trialId]);
    assert.equal(active, 2);
    assert.equal(f.execution.lifecycle.state(trials[0].trialId), 'dispatched');
    gates[2].resolve();
    await bounded(started[3].promise, 'last_pool');
    gates[3].resolve(); gates[0].resolve();
    const { results, error } = await bounded(scheduled, 'pool_completion');
    assert.equal(error, null);
    assert.equal(peak, 2);
    assert.equal(results.size, 4);
    assert.equal(new Set(admitted).size, 4);
    assert.equal(new Set(trials.map(trial => trial.traceId)).size, 4);
    const history = readEvents(eventsPath(f.root));
    assert.deepEqual(loadRunPlan(f.root, f.manifest, history), f.execution.plan);
    for (const trial of trials) {
      const result = results.get(trial.trialId);
      assert.deepEqual(readGrade(f.root, f.execution, trial), result);
      assert.equal(result.clusterId, trial.clusterId);
      assert.equal(result.traceId, trial.traceId);
      assert.equal(result.usage.requests, 1);
      assert.equal(result.usage.inputTokens, 4);
      assert.deepEqual(result.usage.reservations.map(value => value.requestId), [`request-${trial.trialId}`]);
      for (const pointer of result.traces.artifacts) {
        assert.ok(pointer.artifact.startsWith(`${trial.trialId}/`));
        assert.equal(pointer.sha256, sha256(readFileSync(join(f.root, pointer.artifact))));
      }
      for (const event of history.filter(event => event.trialId === trial.trialId && !event.type.startsWith('budget_'))) {
        assert.equal(event.taskId, trial.taskId);
        assert.equal(event.clusterId, trial.clusterId);
        assert.equal(event.repeat, trial.repeat);
        assert.equal(event.traceId, trial.traceId);
      }
    }
    assert.equal(validateBudgetLedger(f.root, f.manifest.executionPolicy.budget, history).requests, 4);
  } finally {
    for (const gate of gates) gate.resolve();
    await scheduled.catch(() => {});
  }
});

test('scheduler stops queued admissions after error or cancellation and drains active work', async t => {
  const trials = ['a', 'b', 'c', 'd'].map(trialId => ({ trialId }));
  await t.test('failure drains the other active worker', async () => {
    const first = deferred(), second = deferred(), entered = [];
    const failure = new EvaluationError('infrastructure', 'fixture_worker_failed');
    let finished = false;
    const scheduled = scheduleTrials(trials, {
      signal: signal(), execute: trial => { entered.push(trial.trialId); return trial.trialId === 'a' ? first.promise : second.promise; }
    });
    const rejected = assert.rejects(scheduled, error => error === failure).then(() => { finished = true; });
    try {
      assert.deepEqual(entered, ['a', 'b']);
      first.reject(failure);
      await nextTurn();
      assert.equal(finished, false);
      assert.deepEqual(entered, ['a', 'b']);
    } finally { second.resolve('b'); await rejected; }
  });
  await t.test('stopOnError false preserves remaining results', async () => {
    const failure = new Error('fixture_worker_failed');
    const result = await scheduleTrials(trials, {
      signal: signal(), stopOnError: false,
      execute: async trial => { if (trial.trialId === 'a') throw failure; return trial.trialId; }
    });
    assert.equal(result.error, failure);
    assert.deepEqual([...result.results.keys()].sort(), ['b', 'c', 'd']);
  });
  await t.test('an already aborted signal starts no workers', async () => {
    const controller = new AbortController(), reason = new EvaluationError('operator', 'fixture_cancelled');
    controller.abort(reason);
    let calls = 0;
    await assert.rejects(scheduleTrials(trials, { signal: controller.signal, execute: async () => { calls++; } }),
      error => error === reason);
    assert.equal(calls, 0);
  });
  await t.test('mid-pool cancellation stops queued work after active workers finish', async () => {
    const controller = new AbortController(), gate = deferred(), entered = [];
    const reason = new EvaluationError('operator', 'fixture_cancelled');
    const scheduled = scheduleTrials(trials, {
      signal: controller.signal, execute: async trial => { entered.push(trial.trialId); await gate.promise; }
    });
    const rejected = assert.rejects(scheduled, error => error === reason);
    controller.abort(reason); gate.resolve();
    await rejected;
    assert.deepEqual(entered, ['a', 'b']);
  });
});

test('budget, admission timeout and cancellation reject before the supplied transport can run', async t => {
  for (const mode of ['requests', 'run-duration', 'expired-admission', 'cancelled']) {
    await t.test(mode, async t => {
      const f = fixture(t, {
        taskTimeoutMs: 1000,
        budget: mode === 'requests' ? { maxModelRequests: 0 }
          : mode === 'run-duration' ? { maxRunDurationMs: 0 } : {}
      });
      const trial = f.execution.plan.trials[0], controller = new AbortController();
      if (mode === 'expired-admission') f.execution.lifecycle.transition(trial, 'admitted', { startedAtMs: Date.now() - 2000 });
      if (mode === 'cancelled') controller.abort(new EvaluationError('operator', 'fixture_cancelled'));
      let callbacks = 0;
      await assert.rejects(withinTrial(f.execution, trial, controller.signal, async taskSignal => {
        callbacks++;
        await providerFor(f).complete(body, taskSignal, { trialId: trial.trialId, requestId: 'blocked' });
      }), mode === 'requests' ? /budget_max_model_requests/ : mode === 'run-duration' ? /budget_max_run_duration/
        : mode === 'expired-admission' ? /budget_max_task_duration/ : /fixture_cancelled/);
      assert.equal(f.transports, 0);
      assert.equal(callbacks, mode === 'requests' ? 1 : 0);
      const history = readEvents(eventsPath(f.root));
      assert.equal(history.some(event => event.type === 'budget_dispatched' || event.type === 'provider_admitted'), false);
      const saved = validateBudgetLedger(f.root, f.manifest.executionPolicy.budget, history);
      assert.equal(saved.requests, 0);
      if (['requests', 'run-duration'].includes(mode)) {
        assert.equal(history.at(-2).type, 'budget_rejected');
        assert.equal(history.at(-1).type, 'budget_checkpoint');
        assert.equal(history.at(-1).stateHash, saved.stateHash);
      }
    });
  }
});

test('lifecycle history rejects identity drift, skipped states and replay without appending', async t => {
  const f = fixture(t), original = readEvents(eventsPath(f.root)), trial = f.execution.plan.trials[0];
  for (const mode of ['taskId', 'clusterId', 'repeat', 'traceId', 'jump', 'replay']) {
    await t.test(mode, () => {
      const changed = structuredClone(original), event = changed.find(event => event.type === 'trial_state' && event.trialId === trial.trialId);
      if (mode === 'jump') event.to = 'completed';
      else if (mode === 'replay') changed.push(structuredClone(event));
      else event[mode] = mode === 'repeat' ? event.repeat + 1 : `changed-${event[mode]}`;
      let appends = 0;
      readonlyReject(f.root, () => new TrialLifecycle(f.execution.plan, () => { appends++; }, changed), /trial_lifecycle_invalid/);
      assert.equal(appends, 0);
    });
  }
  const restored = new TrialLifecycle(f.execution.plan, () => assert.fail('readonly restore appended'), original);
  assert.equal(restored.state(trial.trialId), 'pending');
  assert.deepEqual(original, readEvents(eventsPath(f.root)));
});

test('only proven never-dispatched staging is discarded, with a durable inventory before removal', async t => {
  await t.test('pending and admitted staging are owned and idempotent', t => {
    const f = fixture(t), [trial, other] = f.execution.plan.trials;
    const directory = join(f.root, trial.trialId), sibling = join(f.root, other.trialId);
    mkdirSync(directory); mkdirSync(sibling);
    durableJson(join(directory, 'output.json'), { partial: true });
    durableJson(join(sibling, 'answer.json'), { retained: true });
    const inventoryHash = hash(fileInventory(directory)), siblingBefore = treeSnapshot(sibling);
    f.execution.lifecycle.transition(trial, 'admitted', { startedAtMs: Date.now() });
    const lifecycle = new TrialLifecycle(f.execution.plan, event => {
      if (event.type === 'undispatched_staging_discarded') {
        assert.equal(existsSync(directory), true);
        assert.equal(event.inventoryHash, inventoryHash);
      }
      return f.execution.append(event);
    }, readEvents(eventsPath(f.root)));
    assert.equal(lifecycle.recovery(trial), 'never-dispatched');
    discardUndispatched(f.root, trial, lifecycle);
    assert.equal(existsSync(directory), false);
    const history = readEvents(eventsPath(f.root));
    assert.equal(history.at(-1).type, 'undispatched_staging_discarded');
    assert.equal(history.at(-1).inventoryHash, inventoryHash);
    assert.deepEqual(treeSnapshot(sibling), siblingBefore);
    discardUndispatched(f.root, trial, lifecycle);
    assert.deepEqual(readEvents(eventsPath(f.root)), history);
  });
  await t.test('failed append preserves all staging bytes', t => {
    const f = fixture(t), trial = f.execution.plan.trials[0], directory = join(f.root, trial.trialId);
    mkdirSync(directory); durableJson(join(directory, 'output.json'), { partial: true });
    const lifecycle = new TrialLifecycle(f.execution.plan, () => { throw new Error('fixture_append_failed'); },
      readEvents(eventsPath(f.root)));
    readonlyReject(f.root, () => discardUndispatched(f.root, trial, lifecycle), /fixture_append_failed/, null);
  });
});

test('dispatch markers, advanced lifecycle and symlink staging cannot be discarded', async t => {
  for (const marker of ['worker_started', 'model_request', 'execution_requested', 'budget_dispatched', 'dispatched-state', 'directory-link', 'nested-link']) {
    await t.test(marker, t => {
      const f = fixture(t), trial = f.execution.plan.trials[0], directory = join(f.root, trial.trialId);
      const target = join(f.parent, 'owned-link-target');
      mkdirSync(target); durableJson(join(target, 'answer.json'), { retained: true });
      if (marker === 'directory-link') symlinkSync(target, directory, 'dir');
      else {
        mkdirSync(directory); durableJson(join(directory, 'output.json'), { partial: true });
        if (marker === 'nested-link') symlinkSync(join(target, 'answer.json'), join(directory, 'answer-link.json'));
        else if (marker === 'budget_dispatched') {
          const request = { trialId: trial.trialId, requestId: 'staged-request', requestHash: hash(body),
            kind: 'chat', providerId: 'fixture-provider', model: 'fixture-model', inputTokens: 10, outputTokens: 20 };
          f.execution.budget.reserve(request); f.execution.budget.dispatch(request.requestId, request);
        } else if (marker === 'dispatched-state') {
          f.execution.lifecycle.transition(trial, 'admitted', { startedAtMs: Date.now() });
          f.execution.lifecycle.transition(trial, 'dispatched');
        } else f.execution.lifecycle.record(trial, { type: marker });
      }
      const lifecycle = new TrialLifecycle(f.execution.plan, f.execution.append, readEvents(eventsPath(f.root)));
      readonlyReject(f.parent, () => discardUndispatched(f.root, trial, lifecycle),
        marker === 'directory-link' ? /unsafe_trial_staging_path/
          : marker === 'nested-link' ? /artifact_link_or_special_file/
          : /resume_(trial_requires_reconciliation|dispatched_replay_blocked)/,
        marker === 'nested-link' ? null : 'state');
    });
  }
});

test('two real resumers claim one predecessor exclusively and the loser cannot poison the next owner', { timeout: 30000 }, async t => {
  const f = deadFixture(t), predecessor = readJson(join(f.root, 'execution-owner.json'));
  const a = resumer(f), b = resumer(f);
  const ready = await Promise.all([a.take('ready'), b.take('ready')]);
  assert.equal(ready[0].prefixHash, ready[1].prefixHash);
  a.child.send({ type: 'go' }); b.child.send({ type: 'go' });
  const outcomes = await Promise.all([a.take('result'), b.take('result')]);
  assert.equal(outcomes.filter(result => result.ok).length, 1);
  const winnerIndex = outcomes.findIndex(result => result.ok), loserIndex = 1 - winnerIndex;
  assert.match(outcomes[loserIndex].code, /resume_(changed_before_claim|changed_during_claim|owner_already_claimed|owner_still_running)/);
  assert.equal(outcomes[loserIndex].failureClass, 'state');
  const owner = readJson(join(f.root, 'execution-owner.json'));
  assert.equal(owner.claimId, outcomes[winnerIndex].owner.claimId);
  assert.equal(readEvents(eventsPath(f.root)).filter(event => event.type === 'run_resumed').length, 1);
  assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('resume-claim-')), [`resume-claim-${predecessor.claimId}.json`]);
  const afterClaim = treeSnapshot(f.root);
  await [a, b][loserIndex].close();
  assert.deepEqual(treeSnapshot(f.root), afterClaim);
  await [a, b][winnerIndex].close();
  const next = childRun(f.root, 'resume');
  assert.equal(next.state.requests, 0);
  const history = readEvents(eventsPath(f.root)), successor = readJson(join(f.root, 'execution-owner.json'));
  assert.notEqual(successor.claimId, owner.claimId);
  assert.equal(history.filter(event => event.type === 'run_resumed').length, 2);
  assert.equal(history.findLast(event => event.type === 'run_resumed').previousOwnerHash, hash(owner));
  assert.equal(history.findLast(event => event.type === 'run_resumed').ownerHash, hash(successor));
  assert.equal(readdirSync(f.root).filter(name => name.startsWith('resume-claim-')).length, 2);
  inspectResumable(f.root);
});

test('preclaim rechecks the last owner hash and complete journal prefix before any root mutation', async t => {
  const original = deadFixture(t);
  for (const mode of ['owner', 'prefix']) await t.test(mode, t => {
    const f = cloneRun(t, original.root), checked = inspectResumable(f.root);
    if (mode === 'owner') {
      const owner = readJson(join(f.root, 'execution-owner.json'));
      owner.claimedAtMs++; saveJson(join(f.root, 'execution-owner.json'), owner);
    } else {
      saveEvents(f.root, [...checked.events, { type: 'unrelated_durable_event', at: new Date().toISOString() }]);
    }
    const handle = f.openJournal(true);
    readonlyReject(f.root, () => openExecution(f.root, checked.manifest, handle, checked.events), /resume_changed_before_claim/);
    assert.equal(readdirSync(f.root).some(name => name.startsWith('resume-claim-')), false);
  });
});

test('resume manifest, source identity, owner, plan, journal and durable budget tamper are rejected read-only', { timeout: 30000 }, async t => {
  const original = deadFixture(t);
  const modes = [
    'manifest', 'source', 'owner', 'invalid-owner', 'plan', 'sequence', 'torn-journal',
    'lifecycle', 'snapshot', 'checkpoint', 'missing-checkpoint', 'partial-snapshot', 'budget-policy'
  ];
  for (const mode of modes) await t.test(mode, t => {
    const f = cloneRun(t, original.root), history = readEvents(eventsPath(f.root));
    let expected;
    if (mode === 'manifest' || mode === 'source') {
      const value = readJson(join(f.root, 'manifest.json'));
      if (mode === 'manifest') value.selection[0].clusterId = 'changed-cluster';
      else value.source.sourceHash = '0'.repeat(64);
      saveJson(join(f.root, 'manifest.json'), value);
      expected = mode === 'manifest' ? /run_plan_changed/ : /resume_source_changed/;
    } else if (mode === 'owner' || mode === 'invalid-owner') {
      const value = readJson(join(f.root, 'execution-owner.json'));
      if (mode === 'owner') value.claimedAtMs++;
      else {
        value.pid = -1;
        history.findLast(event => ['run_owner', 'run_resumed'].includes(event.type)).ownerHash = hash(value);
        saveEvents(f.root, history);
      }
      saveJson(join(f.root, 'execution-owner.json'), value);
      expected = mode === 'owner' ? /resume_owner_changed/ : /resume_owner_invalid/;
    } else if (mode === 'plan') {
      const value = readJson(join(f.root, 'run-plan.json'));
      value.trials[0].traceId = 'changed-trace'; saveJson(join(f.root, 'run-plan.json'), value);
      expected = /run_plan_changed/;
    } else if (mode === 'sequence') {
      history[1].sequence = 1;
      writeFileSync(eventsPath(f.root), history.map(event => JSON.stringify(event) + '\n').join(''));
      expected = /run_journal_sequence_invalid/;
    } else if (mode === 'torn-journal') {
      writeFileSync(eventsPath(f.root), readFileSync(eventsPath(f.root), 'utf8').trimEnd());
      expected = /run_journal_torn_write/;
    } else if (mode === 'lifecycle') {
      history.find(event => event.type === 'trial_state').taskId = 'changed-task';
      saveEvents(f.root, history); expected = /trial_lifecycle_invalid/;
    } else if (mode === 'snapshot') {
      const value = readJson(statePath(f.root)); value.elapsedMs++; saveJson(statePath(f.root), value);
      expected = /budget_snapshot_hash_changed/;
    } else if (mode === 'checkpoint') {
      history.findLast(event => event.type === 'budget_checkpoint').stateHash = '0'.repeat(64);
      saveEvents(f.root, history); expected = /budget_checkpoint_changed/;
    } else if (mode === 'missing-checkpoint') {
      history.pop();
      history.push({ type: 'unrelated_durable_event', at: new Date().toISOString() });
      saveEvents(f.root, history); expected = /budget_checkpoint_missing/;
    } else if (mode === 'partial-snapshot') {
      writeFileSync(join(f.root, 'budget-state.json.fixture.tmp'), '{"partial":');
      expected = /budget_snapshot_partial/;
    } else {
      const value = readJson(join(f.root, 'manifest.json')), plan = readJson(join(f.root, 'run-plan.json'));
      value.executionPolicy.budget.maxModelRequests++;
      value.provider.budget.maxModelRequests++;
      plan.manifestHash = hash(value);
      history.find(event => event.type === 'run_plan').planHash = hash(plan);
      saveJson(join(f.root, 'manifest.json'), value); saveJson(join(f.root, 'run-plan.json'), plan);
      saveEvents(f.root, history); expected = /budget_snapshot_policy_changed/;
    }
    readonlyReject(f.root, () => inspectResumable(f.root), expected);
  });
});

test('sealed, finalized and linked run artifacts reject read-only without traversing link targets', { timeout: 30000 }, async t => {
  const original = deadFixture(t);
  for (const mode of ['seal', 'summary', 'finished-event', 'root-link', 'manifest.json', 'run-plan.json', 'events.jsonl', 'execution-owner.json', 'budget-state.json']) {
    await t.test(mode, t => {
      const f = cloneRun(t, original.root);
      let path = f.root, expected, failureClass = 'state';
      if (mode === 'seal') {
        durableJson(join(f.root, 'seal.json'), { sealed: true });
        expected = /resume_requires_unsealed_run/; failureClass = 'policy';
      } else if (mode === 'summary') {
        durableJson(join(f.root, 'summary.json'), { finished: true }); expected = /resume_finalized_run_requires_reconciliation/;
      } else if (mode === 'finished-event') {
        saveEvents(f.root, [...readEvents(eventsPath(f.root)), { type: 'run_finished', at: new Date().toISOString() }]);
        expected = /resume_finalized_run_requires_reconciliation/;
      } else if (mode === 'root-link') {
        path = join(f.parent, 'linked-run'); symlinkSync(f.root, path, 'dir'); expected = /resume_run_not_regular_directory/;
      } else {
        const target = join(f.parent, `owned-${mode}`);
        cpSync(join(f.root, mode), target, { errorOnExist: true, force: false });
        rmSync(join(f.root, mode)); symlinkSync(target, join(f.root, mode));
        expected = mode === 'events.jsonl' ? /run_journal_invalid/ : mode === 'run-plan.json' ? /run_plan_not_regular/
          : mode === 'budget-state.json' ? /budget_ledger_file_invalid/ : /resume_artifact_not_regular/;
      }
      readonlyReject(f.parent, () => inspectResumable(path), expected, failureClass);
    });
  }
});

test('verified seal permits later grading artifacts while fixing every runtime evidence byte and its seal hash', async t => {
  const f = fixture(t), { trial, directory } = await prepareVerified(f);
  validateVerifiedSeal(f.root, f.execution.lifecycle, trial);
  durableJson(join(directory, 'grade.json'), { later: true });
  durableJson(join(directory, 'trial-evidence.json'), { later: true });
  mkdirSync(join(directory, 'grading')); durableJson(join(directory, 'grading', 'analysis.json'), { later: true });
  validateVerifiedSeal(f.root, f.execution.lifecycle, trial);
  const answerPath = join(directory, 'answer.json'), originalAnswer = readFileSync(answerPath);
  writeFileSync(answerPath, '{"changed":true}\n');
  readonlyReject(f.root, () => validateVerifiedSeal(f.root, f.execution.lifecycle, trial), /trial_evidence_changed/);
  writeFileSync(answerPath, originalAnswer);
  durableJson(join(directory, 'unexpected-runtime.json'), { added: true });
  readonlyReject(f.root, () => validateVerifiedSeal(f.root, f.execution.lifecycle, trial), /trial_evidence_changed/);
  rmSync(join(directory, 'unexpected-runtime.json'));
  const sealPath = join(directory, 'verified-evidence.json');
  writeFileSync(sealPath, readFileSync(sealPath, 'utf8') + '\n');
  readonlyReject(f.root, () => validateVerifiedSeal(f.root, f.execution.lifecycle, trial), /trial_evidence_changed/);
});

test('graded reuse is read-only and rejects changed evidence, seal hash and grade identity', async t => {
  for (const mode of ['reuse', 'grade-bytes', 'new-artifact', 'seal-hash', 'rehash-wrong-cluster']) {
    await t.test(mode, async t => {
      const f = fixture(t), { trial, directory, startedAtMs } = await prepareVerified(f);
      const saved = storeGrade(f.root, f.execution, trial, scored, startedAtMs);
      const history = readEvents(eventsPath(f.root));
      assert.equal(history.filter(event => event.type === 'trial_state' && event.to === 'graded').length, 1);
      assert.equal(history.filter(event => event.type === 'trial_finished').length, 1);
      if (mode === 'reuse') {
        const before = treeSnapshot(f.root), transports = f.transports;
        assert.deepEqual(readGrade(f.root, f.execution, trial), saved);
        assert.deepEqual(treeSnapshot(f.root), before);
        assert.equal(f.transports, transports);
        return;
      }
      if (mode === 'grade-bytes') {
        const value = structuredClone(saved); value.metrics.score = 0; saveJson(join(directory, 'grade.json'), value);
      } else if (mode === 'new-artifact') durableJson(join(directory, 'extra-output.json'), { added: true });
      else if (mode === 'seal-hash') {
        const path = join(directory, 'trial-evidence.json'); writeFileSync(path, readFileSync(path, 'utf8') + '\n');
      } else {
        const value = structuredClone(saved); value.clusterId = 'wrong-cluster';
        saveJson(join(directory, 'grade.json'), value);
        rmSync(join(directory, 'trial-evidence.json'));
        const changedSealHash = sealTrial(directory);
        for (const event of history.filter(event => event.trialId === trial.trialId && event.gradeHash)) {
          event.gradeHash = hash(value); event.trialEvidenceHash = changedSealHash;
        }
        saveEvents(f.root, history);
        f.execution.lifecycle = new TrialLifecycle(f.execution.plan, f.execution.append, readEvents(eventsPath(f.root)));
      }
      readonlyReject(f.root, () => readGrade(f.root, f.execution, trial),
        mode === 'rehash-wrong-cluster' ? /resume_grade_changed/ : /trial_evidence_changed/);
    });
  }
});

test('a verified orphan grade with or without a trial seal is adopted without rewriting it or redispatching', async t => {
  for (const withSeal of [false, true]) await t.test(`trial-seal-${withSeal}`, async t => {
    let clock = 10000;
    t.mock.method(Date, 'now', () => clock);
    const f = await orphan(t, { withSeal }), path = join(f.directory, 'grade.json');
    const originalGrade = readFileSync(path), originalSeal = withSeal ? readFileSync(join(f.directory, 'trial-evidence.json')) : null;
    clock += 100;
    await prepareVerified(f, f.execution.plan.trials[1]);
    const usage = f.execution.budget.snapshot({ trialId: f.trial.trialId });
    assert.notEqual(usage.nextRequestNumber, f.saved.usage.nextRequestNumber);
    assert.notEqual(usage.capturedAtMs, f.saved.usage.capturedAtMs);
    const historyBefore = readEvents(eventsPath(f.root)), transports = f.transports;
    validateVerifiedSeal(f.root, f.execution.lifecycle, f.trial);
    assert.equal(readGrade(f.root, f.execution, f.trial), null);
    const recovered = storeGrade(f.root, f.execution, f.trial, structuredClone(scored), f.startedAtMs);
    assert.deepEqual(recovered, f.saved);
    assert.deepEqual(readFileSync(path), originalGrade);
    if (withSeal) assert.deepEqual(readFileSync(join(f.directory, 'trial-evidence.json')), originalSeal);
    assert.equal(f.transports, transports);
    assert.equal(f.execution.lifecycle.state(f.trial.trialId), 'graded');
    const history = readEvents(eventsPath(f.root));
    assert.deepEqual(history.slice(0, historyBefore.length), historyBefore);
    assert.deepEqual(history.slice(historyBefore.length).map(event => event.type), ['trial_state', 'trial_finished']);
    assert.equal(history.filter(event => event.type === 'budget_dispatched').length,
      historyBefore.filter(event => event.type === 'budget_dispatched').length);
    assert.deepEqual(readGrade(f.root, f.execution, f.trial), f.saved);
    inspectTrialSeal(f.directory, 'trial-evidence.json', history.at(-1).trialEvidenceHash);
    validateBudgetLedger(f.root, f.manifest.executionPolicy.budget, history);
  });
});

test('tampered orphan grades fail read-only before supplementing seal or graded journal events', { timeout: 30000 }, async t => {
  for (const withSeal of [false, true]) {
    for (const mode of ['identity', 'score', 'accounting', 'reservation', 'trace', 'negative-latency', 'fractional-latency', 'future-latency', 'sealed-evidence']) {
      if (!withSeal && mode === 'sealed-evidence') continue;
      await t.test(`trial-seal-${withSeal}/${mode}`, async t => {
        const f = await orphan(t, { withSeal }), value = structuredClone(f.saved);
        if (mode === 'identity') value.clusterId = 'wrong-cluster';
        if (mode === 'score') value.metrics.score = 0;
        if (mode === 'accounting') value.usage.accounted.inputTokens++;
        if (mode === 'reservation') value.usage.reservations[0].requestHash = hash('changed-request');
        if (mode === 'trace') value.traces.artifacts[0].sha256 = '0'.repeat(64);
        if (mode === 'negative-latency') value.latencyMs = -1;
        if (mode === 'fractional-latency') value.latencyMs = 0.5;
        if (mode === 'future-latency') value.latencyMs = Number.MAX_SAFE_INTEGER;
        // An unreferenced addition bypasses the pointer comparison and must
        // still be rejected by the existing trial seal.
        if (mode === 'sealed-evidence') durableJson(join(f.directory, 'notes.json'), { added: true });
        else saveJson(join(f.directory, 'grade.json'), value);
        const transports = f.transports, history = readEvents(eventsPath(f.root));
        assert.equal(readGrade(f.root, f.execution, f.trial), null);
        readonlyReject(f.root, () => storeGrade(f.root, f.execution, f.trial, scored, f.startedAtMs),
          mode === 'sealed-evidence' ? /trial_evidence_changed/ : /resume_uncommitted_grade_changed/);
        assert.equal(f.execution.lifecycle.state(f.trial.trialId), 'verified');
        assert.equal(f.transports, transports);
        assert.deepEqual(readEvents(eventsPath(f.root)), history);
      });
    }
  }
});

test('dispatched usage becomes unknown once across real resumes, remains charged and cannot replay; downtime expires admission', { timeout: 30000 }, t => {
  const request = {
    trialId: 'trial-task-a-0', requestId: 'crash-dispatched', requestHash: hash(body),
    kind: 'chat', providerId: 'fixture-provider', model: 'fixture-model', inputTokens: 10, outputTokens: 20
  };
  const f = deadFixture(t, { budget: { maxModelRequests: 1, maxRunDurationMs: 250 } },
    { clock: 1000, dispatch: true, request });
  const initialBytes = readFileSync(statePath(f.root));
  const checked = inspectResumable(f.root);
  assert.equal(validateBudgetLedger(f.root, f.manifest.executionPolicy.budget, checked.events).reservations[0].state, 'dispatched');
  assert.deepEqual(readFileSync(statePath(f.root)), initialBytes);
  const first = childRun(f.root, 'resume', { clock: 1100, replay: true, request, body });
  assert.deepEqual(first.replayError, { code: 'budget_request_replay_blocked', failureClass: 'policy' });
  assert.equal(first.transports, 0);
  assert.equal(first.state.elapsedMs, 100);
  assert.equal(first.state.reservations[0].state, 'unknown');
  assert.equal(first.state.reservations[0].reason, 'resume_usage_unknown');
  assert.equal(first.state.accounted.inputTokens, 10);
  assert.equal(first.state.accounted.outputTokens, 20);
  assert.equal(first.state.unknownRequests, 1);
  assert.equal(first.state.pendingRequests, 0);
  assert.deepEqual(first.state.replayBlockedRequestIds, [request.requestId]);
  const second = childRun(f.root, 'resume', { clock: 1200, replay: true, request, body });
  assert.deepEqual(second.replayError, first.replayError);
  assert.equal(second.transports, 0);
  assert.equal(second.state.elapsedMs, 200);
  assert.deepEqual(second.state.reservations, first.state.reservations);
  const third = childRun(f.root, 'resume', { clock: 1250, checkDuration: true });
  assert.deepEqual(third.durationError, { code: 'budget_max_run_duration', failureClass: 'policy' });
  assert.equal(third.callbacks, 0);
  assert.equal(third.transports, 0);
  assert.equal(third.state.elapsedMs, 250);
  assert.equal(third.state.requests, 1);
  const history = readEvents(eventsPath(f.root));
  assert.equal(history.filter(event => event.type === 'budget_dispatched').length, 1);
  assert.equal(history.filter(event => event.type === 'budget_unknown').length, 1);
  assert.equal(history.filter(event => event.type === 'budget_restored').length, 3);
  assert.equal(history.at(-2).type, 'budget_rejected');
  assert.equal(history.at(-1).type, 'budget_checkpoint');
  const lifecycle = new TrialLifecycle(checked.plan, () => assert.fail('read-only recovery appended'), history);
  assert.equal(lifecycle.recovery(checked.plan.trials[0]), 'verify-existing');
  readonlyReject(f.root, () => discardUndispatched(f.root, checked.plan.trials[0], lifecycle), /resume_dispatched_replay_blocked/);
  validateBudgetLedger(f.root, f.manifest.executionPolicy.budget, history);
});
