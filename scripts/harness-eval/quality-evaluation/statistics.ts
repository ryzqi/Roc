import { QUALITY_FAMILIES, freezeQualityDataset, auditQualityDataset, type QualityFamily, type FrozenQualityDataset } from './dataset';
import { QUALITY_TARGETS } from './protocol';

export const QUALITY_FAILURE_CLASSES = ['infra', 'provider', 'policy', 'effect', 'state', 'verifier', 'agent', 'data', 'operator'] as const;
export type QualityFailureClass = (typeof QUALITY_FAILURE_CLASSES)[number];

export type QualityArmOutcome = {
  status: 'success' | 'failure';
  score: number | null;
  latencyMs: number;
  costUsd: number | null;
  failureClass?: QualityFailureClass;
};

export type PairedQualityTrial = {
  taskId: string;
  family: QualityFamily;
  clusterId: string;
  repeatIndex: number;
  baseline: QualityArmOutcome;
  candidate: QualityArmOutcome;
};

export type ConfidenceInterval = { low: number; high: number } | null;

export type FamilyStatistics = {
  tasks: number;
  targetTasks: number;
  clusters: number;
  baselineMean: number;
  candidateMean: number;
  meanDifference: number;
  confidence95: ConfidenceInterval;
  candidateRegression: boolean | null;
};

export type QualityEvaluationStatistics = {
  method: 'paired-cluster-bootstrap-percentile';
  confidenceLevel: 0.95;
  bootstrapIterations: number;
  taskCount: number;
  clusterCount: number;
  repeatCount: number;
  targetCaseCount: number;
  evidenceStatus: 'sufficient' | 'insufficient';
  conclusion: 'candidate-gain-supported' | 'candidate-regression' | 'uncertain';
  baselineMean: number;
  candidateMean: number;
  meanDifference: number;
  confidence95: ConfidenceInterval;
  baselinePassRate: number;
  candidatePassRate: number;
  baselineP95LatencyMs: number;
  candidateP95LatencyMs: number;
  baselineCostUsd: number | null;
  candidateCostUsd: number | null;
  costStatus: 'known' | 'unknown';
  failureCounts: Record<'baseline' | 'candidate', Partial<Record<QualityFailureClass, number>>>;
  familyStatistics: Record<QualityFamily, FamilyStatistics>;
  familyComparisons: 'exploratory-unadjusted';
  subjectiveReviewStatus: 'not_run';
  stopReason: string | null;
};

export type QualityStatisticsOptions = {
  dataset?: FrozenQualityDataset;
  evidence?: 'fixture' | 'live-model';
  targetCaseCount?: number;
  repeatsPerTask?: number;
  minimumClustersPerFamily?: number;
  bootstrapIterations?: number;
  seed?: number;
  nonInferiorityMargin?: number;
  targetByFamily?: Partial<Record<QualityFamily, number>>;
};

const DEFAULTS = {
  targetCaseCount: 200,
  repeatsPerTask: 3,
  minimumClustersPerFamily: 5,
  bootstrapIterations: 2000,
  seed: 20261030,
  nonInferiorityMargin: 0.05
} as const;

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function assertOutcome(outcome: QualityArmOutcome, label: string): void {
  if (!finiteNonNegative(outcome.latencyMs)) throw new Error(`quality_trial_latency_invalid:${label}`);
  if (outcome.costUsd !== null && !finiteNonNegative(outcome.costUsd)) throw new Error(`quality_trial_cost_invalid:${label}`);
  if (outcome.status === 'success') {
    if (outcome.score === null || !Number.isFinite(outcome.score) || outcome.score < 0 || outcome.score > 1) {
      throw new Error(`quality_trial_score_invalid:${label}`);
    }
    if (outcome.failureClass !== undefined) throw new Error(`quality_trial_success_has_failure:${label}`);
    return;
  }
  if (outcome.status !== 'failure' || outcome.score !== null || outcome.failureClass === undefined
    || !QUALITY_FAILURE_CLASSES.includes(outcome.failureClass)) {
    throw new Error(`quality_trial_failure_unclassified:${label}`);
  }
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error('quality_statistics_empty_values');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) throw new Error('quality_statistics_empty_quantile');
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function percentileInterval(values: readonly number[]): ConfidenceInterval {
  if (values.length < 2) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return { low: quantile(sorted, 0.025), high: quantile(sorted, 0.975) };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function aggregateByCluster(
  tasks: ReadonlyMap<string, { family: QualityFamily; clusterId: string; baseline: number[]; candidate: number[] }>,
  family?: QualityFamily
): { clusterIds: string[]; baseline: number[]; candidate: number[]; differences: number[] } {
  const clusters = new Map<string, { baseline: number[]; candidate: number[] }>();
  for (const task of tasks.values()) {
    if (family !== undefined && task.family !== family) continue;
    const cluster = clusters.get(task.clusterId) ?? { baseline: [], candidate: [] };
    cluster.baseline.push(mean(task.baseline));
    cluster.candidate.push(mean(task.candidate));
    clusters.set(task.clusterId, cluster);
  }
  const entries = [...clusters.entries()].sort(([left], [right]) => left.localeCompare(right));
  const baseline = entries.map(([, values]) => mean(values.baseline));
  const candidate = entries.map(([, values]) => mean(values.candidate));
  return { clusterIds: entries.map(([clusterId]) => clusterId), baseline, candidate, differences: candidate.map((value, index) => value - baseline[index]) };
}

function bootstrapDifference(values: readonly number[], iterations: number, seed: number): ConfidenceInterval {
  if (values.length < 2) return null;
  const random = seededRandom(seed);
  const samples = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const draw = new Array<number>(values.length);
    for (let index = 0; index < values.length; index++) draw[index] = values[Math.floor(random() * values.length)];
    samples[iteration] = mean(draw);
  }
  return percentileInterval(samples);
}

