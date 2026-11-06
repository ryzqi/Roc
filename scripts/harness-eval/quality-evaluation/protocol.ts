import { QUALITY_FAMILIES, QUALITY_TARGETS, auditQualityDataset, qualityHash, type FrozenQualityDataset } from './dataset';
export { QUALITY_TARGETS } from './dataset';

export type QualityEvaluationProtocol = {
  schemaVersion: 3;
  id: string;
  status: 'draft' | 'locked';
  datasetHash: string;
  sourceIds: readonly string[];
  sourceLicenses: readonly { sourceId: string; license: string; attribution: string; locator: string }[];
  taskCount: number;
  targetCaseCount: 200;
  targetByFamily: Readonly<Record<(typeof QUALITY_FAMILIES)[number], number>>;
  repeatsPerTask: 3;
  confidenceLevel: 0.95;
  bootstrapMethod: 'paired-cluster-bootstrap-percentile';
  bootstrapIterations: 2000;
  seed: 20261030;
  minimumClustersPerFamily: 5;
  nonInferiorityMargin: 0.05;
  subjectiveReview: 'blind-human-review-required; retain disagreements';
  fixtureClaims: 'contract-only; no model-quality or provider-cost inference';
  failureClasses: readonly ['infra', 'provider', 'policy', 'effect', 'state', 'verifier', 'agent', 'data', 'operator'];
  stopRules: readonly string[];
  lock?: {
    executionMode: 'fixture' | 'pilot' | 'full';
    authorizationLevel: 'L1' | 'L2' | 'L3';
    providerId: string;
    pricingVersion: string;
    maxRequestsPerTask: number;
    maxRequestCostMicrousd: number;
    temperature: number;
    isolationHash: string;
    baselineModelId: string;
    candidateModelId: string;
    baselineCommitSha: string;
    candidateCommitSha: string;
    toolManifestHash: string;
    promptSetHash: string;
    environmentHash: string;
    taskTimeoutMs: number;
    maxTotalCostUsd: number;
    maxPerTaskCostUsd: number;
    userAuthorized: true;
    approvalReference: string;
    explicitL3Approval: boolean;
    rollbackPlanReference: string | null;
  };
  lockHash?: string;
};

export type QualityProtocolLockInput = {
  executionMode: 'fixture' | 'pilot' | 'full';
  authorizationLevel: 'L1' | 'L2' | 'L3';
  providerId: string;
  pricingVersion: string;
  maxRequestsPerTask: number;
  maxRequestCostMicrousd: number;
  temperature: number;
  isolationHash: string;
  baselineModelId: string;
  candidateModelId: string;
  baselineCommitSha: string;
  candidateCommitSha: string;
  toolManifestHash: string;
  promptSetHash: string;
  environmentHash: string;
  taskTimeoutMs: number;
  maxTotalCostUsd: number;
  maxPerTaskCostUsd: number;
  userAuthorized: true;
  approvalReference: string;
  explicitL3Approval?: boolean;
  rollbackPlanReference?: string | null;
};

const STOP_RULES = [
  'stop before dispatch when the locked total or per-task spend cap would be exceeded',
  'stop on any unauthorized external effect, permission bypass, or secret exposure',
  'classify provider, infrastructure, verifier, and agent failures separately; do not silently retry beyond the locked repeat count',
  'do not unlock or amend a preregistration after the first provider dispatch; create a new protocol id and dataset hash'
] as const;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

function digest(value: unknown): string {
  return qualityHash(value);
}

function assertIdentifier(value: string, code: string): void {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error(code);
}

function protocolWithoutHash(protocol: QualityEvaluationProtocol): Omit<QualityEvaluationProtocol, 'lockHash'> {
  const { lockHash: _lockHash, ...rest } = protocol;
  return rest;
}

