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
      VALUES ('thread','chat','Usage fixture','Usage fixture','active','2026-11-03T00:00:00.000Z','2026-11-03T00:00:00.000Z');
    INSERT INTO agent_runs(id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin)
      VALUES ('run','thread',1,'Usage fixture','running','2026-11-03T00:00:00.000Z','{}','chat');
  `);
  return {
    dispose: api.dispose,
    db,
    ledger: new api.RunUsageLedger(db)
  };
}

function makeLimits(overrides = {}) {
  return {
    policyVersion: 1,
    contextWindowTokens: 1000,
    maxOutputTokens: 250,

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

test('model calls continue after legacy cumulative token quota is exceeded', async () => {
  const { dispose, db, ledger } = await createLedger();
  try {
    const limits = makeLimits();
    ledger.reserve('run', limits, reservation('previous'));
    ledger.settle('run', 'previous', 2801, 'settled');
    assert.doesNotThrow(() => ledger.reserve('run', limits, reservation('next')));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_calls').get().count, 2);
  } finally { db.close(); dispose(); }
});

test('run usage ledger reserves before requests, ignores legacy limits and preserves unknown usage', async () => {
  const { dispose, db, ledger } = await createLedger();
  try {
    const limits = makeLimits();
    ledger.reserve('run', limits, reservation('call-1', {  }));
    ledger.reserve('run', limits, reservation('parallel', { tokens: 0, kind: 'tool', }));
    ledger.settle('run', 'parallel', 0, 'settled');

    ledger.settle('run', 'call-1', 700, 'settled');
    ledger.reserve('run', limits, reservation('call-2', { tokens: 1400,  }));
    ledger.reconcileStartup();

    const status = ledger.readUsageStatus('run');
    assert.equal(status.tokens.settled, 700);
    assert.equal(status.tokens.unknown, 1400);
    assert.equal(status.tokens.reserved, 0);
    assert.equal(status.calls.models.total, 2);
    assert.equal(status.calls.models.reserved, 0);
  } finally {
    db.close();
    dispose();
  }
});

test('unknown partial usage retains the greater of observed and reserved amounts', async () => {
  const { dispose, db, ledger } = await createLedger();
  try {
    const limits = makeLimits();
    ledger.reserve('run', limits, reservation('partial', {  }));
    ledger.settle('run', 'partial', 100, 'unknown');
    const status = ledger.readUsageStatus('run');
    assert.equal(status.tokens.unknown, 1400);
    assert.doesNotThrow(() => ledger.reserve('run', limits, reservation('next-call', {  })));
  } finally { db.close(); dispose(); }
});

test('unknown observed usage above reservation remains recorded in full', async () => {
  const { dispose, db, ledger } = await createLedger();
  try {
    const limits = makeLimits();
    ledger.reserve('run', limits, reservation('over-observed', { }));
    ledger.settle('run', 'over-observed', 1500, 'unknown');
    const status = ledger.readUsageStatus('run');
    assert.equal(status.tokens.unknown, 1500);
    assert.doesNotThrow(() => ledger.reserve('run', limits, reservation('too-many')));
  } finally { db.close(); dispose(); }
});

test('settlement receipt permits identical retries after reopen and rejects changed accounting', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roc-usage-receipt-'));
  const location = join(directory, 'agent.sqlite');
  const { dispose, db, ledger } = await createLedger(location);
  try {
    ledger.reserve('run', makeLimits(), reservation('receipt-call'));
    ledger.settle('run', 'receipt-call', 50, 'settled', 'output-hash', { output: 'ok' });
    db.close();
    const reopened = new Database(location);
    try {
      const api = await loadResearchTestApi();
      try {
        const restored = new api.RunUsageLedger(reopened);
        restored.settle('run', 'receipt-call', 50, 'settled', 'output-hash', { output: 'ok' });
        assert.throws(() => restored.settle('run', 'receipt-call', 51, 'settled', 'output-hash', { output: 'ok' }), /run_call_settlement_invalid/);
        assert.equal(reopened.prepare('SELECT actual_tokens FROM agent_calls WHERE call_id = ?').get('receipt-call').actual_tokens, 50);
        reopened.prepare("UPDATE agent_calls SET actual_tokens = 49 WHERE call_id = 'receipt-call'").run();
        assert.throws(() => restored.settle('run', 'receipt-call', 50, 'settled', 'output-hash', { output: 'ok' }), /run_call_settlement_invalid/);
        assert.throws(() => restored.settle('run', 'receipt-call', 50, 'settled', 'output-hash', { output: 'ok' }), /run_call_settlement_invalid/);
      } finally { api.dispose(); }
    } finally { reopened.close(); }
  } finally {
    if (db.open) db.close();
    dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('many model, tool and child calls continue without cumulative limits', async () => {
  const { dispose, db, ledger } = await createLedger();
  try {
    const limits = makeLimits();
    for (let i = 0; i < 15; i++) {
      ledger.reserve('run', limits, reservation(`call-${i}`, {
        kind: ['model', 'tool', 'child'][i % 3], tokens: 100_000, }));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_calls').get().count, 15);
  } finally { db.close(); dispose(); }
});