function p95(values: readonly number[]): number {
  return quantile([...values].sort((left, right) => left - right), 0.95);
}

function countFailures(trials: readonly PairedQualityTrial[], arm: 'baseline' | 'candidate'): Partial<Record<QualityFailureClass, number>> {
  const counts: Partial<Record<QualityFailureClass, number>> = {};
  for (const trial of trials) {
    const outcome = trial[arm];
    if (outcome.status === 'failure' && outcome.failureClass !== undefined) {
      counts[outcome.failureClass] = (counts[outcome.failureClass] ?? 0) + 1;
    }
  }
  return counts;
}

function totalCost(trials: readonly PairedQualityTrial[], arm: 'baseline' | 'candidate'): number | null {
  const values = trials.map(trial => trial[arm].costUsd);
  return values.every((value): value is number => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function summarizePairedQualityTrials(
  trials: readonly PairedQualityTrial[],
  options: QualityStatisticsOptions = {}
): QualityEvaluationStatistics {
  if (trials.length === 0) throw new Error('quality_trials_empty');
  const targetCaseCount = options.targetCaseCount ?? DEFAULTS.targetCaseCount;
  const repeatsPerTask = options.repeatsPerTask ?? DEFAULTS.repeatsPerTask;
  const minimumClustersPerFamily = options.minimumClustersPerFamily ?? DEFAULTS.minimumClustersPerFamily;
  const bootstrapIterations = options.bootstrapIterations ?? DEFAULTS.bootstrapIterations;
  const seed = options.seed ?? DEFAULTS.seed;
  const nonInferiorityMargin = options.nonInferiorityMargin ?? DEFAULTS.nonInferiorityMargin;
  const targetByFamily = { ...QUALITY_TARGETS, ...options.targetByFamily };
  if (!Number.isSafeInteger(targetCaseCount) || targetCaseCount < 1
    || !Number.isSafeInteger(repeatsPerTask) || repeatsPerTask < 2 || repeatsPerTask > 100
    || !Number.isSafeInteger(minimumClustersPerFamily) || minimumClustersPerFamily < 2
    || !Number.isSafeInteger(bootstrapIterations) || bootstrapIterations < 100 || bootstrapIterations > 100000
    || !Number.isSafeInteger(seed) || seed < 0
    || !Number.isFinite(nonInferiorityMargin) || nonInferiorityMargin < 0 || nonInferiorityMargin > 1
    || QUALITY_FAMILIES.some(family => !Number.isSafeInteger(targetByFamily[family]) || targetByFamily[family] < 0)) {
    throw new Error('quality_statistics_options_invalid');
  }

  const tasks = new Map<string, { family: QualityFamily; clusterId: string; baseline: number[]; candidate: number[]; repeats: Set<number> }>();
  const pairKeys = new Set<string>();
  for (const [index, trial] of trials.entries()) {
    if (trial.taskId.trim().length === 0 || trial.clusterId.trim().length === 0 || !QUALITY_FAMILIES.includes(trial.family)) {
      throw new Error(`quality_trial_identity_invalid:${index}`);
    }
    if (!Number.isSafeInteger(trial.repeatIndex) || trial.repeatIndex < 0 || trial.repeatIndex >= repeatsPerTask) {
      throw new Error(`quality_trial_repeat_invalid:${trial.taskId}`);
    }
    const pairKey = `${trial.taskId}\u0000${trial.repeatIndex}`;
    if (pairKeys.has(pairKey)) throw new Error(`quality_trial_duplicate_pair:${trial.taskId}:${trial.repeatIndex}`);
    pairKeys.add(pairKey);
    assertOutcome(trial.baseline, `${trial.taskId}:baseline`);
    assertOutcome(trial.candidate, `${trial.taskId}:candidate`);
    const existing = tasks.get(trial.taskId);
    if (existing !== undefined && (existing.family !== trial.family || existing.clusterId !== trial.clusterId)) {
      throw new Error(`quality_trial_task_drift:${trial.taskId}`);
    }
    const task = existing ?? { family: trial.family, clusterId: trial.clusterId, baseline: [], candidate: [], repeats: new Set<number>() };
    task.baseline.push(trial.baseline.status === 'success' ? trial.baseline.score ?? 0 : 0);
    task.candidate.push(trial.candidate.status === 'success' ? trial.candidate.score ?? 0 : 0);
    task.repeats.add(trial.repeatIndex);
    tasks.set(trial.taskId, task);
  }
  for (const [taskId, task] of tasks) {
    if (task.repeats.size !== repeatsPerTask) throw new Error(`quality_trial_repeats_incomplete:${taskId}`);
  }

  const clusters = aggregateByCluster(tasks);
  const familyStatistics = {} as Record<QualityFamily, FamilyStatistics>;
  let anyFamilyRegression = false;
  let allFamiliesInterpretable = true;
  let allFamiliesNonInferior = true;
  for (const [familyIndex, family] of QUALITY_FAMILIES.entries()) {
    const familyTasks = new Map([...tasks].filter(([, task]) => task.family === family));
    const familyClusters = aggregateByCluster(familyTasks, family);
    const confidence95 = bootstrapDifference(familyClusters.differences, bootstrapIterations, seed + familyIndex + 1);
    const candidateRegression = confidence95 === null ? null : confidence95.high < -nonInferiorityMargin;
    if (confidence95 === null || confidence95.low < -nonInferiorityMargin) allFamiliesNonInferior = false;
    if (candidateRegression === true) anyFamilyRegression = true;
    const familyMeetsClusterMinimum = familyClusters.clusterIds.length >= minimumClustersPerFamily;
    const familyMeetsTaskTarget = familyTasks.size >= targetByFamily[family];
    if (!familyMeetsTaskTarget || !familyMeetsClusterMinimum) allFamiliesInterpretable = false;
    familyStatistics[family] = {
      tasks: familyTasks.size,
      targetTasks: targetByFamily[family],
      clusters: familyClusters.clusterIds.length,
      baselineMean: familyClusters.baseline.length === 0 ? 0 : mean(familyClusters.baseline),
      candidateMean: familyClusters.candidate.length === 0 ? 0 : mean(familyClusters.candidate),
      meanDifference: familyClusters.differences.length === 0 ? 0 : mean(familyClusters.differences),
      confidence95,
      candidateRegression
    };
  }

  const confidence95 = bootstrapDifference(clusters.differences, bootstrapIterations, seed);
  const dataset = options.dataset === undefined ? undefined : (() => {
    const { datasetHash, ...manifest } = options.dataset!;
    return freezeQualityDataset(manifest, datasetHash);
  })();
  const holdout = dataset?.tasks.filter(row => row.split === 'holdout');
  const datasetMatches = options.evidence === 'live-model' && dataset !== undefined && auditQualityDataset(dataset).fullDatasetReady
    && holdout!.length === tasks.size
    && [...tasks].every(([id, task]) => holdout!.some(row => row.id === id
      && row.family === task.family && row.clusterId === task.clusterId));
  const evidenceStatus = datasetMatches && tasks.size >= targetCaseCount && allFamiliesInterpretable ? 'sufficient' : 'insufficient';
  let conclusion: QualityEvaluationStatistics['conclusion'] = 'uncertain';
  if (evidenceStatus === 'sufficient' && confidence95 !== null) {
    if (anyFamilyRegression || confidence95.high < -nonInferiorityMargin) conclusion = 'candidate-regression';
    else if (confidence95.low > 0 && allFamiliesNonInferior) conclusion = 'candidate-gain-supported';
  }
  const baselineLatencies = trials.map(trial => trial.baseline.latencyMs);
  const candidateLatencies = trials.map(trial => trial.candidate.latencyMs);
  const baselinePasses = trials.filter(trial => trial.baseline.status === 'success' && trial.baseline.score === 1).length;
  const candidatePasses = trials.filter(trial => trial.candidate.status === 'success' && trial.candidate.score === 1).length;
  const baselineCostUsd = totalCost(trials, 'baseline');
  const candidateCostUsd = totalCost(trials, 'candidate');
  let stopReason: string | null = null;
  if (evidenceStatus === 'insufficient') {
    stopReason = !datasetMatches ? 'independent_frozen_dataset_required' : tasks.size < targetCaseCount ? 'target_case_count_not_met' : 'family_task_or_cluster_quota_not_met';
  }

  return {
    method: 'paired-cluster-bootstrap-percentile',
    confidenceLevel: 0.95,
    bootstrapIterations,
    taskCount: tasks.size,
    clusterCount: clusters.clusterIds.length,
    repeatCount: repeatsPerTask,
    targetCaseCount,
    evidenceStatus,
    conclusion,
    baselineMean: mean(clusters.baseline),
    candidateMean: mean(clusters.candidate),
    meanDifference: mean(clusters.differences),
    confidence95,
    baselinePassRate: baselinePasses / trials.length,
    candidatePassRate: candidatePasses / trials.length,
    baselineP95LatencyMs: p95(baselineLatencies),
    candidateP95LatencyMs: p95(candidateLatencies),
    baselineCostUsd,
    candidateCostUsd,
    costStatus: baselineCostUsd !== null && candidateCostUsd !== null ? 'known' : 'unknown',
    failureCounts: { baseline: countFailures(trials, 'baseline'), candidate: countFailures(trials, 'candidate') },
    familyStatistics,
    familyComparisons: 'exploratory-unadjusted',
    subjectiveReviewStatus: 'not_run',
    stopReason
  };
}
