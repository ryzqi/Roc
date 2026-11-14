import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fail, fileInventory, hash, readJson, sha256 } from './common.mjs';
import { mean, quantile, resourceNames, resourceValues, summarizeDiagnostics, summarizeResources, trialTracePointers } from './analysis.mjs';
import { hasQasperQualityProvenance } from './data.mjs';

export const text = z.string().trim().min(1).max(8000);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const changePath = z.string().regex(/^(src|resources)\//)
  .refine(path => !/[\\\r\n]/.test(path) && !path.split('/').some(part => ['', '.', '..'].includes(part)));
const score = z.number().min(0).max(1);
const resourcesSchema = z.strictObject(Object.fromEntries(resourceNames.map(name => [name, z.number().nonnegative().optional()])));
export const acceptanceSchema = z.strictObject({
  nonInferiorityMargin: z.number().min(0).max(.05),
  absoluteFloors: z.record(text, score), trialFloors: z.record(text, score),
  absoluteCeilings: z.record(text, score).optional(),
  primaryMetrics: z.array(text).min(1).refine(names => new Set(names).size === names.length).optional(),
  multiplicity: z.enum(['fixed-sequence', 'bonferroni']).optional(),
  metricDirections: z.record(text, z.enum(['higher-is-better', 'lower-is-better'])).optional(),
  minimumClusters: z.number().int().min(5).optional(), minimumRepeats: z.number().int().min(3).optional(),
  resourceCeilings: resourcesSchema.optional(), maxResourceDegradation: resourcesSchema.optional()
}).refine(value => !value.primaryMetrics || value.primaryMetrics.length === 1 || Boolean(value.multiplicity),
  { message: 'multiple_primary_metrics_require_multiplicity' });
export const experimentSpecFields = {
  schemaVersion: z.literal(1), title: text, hypothesis: text,
  incidents: z.array(text).min(1), allowedChanges: z.array(changePath),
  acceptance: acceptanceSchema
};

export function validateAcceptance(spec, metrics) {
  acceptanceSchema.parse(spec.acceptance);
  if (!metrics.length || new Set(metrics).size !== metrics.length
    || hash(Object.keys(spec.acceptance.absoluteFloors).sort()) !== hash([...metrics].sort())) {
    fail('policy', 'absolute_floors_must_cover_all_metrics');
  }
  if (Object.keys(spec.acceptance.trialFloors).some(metric => !metrics.includes(metric))) fail('policy', 'unknown_trial_floor_metric');
  for (const metric of [...(spec.acceptance.primaryMetrics ?? []),
    ...Object.keys(spec.acceptance.metricDirections ?? {}), ...Object.keys(spec.acceptance.absoluteCeilings ?? {})]) {
    if (!metrics.includes(metric)) fail('policy', 'unknown_acceptance_metric');
  }
  for (const [metric, direction] of Object.entries(spec.acceptance.metricDirections ?? {})) {
    if (direction === 'lower-is-better' && spec.acceptance.absoluteCeilings?.[metric] === undefined) {
      fail('policy', 'lower_metric_requires_absolute_ceiling');
    }
  }
  for (const [metric, maximum] of Object.entries(spec.acceptance.absoluteCeilings ?? {})) {
    if (maximum < spec.acceptance.absoluteFloors[metric]) fail('policy', 'quality_floor_exceeds_ceiling');
  }
}

// Local hash records detect drift. They do not authenticate a malicious operator.
export function writeProtocolRecord(path, kind, value) {
  const payload = { schemaVersion: 1, kind, ...value }, record = { ...payload, recordHash: hash(payload) };
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(record, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  return record;
}
export function readProtocolRecord(path, kind) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail('state', 'experiment_record_not_regular');
  const record = readJson(path), { recordHash, ...payload } = record;
  if (record.kind !== kind || record.schemaVersion !== 1 || hash(payload) !== recordHash) fail('state', 'experiment_record_changed');
  return record;
}
export function readComparisonProtocol(reference) {
  const path = typeof reference === 'string' ? reference : reference?.path ?? reference?.directory;
  if (typeof path !== 'string') fail('policy', 'comparison_protocol_reference_required');
  const directory = realpathSync(path), protocol = readProtocolRecord(join(directory, 'protocol.json'), 'protocol');
  if (reference?.protocolHash && reference.protocolHash !== protocol.recordHash) fail('state', 'experiment_protocol_changed');
  return { path: directory, protocol };
}
export function assertSealedRun(run) {
  if (typeof run.path !== 'string' || !digest.safeParse(run.sealHash).success) fail('state', 'comparison_sealed_run_required');
  const sealPath = join(run.path, 'seal.json'), seal = readJson(sealPath);
  const actual = fileInventory(run.path).filter(file => file.path !== 'seal.json');
  if (hash(actual) !== seal.sha256 || hash(seal.inventory) !== seal.sha256
    || sha256(readFileSync(sealPath)) !== run.sealHash
    || hash(readJson(join(run.path, 'manifest.json'))) !== hash(run.manifest)
    || hash(readJson(join(run.path, 'trials.json'))) !== hash(run.trials)
    || hash(readJson(join(run.path, 'summary.json'))) !== hash(run.summary)) fail('state', 'run_evidence_changed');
}
export function inspectProtocolRun(ref) {
  const path = realpathSync(ref.path);
  const run = { path, sealHash: sha256(readFileSync(join(path, 'seal.json'))),
    manifest: readJson(join(path, 'manifest.json')), summary: readJson(join(path, 'summary.json')),
    trials: readJson(join(path, 'trials.json')) };
  assertSealedRun(run);
  if (ref.sealHash !== run.sealHash) fail('state', 'experiment_run_seal_changed');
  return run;
}
export function preExecutionEvidence(runPath) {
  // The runner claims immediately after creating its local run journal. A run
  // with task directories, manifests, model requests or results cannot be bound.
  const names = readdirSync(runPath);
  if (names.some(name => name !== 'events.jsonl')) fail('policy', 'experiment_requires_fresh_run');
  const files = fileInventory(runPath);
  for (const file of files) {
    const events = readFileSync(join(runPath, file.path), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    if (events.some(event => event.type !== 'run_started')) fail('policy', 'experiment_execution_already_started');
  }
  return { version: 1, executionAbsent: true, files };
}
export function assertPreExecutionClaim(claim, run) {
  const proof = claim.preExecution;
  if (proof?.version !== 1 || proof.executionAbsent !== true || !Array.isArray(proof.files)
    || proof.files.length > 1 || proof.files.some(file => file.path !== 'events.jsonl'
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !digest.safeParse(file.sha256).success)) {
    fail('policy', 'experiment_preregistration_missing');
  }
  for (const file of proof.files) {
    const bytes = readFileSync(join(run.path, file.path));
    if (bytes.length < file.bytes || sha256(bytes.subarray(0, file.bytes)) !== file.sha256) {
      fail('state', 'experiment_preexecution_evidence_changed');
    }
    const events = bytes.subarray(0, file.bytes).toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    if (events.some(event => event.type !== 'run_started')) fail('policy', 'experiment_execution_already_started');
  }
}

export const comparisonFields = ['suite', 'evidence', 'datasetIdentity', 'selection', 'repeats', 'metrics', 'metricsHash', 'taskSchemaHash', 'scorerHash',
  'provider', 'environment', 'executionPolicy', 'split', 'toolManifest', 'applicationContract', 'retrievalConfig', 'retrievalProvider', 'permissions',
  'ragContract', 'datasetReview', 'datasetProvenance', 'qasperQualification', 'budget', 'graderContract', 'metricContract', 'taskContract',
  'profile', 'adapter', 'finalAnswerContract', 'responseContract'];
export function validToolManifest(manifest) {
  return Array.isArray(manifest?.tools) && manifest.tools.length > 0
    && manifest.tools.every(tool => tool && typeof tool === 'object' && text.safeParse(tool.modelVisibleName).success)
    && new Set(manifest.tools.map(tool => tool.modelVisibleName)).size === manifest.tools.length;
}
export function hasApplicationRuntimeEvidence(run) {
  const contract = run.manifest.applicationContract;
  const supportedVersion = contract?.schemaVersion === 1 || (contract?.schemaVersion === 2
    && contract.responseRequirements === 'optional-json-schema-bound-to-frozen-task-inputs');
  return supportedVersion && typeof contract.answerBoundary === 'string' && run.trials.length > 0
    && run.trials.every(t => t.runtimeVerification?.status === 'verified' && t.runtimeVerification.contractHash === hash(contract)
      && /^[a-f0-9]{64}$/.test(t.runtimeVerification.finalAnswerHash ?? '')
      && /^[a-f0-9]{64}$/.test(t.runtimeVerification.evidenceHash ?? ''));
}
export function hasRagRuntimeEvidence(run) {
  const contract = run.manifest.ragContract;
  if (!contract || contract.version !== 1 || !digest.safeParse(contract.hash).success) return false;
  const { hash: contractHash, ...descriptor } = contract;
  const boundary = run.manifest.suite === 'rag-retrieval'
    ? 'host-component-request-bound-to-capability-receipt-v1'
    : run.manifest.suite === 'rag-paper-qa' ? 'checkpoint-tool-message-bound-to-host-capability-receipt-v1' : null;
  return hash(descriptor) === contractHash && descriptor.runtime === 'roc-research-repository-embedding-service'
    && descriptor.sourceMapping === 'source-version-sha256-parser-utf16-v1'
    && boundary !== null && descriptor.toolBoundary === boundary
    && descriptor.verification === 'sqlite-source-ranking-context-transport-v1' && run.trials.length > 0
    && run.trials.every(trial => trial.ragVerification?.status === 'verified'
      && trial.ragVerification.contractHash === contractHash && digest.safeParse(trial.ragVerification.evidenceHash).success);
}
export function hasReviewedRetrievalProvenance(manifest) {
  const review = manifest.datasetReview;
  if (manifest.datasetProvenance?.kind !== 'human_reviewed' || manifest.datasetProvenance?.review?.draft !== 0
    || review?.schemaVersion !== 1 || review.status !== 'reviewed' || !text.safeParse(review.producer).success
    || !Array.isArray(review.tasks) || !review.tasks.length) return false;
  const byId = new Map();
  const identity = name => typeof name === 'string' ? name.normalize('NFKC').trim().toLowerCase() : null;
  const validAttestation = (attestation, contentHash) => text.safeParse(attestation?.reviewer).success
    && identity(attestation.reviewer) !== identity(review.producer) && attestation.contentHash === contentHash
    && z.iso.datetime().safeParse(attestation.reviewedAt).success;
  for (const task of review.tasks) {
    if (!task || !text.safeParse(task.id).success || byId.has(task.id) || !digest.safeParse(task.contentHash).success
      || !Array.isArray(task.annotations) || task.annotations.length < 2) return false;
    const reviewers = new Set(task.annotations.map(annotation => identity(annotation?.reviewer)));
    if (reviewers.size !== task.annotations.length || task.annotations.some(annotation =>
      !validAttestation(annotation, task.contentHash) || !digest.safeParse(annotation.judgmentHash).success)) return false;
    if (new Set(task.annotations.map(annotation => annotation.judgmentHash)).size > 1) {
      if (!validAttestation(task.arbitration, task.contentHash) || reviewers.has(identity(task.arbitration.reviewer))
        || !text.safeParse(task.arbitration.resolution).success) return false;
    } else if (task.arbitration && (!validAttestation(task.arbitration, task.contentHash)
      || reviewers.has(identity(task.arbitration.reviewer)) || !text.safeParse(task.arbitration.resolution).success)) return false;
    byId.set(task.id, task);
  }
  return Array.isArray(manifest.selection) && manifest.selection.length > 0 && manifest.selection.every(task => task
    && byId.has(task.id) && digest.safeParse(task.contentHash).success && task.contentHash === byId.get(task.id).contentHash);
}
export function metricState(trial, name) {
  if (!trial || typeof trial !== 'object') return 'invalid';
  const declaration = trial.metricApplicability;
  if (declaration !== undefined && (!declaration || typeof declaration !== 'object' || Array.isArray(declaration))) return 'invalid';
  const applicability = declaration && Object.hasOwn(declaration, name) ? declaration[name] : 'measured';
  const value = trial.metrics?.[name];
  if (applicability === 'not_applicable') return value === null ? 'not_applicable' : 'invalid';
  return applicability === 'measured' && Number.isFinite(value) && value >= 0 && value <= 1 ? 'measured' : 'invalid';
}
export function validMetrics(trial, names) {
  return Boolean(trial && trial.metrics && typeof trial.metrics === 'object' && !Array.isArray(trial.metrics)
    && (trial.metricApplicability === undefined || (trial.metricApplicability && typeof trial.metricApplicability === 'object'
      && !Array.isArray(trial.metricApplicability) && Object.keys(trial.metricApplicability).every(name => names.includes(name))))
    && names.every(name => metricState(trial, name) !== 'invalid'));
}
export function hasRagSourceBoundaryEvidence(run) {
  return run.trials.length > 0 && run.trials.every(trial => ['wrongSourceRate', 'staleHitRate'].every(metric =>
    metricState(trial, metric) === 'measured' && trial.metrics[metric] === 0));
}
export function comparisonEvidence(baseline, candidate, { allowedFields = [], schemaHashes = null } = {}) {
  const a = baseline.manifest, b = candidate.manifest;
  const mismatches = comparisonFields.filter(key => !allowedFields.includes(key) && hash(a[key] ?? null) !== hash(b[key] ?? null));
  if (mismatches.length) return { rejection: { conclusion: 'incompatible', mismatches } };
  if ([baseline, candidate].some(run => run.summary.status !== 'complete')) return { rejection: { conclusion: 'incomplete' } };
  if (baseline.sealHash && baseline.sealHash === candidate.sealHash) {
    return { rejection: { conclusion: 'insufficient', reason: 'same_run_is_not_independent_evidence' } };
  }
  if (['qasper', 'scienceagentbench', 'rag-paper-qa'].includes(a.suite)
    && ![baseline, candidate].every(hasApplicationRuntimeEvidence)) {
    return { rejection: { conclusion: 'insufficient', reason: 'application_runtime_evidence_missing' } };
  }
  if (['rag-paper-qa', 'rag-retrieval'].includes(a.suite) && ![baseline, candidate].every(hasRagRuntimeEvidence)) {
    return { rejection: { conclusion: 'insufficient', reason: 'rag_runtime_evidence_missing' } };
  }
  if (['rag-paper-qa', 'rag-retrieval'].includes(a.suite) && ![baseline, candidate].every(hasRagSourceBoundaryEvidence)) {
    return { rejection: { conclusion: 'insufficient', reason: 'rag_source_boundary_evidence_missing_or_violated' } };
  }
  if (!Array.isArray(a.selection) || !a.selection.length || !Number.isSafeInteger(a.repeats) || a.repeats < 1
    || new Set(a.selection.map(task => task.id)).size !== a.selection.length
    || a.selection.some(task => !text.safeParse(task.id).success || !text.safeParse(task.clusterId).success)
    || !Array.isArray(a.metrics) || !a.metrics.length || new Set(a.metrics).size !== a.metrics.length) {
    fail('state', 'comparison_selection_invalid');
  }
  const expectedKeys = a.selection.flatMap(task => Array.from({ length: a.repeats }, (_, repeat) => JSON.stringify([task.id, repeat])));
  const clusterById = new Map(a.selection.map(task => [task.id, task.clusterId]));
  const index = run => {
    const result = new Map(run.trials.map(trial => [JSON.stringify([trial.taskId, trial.repeat]), trial]));
    if (result.size !== expectedKeys.length || run.trials.length !== result.size || expectedKeys.some(key => !result.has(key))) {
      fail('state', 'comparison_trial_set_invalid');
    }
    for (const trial of result.values()) {
      if (!validMetrics(trial, a.metrics)) fail('state', 'comparison_metric_invalid');
      if (trial.clusterId !== clusterById.get(trial.taskId)) fail('state', 'comparison_cluster_invalid');
    }
    return result;
  };
  const left = index(baseline), right = index(candidate);
  if ([...left.values(), ...right.values()].some(trial => trial.status === 'invalid'
    || (trial.failureClass && trial.failureClass !== 'agent'))) return { rejection: { conclusion: 'incomplete' } };
  const applicabilityByTask = new Map();
  for (const task of a.selection) {
    const states = {};
    for (const metric of a.metrics) {
      const byArm = [left, right].map(trials => Array.from({ length: a.repeats }, (_, repeat) =>
        metricState(trials.get(JSON.stringify([task.id, repeat])), metric)));
      if (byArm.some(values => new Set(values).size !== 1)) {
        return { rejection: { conclusion: 'incompatible', mismatches: ['metricApplicability'],
          reason: 'metric_applicability_changed_within_task', taskId: task.id, metric } };
      }
      if (byArm[0][0] !== byArm[1][0]) {
        return { rejection: { conclusion: 'incompatible', mismatches: ['metricApplicability'],
          reason: 'metric_applicability_mismatch', taskId: task.id, metric,
          applicability: { baseline: byArm[0][0], candidate: byArm[1][0] } } };
      }
      states[metric] = byArm[0][0];
    }
    applicabilityByTask.set(task.id, states);
  }
  // Matching omissions still do not establish a fixed tool contract.
  if (!validToolManifest(a.toolManifest) || !validToolManifest(b.toolManifest) || [baseline, candidate].some(run =>
    run.trials.some(trial => !digest.safeParse(trial.toolSchemaHash).success))) {
    return { rejection: { conclusion: 'insufficient', reason: 'tool_contract_evidence_missing' } };
  }
  const schemas = [baseline, candidate].map(run => new Set(run.trials.map(trial => trial.toolSchemaHash)));
  if (schemas.some(set => set.size !== 1)) {
    return { rejection: { conclusion: 'incompatible', mismatches: ['toolSchemaHash'], reason: 'tool_schema_changed_within_run' } };
  }
  if (schemaHashes) {
    if ([baseline, candidate].some((run, i) => run.trials[0].toolSchemaHash !== schemaHashes[i])) {
      return { rejection: { conclusion: 'incompatible', mismatches: ['toolSchemaHash'], reason: 'undeclared_tool_schema' } };
    }
  } else if (baseline.trials[0].toolSchemaHash !== candidate.trials[0].toolSchemaHash) {
    return { rejection: { conclusion: 'incompatible', mismatches: ['toolSchemaHash'] } };
  }
  const groups = [...new Set(a.selection.map(task => task.clusterId))];
  const reviewedRag = [a, b].every(hasReviewedRetrievalProvenance);
  // Science currently imports only operator-prepared local recipes. Neither a
  // revision string nor self-declared review authenticates upstream data/assets
  // or the official task environment. This also covers unchanged legacy runs.
  const localScience = a.suite === 'scienceagentbench';
  const qualifiedQasper = a.suite !== 'qasper' || [a, b].every(hasQasperQualityProvenance);
  const qualityEvidence = a.suite === 'rag-retrieval'
    ? ['production-component', 'human-reviewed-retrieval'].includes(a.evidence) && reviewedRag
    : a.evidence === 'live-model' && !localScience && qualifiedQasper && (a.suite !== 'rag-paper-qa' || reviewedRag);
  const sufficient = qualityEvidence && a.repeats >= 3 && groups.length >= 5;
  return { baseline, candidate, left, right, groups, sufficient, qualityEvidence, applicabilityByTask,
    ...(localScience ? { qualityEvidenceReason: 'science_quality_provenance_unverified' }
      : !qualifiedQasper ? { qualityEvidenceReason: 'qasper_quality_provenance_unverified' } : {}) };
}

export function assertFixedProtocol(context, baseline, candidate) {
  const { path, protocol } = context;
  if (protocol.spec.kind === 'ablation') fail('policy', 'fixed_comparison_requires_fixed_protocol');
  validateAcceptance(protocol.spec, baseline.manifest.metrics);
  assertSealedRun(baseline); assertSealedRun(candidate);
  const claim = readProtocolRecord(join(path, 'candidate.json'), 'candidate');
  if (protocol.baseline?.path !== realpathSync(baseline.path) || protocol.baseline?.sealHash !== baseline.sealHash
    || claim.protocolHash !== protocol.recordHash || claim.path !== realpathSync(candidate.path)
    || candidate.manifest.experiment?.path !== path || candidate.manifest.experiment?.protocolHash !== protocol.recordHash
    || candidate.manifest.source?.sourceHash !== protocol.candidateSource.sourceHash) fail('state', 'experiment_candidate_binding_changed');
  if (protocol.comparisonProtocolVersion === 1 || protocol.spec.acceptance.primaryMetrics?.length) {
    if (protocol.comparisonProtocolVersion !== 1 || claim.claimVersion !== 1 || claim.arm !== 'candidate'
      || candidate.manifest.experiment.arm !== 'candidate') fail('policy', 'experiment_preregistration_missing');
    const expected = Object.fromEntries(comparisonFields.map(key => [key, baseline.manifest[key] ?? null]));
    if (claim.sourceHash !== protocol.candidateSource.sourceHash || claim.contractHash !== hash(expected)) {
      fail('state', 'experiment_claim_contract_changed');
    }
    assertPreExecutionClaim(claim, candidate);
  }
}
export function pairedComparison(context, { margin = .05, acceptance = null } = {}) {
  if (!Number.isFinite(margin) || margin < 0 || margin > .05) fail('policy', 'comparison_margin_invalid');
  if (context.rejection) return context.rejection;
  const { baseline, candidate, left, right, groups, applicabilityByTask } = context, a = baseline.manifest, b = candidate.manifest;
  if (acceptance) validateAcceptance({ acceptance }, a.metrics);
  const metrics = {}, sampleByMetric = new Map(), primary = acceptance?.primaryMetrics ?? [];
  const directions = acceptance?.metricDirections ?? {}, alpha = .05;
  const minimumClusters = acceptance?.minimumClusters ?? 5, minimumRepeats = acceptance?.minimumRepeats ?? 3;
  for (const metric of a.metrics) {
    // Keep each source cluster, all its tasks and every repeat together.
    // NA tasks supply no values or independent sample clusters for this metric.
    const applicable = a.selection.filter(task => applicabilityByTask.get(task.id)[metric] === 'measured');
    const clusters = groups.map(group => applicable.filter(task => task.clusterId === group).flatMap(task =>
      Array.from({ length: a.repeats }, (_, repeat) =>
        right.get(JSON.stringify([task.id, repeat])).metrics[metric] - left.get(JSON.stringify([task.id, repeat])).metrics[metric]))).filter(values => values.length);
    const sufficient = context.sufficient && clusters.length >= minimumClusters && a.repeats >= minimumRepeats;
    let state = 20261108;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
    const samples = sufficient ? Array.from({ length: 2000 }, () => mean(Array.from({ length: clusters.length }, () =>
      clusters[Math.floor(random() * clusters.length)]).flat())) : [];
    const interval = samples.length ? { low: quantile(samples, alpha / 2), high: quantile(samples, 1 - alpha / 2) } : null;
    // Simultaneous quality checks use a conservative Bonferroni interval.
    const adjusted = samples.length ? { low: quantile(samples, alpha / (2 * a.metrics.length)),
      high: quantile(samples, 1 - alpha / (2 * a.metrics.length)) } : null;
    const direction = directions[metric] ?? 'higher-is-better';
    const benefit = adjusted && (direction === 'lower-is-better' ? { low: -adjusted.high, high: -adjusted.low } : adjusted);
    metrics[metric] = {
      baseline: mean([...left.values()].filter(trial => metricState(trial, metric) === 'measured').map(trial => trial.metrics[metric])),
      candidate: mean([...right.values()].filter(trial => metricState(trial, metric) === 'measured').map(trial => trial.metrics[metric])),
      delta: mean(clusters.flat()), confidence95: interval, confidenceAdjusted: adjusted, direction,
      sampleSize: { pairedTrials: applicable.length * a.repeats, applicableTasks: applicable.length,
        notApplicableTasks: a.selection.length - applicable.length, notApplicableTrials: (a.selection.length - applicable.length) * a.repeats,
        clusters: clusters.length, repeats: a.repeats, minimumClusters, minimumRepeats, sufficient },
      decision: !benefit ? 'insufficient' : benefit.high < -margin ? 'regression'
        : benefit.low >= -margin ? 'non-inferior' : 'inconclusive'
    };
    sampleByMetric.set(metric, samples);
  }
  let hierarchyOpen = true;
  for (const metric of primary) {
    const samples = sampleByMetric.get(metric) ?? [], comparisons = acceptance.multiplicity === 'bonferroni' ? primary.length : 1;
    const interval = samples.length ? { low: quantile(samples, alpha / (2 * comparisons)),
      high: quantile(samples, 1 - alpha / (2 * comparisons)) } : null;
    const benefit = interval && (directions[metric] === 'lower-is-better' ? { low: -interval.high, high: -interval.low } : interval);
    const supported = Boolean(benefit && benefit.low > 0 && (acceptance.multiplicity !== 'fixed-sequence' || hierarchyOpen));
    metrics[metric].superiority = { preregistered: true, confidence: interval, benefitConfidence: benefit, supported,
      tested: acceptance.multiplicity !== 'fixed-sequence' || hierarchyOpen };
    if (acceptance.multiplicity === 'fixed-sequence' && !supported) hierarchyOpen = false;
  }
  const decisions = Object.values(metrics).map(metric => metric.decision), nonInferior = decisions.every(value => value === 'non-inferior');
  const superior = primary.length > 0 && primary.every(metric => metrics[metric].superiority.supported);
  const sufficient = Object.values(metrics).every(metric => metric.sampleSize.sufficient);
  const perTask = a.selection.map(task => ({
    taskId: task.id, clusterId: task.clusterId,
    metrics: Object.fromEntries(a.metrics.map(metric => {
      const before = Array.from({ length: a.repeats }, (_, repeat) => left.get(JSON.stringify([task.id, repeat])).metrics[metric]);
      const after = Array.from({ length: a.repeats }, (_, repeat) => right.get(JSON.stringify([task.id, repeat])).metrics[metric]);
      const applicability = applicabilityByTask.get(task.id)[metric];
      return [metric, { applicability, baseline: applicability === 'measured' ? mean(before) : null,
        candidate: applicability === 'measured' ? mean(after) : null,
        delta: applicability === 'measured' ? mean(after.map((value, i) => value - before[i])) : null }];
    })),
    trials: Array.from({ length: a.repeats }, (_, repeat) => {
      const before = left.get(JSON.stringify([task.id, repeat])), after = right.get(JSON.stringify([task.id, repeat]));
      return { repeat, baseline: { status: before.status, failureClass: before.failureClass ?? null, reason: before.reason ?? null,
        traces: trialTracePointers(before) }, candidate: { status: after.status, failureClass: after.failureClass ?? null,
        reason: after.reason ?? null, traces: trialTracePointers(after) },
      metrics: Object.fromEntries(a.metrics.map(metric => [metric, {
        applicability: applicabilityByTask.get(task.id)[metric], baseline: before.metrics[metric], candidate: after.metrics[metric],
        delta: applicabilityByTask.get(task.id)[metric] === 'measured' ? after.metrics[metric] - before.metrics[metric] : null
      }])) };
    })
  }));
  const baselineResources = summarizeResources(baseline.trials, baseline.summary.usage);
  const candidateResources = summarizeResources(candidate.trials, candidate.summary.usage);
  const resourceBefore = resourceValues(baselineResources), resourceAfter = resourceValues(candidateResources);
  return {
    conclusion: !sufficient ? 'insufficient' : decisions.includes('regression') ? 'regression'
      : nonInferior ? superior ? 'superior' : 'non-inferior' : 'inconclusive',
    method: 'paired-cluster-bootstrap-percentile', iterations: 2000, margin, clusters: groups.length,
    minimumClusters, minimumRepeats, qualityEvidence: context.qualityEvidence,
    ...(context.qualityEvidenceReason ? { reason: context.qualityEvidenceReason } : {}),
    multiplicity: { quality: 'bonferroni', metrics: a.metrics.length, familywiseAlpha: alpha,
      superiority: primary.length ? acceptance.multiplicity ?? 'single-primary' : 'not-preregistered', primaryMetrics: primary },
    scope: a.suite === 'rag-retrieval' ? 'selected retrieval tasks; component evidence only; no generation or release claim'
      : a.suite === 'scienceagentbench' ? 'selected local scientific tasks; engineering diagnostics only; no official benchmark, quality or release claim'
        : a.suite === 'qasper' && !context.qualityEvidence ? 'selected QASPER tasks; engineering diagnostics only; no quality or release claim'
        : 'selected benchmark tasks; no S01 or production-wide claim',
    releaseEligible: false, metrics, perTask,
    latency: { baseline: baseline.summary.latencyMs, candidate: candidate.summary.latencyMs },
    resources: { baseline: baselineResources, candidate: candidateResources,
      delta: Object.fromEntries(resourceNames.map(name => [name, resourceBefore[name] === null || resourceAfter[name] === null
        ? null : resourceAfter[name] - resourceBefore[name]])) },
    diagnostics: { baseline: summarizeDiagnostics(baseline.trials), candidate: summarizeDiagnostics(candidate.trials) },
    baselineSource: a.source?.sourceHash ?? null, candidateSource: b.source?.sourceHash ?? null,
    traces: { baseline: { path: baseline.path ?? null, sealHash: baseline.sealHash ?? null },
      candidate: { path: candidate.path ?? null, sealHash: candidate.sealHash ?? null } }
  };
}
export function assessResourceGates(acceptance, baseline, candidate) {
  const before = resourceValues(summarizeResources(baseline.trials, baseline.summary.usage));
  const after = resourceValues(summarizeResources(candidate.trials, candidate.summary.usage));
  const ceilings = Object.fromEntries(Object.entries(acceptance.resourceCeilings ?? {}).map(([name, maximum]) => [name, {
    maximum, observed: after[name], passed: after[name] !== null && after[name] <= maximum,
    reason: after[name] === null ? 'measurement_unknown' : after[name] > maximum ? 'ceiling_exceeded' : null
  }]));
  const degradation = Object.fromEntries(Object.entries(acceptance.maxResourceDegradation ?? {}).map(([name, maximum]) => {
    const baselineValue = before[name], candidateValue = after[name];
    const observed = baselineValue === null || candidateValue === null ? null : baselineValue === 0
      ? candidateValue === 0 ? 0 : null : (candidateValue - baselineValue) / baselineValue;
    return [name, { maximum, baseline: baselineValue, candidate: candidateValue, observed,
      passed: observed !== null && observed <= maximum,
      reason: baselineValue === null || candidateValue === null ? 'measurement_unknown'
        : baselineValue === 0 && candidateValue > 0 ? 'increase_from_zero_baseline'
          : observed > maximum ? 'degradation_exceeded' : null }];
  }));
  const budgetNames = { maxModelRequests: 'requests', maxInputTokens: 'inputTokens', maxOutputTokens: 'outputTokens',
    maxEstimatedCostUsd: 'costUsd', maxRunDurationMs: 'runDurationMs' };
  const budget = Object.fromEntries(Object.entries(candidate.manifest.budget ?? {})
    .filter(([name, maximum]) => budgetNames[name] && Number.isFinite(maximum) && maximum >= 0)
    .map(([name, maximum]) => {
      const observed = after[budgetNames[name]];
      return [name, { maximum, observed, passed: observed !== null && observed <= maximum,
        reason: observed === null ? 'measurement_unknown' : observed > maximum ? 'budget_exceeded' : null }];
    }));
  if (Number.isFinite(candidate.manifest.budget?.maxTaskDurationMs)) {
    const maximum = candidate.manifest.budget.maxTaskDurationMs;
    const durations = candidate.trials.map(trial => trial.latencyMs);
    const observed = durations.length && durations.every(value => Number.isFinite(value) && value >= 0)
      ? Math.max(...durations) : null;
    budget.maxTaskDurationMs = { maximum, observed, passed: observed !== null && observed <= maximum,
      reason: observed === null ? 'measurement_unknown' : observed > maximum ? 'budget_exceeded' : null };
  }
  return { registered: Object.keys(ceilings).length + Object.keys(degradation).length > 0,
    ceilings, degradation, budget, passed: [...Object.values(ceilings), ...Object.values(degradation), ...Object.values(budget)]
      .every(gate => gate.passed) };
}

export function assessAcceptance(acceptance, baseline, candidate, comparison) {
  const reasons = [];
  if (!['non-inferior', 'superior'].includes(comparison.conclusion)) reasons.push(`comparison:${comparison.conclusion}`);
  const absoluteFloors = Object.fromEntries(Object.entries(acceptance.absoluteFloors).map(([metric, minimum]) => {
    const observed = comparison.metrics?.[metric]?.candidate ?? null;
    return [metric, { minimum, observed, passed: Number.isFinite(observed) && observed >= minimum }];
  }));
  if (Object.values(absoluteFloors).some(gate => !gate.passed)) reasons.push('absolute_quality_floor');
  const absoluteCeilings = Object.fromEntries(Object.entries(acceptance.absoluteCeilings ?? {}).map(([metric, maximum]) => {
    const observed = comparison.metrics?.[metric]?.candidate ?? null;
    return [metric, { maximum, observed, passed: Number.isFinite(observed) && observed <= maximum }];
  }));
  if (Object.values(absoluteCeilings).some(gate => !gate.passed)) reasons.push('absolute_quality_ceiling');
  const trialFailures = candidate.trials.flatMap(trial => Object.entries(acceptance.trialFloors)
    .filter(([metric, minimum]) => metricState(trial, metric) !== 'not_applicable'
      && (metricState(trial, metric) !== 'measured' || trial.metrics[metric] < minimum))
    .map(([metric, minimum]) => ({ taskId: trial.taskId, repeat: trial.repeat, metric, minimum,
      observed: Number.isFinite(trial.metrics?.[metric]) ? trial.metrics[metric] : null })));
  if (trialFailures.length) reasons.push('per_trial_quality_floor');
  const resources = assessResourceGates(acceptance, baseline, candidate);
  if (!resources.passed) reasons.push('resource_gate');
  const blocked = ['incomplete', 'incompatible', 'insufficient', 'inconclusive'].includes(comparison.conclusion);
  return { status: !reasons.length ? 'eligible' : blocked ? 'blocked' : 'rejected', reasons,
    absoluteFloors, absoluteCeilings, trialFailures, resources, releaseEligible: false };
}
