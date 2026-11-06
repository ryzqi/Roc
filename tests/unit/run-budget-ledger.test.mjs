import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadResearchTestApi } from './fixtures/research-test-kit.mjs';

async function createLedger(location = ':memory:') {
  const api = await loadResearchTestApi();
  const db = new Database(location);
  db.pragma('foreign_keys = ON');
  api.applyDatabaseMigrations(db, { dbName: 'agent', migrations: api.agentMigrations, allowOffline: true });
  db.exec(`
    INSERT INTO agent_threads(id,kind,title,goal,status,created_at,updated_at)
      VALUES ('thread','chat','Budget fixture','Budget fixture','active','2026-11-03T00:00:00.000Z','2026-11-03T00:00:00.000Z');
    INSERT INTO agent_runs(id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin)
      VALUES ('run','thread',1,'Budget fixture','running','2026-11-03T00:00:00.000Z','{}','chat');
  `);
  return {
    dispose: api.dispose,
    db,
    ledger: new api.RunBudgetLedger(db)
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
  const { dispose, db, ledger } = await createLedger();
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
    dispose();
  }
});

test('unknown partial usage retains the greater of observed and reserved amounts', async () => {
  const { dispose, db, ledger } = await createLedger();
  try {
    const limits = makeLimits({ maxCostMicrousd: 100 });
    ledger.reserve('run', limits, reservation('partial', { costMicrousd: 80, pricingVersion: 'test-prices-v1' }));
    ledger.settle('run', 'partial', 100, 'unknown', undefined, {}, 20, 'test-prices-v1');
    const status = ledger.readBudgetStatus('run', limits, true);
    assert.equal(status.tokens.unknown, 1400);
    assert.equal(status.tokens.remaining, 1400);
    assert.equal(status.cost.state, 'unknown');
    assert.equal(status.cost.reservedMicrousd, 80);
    assert.throws(() => ledger.reserve('run', limits, reservation('over-cost', { costMicrousd: 21, pricingVersion: 'test-prices-v1' })), /run_cost_budget_exhausted/);
  } finally { db.close(); dispose(); }
});

test('unknown observed usage above reservation remains charged in full', async () => {
  const { dispose, db, ledger } = await createLedger();
  try {
    const limits = makeLimits();
    ledger.reserve('run', limits, reservation('over-observed', { costMicrousd: 80 }));
    ledger.settle('run', 'over-observed', 1500, 'unknown', undefined, {}, 90);
    const status = ledger.readBudgetStatus('run', limits, true);
    assert.equal(status.tokens.unknown, 1500);
    assert.equal(status.tokens.remaining, 1300);
    assert.equal(status.cost.reservedMicrousd, 90);
    assert.throws(() => ledger.reserve('run', limits, reservation('too-many')), /run_total_token_budget_exhausted/);
  } finally { db.close(); dispose(); }
});

test('unknown partial cost without a price reservation blocks capped spending', async () => {
  const { dispose, db, ledger } = await createLedger();
  try {
    const uncapped = makeLimits();
    ledger.reserve('run', uncapped, reservation('unpriced'));
    ledger.settle('run', 'unpriced', 100, 'unknown', undefined, {}, 10);
    const capped = makeLimits({ maxCostMicrousd: 100 });
    assert.throws(() => ledger.reserve('run', capped, reservation('next', { costMicrousd: 1 })), /run_cost_estimate_unavailable/);
  } finally { db.close(); dispose(); }
});

test('settled token usage without actual cost stays visibly unknown', async () => {
  const { dispose, db, ledger } = await createLedger();
  try {
    const limits = makeLimits();
    ledger.reserve('run', limits, reservation('unpriced-result', { costMicrousd: 80 }));
    ledger.settle('run', 'unpriced-result', 100, 'settled');
    const status = ledger.readBudgetStatus('run', limits, true);
    assert.equal(status.cost.state, 'unknown');
    assert.equal(status.cost.settledMicrousd, 0);
    assert.equal(status.cost.reservedMicrousd, 80);
  } finally { db.close(); dispose(); }
});

test('settlement receipt permits identical retries after reopen and rejects changed accounting', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roc-budget-receipt-'));
  const location = join(directory, 'agent.sqlite');
  const { dispose, db, ledger } = await createLedger(location);
  try {
    ledger.reserve('run', makeLimits(), reservation('receipt-call'));
    ledger.settle('run', 'receipt-call', 50, 'settled', 'output-hash', { output: 'ok' }, 12, 'v1');
    db.close();
    const reopened = new Database(location);
    try {
      const api = await loadResearchTestApi();
      try {
        const restored = new api.RunBudgetLedger(reopened);
        restored.settle('run', 'receipt-call', 50, 'settled', 'output-hash', { output: 'ok' }, 12, 'v1');
        assert.throws(() => restored.settle('run', 'receipt-call', 51, 'settled', 'output-hash', { output: 'ok' }, 12, 'v1'), /run_budget_settlement_invalid/);
        assert.equal(reopened.prepare('SELECT actual_tokens FROM agent_budget_calls WHERE call_id = ?').get('receipt-call').actual_tokens, 50);
        reopened.prepare("UPDATE agent_budget_calls SET pricing_version = 'tampered' WHERE call_id = 'receipt-call'").run();
        assert.throws(() => restored.settle('run', 'receipt-call', 50, 'settled', 'output-hash', { output: 'ok' }, 12, 'v1'), /run_budget_settlement_invalid/);
        reopened.prepare("UPDATE agent_budget_calls SET pricing_version = 'v1', actual_tokens = 49 WHERE call_id = 'receipt-call'").run();
        assert.throws(() => restored.settle('run', 'receipt-call', 50, 'settled', 'output-hash', { output: 'ok' }, 12, 'v1'), /run_budget_settlement_invalid/);
      } finally { api.dispose(); }
    } finally { reopened.close(); }
  } finally {
    if (db.open) db.close();
    dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run budget ledger rejects unverifiable dollar reservations and token overages before insertion', async () => {
  const { dispose, db, ledger } = await createLedger();
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
    dispose();
  }
});

test('run budget ledger emits a durable first stop reason', async () => {
  const { dispose, db, ledger } = await createLedger();
  try {
    ledger.recordStopReason('run', 'run_total_token_budget_exhausted');
    ledger.recordStopReason('run', 'run_cost_budget_exhausted');
    assert.equal(db.prepare('SELECT budget_stop_reason FROM agent_runs WHERE id = ?').get('run').budget_stop_reason,
      'run_total_token_budget_exhausted');
  } finally {
    db.close();
    dispose();
  }
});
