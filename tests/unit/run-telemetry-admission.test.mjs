import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { AgentRunTelemetryAccumulator, AgentRunTelemetryRepository } = await importTypeScriptModule(
  'src/main/plugins/agent/run-telemetry.ts',
  { platform: 'node' }
);

function legacyTelemetry() {
  return {
    schemaVersion: 1,
    correlation: {
      runId: 'run-1',
      threadId: 'thread-1',
      runOrigin: 'chat',
      dispatchKey: null,
      snapshotVersion: 2,
      manifestHash: 'manifest-hash',
      providerId: 'provider-id',
      modelId: 'model-id'
    },
    model: {
      callCount: 0,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      reportedCostUsd: null
    },
    tool: { callCount: 0, errorCount: 0 },
    subagent: { count: 0, failedCount: 0, maxDepth: 0 },
    context: {
      compactionCount: 0,
      summaryCount: 0,
      artifactCount: 0,
      failureCount: 0,
      estimatedCount: 0,
      inputTokens: null,
      budgetTokens: null,
      removedChars: 0,
      persistedChars: 0
    },
    runtime: { firstOutputMs: null, totalDurationMs: 0, recoveryCount: 0 },
    terminal: { status: null, errorCode: null, retryable: null, cancelSource: null }
  };
}

test('legacy telemetry rows default admission aggregates and safely accumulate private-free metrics', () => {
  const storedValue = legacyTelemetry();
  const row = {
    run_id: 'run-1',
    schema_version: 1,
    telemetry_json: JSON.stringify(storedValue)
  };
  const database = {
    prepare: () => ({ get: (runId) => runId === 'run-1' ? row : undefined })
  };
  const existing = new AgentRunTelemetryRepository(database).get('run-1');

  assert.deepEqual(existing.toolAdmission, {
    acquisitionCount: 0,
    cancellationCount: 0,
    contendedCount: 0,
    fallbackCount: 0,
    wait: { count: 0, totalMs: 0, maxMs: 0 },
    hold: { count: 0, totalMs: 0, maxMs: 0 },
    conflicts: {
      app_run: 0,
      background_tasks: 0,
      global_config: 0,
      global_fallback: 0,
      memory: 0,
      network: 0,
      research: 0,
      workspace: 0
    }
  });
  assert.equal(Object.hasOwn(storedValue, 'toolAdmission'), false);

  const accumulator = new AgentRunTelemetryAccumulator({
    existing,
    run: { id: 'run-1', threadId: 'thread-1' },
    snapshot: {
      runOrigin: 'chat',
      dispatchKey: null,
      capabilityManifest: { manifestHash: 'manifest-hash' },
      model: { providerId: 'provider-id', modelId: 'model-id' }
    }
  });
  accumulator.observeToolAdmission({
    status: 'released',
    waitMs: 11,
    holdMs: 20,
    resourceKinds: ['workspace'],
    conflictKinds: []
  });
  accumulator.observeToolAdmission({
    status: 'released',
    waitMs: 13,
    holdMs: 30,
    resourceKinds: ['global_fallback'],
    conflictKinds: ['memory', 'workspace']
  });
  accumulator.observeToolAdmission({
    status: 'cancelled',
    waitMs: 7,
    holdMs: null,
    resourceKinds: ['network'],
    conflictKinds: ['network']
  });

  const telemetry = accumulator.snapshot();
  assert.deepEqual(telemetry.toolAdmission, {
    acquisitionCount: 2,
    cancellationCount: 1,
    contendedCount: 2,
    fallbackCount: 1,
    wait: { count: 3, totalMs: 31, maxMs: 13 },
    hold: { count: 2, totalMs: 50, maxMs: 30 },
    conflicts: {
      app_run: 0,
      background_tasks: 0,
      global_config: 0,
      global_fallback: 0,
      memory: 1,
      network: 1,
      research: 0,
      workspace: 1
    }
  });
  assert.equal(JSON.stringify(telemetry).includes('project-private-id'), false);
  assert.equal(JSON.stringify(telemetry).includes('/private/workspace'), false);
});
