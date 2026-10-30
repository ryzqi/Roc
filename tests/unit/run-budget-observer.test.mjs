import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';

async function loadBudgetModules() {
  const directory = mkdtempSync(join(tmpdir(), 'roc-run-budget-observer-'));
  const observerPath = join(directory, 'observer.mjs');
  const middlewarePath = join(directory, 'middleware.mjs');
  await Promise.all([
    build({ entryPoints: ['src/main/services/deep-agent/run-budget-observer.ts'], outfile: observerPath, bundle: true, format: 'esm', platform: 'node' }),
    build({ entryPoints: ['src/main/services/deep-agent/run-budget-middleware.ts'], outfile: middlewarePath, bundle: true, format: 'esm', platform: 'node' })
  ]);
  const [{ RunBudgetObserver }, { createRunBudgetMiddleware }] = await Promise.all([
    import(observerPath),
    import(middlewarePath)
  ]);
  return { directory, RunBudgetObserver, createRunBudgetMiddleware };
}

function makeLimits(overrides = {}) {
  return {
    policyVersion: 1,
    contextWindowTokens: 1000,
    maxOutputTokens: 250,
    maxCallTokens: 1400,
    maxTotalTokens: 2800,
    maxCostMicrousd: null,
    pricingCatalogVersion: 'test-prices-v1',
    maxModelCalls: 10,
    maxToolCalls: 10,
    maxChildTasks: 3,
    maxConcurrentChildTasks: 2,
    maxConcurrentModelCalls: 2,
    maxConcurrentToolCalls: 2,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  };
}

function makeLedger(reserveError = null) {
  const calls = [];
  const settlements = [];
  const stopReasons = [];
  const ledger = {
    reserve: (...args) => {
      calls.push(args);
      if (reserveError !== null) throw reserveError;
    },
    settle: (...args) => settlements.push(args),
    recordStopReason: (...args) => stopReasons.push(args),
    consumeCorrections: () => undefined,
    readBudgetStatus: (_runId, limits, modelPricingKnown) => ({
      tokens: { limit: limits.maxTotalTokens, settled: 0, unknown: 0, reserved: 0, remaining: limits.maxTotalTokens },
      calls: {
        models: { limit: limits.maxModelCalls, total: calls.length, reserved: calls.length },
        tools: { limit: limits.maxToolCalls, total: 0, reserved: 0 },
        children: { limit: limits.maxChildTasks, total: 0, reserved: 0 }
      },
      cost: { state: modelPricingKnown ? 'known' : 'unknown', limitMicrousd: limits.maxCostMicrousd, settledMicrousd: 0, reservedMicrousd: 0 },
      pricingCatalogVersion: limits.pricingCatalogVersion,
      deadlineAt: limits.deadlineAt,
      stopReason: null
    })
  };
  return { ledger, calls, settlements, stopReasons };
}

test('run budget reserves before the provider handler and settles exact usage', async () => {
  const { directory, RunBudgetObserver } = await loadBudgetModules();
  try {
    const state = makeLedger();
    const statuses = [];
    const observer = new RunBudgetObserver(state.ledger, 'run', makeLimits(), 'revision', {
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
    assert.equal(state.calls[0][2].tokens, 1400);
    assert.equal(state.calls[0][2].costMicrousd, null);
    assert.equal(state.settlements.length, 1);
    assert.equal(state.settlements[0][2], 20);
    assert.equal(state.settlements[0][3], 'settled');
    assert.equal(state.settlements[0][6], null);
    assert.ok(statuses.length >= 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run budget middleware blocks the provider when reservation fails', async () => {
  const { directory, RunBudgetObserver, createRunBudgetMiddleware } = await loadBudgetModules();
  try {
    const state = makeLedger(new Error('run_total_token_budget_exhausted'));
    const limits = makeLimits();
    const observer = new RunBudgetObserver(state.ledger, 'run', limits, 'revision');
    const middleware = createRunBudgetMiddleware(state.ledger, 'run', limits, observer);
    let providerCalls = 0;
    await assert.rejects(middleware.wrapModelCall({
      messages: [new HumanMessage('too much')],
      systemMessage: new SystemMessage('system'),
      runtime: { signal: undefined }
    }, async () => {
      providerCalls++;
      return new AIMessage('must not reach provider');
    }), /run_total_token_budget_exhausted/);
    assert.equal(providerCalls, 0);
    assert.equal(state.stopReasons[0][1], 'run_total_token_budget_exhausted');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run budget preserves unknown usage after missing metadata or provider interruption', async () => {
  const { directory, RunBudgetObserver } = await loadBudgetModules();
  try {
    const state = makeLedger();
    const observer = new RunBudgetObserver(state.ledger, 'run', makeLimits(), 'revision');
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
