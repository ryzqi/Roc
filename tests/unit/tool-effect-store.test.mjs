import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const bundleOptions = {
  platform: 'node',
  external: ['better-sqlite3'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
};
const { AgentToolEffectStore, createToolEffectIdentity, hashToolInput } = await importTypeScriptModule(
  'src/main/services/deep-agent/tool-effect-store.ts',
  bundleOptions
);
const { applyAgentDatabaseSchema } = await importTypeScriptModule(
  'src/main/infrastructure/database-schemas.ts',
  bundleOptions
);

function createDatabase(location = ':memory:') {
  const db = new Database(location);
  applyAgentDatabaseSchema(db);
  return db;
}

function operation(overrides = {}) {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    executionPath: 'main',
    checkpointId: 'checkpoint-1',
    toolCallId: 'tool-call-1',
    toolName: 'write_file',
    canonicalToolIdentity: 'workspace.write_file',
    toolVersion: 'roc-workspace-write-v1',
    args: { path: '/notes.md', content: 'hello' },
    effectClass: 'workspace_mutation',
    reconcileStrategy: 'retry_safe',
    ...overrides
  };
}

test('operation identity is stable under object key order and changes with arguments', () => {
  const first = createToolEffectIdentity(operation({ args: { path: '/notes.md', content: 'hello' } }));
  const reordered = createToolEffectIdentity(operation({ args: { content: 'hello', path: '/notes.md' } }));
  const changed = createToolEffectIdentity(operation({ args: { path: '/notes.md', content: 'changed' } }));
  const undefinedProperty = createToolEffectIdentity(operation({ args: { path: '/notes.md', content: 'hello', optional: undefined } }));

  assert.equal(first.operationId, reordered.operationId);
  assert.equal(first.operationId, undefinedProperty.operationId);
  assert.equal(first.idempotencyKey, reordered.idempotencyKey);
  assert.notEqual(first.operationId, changed.operationId);
  assert.notEqual(first.operationId, createToolEffectIdentity(operation({ runId: 'run-2' })).operationId);
  assert.notEqual(first.operationId, createToolEffectIdentity(operation({ threadId: 'thread-2' })).operationId);
  assert.notEqual(first.operationId, createToolEffectIdentity(operation({ executionPath: 'subagent:writer' })).operationId);
  assert.notEqual(first.operationId, createToolEffectIdentity(operation({ checkpointId: 'checkpoint-2' })).operationId);
  assert.notEqual(first.operationId, createToolEffectIdentity(operation({ toolCallId: 'tool-call-2' })).operationId);
  assert.notEqual(first.operationId, createToolEffectIdentity(operation({ canonicalToolIdentity: 'workspace.edit_file' })).operationId);
  assert.notEqual(first.operationId, createToolEffectIdentity(operation({ toolVersion: 'roc-workspace-write-v2' })).operationId);
  assert.equal(hashToolInput({ values: [undefined] }), hashToolInput({ values: [null] }));
  assert.throws(
    () => createToolEffectIdentity(operation({ args: { invalid: () => undefined } })),
    /agent_tool_effect_value_not_serializable/u
  );
});

test('retry attempt leases fence stale workers and completed operations replay', () => {
  const db = createDatabase();
  const store = new AgentToolEffectStore(db);
  const input = operation();
  const first = store.beginOperation(input);
  assert.equal(first.kind, 'execute');
  store.markStarted(first.lease);
  store.finishError(first.lease, new Error('temporary failure'), true);

  const second = store.beginOperation(input);
  assert.equal(second.kind, 'execute');
  assert.equal(second.lease.leaseGeneration, first.lease.leaseGeneration + 1);
  store.markStarted(second.lease);
  assert.throws(() => store.finishSuccess(first.lease, { value: 'stale' }), /agent_tool_effect_lease_lost/u);
  store.finishSuccess(second.lease, { value: 'committed' });
  assert.deepEqual(store.replayRecordedOperation(input).result, {value:'committed'});

  const replay = store.beginOperation(input);
  assert.deepEqual(replay, {
    kind: 'replay',
    result: { value: 'committed' },
    operationId: second.lease.operationId
  });
  assert.throws(
    () => store.beginOperation(operation({ args: { path: '/notes.md', content: 'drifted' } })),
    /agent_tool_effect_input_drift/u
  );
  db.close();
});

