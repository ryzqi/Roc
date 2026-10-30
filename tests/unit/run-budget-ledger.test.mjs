import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

async function createLedger() {
  const directory = mkdtempSync(join(tmpdir(), 'roc-run-budget-ledger-'));
  const outfile = join(directory, 'ledger.mjs');
  await build({ entryPoints: ['src/main/services/deep-agent/run-budget-ledger.ts'], outfile, bundle: true, format: 'esm', platform: 'node' });
  const { RunBudgetLedger } = await import(outfile);
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_runs (id TEXT PRIMARY KEY, budget_stop_reason TEXT);
    CREATE TABLE agent_budget_calls (
      run_id TEXT NOT NULL, call_id TEXT NOT NULL, kind TEXT NOT NULL, input_hash TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL, actual_tokens INTEGER, reserved_cost_microusd INTEGER,
      actual_cost_microusd INTEGER, pricing_version TEXT, state TEXT NOT NULL,
      envelope_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (run_id, call_id)
    );
    CREATE TABLE agent_pilot_runs (
      run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, decision TEXT NOT NULL, disclosure TEXT NOT NULL,
      profile TEXT, bucket INTEGER NOT NULL, extra_budget_microusd INTEGER NOT NULL,
      allowance_model_calls INTEGER NOT NULL, allowance_tool_calls INTEGER NOT NULL, allowance_tokens INTEGER NOT NULL,
      spent_model_calls INTEGER NOT NULL DEFAULT 0, spent_tool_calls INTEGER NOT NULL DEFAULT 0,
      spent_tokens INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO agent_runs (id, budget_stop_reason) VALUES ('run', NULL);
  `);
  return {
    directory,
    db,
    ledger: new RunBudgetLedger(db)
  };
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

function reservation(id, overrides = {}) {
  return {
    id,
    kind: 'model',
    tokens: 1400,
    inputHash: `hash-${id}`,
    envelope: { callId: id },
    ...overrides
  };
}

test('run budget ledger reserves before requests, enforces hard limits and preserves unknown usage', async () => {
  const { directory, db, ledger } = await createLedger();
  try {
    const limits = makeLimits({ maxConcurrentModelCalls: 1 });
    ledger.reserve('run', limits, reservation('call-1', { costMicrousd: 80, pricingVersion: 'test-prices-v1' }));
    assert.throws(() => ledger.reserve('run', limits, reservation('call-2')), /run_model_concurrency_exhausted/);

    ledger.settle('run', 'call-1', 700, 'settled', undefined, {}, 40, 'test-prices-v1');
    ledger.reserve('run', limits, reservation('call-2', { tokens: 1400, costMicrousd: 80, pricingVersion: 'test-prices-v1' }));
    ledger.reconcileStartup();

    const status = ledger.readBudgetStatus('run', limits, true);
    assert.equal(status.tokens.settled, 700);
    assert.equal(status.tokens.unknown, 1400);
    assert.equal(status.tokens.reserved, 0);
    assert.equal(status.tokens.remaining, 700);
    assert.equal(status.calls.models.total, 2);
    assert.equal(status.calls.models.reserved, 0);
    assert.equal(status.cost.state, 'unknown');
    assert.equal(status.cost.settledMicrousd, 40);
    assert.equal(status.cost.reservedMicrousd, 80);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run budget ledger rejects unverifiable dollar reservations and token overages before insertion', async () => {
  const { directory, db, ledger } = await createLedger();
  try {
    const feeCapped = makeLimits({ maxCostMicrousd: 100 });
    assert.throws(() => ledger.reserve('run', feeCapped, reservation('unknown-price')), /run_cost_estimate_unavailable/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_budget_calls').get().count, 0);

    assert.throws(() => ledger.reserve('run', makeLimits(), reservation('oversized', { tokens: 1401 })), /run_model_call_token_reservation_exhausted/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_budget_calls').get().count, 0);

    const capped = makeLimits({ maxCostMicrousd: 100 });
    assert.throws(() => ledger.reserve('run', capped, reservation('over-cost', { costMicrousd: 101 })), /run_cost_budget_exhausted/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_budget_calls').get().count, 0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run budget ledger emits a durable first stop reason', async () => {
  const { directory, db, ledger } = await createLedger();
  try {
    ledger.recordStopReason('run', 'run_total_token_budget_exhausted');
    ledger.recordStopReason('run', 'run_cost_budget_exhausted');
    assert.equal(db.prepare('SELECT budget_stop_reason FROM agent_runs WHERE id = ?').get('run').budget_stop_reason,
      'run_total_token_budget_exhausted');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
