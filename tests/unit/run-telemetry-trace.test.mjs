import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const bundleOptions = {
  platform: 'node',
  external: ['better-sqlite3', 'yazl'],
  tempDir: join(process.cwd(), '.runtime/tmp')
};
const {
  AgentRunTelemetryAccumulator,
  AgentRunTelemetryRepository,
  assertAgentRunTelemetryIdentity
} = await importTypeScriptModule('src/main/plugins/agent/run-telemetry.ts', bundleOptions);
const {
  createEmptyContextContractAudit,
  runDiagnosticsRequestSchema,
  runDiagnosticsSchema,
  runTraceSpanSchema
} = await importTypeScriptModule('src/shared/schemas/run-diagnostics.ts', { platform: 'node' });
const { applyDatabaseMigrations } = await importTypeScriptModule(
  'src/main/infrastructure/database-migrations.ts', bundleOptions
);
const { agentMigrations } = await importTypeScriptModule(
  'src/main/infrastructure/database-schemas.ts', bundleOptions
);
const { AgentTaskHistoryContract } = await importTypeScriptModule(
  'src/main/plugins/agent/agent-task-history-contract.ts', bundleOptions
);

const run = { id: 'run-1', threadId: 'thread-1' };
const snapshot = {
  runOrigin: 'chat',
  dispatchKey: null,
  capabilityManifest: { manifestHash: 'manifest-hash' },
  model: { providerId: 'provider-1', modelId: 'model-1' }
};
const privateMarker = 'SECRET_PROMPT_TOOL_ARGUMENT_CORRECTION';

function accumulator(existing = null) {
  return new AgentRunTelemetryAccumulator({ existing, run, snapshot });
}

function toolEvent(phase, callId = 'call-secret', extra = {}) {
  return {
    type: 'assistant_block',
    runId: run.id,
    block: {
      kind: 'tool_call',
      callId,
      blockId: `tool-${callId}`,
      name: privateMarker,
      phase,
      input: { token: privateMarker },
      output: { content: privateMarker },
      error: { message: privateMarker },
      ...extra
    }
  };
}

function contextEvent(event, cycleId, extra = {}) {
  return {
    type: 'context_maintenance',
    runId: run.id,
    threadId: run.threadId,
    event,
    cycleId,
    stage: 'summary',
    mode: 'run',
    ...extra
  };
}

function terminal(status, durationMs = 100) {
  return { status, durationMs, errorCode: null, retryable: null, cancelSource: status === 'cancelled' ? 'user_cancelled' : null };
}

function modelObservation(extra = {}) {
  return {
    purpose: 'agent',
    status: 'completed',
    durationMs: 8,
    estimatedInputTokens: 30,
    actualInputTokens: 25,
    actualOutputTokens: 5,
    estimateApproximate: true,
    ...extra
  };
}

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations });
  db.prepare(`INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
    VALUES (?, 'chat', 'Fixture', 'Fixture', 'active', ?, ?)`).run(run.threadId, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  db.prepare(`INSERT INTO agent_runs (id, thread_id, run_number, user_input, status, started_at, enabled_capabilities_json)
    VALUES (?, ?, 1, 'Fixture', 'running', ?, '{}')`).run(run.id, run.threadId, '2026-10-01T00:00:00.000Z');
  return db;
}

test('trace replaces private tool identifiers and payloads with bounded span aliases', () => {
  const telemetry = accumulator();
  telemetry.observeEvent(toolEvent('start'), 10);
  telemetry.observeToolAdmission({
    toolCallId: 'call-secret',
    status: 'released',
    waitMs: 3,
    holdMs: 5,
    endOffsetMs: 20,
    resourceKinds: ['workspace'],
    conflictKinds: ['workspace'],
    arguments: privateMarker
  });
  telemetry.observeEvent(toolEvent('error'), 30);
  telemetry.observeModelInvocation(modelObservation({ rawPrompt: privateMarker }), 40);
  telemetry.observeEvent({
    type: 'assistant_block',
    runId: run.id,
    block: { kind: 'text', blockId: 'text-secret', phase: 'delta', text: privateMarker }
  }, 45);
  telemetry.markTerminal(terminal('failed', 50));
  const value = telemetry.snapshot();
  const spans = value.trace.spans;
  const tool = spans.find(span => span.operation === 'tool_effect');
  const admission = spans.find(span => span.operation === 'tool_admission');
  const model = spans.find(span => span.operation === 'agent_model');
  assert.equal(tool.status, 'failed');
  assert.equal(tool.durationMs, 20);
  assert.equal(admission.parentSpanId, tool.spanId);
  assert.equal(admission.startOffsetMs, 12);
  assert.equal(admission.durationMs, 8);
  assert.equal(model.startOffsetMs, 32);
  assert.equal(model.actualInputTokens, 25);
  assert.equal(value.tool.callCount, 1);
  assert.equal(value.tool.errorCount, 1);
  assert.equal(value.runtime.firstOutputMs, 45);
  assert.equal(JSON.stringify(value).includes(privateMarker), false);
  assert.equal(JSON.stringify(value).includes('call-secret'), false);
  assert.equal(JSON.stringify(value).includes('text-secret'), false);
  for (const span of spans) assert.equal(runTraceSpanSchema.safeParse(span).success, true);
});

