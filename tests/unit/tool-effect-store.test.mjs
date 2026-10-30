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
const { applyDatabaseMigrations } = await importTypeScriptModule(
  'src/main/infrastructure/database-migrations.ts',
  bundleOptions
);
const { agentMigrations } = await importTypeScriptModule(
  'src/main/infrastructure/database-schemas.ts',
  bundleOptions
);

function createDatabase(migrations = agentMigrations, location = ':memory:') {
  const db = new Database(location);
  applyDatabaseMigrations(db, { dbName: 'agent', migrations });
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

function insertLegacyEffect(db, { runId, status, reconcileStrategy = 'retry_safe' }) {
  db.prepare(`INSERT INTO agent_tool_effects (
    run_id, thread_id, execution_path, checkpoint_id, tool_call_id, tool_name, input_hash,
    effect_class, reconcile_strategy, status, created_at, updated_at
  ) VALUES (?, ?, 'main', 'checkpoint-1', ?, 'write_file', 'legacy-input-hash',
    'workspace_mutation', ?, ?, '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`).run(
    runId,
    `thread-${runId}`,
    `call-${runId}`,
    reconcileStrategy,
    status
  );
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

test('SQLite restart marks dispatched operations unknown and fences the old process lease', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roc-tool-effect-restart-'));
  const databasePath = join(directory, 'agent.sqlite');
  const input = operation({ runId: 'run-restart', threadId: 'thread-restart' });
  const beforeRestart = createDatabase(agentMigrations, databasePath);
  const storeBeforeRestart = new AgentToolEffectStore(beforeRestart);
  const started = storeBeforeRestart.beginOperation(input);
  assert.equal(started.kind, 'execute');
  storeBeforeRestart.markStarted(started.lease);
  beforeRestart.close();

  const afterRestart = createDatabase(agentMigrations, databasePath);
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

test('restore from v8 fences active attempts and preserves reconciliation history', () => {
  const versionEight = agentMigrations.filter((entry) => entry.version <= 8);
  const source = createDatabase(versionEight);
  const target = createDatabase();
  insertLegacyEffect(source, { runId: 'run-in-progress', status: 'in_progress' });
  insertLegacyEffect(source, { runId: 'run-manual', status: 'failed_retryable', reconcileStrategy: 'manual_confirmation' });
  insertLegacyEffect(source, { runId: 'run-reserved', status: 'reserved' });
  insertLegacyEffect(source, { runId: 'run-succeeded', status: 'succeeded' });
  source.prepare(`INSERT INTO agent_tool_effect_reconciliations (
    run_id, execution_path, checkpoint_id, tool_call_id, input_hash, evidence, outcome, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'run-succeeded',
    'main',
    'checkpoint-1',
    'call-run-succeeded',
    'legacy-input-hash',
    'provider receipt confirmed',
    'applied',
    '2026-10-30T00:00:00.000Z'
  );

  new AgentToolEffectStore(target).restoreFrom(source);
  const restored = target.prepare('SELECT run_id, status, attempt_id, lease_generation FROM agent_tool_effects ORDER BY run_id').all();
  assert.deepEqual(restored, [
    { run_id: 'run-in-progress', status: 'unknown', attempt_id: null, lease_generation: 1 },
    { run_id: 'run-manual', status: 'unknown', attempt_id: null, lease_generation: 1 },
    { run_id: 'run-reserved', status: 'failed_retryable', attempt_id: null, lease_generation: 1 },
    { run_id: 'run-succeeded', status: 'succeeded', attempt_id: null, lease_generation: 1 }
  ]);
  assert.equal(target.prepare('SELECT count(*) FROM agent_tool_effect_reconciliations').pluck().get(), 1);
  assert.equal(target.prepare('SELECT count(*) FROM agent_tool_effect_reconciliations WHERE operation_id IS NULL').pluck().get(), 1);
  source.close();
  target.close();
});
