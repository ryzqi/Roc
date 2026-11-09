import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';

async function loadUsageModules() {
  const directory = mkdtempSync(join(tmpdir(), 'roc-run-usage-observer-'));
  const observerPath = join(directory, 'observer.mjs');
  const middlewarePath = join(directory, 'middleware.mjs');
  await Promise.all([
    build({ entryPoints: ['src/main/services/deep-agent/run-usage-observer.ts'], outfile: observerPath, bundle: true, format: 'esm', platform: 'node' }),
    build({ entryPoints: ['src/main/services/deep-agent/run-usage-middleware.ts'], outfile: middlewarePath, bundle: true, format: 'esm', platform: 'node' })
  ]);
  const [{ RunUsageObserver }, { createRunUsageMiddleware }] = await Promise.all([
    import(observerPath),
    import(middlewarePath)
  ]);
  return { directory, RunUsageObserver, createRunUsageMiddleware };
}

function makeLimits(overrides = {}) {
  return {
    policyVersion: 1,
    contextWindowTokens: 1000,
    maxOutputTokens: 250,

    ...overrides
  };
}

function makeLedger(reserveError = null) {
  const calls = [];
  const settlements = [];
  const ledger = {
    reserve: (...args) => {
      calls.push(args);
      if (reserveError !== null) throw reserveError;
    },
    settle: (...args) => settlements.push(args),
    consumeCorrections: () => undefined,
    recordModelObservation: () => undefined,
    readUsageStatus: () => ({
      tokens: { settled: 0, unknown: 0, reserved: 0 },
      calls: {
        models: { total: calls.length, reserved: calls.length },
        tools: { total: 0, reserved: 0 },
        children: { total: 0, reserved: 0 }
      }
    })
  };
  return { ledger, calls, settlements };
}

