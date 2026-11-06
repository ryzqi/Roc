import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { QUALITY_FAMILIES, agentTaskViewSchema, qualityHash, deepFreeze, type AgentTaskView, type QualityFamily } from './agent-task-view';
export * from './agent-task-view';

export const QUALITY_TARGETS = Object.freeze({
  'literature-verification': 30, 'multi-paper-evidence': 30, 'long-memory': 25,
  'file-report': 30, 'experiment-script': 25, 'mcp-recovery': 20,
  'permission-injection': 20, 'cancel-crash': 20
});
const text = z.string().trim().min(1).max(65536);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const fact = z.union([z.string(), z.number().finite(), z.boolean()]);
export const qualityValidatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('paper-facts'), studies: z.array(z.strictObject({
    doi: text, facts: z.record(text, fact), tolerance: z.number().nonnegative().optional()
  })).min(1) }),
  z.strictObject({ kind: z.literal('memory'), requiredPhrases: z.array(text).min(1), forbiddenPhrases: z.array(text), citations: z.array(text) }),
  z.strictObject({ kind: z.literal('csv-report'), filename: text, rows: z.array(text).min(1) }),
  z.strictObject({ kind: z.literal('experiment-script'), functionName: text, operation: z.enum(['mean', 'sum']),
    inputValues: z.record(text, z.array(z.number().finite()).min(1)), requiredMethods: z.array(text),
    expectedValues: z.record(text, z.number().finite()), tolerance: z.number().nonnegative() }),
  z.strictObject({ kind: z.literal('mcp-recovery'), expectedStatus: z.literal('completed'),
    expectedEvents: z.array(text), expectedExternalEffects: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('permission-boundary'), blockedAction: text, expectedExecutedActions: z.array(text) }),
  z.strictObject({ kind: z.literal('cancel-crash-recovery'), expectedStatus: z.enum(['unknown', 'completed']),
    reconciliationRequired: z.boolean(), retryDispatched: z.literal(false), duplicateEffects: z.literal(0) })
]);
const reviewSchema = z.strictObject({
  status: z.enum(['fixture', 'pending', 'reviewed', 'adjudicated']),
  reviewers: z.array(identifier), independent: z.boolean(), annotationRef: text.nullable(),
  annotationHash: hash.nullable(), reviewedAt: z.iso.datetime().nullable(),
  disagreement: z.boolean(), arbitrationRef: text.nullable(), arbitrationHash: hash.nullable()
});
export const qualityDatasetManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), id: identifier, version: text,
  evidence: z.enum(['fixture', 'independent']), frozenAt: z.iso.datetime(),
  preregistration: z.strictObject({ id: identifier, registeredAt: z.iso.datetime(),
    clusterSplits: z.record(identifier, z.enum(['fixture', 'train', 'dev', 'holdout'])) }),
  sources: z.array(z.strictObject({ id: identifier, clusterId: identifier, origin: z.enum(['real', 'synthetic']),
    license: text, attribution: text, locator: text, contentHash: hash,
    permission: z.enum(['fixture-only', 'evaluation-approved', 'pending']) })),
  tasks: z.array(agentTaskViewSchema.extend({
    clusterId: identifier, split: z.enum(['fixture', 'train', 'dev', 'holdout']),
    sourceIds: z.array(identifier).min(1), provenance: z.enum(['real', 'synthetic']),
    inputHash: hash, review: reviewSchema,
    expectedRef: text, expectedHash: hash
  })).min(1).max(10000)
});
export type QualityFact = z.infer<typeof fact>;
export type QualityValidator = z.infer<typeof qualityValidatorSchema>;
export type QualityTask = z.infer<typeof qualityDatasetManifestSchema>['tasks'][number];
export type FrozenQualityDataset = z.infer<typeof qualityDatasetManifestSchema> & { datasetHash: string };
export type QualityExpectations = Readonly<Record<string, QualityValidator>>;

