import { closeSync, existsSync, fsyncSync, lstatSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { directory, EVAL_ROOT, fail, hash, readJson, sourceIdentity } from './common.mjs';
import { compareRuns, comparisonFields, inspectRun } from './report.mjs';

const text = z.string().trim().min(1).max(8000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const score = z.number().min(0).max(1);
const taskRef = z.strictObject({ taskId: text, repeat: z.number().int().nonnegative() });
const changePath = z.string().regex(/^(src|resources)\//).refine(p => !/[\\\r\n]/.test(p) && !p.split('/').some(s => ['', '.', '..'].includes(s)));
const analysisSchema = z.strictObject({
  category: z.enum(['agent', 'harness', 'environment', 'verifier', 'provider', 'budget', 'unknown']),
  observation: text, hypothesis: text, proposedChange: text, expectedOutcome: text
});
export const experimentSpecSchema = z.strictObject({
  schemaVersion: z.literal(1), title: text, hypothesis: text,
  incidents: z.array(text).min(1), allowedChanges: z.array(changePath),
  acceptance: z.strictObject({
    // Experiments may tighten, but cannot weaken, the existing comparison margin.
    nonInferiorityMargin: z.number().min(0).max(.05),
    absoluteFloors: z.record(text, score), trialFloors: z.record(text, score)
  })
});
const reviewSchema = z.strictObject({
  decision: z.enum(['adopt', 'reject']), reviewer: text, rationale: text,
  reviewedTrials: z.array(taskRef.extend({ finding: text }))
});

// These local hash records detect drift, not a malicious operator rewriting all evidence.
function writeRecord(path, kind, value) {
  const payload = { schemaVersion: 1, kind, ...value }, record = { ...payload, recordHash: hash(payload) };
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(record, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  return record;
}
function readRecord(path, kind) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail('state', 'experiment_record_not_regular');
  const record = readJson(path), { recordHash, ...payload } = record;
  if (record.kind !== kind || record.schemaVersion !== 1 || hash(payload) !== recordHash) fail('state', 'experiment_record_changed');
  return record;
}
function runReference(run) { return { path: realpathSync(run.path), sealHash: run.sealHash }; }
function inspectReference(ref) {
  const run = inspectRun(ref.path);
  if (run.sealHash !== ref.sealHash) fail('state', 'experiment_run_seal_changed');
  return run;
}
function findTrial(run, ref) {
  const matches = run.trials.filter(t => t.taskId === ref.taskId && t.repeat === ref.repeat);
  if (matches.length !== 1) fail('policy', 'incident_trial_not_found');
  return matches[0];
}
export function captureIncident({ runPath, trial = null, analysis }) {
  const run = inspectRun(realpathSync(runPath));
  if (run.manifest.split === 'holdout') fail('policy', 'holdout_not_for_optimization');
  const note = analysisSchema.parse(analysis), ref = trial === null ? null : taskRef.parse(trial);
  const observed = ref ? findTrial(run, ref) : run.summary;
  const path = directory(join(EVAL_ROOT, 'local/incidents'), 'incident');
  const record = writeRecord(join(path, 'incident.json'), 'incident', {
    createdAt: new Date().toISOString(), source: runReference(run), trial: ref,
    observed, analysis: note, diagnosisStatus: 'operator-hypothesis'
  });
  return { directory: path, recordHash: record.recordHash };
}
function inspectIncident(path) {
  const record = readRecord(join(path, 'incident.json'), 'incident');
  const run = inspectReference(record.source);
  if (run.manifest.split === 'holdout') fail('policy', 'holdout_not_for_optimization');
  analysisSchema.parse(record.analysis);
  const observed = record.trial ? findTrial(run, taskRef.parse(record.trial)) : run.summary;
  if (hash(observed) !== hash(record.observed)) fail('state', 'incident_observation_changed');
  return record;
}
function validateAcceptance(spec, metrics) {
  if (!metrics.length || hash(Object.keys(spec.acceptance.absoluteFloors).sort()) !== hash([...metrics].sort())) {
    fail('policy', 'absolute_floors_must_cover_all_metrics');
  }
  if (Object.keys(spec.acceptance.trialFloors).some(m => !metrics.includes(m))) fail('policy', 'unknown_trial_floor_metric');
}
function changedFiles(baseline, candidate) {
  if (!Array.isArray(baseline.files) || !Array.isArray(candidate.files)) fail('state', 'source_inventory_required');
  const before = new Map(baseline.files.map(f => [f.path, f.sha256]));
  const after = new Map(candidate.files.map(f => [f.path, f.sha256]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).sort();
}
export function createExperiment({ baselinePath, spec, specDirectory = process.cwd() }) {
  spec = experimentSpecSchema.parse(spec);
  const baseline = inspectRun(realpathSync(baselinePath)), a = baseline.manifest;
  if (baseline.summary.status !== 'complete') fail('policy', 'experiment_requires_complete_baseline');
  if (a.split !== 'development' || !['qasper', 'scienceagentbench'].includes(a.suite)) fail('policy', 'experiment_requires_development_benchmark');
  validateAcceptance(spec, a.metrics);
  // Reject missing/unstable legacy tool evidence before spending on a new candidate.
  const schemas = new Set(baseline.trials.map(t => t.toolSchemaHash));
  if (!a.toolManifest?.tools?.length || schemas.size !== 1 || !digest.safeParse([...schemas][0]).success) fail('policy', 'tool_contract_evidence_missing');
  const source = sourceIdentity(), changes = changedFiles(a.source, source);
  if (changes.some(p => !spec.allowedChanges.includes(p))) fail('policy', 'experiment_undeclared_source_changes');
  const incidents = spec.incidents.map(p => {
    const path = realpathSync(resolve(specDirectory, p)), record = inspectIncident(path);
    return { path, recordHash: record.recordHash };
  });
  const path = directory(join(EVAL_ROOT, 'local/experiments'), 'experiment');
  const record = writeRecord(join(path, 'protocol.json'), 'protocol', {
    createdAt: new Date().toISOString(), spec: { ...spec, incidents: incidents.map(i => i.path) }, incidents,
    baseline: runReference(baseline), candidateSource: source, changedFiles: changes, toolSchemaHash: [...schemas][0]
  });
  return { directory: path, protocolHash: record.recordHash, evidence: a.evidence, changedFiles: changes };
}
function loadExperiment(path) {
  path = realpathSync(path);
  const protocol = readRecord(join(path, 'protocol.json'), 'protocol');
  experimentSpecSchema.parse(protocol.spec);
  const baseline = inspectReference(protocol.baseline);
  validateAcceptance(protocol.spec, baseline.manifest.metrics);
  for (const ref of protocol.incidents) {
    if (inspectIncident(ref.path).recordHash !== ref.recordHash) fail('state', 'experiment_incident_changed');
  }
  return { path, protocol, baseline };
}
export function claimExperiment(path, runPath, manifest) {
  const context = loadExperiment(path), { protocol, baseline } = context;
  if (manifest.source.sourceHash !== protocol.candidateSource.sourceHash) fail('state', 'experiment_candidate_source_changed');
  for (const key of ['suite', 'profile', 'evidence', 'repeats', 'split', 'metrics', 'scorerHash']) {
    if (hash(manifest[key]) !== hash(baseline.manifest[key])) fail('policy', `experiment_contract_mismatch:${key}`);
  }
  // Exclusive and durable before any model-host access. Failed attempts stay visible;
  // a retry requires a new protocol rather than replacing an unfavourable candidate.
  writeRecord(join(context.path, 'candidate.json'), 'candidate', {
    protocolHash: protocol.recordHash, path: realpathSync(runPath), claimedAt: new Date().toISOString()
  });
  return { ...context, binding: { path: context.path, protocolHash: protocol.recordHash } };
}
export function assertExperimentManifest(context, manifest) {
  for (const key of comparisonFields) {
    if (hash(manifest[key] ?? null) !== hash(context.baseline.manifest[key] ?? null)) fail('policy', `experiment_contract_mismatch:${key}`);
  }
  assertExperimentUnchanged(context);
}
export function assertExperimentUnchanged(context) {
  const current = loadExperiment(context.path);
  if (current.protocol.recordHash !== context.protocol.recordHash) fail('state', 'experiment_protocol_changed');
}
export function assertExperimentToolSchema(context, schemaHash) {
  if (schemaHash !== context.protocol.toolSchemaHash) fail('policy', 'experiment_tool_schema_mismatch');
}
function assess(context) {
  const { path, protocol, baseline } = context;
  const claim = readRecord(join(path, 'candidate.json'), 'candidate');
  if (claim.protocolHash !== protocol.recordHash) fail('state', 'experiment_candidate_binding_changed');
  const candidate = inspectRun(claim.path);
  if (candidate.manifest.experiment?.protocolHash !== protocol.recordHash
    || candidate.manifest.experiment?.path !== path
    || candidate.manifest.source?.sourceHash !== protocol.candidateSource.sourceHash) fail('state', 'experiment_candidate_binding_changed');
  const comparison = compareRuns(baseline, candidate, { margin: protocol.spec.acceptance.nonInferiorityMargin });
  const reasons = [];
  if (comparison.conclusion !== 'non-inferior') reasons.push(`comparison:${comparison.conclusion}`);
  const floors = Object.fromEntries(Object.entries(protocol.spec.acceptance.absoluteFloors).map(([metric, minimum]) => {
    const observed = comparison.metrics?.[metric]?.candidate ?? null;
    return [metric, { minimum, observed, passed: observed !== null && observed >= minimum }];
  }));
  if (Object.values(floors).some(f => !f.passed)) reasons.push('absolute_quality_floor');
  const trialFailures = candidate.trials.flatMap(t => Object.entries(protocol.spec.acceptance.trialFloors)
    .filter(([metric, minimum]) => !Number.isFinite(t.metrics?.[metric]) || t.metrics[metric] < minimum)
    .map(([metric, minimum]) => ({ taskId: t.taskId, repeat: t.repeat, metric, minimum, observed: t.metrics?.[metric] ?? null })));
  if (trialFailures.length) reasons.push('per_trial_quality_floor');
  const blocked = ['incomplete', 'incompatible', 'insufficient', 'inconclusive'].includes(comparison.conclusion);
  const value = {
    protocolHash: protocol.recordHash, baseline: runReference(baseline), candidate: runReference(candidate),
    status: !reasons.length ? 'eligible' : blocked ? 'blocked' : 'rejected', reasons,
    comparison, absoluteFloors: floors, trialFailures,
    scope: 'development experiment only; eligibility is not deployment or independent holdout approval'
  };
  return { value, candidate };
}
export function assessExperiment(path) {
  const context = loadExperiment(path), { value } = assess(context);
  const target = join(context.path, 'assessment.json');
  if (existsSync(target)) {
    const previous = readRecord(target, 'assessment'), { schemaVersion, kind, recordHash, ...payload } = previous;
    if (hash(payload) !== hash(value)) fail('state', 'experiment_assessment_changed');
    return previous;
  }
  return writeRecord(target, 'assessment', value);
}
export function recordExperimentDecision(path, review) {
  review = reviewSchema.parse(review);
  const context = loadExperiment(path), assessment = assessExperiment(path);
  const candidate = inspectReference(assessment.candidate);
  for (const ref of review.reviewedTrials) findTrial(candidate, ref);
  if (review.decision === 'adopt' && (assessment.status !== 'eligible' || !review.reviewedTrials.length)) {
    fail('policy', 'experiment_not_eligible_for_adoption');
  }
  return writeRecord(join(context.path, 'decision.json'), 'decision', {
    createdAt: new Date().toISOString(), protocolHash: context.protocol.recordHash,
    assessmentHash: assessment.recordHash, baseline: assessment.baseline, candidate: assessment.candidate,
    rollbackSource: context.baseline.manifest.source.sourceHash, review,
    effect: 'local review record only; no deployment or application configuration change'
  });
}
export function inspectExperiment(path) {
  const context = loadExperiment(path), result = {
    directory: context.path, protocolHash: context.protocol.recordHash, title: context.protocol.spec.title,
    state: 'registered', evidence: context.baseline.manifest.evidence, changedFiles: context.protocol.changedFiles
  };
  if (!existsSync(join(context.path, 'candidate.json'))) return result;
  const claim = readRecord(join(context.path, 'candidate.json'), 'candidate');
  if (claim.protocolHash !== context.protocol.recordHash) fail('state', 'experiment_candidate_binding_changed');
  if (!existsSync(join(claim.path, 'seal.json'))) {
    return { ...result, state: 'awaiting-sealed-candidate', candidate: claim.path,
      reason: 'candidate_running_or_interrupted; no quality conclusion' };
  }
  const { value } = assess(context);
  Object.assign(result, { state: 'assessed', assessment: value });
  const assessmentPath = join(context.path, 'assessment.json');
  const assessment = existsSync(assessmentPath) ? readRecord(assessmentPath, 'assessment') : null;
  const expectedHash = hash({ schemaVersion: 1, kind: 'assessment', ...value });
  if (assessment && assessment.recordHash !== expectedHash) fail('state', 'experiment_assessment_changed');
  const decisionPath = join(context.path, 'decision.json');
  if (existsSync(decisionPath)) {
    const decision = readRecord(decisionPath, 'decision');
    if (assessment?.recordHash !== expectedHash || decision.assessmentHash !== expectedHash
      || decision.protocolHash !== context.protocol.recordHash) fail('state', 'experiment_decision_evidence_changed');
    result.state = 'decided'; result.decision = decision.review;
  }
  return result;
}
