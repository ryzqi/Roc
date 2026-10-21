import { randomUUID } from 'node:crypto';
import { contentHash } from './surface';

/** P5-04: grouped, split, frozen scenarios. Scenario payloads are synthetic research fixtures. */
export const scenarioFamilies = ['literature-search', 'evidence-extraction', 'experiment', 'citation-repair', 'export'] as const;
export type ScenarioFamily = (typeof scenarioFamilies)[number];
export type DatasetSplit = 'train' | 'dev' | 'holdout';
export type DatasetReader = 'rewriter' | 'selector' | 'holdout-evaluator';

export type OptimizerScenario = {
  id: string;
  clusterId: string;
  family: ScenarioFamily;
  split: DatasetSplit;
  seed: number;
  sourceKey: string;
  payload: { citeKey: string; draft: string; values: number[] };
};

export type OptimizerDataset = {
  schemaVersion: 1;
  seed: string;
  scenarios: OptimizerScenario[];
  splits: Record<DatasetSplit, { scenarios: number; clusters: number }>;
  frozen: string | null;
};

const CLUSTER_COUNT = 48;
const VARIANTS_PER_CLUSTER = 5;
const TRAIN_CLUSTERS = 24;
const DEV_CLUSTERS = 9;

export function buildDataset(seed = 'roc-offline-optimizer-v1'): OptimizerDataset {
  const scenarios: OptimizerScenario[] = [];
  for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) {
    const split: DatasetSplit = cluster < TRAIN_CLUSTERS ? 'train' : cluster < TRAIN_CLUSTERS + DEV_CLUSTERS ? 'dev' : 'holdout';
    const family = scenarioFamilies[cluster % scenarioFamilies.length];
    const clusterId = `paper-${String(cluster).padStart(2, '0')}`;
    const citeKey = `roc-${cluster}`;
    for (let variant = 0; variant < VARIANTS_PER_CLUSTER; variant++) {
      scenarios.push({
        id: `${clusterId}-q${variant}`,
        clusterId,
        family,
        split,
        seed: cluster * 100 + variant,
        sourceKey: `doi:10.5555/${seed}/${cluster}`,
        payload: {
          citeKey,
          draft: `\\section*{Finding ${cluster}.${variant}} Sample=${12 + variant}; result=${3.5 + cluster / 10}. \\cite{${variant === 3 ? `missing-${cluster}` : citeKey}}`,
          values: [cluster, variant, 12 + variant, 3.5 + cluster / 10]
        }
      });
    }
  }
  const dataset: OptimizerDataset = { schemaVersion: 1, seed, scenarios, splits: summarizeSplits(scenarios), frozen: null };
  return dataset;
}

export function summarizeSplits(scenarios: readonly OptimizerScenario[]): OptimizerDataset['splits'] {
  const result: OptimizerDataset['splits'] = {
    train: { scenarios: 0, clusters: 0 },
    dev: { scenarios: 0, clusters: 0 },
    holdout: { scenarios: 0, clusters: 0 }
  };
  const clusters: Record<DatasetSplit, Set<string>> = { train: new Set(), dev: new Set(), holdout: new Set() };
  for (const scenario of scenarios) {
    result[scenario.split].scenarios++;
    clusters[scenario.split].add(scenario.clusterId);
  }
  for (const split of ['train', 'dev', 'holdout'] as const) result[split].clusters = clusters[split].size;
  return result;
}

/**
 * Freezing publishes a content hash but keeps the holdout key in a private registry. Holding the
 * dataset is therefore not enough to read holdout: the evaluator needs the returned key object.
 */
const freezeSecrets = new WeakMap<OptimizerDataset, string>();

export type HoldoutKey = { datasetHash: string; secret: string };

export function freezeDataset(dataset: OptimizerDataset): { dataset: OptimizerDataset; key: HoldoutKey } {
  const frozen = contentHash({ scenarios: dataset.scenarios, splits: dataset.splits });
  const frozenDataset: OptimizerDataset = { ...dataset, frozen };
  const secret = randomUUID();
  freezeSecrets.set(frozenDataset, secret);
  return { dataset: frozenDataset, key: { datasetHash: frozen, secret } };
}

const readable: Record<DatasetReader, readonly DatasetSplit[]> = {
  rewriter: ['train', 'dev'],
  selector: ['train', 'dev'],
  'holdout-evaluator': ['train', 'dev', 'holdout']
};

/**
 * Rewriters and selectors never see holdout scenarios. Only a frozen dataset is readable through
 * the holdout-evaluator path, and only when the caller presents the matching freeze token.
 */
export function readSplit(
  dataset: OptimizerDataset,
  split: DatasetSplit,
  reader: DatasetReader,
  key?: HoldoutKey
): OptimizerScenario[] {
  if (!readable[reader].includes(split)) throw new Error(`optimizer_holdout_protected:${reader}:${split}`);
  if (split === 'holdout') {
    const secret = freezeSecrets.get(dataset);
    if (dataset.frozen === null || secret === undefined) throw new Error('optimizer_holdout_not_frozen');
    // Re-derive the hash so a caller cannot freeze, then quietly edit scenarios and keep the key.
    const current = contentHash({ scenarios: dataset.scenarios, splits: dataset.splits });
    if (current !== dataset.frozen) throw new Error('optimizer_holdout_mutated');
    if (key === undefined || key.datasetHash !== dataset.frozen || key.secret !== secret) {
      throw new Error('optimizer_holdout_key_mismatch');
    }
  }
  const scenarios = dataset.scenarios.filter(scenario => scenario.split === split);
  if (scenarios.length === 0) throw new Error(`optimizer_split_empty:${split}`);
  return scenarios;
}

