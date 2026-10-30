import assert from 'node:assert/strict';
import { QUALITY_FAMILIES, QUALITY_SOURCES, QUALITY_TASKS, toAgentTaskView, qualityDatasetHash } from './data';
import { assertQualityProtocolAuthorized, createQualityProtocolDraft, lockQualityProtocol } from './protocol';
import { summarizePairedQualityTrials, type PairedQualityTrial } from './statistics';

function buildFixtureTrials(): PairedQualityTrial[] {
  return QUALITY_TASKS.flatMap(task => Array.from({ length: 3 }, (_, repeatIndex) => ({
    taskId: task.id,
    family: task.family,
    clusterId: task.clusterId,
    repeatIndex,
    baseline: { status: 'success' as const, score: 0.75, latencyMs: 100 + repeatIndex, costUsd: null },
    candidate: { status: 'success' as const, score: 0.8, latencyMs: 110 + repeatIndex, costUsd: null }
  })));
}

export function verifyQualityEvaluation(): Record<string, unknown> {
  assert.equal(QUALITY_TASKS.length, 16, 'quality pilot task count');
  assert.equal(QUALITY_SOURCES.length, 3, 'verified CC BY source count');
  assert.ok(Object.isFrozen(QUALITY_SOURCES) && Object.isFrozen(QUALITY_SOURCES[0]), 'source records are immutable');
  const familyCounts = Object.fromEntries(QUALITY_FAMILIES.map(family => [family, QUALITY_TASKS.filter(task => task.family === family).length]));
  for (const family of QUALITY_FAMILIES) assert.equal(familyCounts[family], 2, `pilot family ${family}`);
  const datasetHash = qualityDatasetHash();
  assert.match(datasetHash, /^[a-f0-9]{64}$/u);

  for (const task of QUALITY_TASKS) {
    const publicTask = toAgentTaskView(task);
    assert.equal('validator' in publicTask, false, `${task.id} hides reference validator`);
    assert.equal('sourceIds' in publicTask, false, `${task.id} hides provenance registry`);
    assert.equal('clusterId' in publicTask, false, `${task.id} hides statistical cluster`);
    assert.equal('split' in publicTask, false, `${task.id} hides data split`);
    assert.ok(task.sourceIds.every(sourceId => QUALITY_SOURCES.some(source => source.id === sourceId)), `${task.id} source references`);
    if (task.family === 'long-memory') assert.ok((publicTask.conversationTurns?.length ?? 0) >= 4, `${task.id} has prior conversation turns`);
  }

  const draft = createQualityProtocolDraft();
  assert.equal(draft.status, 'draft');
  assert.equal(draft.datasetHash, datasetHash);
  assert.equal(draft.pilotTaskCount, QUALITY_TASKS.length);
  assert.equal(Object.values(draft.targetByFamily).reduce((sum, value) => sum + value, 0), 200);
  assert.throws(() => assertQualityProtocolAuthorized(draft), /quality_eval_authorization_required/u);
  assert.throws(() => lockQualityProtocol(draft, {
    executionMode: 'full', authorizationLevel: 'L2', providerId: 'fixture-provider',
    baselineModelId: 'fixture-baseline', candidateModelId: 'fixture-candidate',
    toolManifestHash: '0'.repeat(64), promptSetHash: '1'.repeat(64), environmentHash: '2'.repeat(64),
    taskTimeoutMs: 10000, maxTotalCostUsd: 1, maxPerTaskCostUsd: 0.1,
    userAuthorized: true, approvalReference: 'fixture-approval'
  }), /quality_protocol_full_dataset_incomplete/u);

  const statistics = summarizePairedQualityTrials(buildFixtureTrials());
  assert.equal(statistics.evidenceStatus, 'insufficient');
  assert.equal(statistics.conclusion, 'uncertain');
  assert.equal(statistics.costStatus, 'unknown');
  assert.equal(statistics.taskCount, QUALITY_TASKS.length);
  return {
    evidence: 'deterministic-fixture-contract-only',
    tasks: QUALITY_TASKS.length,
    families: familyCounts,
    datasetHash,
    protocolStatus: draft.status,
    targetCases: draft.targetCaseCount,
    fixtureConclusion: statistics.conclusion,
    fixtureEvidenceStatus: statistics.evidenceStatus,
    modelCalls: 0,
    externalCalls: 0,
    costUsd: null,
    qualityClaim: draft.fixtureClaims
  };
}

export { QUALITY_FAMILIES, QUALITY_SOURCES, QUALITY_TASKS, toAgentTaskView, qualityDatasetHash } from './data';
export { validateQualityTaskOutput } from './validators';
export { summarizePairedQualityTrials } from './statistics';
export { assertQualityProtocolAuthorized, createQualityProtocolDraft, lockQualityProtocol, QUALITY_TARGETS } from './protocol';
