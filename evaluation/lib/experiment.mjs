import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { directory, EVAL_ROOT, fail, hash, readJson, sourceIdentity } from './common.mjs';
import { compareRuns, inspectRun, renderComparisonReport } from './report.mjs';
import { assertPreExecutionClaim, assessAcceptance, comparisonFields, digest, experimentSpecFields,
  hasApplicationRuntimeEvidence, hasRagRuntimeEvidence, preExecutionEvidence,
  readProtocolRecord as readRecord, text, validToolManifest, validateAcceptance, writeProtocolRecord as writeRecord } from './comparison.mjs';
import { ablationArmContract, ablationSpecSchema, assertAblationManifest, validateAblationSpec } from './ablation.mjs';

const taskRef = z.strictObject({ taskId: text, repeat: z.number().int().nonnegative() });
const analysisSchema = z.strictObject({
  category: z.enum(['agent', 'harness', 'environment', 'verifier', 'provider', 'unknown']),
  observation: text, hypothesis: text, proposedChange: text, expectedOutcome: text
});
export const fixedExperimentSpecSchema = z.strictObject({ ...experimentSpecFields, kind: z.literal('fixed-contract').optional() });
export const experimentSpecSchema = z.union([fixedExperimentSpecSchema, ablationSpecSchema]);
const reviewSchema = z.strictObject({
  decision: z.enum(['adopt', 'reject']), reviewer: text, rationale: text,
  reviewedTrials: z.array(taskRef.extend({ finding: text }))
});

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
export function captureIncident({ runPath, trial = null, analysis, outputRoot = join(EVAL_ROOT, 'local/incidents') }) {
  const run = inspectRun(realpathSync(runPath));
  if (run.manifest.split === 'holdout') fail('policy', 'holdout_not_for_optimization');
  const note = analysisSchema.parse(analysis), ref = trial === null ? null : taskRef.parse(trial);
  const observed = ref ? findTrial(run, ref) : run.summary;
  const path = directory(outputRoot, 'incident');
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
function changedFiles(baseline, candidate) {
  if (!Array.isArray(baseline.files) || !Array.isArray(candidate.files)) fail('state', 'source_inventory_required');
  const before = new Map(baseline.files.map(f => [f.path, f.sha256]));
  const after = new Map(candidate.files.map(f => [f.path, f.sha256]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).sort();
}
export function createExperiment({ baselinePath, spec, specDirectory = process.cwd(), outputRoot = join(EVAL_ROOT, 'local/experiments') }) {
  spec = experimentSpecSchema.parse(spec);
  const baseline = inspectRun(realpathSync(baselinePath)), a = baseline.manifest;
  if (baseline.summary.status !== 'complete') fail('policy', 'experiment_requires_complete_baseline');
  if (a.split !== 'development' || !['qasper', 'scienceagentbench', 'rag-paper-qa', 'rag-retrieval'].includes(a.suite)) {
    fail('policy', 'experiment_requires_development_benchmark');
  }
  validateAcceptance(spec, a.metrics);
  // Reject missing/unstable legacy tool evidence before spending on a new candidate.
  const schemas = new Set(baseline.trials.map(t => t.toolSchemaHash));
  if (!validToolManifest(a.toolManifest) || schemas.size !== 1 || !digest.safeParse([...schemas][0]).success) fail('policy', 'tool_contract_evidence_missing');
  if (a.suite !== 'rag-retrieval' && !hasApplicationRuntimeEvidence(baseline)) fail('policy', 'application_runtime_evidence_missing');
  if (['rag-paper-qa', 'rag-retrieval'].includes(a.suite) && !hasRagRuntimeEvidence(baseline)) fail('policy', 'rag_runtime_evidence_missing');
  if (spec.kind === 'ablation') {
    validateAblationSpec(spec, a);
    if (a.permissions === undefined || a.permissions === null) fail('policy', 'ablation_permissions_contract_required');
  }
  const source = sourceIdentity(), changes = changedFiles(a.source, source);
  if (changes.some(p => !spec.allowedChanges.includes(p))) fail('policy', 'experiment_undeclared_source_changes');
  const incidents = spec.incidents.map(p => {
    const path = realpathSync(resolve(specDirectory, p)), record = inspectIncident(path);
    return { path, recordHash: record.recordHash };
  });
  const path = directory(outputRoot, 'experiment');
  const record = writeRecord(join(path, 'protocol.json'), 'protocol', {
    comparisonProtocolVersion: 1, createdAt: new Date().toISOString(), spec: { ...spec, incidents: incidents.map(i => i.path) }, incidents,
    baseline: runReference(baseline), candidateSource: source, changedFiles: changes, toolSchemaHash: [...schemas][0]
  });
  return { directory: path, protocolHash: record.recordHash, kind: spec.kind ?? 'fixed-contract',
    requiredArms: spec.kind === 'ablation' ? ['baseline', 'candidate'] : ['candidate'], evidence: a.evidence, changedFiles: changes };
}
function loadExperiment(path) {
  path = realpathSync(path);
  const protocol = readRecord(join(path, 'protocol.json'), 'protocol');
  experimentSpecSchema.parse(protocol.spec);
  const baseline = inspectReference(protocol.baseline);
  validateAcceptance(protocol.spec, baseline.manifest.metrics);
  if (protocol.spec.kind === 'ablation') {
    if (protocol.comparisonProtocolVersion !== 1) fail('policy', 'ablation_preregistration_missing');
    validateAblationSpec(protocol.spec, baseline.manifest);
    if (baseline.manifest.permissions === undefined || baseline.manifest.permissions === null) fail('policy', 'ablation_permissions_contract_required');
  }
  for (const ref of protocol.incidents) {
    if (inspectIncident(ref.path).recordHash !== ref.recordHash) fail('state', 'experiment_incident_changed');
  }
  return { path, protocol, baseline };
}
function armFor(protocol, requested) {
  if (protocol.spec.kind === 'ablation') {
    if (!['baseline', 'candidate'].includes(requested)) fail('policy', 'experiment_arm_required');
    return requested;
  }
  if (requested !== undefined && requested !== 'candidate') fail('policy', 'fixed_experiment_candidate_arm_required');
  return 'candidate';
}
function armContract(context, arm) {
  return context.protocol.spec.kind === 'ablation'
    ? ablationArmContract(context.protocol, context.baseline.manifest, arm)
    : { fields: Object.fromEntries(comparisonFields.map(key => [key, context.baseline.manifest[key] ?? null])),
      toolSchemaHash: context.protocol.toolSchemaHash };
}
function assertClaimManifest(context, manifest, arm, partial) {
  if (context.protocol.spec.kind === 'ablation') {
    return assertAblationManifest(context.protocol, context.baseline.manifest, manifest, arm, { partial });
  }
  if (manifest.source?.sourceHash !== context.protocol.candidateSource.sourceHash) fail('state', 'experiment_candidate_source_changed');
  const expected = armContract(context, arm);
  for (const key of partial ? ['suite', 'profile', 'evidence', 'repeats', 'split', 'metrics', 'scorerHash', 'applicationContract'] : comparisonFields) {
    if (hash(manifest[key] ?? null) !== hash(expected.fields[key])) fail('policy', `experiment_contract_mismatch:${key}`);
  }
  return expected;
}
function claimedContext(context, arm, claim) {
  return { ...context, arm, claim, expected: armContract(context, arm),
    binding: { path: context.path, protocolHash: context.protocol.recordHash, arm } };
}
export function claimExperiment(path, runPath, manifest, { arm: requested } = {}) {
  const context = loadExperiment(path), { protocol } = context, arm = armFor(protocol, requested);
  const expected = assertClaimManifest(context, manifest, arm, true), target = realpathSync(runPath);
  if (target === realpathSync(protocol.baseline.path)) fail('policy', 'experiment_requires_fresh_run');
  if (protocol.spec.kind === 'ablation') {
    const otherPath = join(context.path, `${arm === 'baseline' ? 'candidate' : 'baseline'}.json`);
    if (existsSync(otherPath) && readRecord(otherPath, arm === 'baseline' ? 'candidate' : 'baseline').path === target) {
      fail('policy', 'ablation_arms_require_distinct_fresh_runs');
    }
  }
  const preExecution = preExecutionEvidence(target);
  // Exclusive and durable before any model-host access. Failed attempts stay visible;
  // a retry requires a new protocol rather than replacing an unfavourable candidate.
  const claim = writeRecord(join(context.path, `${arm}.json`), arm, {
    claimVersion: 1, arm, protocolHash: protocol.recordHash, path: target, claimedAt: new Date().toISOString(),
    sourceHash: protocol.candidateSource.sourceHash, contractHash: hash(expected.fields), preExecution
  });
  return claimedContext(context, arm, claim);
}
export function resumeExperiment(path, runPath, manifest, { arm: requested } = {}) {
  const context = loadExperiment(path), arm = armFor(context.protocol, requested), target = realpathSync(runPath);
  if (existsSync(join(target, 'seal.json'))) fail('policy', 'experiment_resume_requires_unsealed_run');
  const claimPath = join(context.path, `${arm}.json`);
  if (!existsSync(claimPath)) fail('policy', 'experiment_resume_claim_missing');
  const claim = readRecord(claimPath, arm), expected = assertClaimManifest(context, manifest, arm, false);
  const result = claimedContext(context, arm, claim);
  if (claim.claimVersion !== 1 || claim.arm !== arm || claim.protocolHash !== context.protocol.recordHash || claim.path !== target
    || claim.sourceHash !== context.protocol.candidateSource.sourceHash || claim.contractHash !== hash(expected.fields)
    || hash(manifest.experiment) !== hash(result.binding)) fail('state', 'experiment_resume_binding_changed');
  if (existsSync(join(target, 'manifest.json')) && hash(readJson(join(target, 'manifest.json'))) !== hash(manifest)) {
    fail('state', 'experiment_resume_manifest_changed');
  }
  assertPreExecutionClaim(claim, { path: target });
  return { ...result, resumed: true };
}
export function assertExperimentManifest(context, manifest) {
  assertClaimManifest(context, manifest, context.arm ?? 'candidate', false);
  if (manifest.experiment && hash(manifest.experiment) !== hash(context.binding)) fail('state', 'experiment_candidate_binding_changed');
  assertExperimentUnchanged(context);
}
export function assertExperimentUnchanged(context) {
  const current = loadExperiment(context.path);
  if (current.protocol.recordHash !== context.protocol.recordHash) fail('state', 'experiment_protocol_changed');
  if (context.claim && readRecord(join(context.path, `${context.arm}.json`), context.arm).recordHash !== context.claim.recordHash) {
    fail('state', 'experiment_claim_changed');
  }
}
export function assertExperimentToolSchema(context, schemaHash) {
  if (schemaHash !== (context.expected?.toolSchemaHash ?? context.protocol.toolSchemaHash)) fail('policy', 'experiment_tool_schema_mismatch');
}
function assess(context) {
  const { path, protocol } = context;
  const claim = readRecord(join(path, 'candidate.json'), 'candidate');
  if (claim.protocolHash !== protocol.recordHash) fail('state', 'experiment_candidate_binding_changed');
  const candidate = inspectRun(claim.path);
  if (candidate.manifest.experiment?.protocolHash !== protocol.recordHash
    || candidate.manifest.experiment?.path !== path
    || candidate.manifest.source?.sourceHash !== protocol.candidateSource.sourceHash) fail('state', 'experiment_candidate_binding_changed');
  let baseline = context.baseline;
  if (protocol.spec.kind === 'ablation') {
    const baselineClaim = readRecord(join(path, 'baseline.json'), 'baseline');
    if (baselineClaim.protocolHash !== protocol.recordHash) fail('state', 'ablation_run_binding_changed');
    baseline = inspectRun(baselineClaim.path);
  }
  const comparison = compareRuns(baseline, candidate, { margin: protocol.spec.acceptance.nonInferiorityMargin,
    protocol: { path, protocolHash: protocol.recordHash } });
  const acceptance = comparison.acceptance ?? assessAcceptance(protocol.spec.acceptance, baseline, candidate, comparison);
  const value = {
    protocolHash: protocol.recordHash, protocolKind: protocol.spec.kind ?? 'fixed-contract',
    baseline: runReference(baseline), candidate: runReference(candidate), ...acceptance,
    comparison, ...(protocol.spec.kind === 'ablation' ? { contractSeed: protocol.baseline } : {}),
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
  const record = writeRecord(target, 'assessment', value);
  writeFileSync(join(context.path, 'assessment.md'), renderComparisonReport(value.comparison), { flag: 'wx', mode: 0o600 });
  return record;
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
    rollbackSource: inspectReference(assessment.baseline).manifest.source.sourceHash, review,
    ...(context.protocol.spec.kind === 'ablation' ? { rollbackContract: {
      retrievalConfig: inspectReference(assessment.baseline).manifest.retrievalConfig ?? null,
      toolManifest: inspectReference(assessment.baseline).manifest.toolManifest,
      toolSchemaHash: inspectReference(assessment.baseline).trials[0].toolSchemaHash
    } } : {}),
    effect: 'local review record only; no deployment or application configuration change'
  });
}
export function inspectExperiment(path) {
  const context = loadExperiment(path), result = {
    directory: context.path, protocolHash: context.protocol.recordHash, title: context.protocol.spec.title,
    state: 'registered', kind: context.protocol.spec.kind ?? 'fixed-contract',
    evidence: context.baseline.manifest.evidence, changedFiles: context.protocol.changedFiles
  };
  if (context.protocol.spec.kind === 'ablation') {
    result.arms = Object.fromEntries(['baseline', 'candidate'].map(arm => {
      const claimPath = join(context.path, `${arm}.json`);
      if (!existsSync(claimPath)) return [arm, { claimed: false, sealed: false, path: null }];
      const claim = readRecord(claimPath, arm);
      if (claim.arm !== arm || claim.protocolHash !== context.protocol.recordHash) fail('state', 'ablation_run_binding_changed');
      return [arm, { claimed: true, sealed: existsSync(join(claim.path, 'seal.json')), path: claim.path }];
    }));
    if (Object.values(result.arms).some(arm => !arm.sealed)) {
      return { ...result, state: Object.values(result.arms).some(arm => arm.claimed) ? 'awaiting-sealed-arms' : 'registered',
        reason: 'both fresh arms must be claimed and sealed; no quality conclusion' };
    }
  }
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