export function verifyDatasetShape(dataset: OptimizerDataset): Record<string, unknown> {
  const ids = new Set<string>();
  const clusterSplit = new Map<string, DatasetSplit>();
  for (const scenario of dataset.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`optimizer_dataset_duplicate:${scenario.id}`);
    ids.add(scenario.id);
    const existing = clusterSplit.get(scenario.clusterId);
    if (existing !== undefined && existing !== scenario.split) throw new Error(`optimizer_dataset_cluster_split:${scenario.clusterId}`);
    clusterSplit.set(scenario.clusterId, scenario.split);
  }
  const splits = summarizeSplits(dataset.scenarios);
  if (dataset.scenarios.length < 200) throw new Error(`optimizer_dataset_too_small:${dataset.scenarios.length}`);
  if (splits.holdout.scenarios < 60) throw new Error(`optimizer_holdout_too_small:${splits.holdout.scenarios}`);
  if (splits.train.scenarios === 0 || splits.dev.scenarios === 0) throw new Error('optimizer_split_missing');
  for (const scenario of dataset.scenarios) {
    if (!scenarioFamilies.includes(scenario.family)) throw new Error(`optimizer_dataset_family:${scenario.id}`);
  }
  return { scenarios: dataset.scenarios.length, clusters: clusterSplit.size, splits };
}

export type PairedObservation = {
  scenarioId: string;
  clusterId: string;
  base: number | null;
  candidate: number | null;
  baseDurationMs?: number;
  candidateDurationMs?: number;
};

export type PairedSummary = {
  scenarios: number;
  clusters: number;
  failuresIncluded: true;
  intervalMethod: 'cluster-bootstrap-percentile';
  baseDurationMs: number;
  candidateDurationMs: number;
  durationRatio: number;
  baseMean: number;
  candidateMean: number;
  meanDifference: number;
  ciLow: number;
  ciHigh: number;
  basePassRate: number;
  candidatePassRate: number;
  basePassRateInterval: Interval;
  candidatePassRateInterval: Interval;
  deltaPassRate: number;
};

export type Interval = { low: number; high: number };

/** Null means the candidate produced no artifact or the verifier refused it: counted as failure. */
function score(value: number | null): number {
  return value === null ? 0 : value;
}

export function wilsonInterval(successes: number, total: number, z = 1.959964): Interval {
  if (total <= 0) throw new Error('optimizer_interval_invalid');
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { low: Math.max(0, (centre - spread) / denominator), high: Math.min(1, (centre + spread) / denominator) };
}

/** Deterministic LCG so a report can be replayed exactly from its seed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function quantile(sorted: readonly number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/**
 * Pairing is per scenario, but resampling is per cluster: five variants of one paper are not five
 * independent observations. Failures stay in the denominator.
 */
export function pairedClusterSummary(observations: readonly PairedObservation[], options: { iterations?: number; seed?: number } = {}): PairedSummary {
  if (observations.length === 0) throw new Error('optimizer_pairs_empty');
  const sorted = [...observations].sort((left, right) => (left.scenarioId < right.scenarioId ? -1 : left.scenarioId > right.scenarioId ? 1 : 0));
  const clusters = new Map<string, number[]>();
  for (const observation of sorted) {
    const list = clusters.get(observation.clusterId) ?? [];
    list.push(score(observation.candidate) - score(observation.base));
    clusters.set(observation.clusterId, list);
  }
  const clusterMeans = [...clusters.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([, values]) => mean(values));
  const iterations = options.iterations ?? 2000;
  const random = lcg(options.seed ?? 20261021);
  const sampled: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const draw: number[] = [];
    for (let index = 0; index < clusterMeans.length; index++) {
      draw.push(clusterMeans[Math.floor(random() * clusterMeans.length)]);
    }
    sampled.push(mean(draw));
  }
  sampled.sort((left, right) => left - right);
  const baseValues = sorted.map(observation => score(observation.base));
  const candidateValues = sorted.map(observation => score(observation.candidate));
  const basePass = baseValues.filter(value => value >= 1).length;
  const candidatePass = candidateValues.filter(value => value >= 1).length;
  const baseDurationMs = sorted.reduce((total, observation) => total + (observation.baseDurationMs ?? 0), 0);
  const candidateDurationMs = sorted.reduce((total, observation) => total + (observation.candidateDurationMs ?? 0), 0);
  return {
    scenarios: sorted.length,
    clusters: clusters.size,
    failuresIncluded: true,
    intervalMethod: 'cluster-bootstrap-percentile',
    baseDurationMs,
    candidateDurationMs,
    durationRatio: baseDurationMs === 0 ? 1 : candidateDurationMs / baseDurationMs,
    baseMean: mean(baseValues),
    candidateMean: mean(candidateValues),
    meanDifference: mean(candidateValues) - mean(baseValues),
    ciLow: quantile(sampled, 0.025),
    ciHigh: quantile(sampled, 0.975),
    basePassRate: basePass / sorted.length,
    candidatePassRate: candidatePass / sorted.length,
    basePassRateInterval: wilsonInterval(basePass, sorted.length),
    candidatePassRateInterval: wilsonInterval(candidatePass, sorted.length),
    deltaPassRate: (candidatePass - basePass) / sorted.length
  };
}

export type AblationReport = { id: string; summary: PairedSummary };

export function ablationReport(
  id: string,
  base: readonly PairedObservation[],
  variants: readonly { id: string; observations: readonly PairedObservation[] }[]
): AblationReport[] {
  return [
    { id: `${id}:full`, summary: pairedClusterSummary(base) },
    ...variants.map(variant => ({ id: `${id}:${variant.id}`, summary: pairedClusterSummary(variant.observations) }))
  ];
}