test('concurrent context cycles preserve independent stage durations and count-only audits', () => {
  const telemetry = accumulator();
  const first = '10000000-0000-4000-8000-000000000001';
  const second = '10000000-0000-4000-8000-000000000002';
  const audit = { ...createEmptyContextContractAudit(), constraintCount: 3, missingConstraintCount: 1, workspaceVersionPresent: true };
  telemetry.observeEvent(contextEvent('context_compaction_started', first), 10);
  telemetry.observeEvent(contextEvent('context_compaction_started', second), 20);
  telemetry.observeEvent(contextEvent('context_summary_started', first), 30);
  telemetry.observeEvent(contextEvent('context_summary_started', second), 35);
  telemetry.observeModelInvocation(modelObservation({ purpose: 'summary', contextCycleId: second }), 40);
  telemetry.observeModelInvocation(modelObservation({ purpose: 'summary', contextCycleId: first }), 45);
  telemetry.observeEvent(contextEvent('context_summary_completed', second, {
    inputTokens: 70, capacityTokens: 100, estimated: true, contractAudit: audit
  }), 50);
  telemetry.observeEvent(contextEvent('context_compaction_failed', first), 70);
  const value = telemetry.snapshot();
  const compactions = value.trace.spans.filter(span => span.operation === 'context_compaction');
  const summaries = value.trace.spans.filter(span => span.operation === 'context_summary');
  assert.deepEqual(compactions.map(span => [span.startOffsetMs, span.durationMs, span.status]), [
    [10, 60, 'failed'], [20, 30, 'completed']
  ]);
  assert.deepEqual(summaries.map(span => [span.startOffsetMs, span.durationMs, span.status]), [
    [30, 40, 'failed'], [35, 15, 'completed']
  ]);
  assert.equal(summaries[0].parentSpanId, compactions[0].spanId);
  assert.equal(summaries[1].parentSpanId, compactions[1].spanId);
  const models = value.trace.spans.filter(span => span.operation === 'summary_model');
  assert.equal(models[0].parentSpanId, compactions[1].spanId);
  assert.equal(models[1].parentSpanId, compactions[0].spanId);
  assert.deepEqual(value.context.contractAudit, audit);
  assert.equal(value.context.lastInputEstimated, true);
  assert.equal(value.context.failureCount, 1);
  assert.equal(JSON.stringify(value).includes(first), false);
  assert.equal(JSON.stringify(value).includes(second), false);
});