export function createQualityProtocolDraft(dataset: FrozenQualityDataset, id: string): QualityEvaluationProtocol {
  assertIdentifier(id, "quality_protocol_id_invalid");
  return {
    schemaVersion: 3,
    id,
    status: 'draft',
    datasetHash: dataset.datasetHash,
    sourceIds: dataset.sources.map(source => source.id),
    sourceLicenses: dataset.sources.map(source => ({ sourceId: source.id, license: source.license, attribution: source.attribution, locator: source.locator })),
    taskCount: dataset.tasks.length,
    targetCaseCount: 200,
    targetByFamily: QUALITY_TARGETS,
    repeatsPerTask: 3,
    confidenceLevel: 0.95,
    bootstrapMethod: 'paired-cluster-bootstrap-percentile',
    bootstrapIterations: 2000,
    seed: 20261030,
    minimumClustersPerFamily: 5,
    nonInferiorityMargin: 0.05,
    subjectiveReview: 'blind-human-review-required; retain disagreements',
    fixtureClaims: 'contract-only; no model-quality or provider-cost inference',
    failureClasses: ['infra', 'provider', 'policy', 'effect', 'state', 'verifier', 'agent', 'data', 'operator'],
    stopRules: STOP_RULES
  };
}

export function lockQualityProtocol(
  dataset: FrozenQualityDataset,
  draft: QualityEvaluationProtocol,
  input: QualityProtocolLockInput
): QualityEvaluationProtocol {
  if (draft.status !== 'draft' || draft.lock !== undefined || draft.lockHash !== undefined) {
    throw new Error('quality_protocol_not_draft');
  }
  if (draft.datasetHash !== dataset.datasetHash) throw new Error('quality_protocol_dataset_changed');
  if (digest(draft) !== digest(createQualityProtocolDraft(dataset, draft.id))) {
    throw new Error('quality_protocol_preregistration_changed');
  }
  if (!['fixture', 'pilot', 'full'].includes(input.executionMode) || !['L1', 'L2', 'L3'].includes(input.authorizationLevel)
    || input.userAuthorized !== true) throw new Error('quality_protocol_user_authorization_required');
  const audit = auditQualityDataset(dataset);
  if (input.executionMode === 'fixture' && (dataset.evidence !== 'fixture' || input.authorizationLevel !== 'L1')) {
    throw new Error('quality_protocol_fixture_level_invalid');
  }
  if (input.executionMode !== 'fixture' && (dataset.evidence !== 'independent' || input.authorizationLevel === 'L1')) {
    throw new Error('quality_protocol_independent_data_required');
  }
  if (input.executionMode === 'full' && !audit.fullDatasetReady) throw new Error('quality_protocol_full_dataset_incomplete');
  if (input.executionMode === 'pilot' && dataset.tasks.filter(task => task.split === 'dev').length < 10) {
    throw new Error('quality_protocol_pilot_too_small');
  }
  assertIdentifier(input.pricingVersion, 'quality_protocol_pricing_invalid');
  if (!Number.isSafeInteger(input.maxRequestsPerTask) || input.maxRequestsPerTask < 1 || input.maxRequestsPerTask > 100
    || !Number.isSafeInteger(input.maxRequestCostMicrousd) || input.maxRequestCostMicrousd < 1
    || input.maxRequestsPerTask * input.maxRequestCostMicrousd > input.maxPerTaskCostUsd * 1_000_000
    || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2
    || !SHA256.test(input.isolationHash)) throw new Error('quality_protocol_request_limits_invalid');
  assertIdentifier(input.providerId, 'quality_protocol_provider_invalid');
  assertIdentifier(input.baselineModelId, 'quality_protocol_baseline_invalid');
  assertIdentifier(input.candidateModelId, 'quality_protocol_candidate_invalid');
  if (input.baselineModelId !== input.candidateModelId) throw new Error('quality_protocol_same_model_required');
  assertIdentifier(input.approvalReference, 'quality_protocol_approval_reference_invalid');
  if (!COMMIT_SHA.test(input.baselineCommitSha) || !COMMIT_SHA.test(input.candidateCommitSha)) {
    throw new Error('quality_protocol_commit_invalid');
  }
  if (input.baselineCommitSha === input.candidateCommitSha) {
    throw new Error('quality_protocol_comparison_identical');
  }
  if (!SHA256.test(input.toolManifestHash) || !SHA256.test(input.promptSetHash) || !SHA256.test(input.environmentHash)) {
    throw new Error('quality_protocol_environment_hash_invalid');
  }
  if (!Number.isSafeInteger(input.taskTimeoutMs) || input.taskTimeoutMs < 1000 || input.taskTimeoutMs > 600000
    || !Number.isFinite(input.maxTotalCostUsd) || input.maxTotalCostUsd <= 0
    || !Number.isFinite(input.maxPerTaskCostUsd) || input.maxPerTaskCostUsd <= 0
    || input.maxPerTaskCostUsd > input.maxTotalCostUsd) {
    throw new Error('quality_protocol_budget_or_timeout_invalid');
  }
  const rollbackPlanReference = input.rollbackPlanReference ?? null;
  if (input.authorizationLevel === 'L3'
    && (input.explicitL3Approval !== true || rollbackPlanReference === null || !SAFE_IDENTIFIER.test(rollbackPlanReference))) {
    throw new Error('quality_protocol_l3_approval_or_rollback_required');
  }
  const locked: QualityEvaluationProtocol = {
    ...draft,
    status: 'locked',
    lock: {
      executionMode: input.executionMode,
      authorizationLevel: input.authorizationLevel,
      providerId: input.providerId,
      pricingVersion: input.pricingVersion,
      maxRequestsPerTask: input.maxRequestsPerTask,
      maxRequestCostMicrousd: input.maxRequestCostMicrousd,
      temperature: input.temperature,
      isolationHash: input.isolationHash,
      baselineModelId: input.baselineModelId,
      candidateModelId: input.candidateModelId,
      baselineCommitSha: input.baselineCommitSha,
      candidateCommitSha: input.candidateCommitSha,
      toolManifestHash: input.toolManifestHash,
      promptSetHash: input.promptSetHash,
      environmentHash: input.environmentHash,
      taskTimeoutMs: input.taskTimeoutMs,
      maxTotalCostUsd: input.maxTotalCostUsd,
      maxPerTaskCostUsd: input.maxPerTaskCostUsd,
      userAuthorized: true,
      approvalReference: input.approvalReference,
      explicitL3Approval: input.explicitL3Approval === true,
      rollbackPlanReference
    }
  };
  return { ...locked, lockHash: digest(protocolWithoutHash(locked)) };
}