export function toAgentTaskView(task: QualityTask): AgentTaskView {
  return deepFreeze(agentTaskViewSchema.parse({
    id: task.id, family: task.family, difficulty: task.difficulty, prompt: task.prompt,
    ...(task.conversationTurns === undefined ? {} : { conversationTurns: task.conversationTurns }),
    outputFormat: task.outputFormat
  }));
}
export function freezeQualityDataset(value: unknown, expectedHash: string): FrozenQualityDataset {
  const manifest = qualityDatasetManifestSchema.parse(value);
  if (qualityHash(manifest) !== expectedHash) throw new Error('quality_dataset_hash_changed');
  const sourceIds = new Set<string>();
  const taskIds = new Set<string>();
  const clusters = new Map<string, string>();
  const sourceClusters = new Map<string, string>();
  for (const source of manifest.sources) {
    if (sourceIds.has(source.id)) throw new Error('quality_dataset_duplicate_source');
    sourceIds.add(source.id);
    if (manifest.evidence === 'independent') {
      for (const identity of [source.contentHash, source.locator]) {
        if (sourceClusters.has(identity) && sourceClusters.get(identity) !== source.clusterId) {
          throw new Error('quality_dataset_source_reclustered');
        }
        sourceClusters.set(identity, source.clusterId);
      }
    }
    if (manifest.preregistration.clusterSplits[source.clusterId] === undefined) throw new Error('quality_dataset_cluster_unregistered');
  }
  for (const task of manifest.tasks) {
    if (taskIds.has(task.id)) throw new Error('quality_dataset_duplicate_task');
    taskIds.add(task.id);
    if (qualityHash(toAgentTaskView(task)) !== task.inputHash) throw new Error('quality_dataset_input_changed');
    const sources = task.sourceIds.map(id => manifest.sources.find(source => source.id === id));
    if (sources.some(source => source === undefined || source.clusterId !== task.clusterId)) {
      throw new Error('quality_dataset_source_cluster_invalid');
    }
    // Multi-source tasks must share one connected source cluster, never cross train/dev/holdout.
    for (const cluster of [task.clusterId, ...sources.map(source => source!.clusterId)]) {
      if (clusters.has(cluster) && clusters.get(cluster) !== task.split) throw new Error('quality_dataset_split_leakage');
      clusters.set(cluster, task.split);
      if (manifest.preregistration.clusterSplits[cluster] !== task.split) throw new Error('quality_dataset_split_unregistered');
    }
    if (manifest.evidence === 'fixture' && (task.split !== 'fixture' || task.review.status !== 'fixture')) {
      throw new Error('quality_dataset_fixture_mislabeled');
    }
    if (manifest.evidence === 'independent' && (task.split === 'fixture'
      || sources.some(source => source!.permission !== 'evaluation-approved')
      || !['reviewed', 'adjudicated'].includes(task.review.status) || task.review.reviewers.length !== 2
      || new Set(task.review.reviewers).size !== 2 || !task.review.independent
      || task.review.annotationRef === null || task.review.annotationHash === null || task.review.reviewedAt === null
      || (task.review.disagreement && (task.review.status !== 'adjudicated'
        || task.review.arbitrationRef === null || task.review.arbitrationHash === null))
      || Date.parse(manifest.preregistration.registeredAt) >= Date.parse(task.review.reviewedAt!)
      || Date.parse(task.review.reviewedAt!) > Date.parse(manifest.frozenAt))) {
      throw new Error('quality_dataset_license_or_review_incomplete');
    }
    if (manifest.evidence === 'independent' && ['literature-verification', 'multi-paper-evidence'].includes(task.family)
      && (task.provenance !== 'real' || sources.some(source => source!.origin !== 'real'))) {
      throw new Error('quality_dataset_scientific_source_synthetic');
    }
  }
  return deepFreeze({ ...manifest, datasetHash: expectedHash });
}
export function loadQualityDataset(manifestPath: string, expectedHash: string): FrozenQualityDataset {
  return freezeQualityDataset(JSON.parse(readFileSync(manifestPath, 'utf8')), expectedHash);
}
/** Evaluator-only loader. The agent worker must never receive this directory or these refs. */
export function loadQualityExpectations(dataset: FrozenQualityDataset, root: string): QualityExpectations {
  const canonicalRoot = realpathSync(root);
  const expectations: Record<string, QualityValidator> = {};
  function loadHidden(ref: string, expectedHash: string): unknown {
    const path = realpathSync(resolve(canonicalRoot, ref));
    const child = relative(canonicalRoot, path);
    if (child === '..' || child.startsWith('../') || isAbsolute(child)) throw new Error('quality_expected_path_outside');
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (qualityHash(value) !== expectedHash) throw new Error('quality_expected_hash_changed');
    return value;
  }
  for (const task of dataset.tasks) {
    const value = loadHidden(task.expectedRef, task.expectedHash);
    expectations[task.id] = qualityValidatorSchema.parse(value);
    if (dataset.evidence === 'independent') {
      loadHidden(task.review.annotationRef!, task.review.annotationHash!);
      if (task.review.disagreement) loadHidden(task.review.arbitrationRef!, task.review.arbitrationHash!);
    }
  }
  return deepFreeze(expectations);
}
export function loadQualityDatasetPackage(manifestPath: string, expectedHash: string) {
  const dataset = loadQualityDataset(manifestPath, expectedHash);
  return { dataset, expectations: loadQualityExpectations(dataset, dirname(manifestPath)) };
}
export function auditQualityDataset(dataset: FrozenQualityDataset) {
  const byFamily = Object.fromEntries(QUALITY_FAMILIES.map(family => {
    const tasks = dataset.tasks.filter(task => task.family === family && task.split === 'holdout');
    return [family, { tasks: tasks.length, target: QUALITY_TARGETS[family],
      clusters: new Set(tasks.map(task => task.clusterId)).size }];
  })) as Record<QualityFamily, { tasks: number; target: number; clusters: number }>;
  const fullDatasetReady = dataset.evidence === 'independent'
    && Object.values(byFamily).every(row => row.tasks >= row.target && row.clusters >= 5);
  return { id: dataset.id, version: dataset.version, datasetHash: dataset.datasetHash,
    evidence: dataset.evidence, tasks: dataset.tasks.length, byFamily,
    splits: [...new Set(dataset.tasks.map(task => task.split))], fullDatasetReady,
    scientificStatus: fullDatasetReady ? 'data-ready; live-run-and-blind-review-required' : 'insufficient' };
}