test('subagent tree, leaf tool and approval spans correlate without names or task text', () => {
  const telemetry = accumulator();
  const identity = {
    subagentId: 'private-subagent',
    parentSubagentId: null,
    depth: 1,
    name: privateMarker,
    path: [privateMarker],
    taskInput: privateMarker,
    execution: 'sync'
  };
  const childEvent = (event, elapsed, childIdentity = identity) => telemetry.observeEvent({
    type: 'subagent_event', runId: run.id, sequence: 0, identity: childIdentity, event
  }, elapsed);
  childEvent({ kind: 'started' }, 10);
  const nestedIdentity = { ...identity, subagentId: 'nested-private-subagent', parentSubagentId: identity.subagentId, depth: 2 };
  childEvent({ kind: 'started' }, 15, nestedIdentity);
  childEvent({ kind: 'tool_call', block: toolEvent('start', 'child-call').block }, 20, nestedIdentity);
  childEvent({ kind: 'tool_call', block: toolEvent('end', 'child-call').block }, 25, nestedIdentity);
  childEvent({ kind: 'completed', summary: privateMarker }, 30, nestedIdentity);
  childEvent({ kind: 'failed', error: { message: privateMarker } }, 40);
  telemetry.observeEvent({
    type: 'run_interrupted', runId: run.id, threadId: run.threadId, interruptId: 'private-interrupt',
    payload: { kind: 'approval', actionRequests: [{ name: privateMarker, args: { secret: privateMarker } }] }
  }, 45);
  telemetry.observeEvent({ type: 'run_resumed', runId: run.id, threadId: run.threadId, interruptId: 'private-interrupt' }, 60);
  const value = telemetry.snapshot();
  const children = value.trace.spans.filter(span => span.operation === 'subagent');
  const tool = value.trace.spans.find(span => span.operation === 'tool_effect');
  const approval = value.trace.spans.find(span => span.operation === 'approval_wait');
  assert.equal(children[1].parentSpanId, children[0].spanId);
  assert.equal(tool.parentSpanId, children[1].spanId);
  assert.deepEqual([approval.durationMs, approval.status], [15, 'completed']);
  assert.deepEqual(value.subagent, { count: 2, failedCount: 1, maxDepth: 2 });
  assert.equal(JSON.stringify(value).includes(privateMarker), false);
  assert.equal(JSON.stringify(value).includes('private-subagent'), false);
  assert.equal(JSON.stringify(value).includes('private-interrupt'), false);
});

test('recovery, restart and checkpoint resume retain valid span aliases and terminal states', () => {
  const telemetry = accumulator();
  telemetry.observeEvent({ type: 'run_recovering', runId: run.id, attempt: 1, message: privateMarker, code: 'network_error' }, 10);
  telemetry.observeModelInvocation(modelObservation({ status: 'failed', actualInputTokens: null, actualOutputTokens: null }), 30);
  telemetry.observeEvent({ type: 'run_recovered', runId: run.id, attempt: 1 }, 40);
  telemetry.observeEvent(toolEvent('start'), 45);
  telemetry.markTerminal(terminal('interrupted', 50));
  const interrupted = telemetry.snapshot();
  assert.equal(interrupted.trace.spans.find(span => span.operation === 'recovery').durationMs, 30);
  assert.equal(interrupted.trace.spans.find(span => span.operation === 'agent_model').parentSpanId,
    interrupted.trace.spans.find(span => span.operation === 'recovery').spanId);
  assert.equal(interrupted.trace.spans.find(span => span.operation === 'tool_effect').status, 'interrupted');
  const resumed = accumulator(interrupted);
  resumed.resumeAfterInterruption();
  resumed.observeModelInvocation(modelObservation(), 70);
  resumed.markTerminal(terminal('completed', 90));
  const final = resumed.snapshot();
  const checkpoint = final.trace.spans.find(span => span.operation === 'checkpoint_resume');
  assert.match(checkpoint.checkpointId, /^checkpoint-\d{1,6}$/u);
  assert.equal(final.trace.spans.at(-1).checkpointId, checkpoint.checkpointId);
  assert.equal(final.runtime.recoveryCount, 1);
  assert.equal(final.trace.spans[0].status, 'completed');
  assert.equal(final.trace.spans[0].durationMs, 90);
  assert.equal(new Set(final.trace.spans.map(span => span.spanId)).size, final.trace.spans.length);
  assert.equal(final.trace.spans.some(span => span.status === 'running'), false);
});

test('bounded trace drops new spans but retains aggregate counts and unknown model usage', () => {
  const telemetry = accumulator();
  for (let index = 0; index < 400; index++) {
    telemetry.observeModelInvocation(modelObservation({ actualInputTokens: null, actualOutputTokens: null }), index + 10);
  }
  telemetry.observeModelUsage({
    callCount: 400, inputTokens: null, outputTokens: null, totalTokens: null,
    cacheReadTokens: null, cacheCreationTokens: null
  });
  telemetry.markTerminal(terminal('cancelled', 500));
  const value = telemetry.snapshot();
  assert.equal(value.trace.spans.length, 256);
  assert.equal(value.trace.droppedSpanCount, 145);
  assert.equal(value.model.callCount, 400);
  assert.equal(value.model.unknownUsageCallCount, 400);
  assert.equal(value.model.inputTokens, null);
  assert.equal(value.model.totalTokens, null);
  assert.equal(value.trace.spans[0].status, 'cancelled');
  assert.equal(value.trace.spans.at(-1).actualInputTokens, null);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 130_000);
  telemetry.observeModelInvocation(modelObservation(), 510);
  assert.deepEqual(telemetry.snapshot(), value);
});