test('run usage reserves before the provider handler and settles exact usage', async () => {
  const { directory, RunUsageObserver } = await loadUsageModules();
  try {
    const state = makeLedger();
    const statuses = [];
    const observer = new RunUsageObserver(state.ledger, 'run', makeLimits(), 'revision', {
      providerId: 'provider',
      modelId: 'mutable-alias',
      onStatus: (status) => statuses.push(status)
    });
    let providerCalls = 0;
    const response = new AIMessage({
      content: 'ok',
      usage_metadata: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }
    });
    const result = await observer.invoke({
      messages: [new HumanMessage('hello')],
      purpose: 'agent',
      responseMessage: (message) => message,
      invoke: async () => {
        providerCalls++;
        return response;
      }
    });
    assert.equal(result, response);
    assert.equal(providerCalls, 1);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0][2].tokens, 0);
    assert.equal(state.settlements.length, 1);
    assert.equal(state.settlements[0][2], 20);
    assert.equal(state.settlements[0][3], 'settled');
    assert.ok(statuses.length >= 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run usage middleware blocks the provider when reservation fails', async () => {
  const { directory, RunUsageObserver, createRunUsageMiddleware } = await loadUsageModules();
  try {
    const state = makeLedger(new Error('run_usage_call_input_drift'));
    const limits = makeLimits();
    const observer = new RunUsageObserver(state.ledger, 'run', limits, 'revision');
    const middleware = createRunUsageMiddleware(state.ledger, 'run', limits, observer);
    let providerCalls = 0;
    await assert.rejects(middleware.wrapModelCall({
      messages: [new HumanMessage('too much')],
      systemMessage: new SystemMessage('system'),
      runtime: { signal: undefined }
    }, async () => {
      providerCalls++;
      return new AIMessage('must not reach provider');
    }), /run_usage_call_input_drift/);
    assert.equal(providerCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('project domain errors preserve their original classification', async () => {
  const { directory, RunUsageObserver } = await loadUsageModules();
  try {
    const failedState = makeLedger();
    const failed = new RunUsageObserver(failedState.ledger, 'run', makeLimits(), 'revision');
    await assert.rejects(failed.invoke({
      messages: [new HumanMessage('archived project')],
      purpose: 'agent',
      responseMessage: message => message,
      invoke: async () => { throw new Error('research_project_archived'); }
    }), /research_project_archived/u);
    assert.equal(failedState.settlements.length, 1);
    assert.equal(failedState.settlements[0][3], 'unknown');

    const blockedState = makeLedger(new Error('research_project_not_found'));
    const blocked = new RunUsageObserver(blockedState.ledger, 'run', makeLimits(), 'revision');
    await assert.rejects(blocked.invoke({
      messages: [new HumanMessage('missing project')],
      purpose: 'summary',
      responseMessage: message => message,
      invoke: async () => { throw new Error('provider must not run'); }
    }), /research_project_not_found/u);
    assert.equal(blockedState.settlements.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run usage preserves unknown usage after missing metadata or provider interruption', async () => {
  const { directory, RunUsageObserver } = await loadUsageModules();
  try {
    const state = makeLedger();
    const observer = new RunUsageObserver(state.ledger, 'run', makeLimits(), 'revision');
    await observer.invoke({
      messages: [new HumanMessage('missing usage')],
      purpose: 'agent',
      responseMessage: (message) => message,
      invoke: async () => new AIMessage('unmetered')
    });
    await assert.rejects(observer.invoke({
      messages: [new HumanMessage('interrupted')],
      purpose: 'agent',
      responseMessage: (message) => message,
      invoke: async () => { throw new Error('network_error'); }
    }), /network_error/);
    assert.equal(state.settlements.length, 2);
    assert.equal(state.settlements[0][2], null);
    assert.equal(state.settlements[0][3], 'unknown');
    assert.equal(state.settlements[1][2], null);
    assert.equal(state.settlements[1][3], 'unknown');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('model observations distinguish agent and summary estimates, actual usage and unknown metadata', async () => {
  const { directory, RunUsageObserver } = await loadUsageModules();
  try {
    const state = makeLedger();
    const observations = [];
    const observer = new RunUsageObserver(state.ledger, 'run', makeLimits(), 'revision', {
      onInvocation: observation => observations.push(observation)
    });
    await observer.invoke({
      messages: [new HumanMessage('private prompt never belongs in observation')],
      purpose: 'summary',
      estimatedInputTokens: 18,
      estimateApproximate: true,
      responseMessage: message => message,
      invoke: async () => new AIMessage({
        content: 'private model output',
        usage_metadata: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }
      })
    });
    await observer.invoke({
      messages: [new HumanMessage('second private prompt')],
      purpose: 'agent',
      responseMessage: message => message,
      invoke: async () => new AIMessage('unmetered')
    });
    assert.equal(observations.length, 2);
    const { durationMs, ...summary } = observations[0];
    assert.ok(Number.isInteger(durationMs) && durationMs >= 0);
    assert.deepEqual(summary, {
      purpose: 'summary', status: 'completed', estimatedInputTokens: 18,
      actualInputTokens: 12, actualOutputTokens: 8, actualCacheReadTokens: 0,
      actualCacheCreationTokens: 0, estimateApproximate: true
    });
    const { durationMs: unknownDuration, ...unknown } = observations[1];
    assert.ok(Number.isInteger(unknownDuration) && unknownDuration >= 0);
    assert.deepEqual(unknown, {
      purpose: 'agent', status: 'completed', estimatedInputTokens: null,
      actualInputTokens: null, actualOutputTokens: null, actualCacheReadTokens: null,
      actualCacheCreationTokens: null, estimateApproximate: null
    });
    assert.equal(JSON.stringify(observations).includes('private'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('model observations report blocked reservation and failed provider without success-shaped usage', async () => {
  const { directory, RunUsageObserver } = await loadUsageModules();
  try {
    const observations = [];
    const blockedState = makeLedger(new Error('run_usage_execution_unlinked'));
    const blocked = new RunUsageObserver(blockedState.ledger, 'run', makeLimits(), 'revision', {
      onInvocation: observation => observations.push(observation)
    });
    let providerCalls = 0;
    await assert.rejects(blocked.invoke({
      messages: [new HumanMessage('denied')],
      purpose: 'agent',
      estimatedInputTokens: 100,
      estimateApproximate: false,
      responseMessage: message => message,
      invoke: async () => { providerCalls++; return new AIMessage('must not dispatch'); }
    }), /run_usage_execution_unlinked/u);
    const failedState = makeLedger();
    const failed = new RunUsageObserver(failedState.ledger, 'run', makeLimits(), 'revision', {
      onInvocation: observation => observations.push(observation)
    });
    await assert.rejects(failed.invoke({
      messages: [new HumanMessage('private prompt')],
      purpose: 'summary',
      responseMessage: message => message,
      invoke: async () => { throw new Error('provider-private-error-details'); }
    }), /provider-private-error-details/u);
    assert.equal(providerCalls, 0);
    assert.equal(observations[0].status, 'blocked');
    assert.equal(observations[1].status, 'failed');
    assert.equal(observations.every(observation => observation.actualInputTokens === null && observation.actualOutputTokens === null), true);
    assert.equal(blockedState.settlements.length, 0);
    assert.equal(failedState.settlements[0][3], 'unknown');
    assert.equal(JSON.stringify(observations).includes('provider-private-error-details'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('diagnostic observer failure cannot change provider success, failure or budget settlement', async () => {
  const { directory, RunUsageObserver } = await loadUsageModules();
  try {
    const state = makeLedger();
    const observer = new RunUsageObserver(state.ledger, 'run', makeLimits(), 'revision', {
      onInvocation: () => { throw new Error('diagnostic_callback_failed'); }
    });
    const response = new AIMessage({
      content: 'ok', usage_metadata: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }
    });
    assert.equal(await observer.invoke({
      messages: [new HumanMessage('hello')], purpose: 'agent', responseMessage: message => message,
      invoke: async () => response
    }), response);
    await assert.rejects(observer.invoke({
      messages: [new HumanMessage('failure')], purpose: 'summary', responseMessage: message => message,
      invoke: async () => { throw new Error('provider_failed'); }
    }), /provider_failed/u);
    assert.equal(state.settlements.length, 2);
    assert.equal(state.settlements[0][3], 'settled');
    assert.equal(state.settlements[1][3], 'unknown');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('parallel compaction cycles keep model correlation isolated without persisting cycle identities', async () => {
  const { directory, RunUsageObserver } = await loadUsageModules();
  try {
    const state = makeLedger();
    const observations = [];
    const observer = new RunUsageObserver(state.ledger, 'run', makeLimits(), 'revision', {
      onInvocation: observation => observations.push(observation)
    });
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const invoke = async (wait = null) => await observer.invoke({
      messages: [new HumanMessage('private prompt')],
      purpose: 'summary',
      responseMessage: message => message,
      invoke: async () => {
        if (wait !== null) await wait;
        return new AIMessage({
          content: 'ok', usage_metadata: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }
        });
      }
    });
    const first = observer.withContextCycle('context-first-private-id', () => invoke(firstGate));
    await observer.withContextCycle('context-second-private-id', () => invoke());
    releaseFirst();
    await first;
    await invoke();
    assert.deepEqual(observations.map(observation => observation.contextCycleId), [
      'context-second-private-id', 'context-first-private-id', undefined
    ]);
    assert.equal(JSON.stringify(state.calls).includes('context-first-private-id'), false);
    assert.equal(JSON.stringify(state.calls).includes('context-second-private-id'), false);
    assert.equal(state.settlements.length, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
