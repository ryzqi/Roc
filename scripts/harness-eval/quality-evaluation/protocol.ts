import { createHash } from 'node:crypto';
import { QUALITY_FAMILIES, QUALITY_SOURCES, QUALITY_TASKS, qualityDatasetHash } from './data';

export const QUALITY_TARGETS: Readonly<Record<(typeof QUALITY_FAMILIES)[number], number>> = Object.freeze({
  'literature-verification': 30,
  'multi-paper-evidence': 30,
  'long-memory': 25,
  'file-report': 30,
  'experiment-script': 25,
  'mcp-recovery': 20,
  'permission-injection': 20,
  'cancel-crash': 20
});

export type QualityEvaluationProtocol = {
  schemaVersion: 1;
  id: 'roc-agent-harness-pr06-v1';
  status: 'draft' | 'locked';
  datasetHash: string;
  sourceIds: readonly string[];
  sourceLicenses: readonly { sourceId: string; license: 'CC BY'; attribution: string; locator: string }[];
  pilotTaskCount: number;
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
    executionMode: 'pilot' | 'full';
    authorizationLevel: 'L2' | 'L3';
    providerId: string;
    baselineModelId: string;
    candidateModelId: string;
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
  executionMode: 'pilot' | 'full';
  authorizationLevel: 'L2' | 'L3';
  providerId: string;
  baselineModelId: string;
  candidateModelId: string;
  toolManifestHash: string;
  promptSetHash: string;
  environmentHash: string;
  taskTimeoutMs: number;
  maxTotalCostUsd: number;
  maxPerTaskCostUsd: number;
  userAuthorized: true;
  approvalReference: string;
  explicitL3Approval?: boolean;
  rollbackPlanReference?: string;
};

const STOP_RULES = [
  'stop before dispatch when the locked total or per-task spend cap would be exceeded',
  'stop on any unauthorized external effect, permission bypass, or secret exposure',
  'classify provider, infrastructure, verifier, and agent failures separately; do not silently retry beyond the locked repeat count',
  'do not unlock or amend a preregistration after the first provider dispatch; create a new protocol id and dataset hash'
] as const;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertIdentifier(value: string, code: string): void {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error(code);
}

function protocolWithoutHash(protocol: QualityEvaluationProtocol): Omit<QualityEvaluationProtocol, 'lockHash'> {
  const { lockHash: _lockHash, ...rest } = protocol;
  return rest;
}

export function createQualityProtocolDraft(): QualityEvaluationProtocol {
  return {
    schemaVersion: 1,
    id: 'roc-agent-harness-pr06-v1',
    status: 'draft',
    datasetHash: qualityDatasetHash(),
    sourceIds: QUALITY_SOURCES.map(source => source.id),
    sourceLicenses: QUALITY_SOURCES.map(source => ({ sourceId: source.id, license: source.license, attribution: source.attribution, locator: source.locator })),
    pilotTaskCount: QUALITY_TASKS.length,
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
  draft: QualityEvaluationProtocol,
  input: QualityProtocolLockInput
): QualityEvaluationProtocol {
  if (draft.status !== 'draft' || draft.lock !== undefined || draft.lockHash !== undefined) {
    throw new Error('quality_protocol_not_draft');
  }
  if (draft.datasetHash !== qualityDatasetHash()) throw new Error('quality_protocol_dataset_changed');
  if (!['pilot', 'full'].includes(input.executionMode) || !['L2', 'L3'].includes(input.authorizationLevel)
    || input.userAuthorized !== true) throw new Error('quality_protocol_user_authorization_required');
  if (input.executionMode === 'full' && QUALITY_TASKS.length !== draft.targetCaseCount) {
    throw new Error('quality_protocol_full_dataset_incomplete');
  }
  if (input.executionMode === 'pilot' && QUALITY_TASKS.length < 10) throw new Error('quality_protocol_pilot_too_small');
  assertIdentifier(input.providerId, 'quality_protocol_provider_invalid');
  assertIdentifier(input.baselineModelId, 'quality_protocol_baseline_invalid');
  assertIdentifier(input.candidateModelId, 'quality_protocol_candidate_invalid');
  assertIdentifier(input.approvalReference, 'quality_protocol_approval_reference_invalid');
  if (input.baselineModelId === input.candidateModelId) throw new Error('quality_protocol_models_must_differ');
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
      baselineModelId: input.baselineModelId,
      candidateModelId: input.candidateModelId,
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

export function assertQualityProtocolAuthorized(protocol: QualityEvaluationProtocol): asserts protocol is QualityEvaluationProtocol & {
  status: 'locked';
  lock: NonNullable<QualityEvaluationProtocol['lock']>;
  lockHash: string;
} {
  if (protocol.status !== 'locked' || protocol.lock === undefined || protocol.lockHash === undefined) {
    throw new Error('quality_eval_authorization_required');
  }
  if (protocol.datasetHash !== qualityDatasetHash()) throw new Error('quality_protocol_dataset_changed');
  if (digest(protocolWithoutHash(protocol)) !== protocol.lockHash) throw new Error('quality_protocol_lock_tampered');
  if (protocol.lock.userAuthorized !== true || !SAFE_IDENTIFIER.test(protocol.lock.approvalReference)) {
    throw new Error('quality_protocol_user_authorization_required');
  }
  if (protocol.lock.authorizationLevel === 'L3'
    && (!protocol.lock.explicitL3Approval || protocol.lock.rollbackPlanReference === null)) {
    throw new Error('quality_protocol_l3_approval_or_rollback_required');
  }
}