test('diagnostics schemas reject arbitrary payload fields and unsafe identifier shapes', () => {
  const span = accumulator().snapshot().trace.spans[0];
  assert.equal(runTraceSpanSchema.safeParse({ ...span, arguments: privateMarker }).success, false);
  assert.equal(runTraceSpanSchema.safeParse({ ...span, operation: privateMarker }).success, false);
  assert.equal(runTraceSpanSchema.safeParse({ ...span, spanId: `span-${privateMarker}` }).success, false);
  assert.equal(runTraceSpanSchema.safeParse({ ...span, checkpointId: '/private/workspace' }).success, false);
  assert.equal(runDiagnosticsRequestSchema.safeParse({ ...run, prompt: privateMarker }).success, false);
  assert.equal(runDiagnosticsRequestSchema.safeParse({ runId: 'run-1', threadId: 'thread-1', prompt: privateMarker }).success, false);
  assert.equal(runDiagnosticsRequestSchema.safeParse({ runId: 'run-1', threadId: 'thread-1' }).success, true);
  const value = accumulator().snapshot();
  const diagnostics = {
    runId: run.id, threadId: run.threadId, providerId: 'provider-1', modelId: 'model-1',
    totalDurationMs: 0, model: value.model,
    tool: value.tool, subagent: value.subagent, context: value.context, toolAdmission: value.toolAdmission,
    trace: value.trace, terminalStatus: null
  };
  assert.equal(runDiagnosticsSchema.safeParse(diagnostics).success, true);
  assert.equal(runDiagnosticsSchema.safeParse({ ...diagnostics, rawEvent: { prompt: privateMarker } }).success, false);
  assert.equal(runDiagnosticsSchema.safeParse({ ...diagnostics, context: { ...diagnostics.context, correction: privateMarker } }).success, false);
});

