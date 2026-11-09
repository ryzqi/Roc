import assert from 'node:assert/strict';
import { auditQualityDataset, toAgentTaskView, qualityHash, qualityValidatorSchema, type FrozenQualityDataset, type QualityExpectations } from './dataset';
import { assertQualityProtocolAuthorized, createQualityProtocolDraft } from './protocol';
import { summarizePairedQualityTrials, type PairedQualityTrial } from './statistics';

export function verifyQualityEvaluation(dataset: FrozenQualityDataset, expectations: QualityExpectations): Record<string, unknown> {
  const draft = createQualityProtocolDraft(dataset, 'offline-quality-contract');
  assert.throws(() => assertQualityProtocolAuthorized(dataset, draft), /quality_eval_authorization_required/u);
  for (const task of dataset.tasks) {
    assert.equal(qualityHash(qualityValidatorSchema.parse(expectations[task.id])), task.expectedHash);
    const view = toAgentTaskView(task);
    for (const hidden of ['validator', 'expectedRef', 'expectedHash', 'sourceIds', 'clusterId', 'split', 'review']) {
      assert.equal(Object.hasOwn(view, hidden), false);
    }
  }
  const trials: PairedQualityTrial[] = dataset.tasks.flatMap(task => Array.from({ length: 3 }, (_, repeatIndex) => ({
    taskId: task.id, family: task.family, clusterId: task.clusterId, repeatIndex,
    baseline: { status: 'success', score: 0.75, latencyMs: 100 },
    candidate: { status: 'success', score: 0.8, latencyMs: 110 }
  })));
  const statistics = summarizePairedQualityTrials(trials);
  assert.equal(statistics.evidenceStatus, 'insufficient');
  return { ...auditQualityDataset(dataset), evidence: dataset.evidence === 'fixture'
    ? 'deterministic-fixture-contract-only' : 'offline-independent-dataset-contract-only',
    modelCalls: 0, externalCalls: 0,
    qualityClaim: draft.fixtureClaims, fixtureEvidenceStatus: statistics.evidenceStatus };
}
export * from './dataset';
export { validateQualityTaskOutput } from './validators';
export { summarizePairedQualityTrials } from './statistics';
export { assertQualityProtocolAuthorized, createQualityProtocolDraft, lockQualityProtocol } from './protocol';