test('unresolved operations block run and thread deletion until reconciled', () => {
  const db = createDatabase();
  const store = new AgentToolEffectStore(db);
  const input = operation({ reconcileStrategy: 'manual_confirmation' });
  const started = store.beginOperation(input);
  assert.equal(started.kind, 'execute');
  store.markStarted(started.lease);
  store.finishUnknown(started.lease, new Error('remote result unknown'));

  assert.throws(() => store.deleteForRunIds([input.runId]), /agent_tool_effect_pending_reconciliation/u);
  assert.throws(() => store.deleteForThread(input.threadId), /agent_tool_effect_pending_reconciliation/u);
  const before = store.readState(input);
  assert.equal(before.status, 'unknown');
  assert.ok(before.operationId !== null);

  store.reconcile({
    operation: input,
    expectedLeaseGeneration: before.leaseGeneration,
    receipt: {
      schemaVersion: 1,
      kind: 'resolution',
      source: 'operator',
      outcome: 'not_applied',
      operationId: before.operationId,
      reference: 'case-123',
      evidenceHash: hashToolInput({ evidence: 'provider confirms no operation' }),
      recordedAt: '2026-10-30T00:00:00.000Z'
    }
  });
  assert.equal(store.readState(input).status, 'failed_retryable');
  assert.equal(store.deleteForThread(input.threadId), 1);
  db.close();
});

test('reconciled replay rejects corrupted receipt and output after reopening SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roc-tool-effect-replay-'));
  const databasePath = join(directory, 'agent.sqlite');
  const input = operation({ runId: 'run-replay' });
  let db = createDatabase(databasePath);
  let store = new AgentToolEffectStore(db);
  const started = store.beginOperation(input);
  store.markStarted(started.lease);
  store.finishUnknown(started.lease, new Error('unknown'));
  const state = store.readState(input);
  store.reconcile({ operation: input, expectedLeaseGeneration: state.leaseGeneration, receipt: {
    schemaVersion: 1, kind: 'resolution', source: 'operator', outcome: 'applied',
    operationId: state.operationId, reference: 'case-verified',
    evidenceHash: hashToolInput({ value: 'verified' }), recordedAt: '2026-10-30T00:00:00.000Z'
  }, result: { value: 'verified' } });
  db.close();
  db = createDatabase(databasePath);
  store = new AgentToolEffectStore(db);
  const changes = db.prepare('SELECT total_changes() AS changes').get().changes;
  assert.deepEqual(store.replayRecordedOperation(input), {
    kind: 'recorded', result: { value: 'verified' }, operationId: state.operationId,
    receiptHash: db.prepare('SELECT receipt_hash FROM agent_tool_effect_results WHERE operation_id=?').pluck().get(state.operationId)
  });
  assert.equal(db.prepare('SELECT total_changes() AS changes').get().changes, changes);
  assert.throws(() => store.replayRecordedOperation(operation({ runId: 'run-replay', args: { changed: true } })), /agent_tool_effect_input_drift/u);
  assert.deepEqual(store.replayRecordedOperation(operation({ runId: 'missing' })), { kind: 'unavailable', reason: 'not_found' });
  assert.deepEqual(store.beginOperation(input).result, { value: 'verified' });
  db.prepare('UPDATE agent_tool_effects SET result_json = ? WHERE run_id = ?').run('{"value":"changed"}', input.runId);
  assert.throws(() => store.replayRecordedOperation(input), /agent_tool_effect_result_corrupt/u);
  assert.throws(() => store.beginOperation(input), /agent_tool_effect_result_corrupt/u);
  db.prepare('UPDATE agent_tool_effects SET result_hash = ? WHERE run_id = ?')
    .run(hashToolInput({ value: 'changed' }), input.runId);
  assert.throws(() => store.replayRecordedOperation(input), /agent_tool_effect_result_corrupt/u);
  assert.throws(() => store.beginOperation(input), /agent_tool_effect_result_corrupt/u);
  db.prepare('UPDATE agent_tool_effects SET result_json = ?, result_hash = ?, receipt_hash = ? WHERE run_id = ?')
    .run('{"value":"verified"}', hashToolInput({ value: 'verified' }), '0'.repeat(64), input.runId);
  assert.throws(() => store.replayRecordedOperation(input), /agent_tool_effect_receipt_corrupt/u);
  assert.throws(() => store.beginOperation(input), /agent_tool_effect_receipt_corrupt/u);
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test('SQLite restart marks dispatched operations unknown and fences the old process lease', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roc-tool-effect-restart-'));
  const databasePath = join(directory, 'agent.sqlite');
  const input = operation({ runId: 'run-restart', threadId: 'thread-restart' });
  const beforeRestart = createDatabase(databasePath);
  const storeBeforeRestart = new AgentToolEffectStore(beforeRestart);
  const started = storeBeforeRestart.beginOperation(input);
  assert.equal(started.kind, 'execute');
  storeBeforeRestart.markStarted(started.lease);
  beforeRestart.close();

  const afterRestart = createDatabase(databasePath);
  const storeAfterRestart = new AgentToolEffectStore(afterRestart);
  storeAfterRestart.markRestartedUnknown(input.runId);

  const state = storeAfterRestart.readState(input);
  assert.equal(state.status, 'unknown');
  assert.equal(state.attemptId, null);
  assert.equal(state.leaseGeneration, started.lease.leaseGeneration + 1);
  assert.throws(
    () => storeAfterRestart.finishSuccess(started.lease, { value: 'late worker' }),
    /agent_tool_effect_lease_lost/u
  );
  afterRestart.close();
  rmSync(directory, { recursive: true, force: true });
});