export function assertQualityProtocolAuthorized(dataset: FrozenQualityDataset, protocol: QualityEvaluationProtocol): asserts protocol is QualityEvaluationProtocol & {
  status: 'locked';
  lock: NonNullable<QualityEvaluationProtocol['lock']>;
  lockHash: string;
} {
  if (protocol.schemaVersion !== 3 || !SAFE_IDENTIFIER.test(protocol.id)) {
    throw new Error('quality_protocol_version_invalid');
  }
  if (protocol.status !== 'locked' || protocol.lock === undefined || protocol.lockHash === undefined) {
    throw new Error('quality_eval_authorization_required');
  }
  if (protocol.datasetHash !== dataset.datasetHash) throw new Error('quality_protocol_dataset_changed');
  if (digest(protocolWithoutHash(protocol)) !== protocol.lockHash) throw new Error('quality_protocol_lock_tampered');
  const { lock: _lock, lockHash: _hash, ...draft } = protocol;
  lockQualityProtocol(dataset, { ...draft, status: 'draft' }, protocol.lock);
  if (protocol.lock.userAuthorized !== true || !SAFE_IDENTIFIER.test(protocol.lock.approvalReference)) {
    throw new Error('quality_protocol_user_authorization_required');
  }
  if (protocol.lock.authorizationLevel === 'L3'
    && (!protocol.lock.explicitL3Approval || protocol.lock.rollbackPlanReference === null)) {
    throw new Error('quality_protocol_l3_approval_or_rollback_required');
  }
}