test('real SQLite defaults legacy rows, rejects corruption and deletes trace with thread history', () => {
  const db = createDatabase();
  try {
    const repository = new AgentRunTelemetryRepository(db);
    const legacy = accumulator().snapshot();
    delete legacy.trace;
    delete legacy.toolAdmission;
    delete legacy.model.unknownUsageCallCount;
    delete legacy.context.lastInputEstimated;
    delete legacy.context.contractAudit;
    db.prepare(`INSERT INTO agent_run_telemetry (run_id, schema_version, telemetry_json, created_at, updated_at)
      VALUES (?, 1, ?, ?, ?)`).run(run.id, JSON.stringify(legacy), '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const loaded = repository.get(run.id);
    assert.deepEqual(loaded.trace, { spans: [], droppedSpanCount: 0 });
    assert.deepEqual(loaded.context.contractAudit, createEmptyContextContractAudit());
    assert.equal(loaded.context.lastInputEstimated, null);
    assert.equal(loaded.toolAdmission.wait.count, 0);
    assert.equal(loaded.model.unknownUsageCallCount, 0);
    assert.equal(repository.get('missing-run'), null);
    assert.throws(() => repository.save({ ...loaded, prompt: privateMarker }, '2026-10-31T00:00:00.000Z'), /agent_run_telemetry_invalid/u);
    db.prepare('UPDATE agent_run_telemetry SET telemetry_json = ? WHERE run_id = ?')
      .run(JSON.stringify({ ...loaded, prompt: privateMarker }), run.id);
    assert.throws(() => repository.get(run.id), /agent_run_telemetry_corrupt/u);
    const resumed = accumulator(loaded);
    resumed.observeModelInvocation(modelObservation(), 20);
    repository.save(resumed.snapshot(), '2026-10-31T00:00:00.000Z');
    new AgentTaskHistoryContract(db).deleteThread(run.threadId);
    assert.equal(repository.get(run.id), null);
    assert.equal(db.prepare('SELECT COUNT(*) FROM agent_threads').pluck().get(), 0);
  } finally {
    db.close();
  }
});

test('model invocation usage includes summaries and does not double-count event/outcome usage', () => {
  const telemetry = accumulator();
  telemetry.observeModelInvocation(modelObservation({
    actualCacheReadTokens: 4, actualCacheCreationTokens: 2
  }), 20);
  telemetry.observeModelInvocation(modelObservation({
    purpose: 'summary', actualInputTokens: 10, actualOutputTokens: 3,
    actualCacheReadTokens: 1, actualCacheCreationTokens: 0
  }), 30);
  telemetry.observeModelInvocation(modelObservation({
    status: 'blocked', actualInputTokens: null, actualOutputTokens: null
  }), 35);
  const beforeOutcome = telemetry.snapshot();
  telemetry.observeModelUsage({
    callCount: 100, inputTokens: 999, outputTokens: 999, totalTokens: 1998,
    cacheReadTokens: 50, cacheCreationTokens: 50
  });
  assert.deepEqual(telemetry.snapshot(), beforeOutcome);
  assert.deepEqual(beforeOutcome.model, {
    callCount: 2, unknownUsageCallCount: 0, inputTokens: 35, outputTokens: 8, totalTokens: 43,
    cacheReadTokens: 5, cacheCreationTokens: 2, });
  assert.equal(beforeOutcome.trace.spans.filter(span => span.operation === 'summary_model').length, 1);

  const legacyExecutor = accumulator();
  legacyExecutor.observeModelUsage({
    callCount: 1, inputTokens: 10, outputTokens: 3, totalTokens: 13,
    cacheReadTokens: null, cacheCreationTokens: null
  });
  assert.equal(legacyExecutor.snapshot().model.totalTokens, 13);

  const event = contextEvent('context_tool_result_persisted', '10000000-0000-4000-8000-000000000001', {
    persistedChars: 50
  });
  telemetry.observeEvent(event, 40);
  telemetry.observeEvent(event, 41);
  assert.equal(telemetry.snapshot().context.artifactCount, 1);
  assert.equal(telemetry.snapshot().context.persistedChars, 50);
});

test('retention prunes terminal diagnostics after 30 days but keeps active and interrupted runs', () => {
  const db = createDatabase();
  try {
    const repository = new AgentRunTelemetryRepository(db);
    db.prepare(`INSERT INTO agent_run_telemetry (run_id, schema_version, telemetry_json, created_at, updated_at)
      VALUES (?, 1, 'not-json', ?, ?)`).run(run.id, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    const values = [
      ['completed-old', 'completed', '2026-09-29T00:00:00.000Z'],
      ['failed-old', 'failed', '2026-09-29T00:00:00.000Z'],
      ['cancelled-old', 'cancelled', '2026-09-29T00:00:00.000Z'],
      ['interrupted-old', 'interrupted', '2026-09-29T00:00:00.000Z'],
      ['active-old', null, '2026-09-29T00:00:00.000Z'],
      ['completed-boundary', 'completed', '2026-10-01T00:00:00.000Z'],
      ['completed-new', 'completed', '2026-10-30T00:00:00.000Z']
    ];
    for (const [runId, status, updatedAt] of values) {
      const threadId = `thread-${runId}`;
      db.prepare(`INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
        VALUES (?, 'chat', 'Fixture', 'Fixture', 'active', ?, ?)`).run(threadId, updatedAt, updatedAt);
      db.prepare(`INSERT INTO agent_runs (id, thread_id, run_number, user_input, status, started_at, enabled_capabilities_json)
        VALUES (?, ?, 1, 'Fixture', ?, ?, '{}')`).run(runId, threadId, status ?? 'running', updatedAt);
      const value = accumulator().snapshot();
      value.correlation.runId = runId;
      value.correlation.threadId = threadId;
      value.terminal.status = status;
      repository.save(value, updatedAt);
    }
    assert.throws(() => repository.pruneExpired('invalid'), /agent_run_telemetry_retention_time_invalid/u);
    assert.equal(repository.pruneExpired('2026-10-31T00:00:00.000Z'), 3);
    for (const [runId, status] of values) {
      const pruned = ['completed-old', 'failed-old', 'cancelled-old'].includes(runId);
      assert.equal(repository.get(runId) === null, pruned, `${runId}:${status}`);
    }
    assert.equal(db.prepare('SELECT COUNT(*) FROM agent_runs').pluck().get(), values.length + 1);
    assert.throws(() => repository.get(run.id), /agent_run_telemetry_corrupt/u);
    assert.equal(repository.pruneExpired('2026-10-31T00:00:00.000Z'), 0);
  } finally {
    db.close();
  }
});

test('run diagnostics read checks thread identity and omits internal metadata and stale missing rows', async () => {
  const { AgentPluginRuntime } = await importTypeScriptModule('src/main/plugins/agent/runtime.ts', {
    ...bundleOptions, external: [...bundleOptions.external, 'deepagents', 'langchain', '@langchain/*']
  });
  let reads = 0;
  let value = accumulator().snapshot();
  const runtime = new AgentPluginRuntime({
    executionGrantBroker: {revokeRun: () => assert.fail('diagnostics must not revoke grants')},
    repository: {
      getRun: runId => {
        if (runId !== run.id) throw new Error('task_run_not_found');
        return { ...run, startedAt: '2026-10-30T00:00:00.000Z', endedAt: '2026-10-30T00:00:01.000Z' };
      },
      getRunExecutionSnapshot: () => snapshot,
      getRunTelemetry: () => { reads++; return value; }
    }
  });
  assert.throws(() => runtime.getRunDiagnostics({ runId: run.id, threadId: 'wrong-thread' }), /agent_run_diagnostics_thread_mismatch/u);
  assert.equal(reads, 0);
  assert.throws(() => runtime.getRunDiagnostics({ runId: 'missing-run', threadId: run.threadId }), /task_run_not_found/u);
  const diagnostics = runtime.getRunDiagnostics({ runId: run.id, threadId: run.threadId });
  assert.equal(runDiagnosticsSchema.safeParse(diagnostics).success, true);
  assert.equal(Object.hasOwn(diagnostics, 'correlation'), false);
  assert.equal(Object.hasOwn(diagnostics.model, 'reportedCostUsd'), false);
  assert.equal(Object.hasOwn(diagnostics, 'dispatchKey'), false);
  assert.equal(Object.hasOwn(diagnostics, 'manifestHash'), false);
  diagnostics.trace.spans[0].operation = 'tool_effect';
  assert.equal(value.trace.spans[0].operation, 'run');
  value = null;
  assert.equal(runtime.getRunDiagnostics({ runId: run.id, threadId: run.threadId }), null);
  value = accumulator().snapshot();
  value.correlation.modelId = 'different-model';
  assert.throws(() => runtime.getRunDiagnostics({ runId: run.id, threadId: run.threadId }), /agent_run_telemetry_identity_mismatch/u);
});

test('telemetry correlation rejects run, thread, manifest, provider and model identity drift', () => {
  const value = accumulator().snapshot();
  for (const badRun of [{ ...run, id: 'run-2' }, { ...run, threadId: 'thread-2' }]) {
    assert.throws(() => assertAgentRunTelemetryIdentity(value, badRun, snapshot), /agent_run_telemetry_identity_mismatch/u);
  }
  for (const badSnapshot of [
    { ...snapshot, capabilityManifest: { manifestHash: 'different' } },
    { ...snapshot, model: { ...snapshot.model, providerId: 'provider-2' } },
    { ...snapshot, model: { ...snapshot.model, modelId: 'model-2' } }
  ]) {
    assert.throws(() => assertAgentRunTelemetryIdentity(value, run, badSnapshot), /agent_run_telemetry_identity_mismatch/u);
  }
});

test('unknown dispatched model calls remain explicit beside known subtotals after restart', () => {
  const telemetry = accumulator();
  telemetry.observeModelInvocation(modelObservation(), 20);
  telemetry.observeModelInvocation(modelObservation({
    purpose: 'summary', actualInputTokens: null, actualOutputTokens: null
  }), 30);
  telemetry.observeModelInvocation(modelObservation({
    status: 'failed', actualInputTokens: null, actualOutputTokens: null
  }), 40);
  telemetry.observeModelInvocation(modelObservation({
    status: 'blocked', actualInputTokens: null, actualOutputTokens: null
  }), 50);
  const value = telemetry.snapshot();
  assert.equal(value.model.callCount, 3);
  assert.equal(value.model.unknownUsageCallCount, 2);
  assert.equal(value.model.inputTokens, 25);
  assert.equal(value.model.outputTokens, 5);
  assert.equal(value.model.totalTokens, 30);
  assert.equal(value.trace.spans.filter(span => span.operation.endsWith('_model') && span.actualInputTokens === null).length, 3);
  assert.equal(accumulator(value).snapshot().model.unknownUsageCallCount, 2);
});

test('live telemetry round-trips through SQLite and cannot overwrite terminal or mismatched run data', async () => {
  const { AgentSessionRepository } = await importTypeScriptModule('src/main/plugins/agent/session-repository.ts', {
    ...bundleOptions, external: [...bundleOptions.external, 'deepagents', 'langchain', '@langchain/*']
  });
  const { compileRunCapabilityManifest } = await importTypeScriptModule(
    'src/main/plugins/agent/run-capability-manifest.ts', bundleOptions
  );
  const { createRunExecutionSnapshot, createRunModelConfig } = await importTypeScriptModule(
    'src/main/plugins/agent/run-execution-snapshot.ts', bundleOptions
  );
  const db = createDatabase();
  try {
    const manifest = compileRunCapabilityManifest({
      mode: 'chat', deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic',
      mcpServers: [], skills: [], requestedCapabilities: { mcpServers: [], skills: [] },
      workflowHint: null, researchProjectId: null
    }).manifest;
    const frozen = createRunExecutionSnapshot({
      runId: run.id, threadId: run.threadId, inputMessageId: 'message-1',
      snapshot: {
        schemaVersion: 11,
        submissionHash: 'f'.repeat(64),
        taskContract: {
          contractVersion: 1, objective: 'Fixture reply', constraints: [], kind: 'reply',
          criteria: [{ id: 'response', description: 'Return a reply', check: { kind: 'response' } }]
        },
        runOrigin: 'chat', model: snapshot.model, mode: 'run', workspace: null,
        capabilityManifest: manifest, workflowHint: null, explicitSkillIds: [], dispatchKey: null,
        researchProjectId: null, modelConfig: createRunModelConfig({ contextWindowTokens: null })
      }
    });
    db.prepare(`UPDATE agent_runs SET snapshot_json = ?, snapshot_version = 11, provider_id = ?, model_id = ?,
      enabled_capabilities_json = ?, run_origin = 'chat' WHERE id = ?`).run(
      JSON.stringify(frozen), frozen.model.providerId, frozen.model.modelId,
      JSON.stringify(manifest.resolvedCapabilities), run.id
    );
    const now = new Date().toISOString();
    const store = new AgentRunTelemetryRepository(db);
    const telemetry = new AgentRunTelemetryAccumulator({ existing: null, run, snapshot: frozen });
    store.save(telemetry.snapshot(), now);
    const repository = new AgentSessionRepository(db);
    telemetry.observeEvent(toolEvent('start'), 10);
    telemetry.observeModelInvocation(modelObservation(), 20);
    repository.saveLiveRunTelemetry(telemetry.snapshot(), now);
    const saved = repository.getRunTelemetry(run.id);
    assert.equal(saved.model.callCount, 1);
    assert.equal(saved.tool.callCount, 1);
    assert.equal(saved.trace.spans.find(span => span.operation === 'tool_effect').status, 'running');
    const reopened = new AgentSessionRepository(db);
    assert.deepEqual(reopened.getRunTelemetry(run.id), saved);

    const wrongIdentity = structuredClone(saved);
    wrongIdentity.correlation.modelId = 'wrong-model';
    assert.throws(() => repository.saveLiveRunTelemetry(wrongIdentity, now), /agent_run_telemetry_identity_mismatch/u);
    assert.deepEqual(repository.getRunTelemetry(run.id), saved);

    const prematureTerminal = structuredClone(saved);
    prematureTerminal.terminal.status = 'completed';
    repository.saveLiveRunTelemetry(prematureTerminal, now);
    assert.deepEqual(repository.getRunTelemetry(run.id), saved);

    telemetry.markTerminal(terminal('completed', 100));
    db.prepare("UPDATE agent_runs SET status = 'completed', ended_at = ? WHERE id = ?").run(now, run.id);
    store.save(telemetry.snapshot(), now);
    const final = repository.getRunTelemetry(run.id);
    repository.saveLiveRunTelemetry(saved, now);
    assert.deepEqual(repository.getRunTelemetry(run.id), final);
    assert.equal(final.terminal.status, 'completed');
    assert.equal(final.trace.spans.some(span => span.status === 'running'), false);
  } finally {
    db.close();
  }
});