test('restore rejects incompatible effect schemas without changing the target', () => {
  const source = new Database(':memory:');
  const target = createDatabase();
  source.exec('CREATE TABLE agent_tool_effects (run_id TEXT)');
  assert.throws(() => new AgentToolEffectStore(target).restoreFrom(source), /agent_tool_effect_restore_schema_invalid/);
  assert.equal(target.prepare('SELECT count(*) FROM agent_tool_effects').pluck().get(),0);
  source.close(); target.close();
});

test('pre-effect suspension survives SQLite reopen and restore while unmarked manual retries remain unknown', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roc-effect-suspension-'));
  const databasePath = join(directory, 'agent.sqlite');
  let source = createDatabase(databasePath);
  let store = new AgentToolEffectStore(source);
  const suspended = operation({runId:'suspended', reconcileStrategy:'manual_confirmation'});
  const legacy = operation({runId:'legacy', reconcileStrategy:'manual_confirmation'});
  const lease = store.beginOperation(suspended).lease;
  store.markStarted(lease); store.finishSuspended(lease, new Error('GraphInterrupt'));
  const legacyLease = store.beginOperation(legacy).lease;
  store.markStarted(legacyLease); store.finishError(legacyLease, new Error('old retry'), true);
  // Old persisted retries have no proof that execution stopped before effects.
  source.prepare("UPDATE agent_tool_effects SET status='failed_retryable' WHERE run_id=?").run(legacy.runId);
  source.close(); source = createDatabase(databasePath);
  store = new AgentToolEffectStore(source);
  const target = createDatabase(); const restored = new AgentToolEffectStore(target);
  try {
    restored.restoreFrom(source);
    assert.equal(restored.readState(suspended).status,'failed_retryable');
    assert.equal(restored.readState(legacy).status,'unknown');
    store.markRestartedUnknown(suspended.runId); store.markRestartedUnknown(legacy.runId);
    assert.equal(store.readState(suspended).status,'failed_retryable');
    assert.equal(store.hasUnknown(suspended.runId),false);
    assert.equal(store.readState(suspended).leaseGeneration,lease.leaseGeneration+1);
    assert.equal(store.readState(legacy).status,'unknown');
    for (const current of [store,restored]) {
      assert.throws(()=>current.finishSuccess(lease,{late:true}),/agent_tool_effect_lease_lost/);
      const resumed=current.beginOperation(suspended);
      assert.equal(resumed.kind,'execute'); current.markStarted(resumed.lease);
      current.finishSuccess(resumed.lease,{approved:true});
      assert.deepEqual(current.beginOperation(suspended).result,{approved:true});
    }
  } finally {
    source.close(); target.close(); rmSync(directory,{recursive:true,force:true});
  }
});

test('current restore preserves successful receipts and fences unfinished attempts', async () => {
  const directory = mkdtempSync(join(tmpdir(),'roc-effect-restore-'));
  const sourcePath = join(directory,'source.db');
  let source = createDatabase(sourcePath);
  const store = new AgentToolEffectStore(source);
  const done = operation();
  const active = operation({runId:'active'});
  const reserved = operation({runId:'reserved'});
  const doneLease = store.beginOperation(done).lease;
  store.markStarted(doneLease); store.finishSuccess(doneLease,{value:'persisted'});
  const activeLease = store.beginOperation(active).lease; store.markStarted(activeLease);
  const reservedLease = store.beginOperation(reserved).lease;
  source.close(); source = new Database(sourcePath);
  const target = createDatabase(); const restored = new AgentToolEffectStore(target);
  restored.restoreFrom(source);
  assert.equal(restored.readState(active).status,'unknown');
  assert.equal(restored.readState(active).leaseGeneration,activeLease.leaseGeneration+1);
  assert.equal(restored.readState(reserved).status,'failed_retryable');
  assert.equal(restored.readState(reserved).leaseGeneration,reservedLease.leaseGeneration+1);
  const changes = target.prepare('SELECT total_changes()').pluck().get();
  assert.deepEqual(restored.replayRecordedOperation(done).result,{value:'persisted'});
  assert.equal(target.prepare('SELECT total_changes()').pluck().get(),changes);
  restored.deleteForRunIds([done.runId]);
  assert.equal(target.prepare('SELECT count(*) FROM agent_tool_effect_results').pluck().get(),0);
  source.close(); target.close(); rmSync(directory,{recursive:true,force:true});
});
