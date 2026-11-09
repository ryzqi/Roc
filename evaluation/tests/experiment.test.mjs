import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureIncident, createExperiment, claimExperiment, assertExperimentManifest, assertExperimentToolSchema,
  assessExperiment, inspectExperiment, recordExperimentDecision } from '../lib/experiment.mjs';
import { ROOT, directory, fileInventory, hash, readJson, sourceIdentity, writeJson } from '../lib/common.mjs';
import { inspectRun, sealRun, summarize } from '../lib/report.mjs';
import { importQasper } from '../lib/qasper.mjs';

mkdirSync(join(ROOT, 'evaluation/.runtime/tests'), { recursive: true });
const root = mkdtempSync(join(ROOT, 'evaluation/.runtime/tests/experiment-'));
const analysis = { category: 'agent', observation: 'The answer omits supporting evidence.', hypothesis: 'The retrieval instruction may be incomplete.',
  proposedChange: 'Clarify evidence retrieval in the prompt.', expectedOutcome: 'Improve grounded answers without breaking existing tasks.' };
const acceptance = { nonInferiorityMargin: .05, absoluteFloors: { answerF1: .7, citationValidity: 1 }, trialFloors: { citationValidity: 1 } };

// Synthetic sealed records exercise gate logic, not model quality. They are kept
// under .runtime/tests, never added to the archive of actual benchmark runs.
function sample({ score = .8, evidence = 'live-model', split = 'development', fatal = null, source = sourceIdentity() } = {}) {
  const path = directory(root, 'synthetic-run');
  const selection = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, clusterId: `paper${i}` }));
  const manifest = { suite: 'qasper', evidence, profile: 'full', datasetIdentity: hash('synthetic'), selection, repeats: 3,
    metrics: ['answerF1', 'citationValidity'], scorerHash: hash('test-scorer'), provider: { model: 'test-only', maxTotalRequests: 60 },
    environment: { node: process.version }, split, exclusions: [], source, testOnly: true,
    toolManifest: { tools: [{ modelVisibleName: 'read_file', executionScopes: ['main'], effect: 'read' }] } };
  const trials = selection.flatMap(t => Array.from({ length: 3 }, (_, repeat) => ({ taskId: t.id, clusterId: t.clusterId, repeat,
    status: 'scored', metrics: { answerF1: score, citationValidity: 1 }, latencyMs: 100, toolSchemaHash: hash('test-schema') })));
  return { path, manifest, trials, fatal };
}
function save(run) {
  writeJson(join(run.path, 'manifest.json'), run.manifest); writeJson(join(run.path, 'trials.json'), run.trials);
  sealRun(run.path, summarize(run.manifest, run.trials, run.fatal));
  return run;
}
function protocol(baseline, overrides = {}) {
  const incident = captureIncident({ runPath: baseline.path, trial: { taskId: 'q0', repeat: 0 }, analysis });
  const spec = { schemaVersion: 1, title: 'Synthetic gate calibration', hypothesis: analysis.hypothesis,
    incidents: [incident.directory], allowedChanges: [], acceptance, ...overrides };
  return { experiment: createExperiment({ baselinePath: baseline.path, spec }), spec, incident };
}
function candidateFor(baseline, experiment, { score = .85, fatal = null, mutate = () => {} } = {}) {
  const candidate = sample({ score, evidence: baseline.manifest.evidence, source: baseline.manifest.source, fatal });
  const context = claimExperiment(experiment.directory, candidate.path, candidate.manifest);
  candidate.manifest.experiment = context.binding;
  assertExperimentManifest(context, candidate.manifest);
  mutate(candidate);
  save(candidate);
  return candidate;
}
const review = decision => ({ decision, reviewer: 'Synthetic test reviewer', rationale: 'Test-only gate calibration.',
  reviewedTrials: [{ taskId: 'q0', repeat: 0, finding: 'Test-only evidence inspected.' }] });

test('incident records exact sealed observation and leaves diagnosis a hypothesis', () => {
  const baseline = save(sample()), incident = captureIncident({ runPath: baseline.path, trial: { taskId: 'q0', repeat: 2 }, analysis });
  const record = readJson(join(incident.directory, 'incident.json'));
  assert.equal(record.source.sealHash, inspectRun(baseline.path).sealHash);
  assert.deepEqual(record.observed, baseline.trials[2]); assert.equal(record.diagnosisStatus, 'operator-hypothesis');
  assert.throws(() => captureIncident({ runPath: baseline.path, trial: { taskId: 'missing', repeat: 0 }, analysis }), /trial_not_found/);
  assert.throws(() => captureIncident({ runPath: baseline.path, analysis: { ...analysis, apiKey: 'not-a-secret' } }));
  const runIncident = captureIncident({ runPath: baseline.path, analysis });
  assert.equal(readJson(join(runIncident.directory, 'incident.json')).trial, null);
});
test('holdout and incomplete baselines cannot enter the optimization loop', () => {
  const holdout = save(sample({ split: 'holdout' }));
  assert.throws(() => captureIncident({ runPath: holdout.path, analysis }), /holdout_not_for_optimization/);
  const baseline = save(sample()), { spec } = protocol(baseline);
  assert.throws(() => createExperiment({ baselinePath: holdout.path, spec }), /requires_development/);
  const broken = save(sample({ fatal: { failureClass: 'provider', reason: 'synthetic_failure' } }));
  assert.throws(() => createExperiment({ baselinePath: broken.path, spec }), /requires_complete_baseline/);
  const legacy = sample(); legacy.trials.forEach(t => { delete t.toolSchemaHash; }); save(legacy);
  assert.throws(() => createExperiment({ baselinePath: legacy.path, spec }), /tool_contract_evidence_missing/);
});
test('registration requires declared source changes and complete, bounded acceptance criteria', () => {
  const baseline = sample();
  const target = baseline.manifest.source.files.find(f => f.path === 'src/main/plugins/agent/run-harness.ts');
  assert.ok(target); target.sha256 = hash('previous prompt');
  save(baseline);
  assert.throws(() => protocol(baseline), /undeclared_source_changes/);
  const { experiment, spec } = protocol(baseline, { allowedChanges: [target.path] });
  assert.deepEqual(experiment.changedFiles, [target.path]);
  assert.throws(() => createExperiment({ baselinePath: baseline.path, spec: { ...spec, allowedChanges: ['evaluation/lib/report.mjs'] } }));
  assert.throws(() => createExperiment({ baselinePath: baseline.path, spec: { ...spec, allowedChanges: ['src/../evaluation/lib/report.mjs'] } }));
  assert.throws(() => createExperiment({ baselinePath: baseline.path, spec: { ...spec, acceptance: { ...acceptance, absoluteFloors: { answerF1: .7 } } } }), /floors_must_cover/);
  assert.throws(() => createExperiment({ baselinePath: baseline.path, spec: { ...spec, acceptance: { ...acceptance, trialFloors: { nonexistent: 1 } } } }), /unknown_trial/);
  for (const margin of [-.01, .06, NaN]) assert.throws(() => createExperiment({ baselinePath: baseline.path, spec: { ...spec, acceptance: { ...acceptance, nonInferiorityMargin: margin } } }));
});
test('claim freezes source and contracts, refuses retries, and checks actual tools before dispatch', () => {
  const baseline = save(sample()), { experiment } = protocol(baseline), candidate = sample();
  const drift = structuredClone(candidate.manifest); drift.source.sourceHash = hash('different source');
  assert.throws(() => claimExperiment(experiment.directory, candidate.path, drift), /candidate_source_changed/);
  const profileDrift = { ...candidate.manifest, profile: 'smoke' };
  assert.throws(() => claimExperiment(experiment.directory, candidate.path, profileDrift), /contract_mismatch:profile/);
  const context = claimExperiment(experiment.directory, candidate.path, candidate.manifest);
  assert.throws(() => claimExperiment(experiment.directory, candidate.path, candidate.manifest), /EEXIST/);
  assert.equal(inspectExperiment(experiment.directory).state, 'awaiting-sealed-candidate');
  assertExperimentManifest(context, candidate.manifest);
  assert.throws(() => assertExperimentManifest(context, { ...candidate.manifest, provider: { ...candidate.manifest.provider, maxTotalRequests: 999 } }), /contract_mismatch:provider/);
  assert.throws(() => assertExperimentManifest(context, { ...candidate.manifest, datasetIdentity: 'changed' }), /contract_mismatch:datasetIdentity/);
  assertExperimentToolSchema(context, hash('test-schema'));
  assert.throws(() => assertExperimentToolSchema(context, hash('changed schema')), /tool_schema_mismatch/);
});
test('low-to-low noninferiority fails the absolute floor; stricter frozen margins catch smaller regressions', () => {
  const low = save(sample({ score: .4 })), { experiment } = protocol(low);
  candidateFor(low, experiment, { score: .4 });
  const result = assessExperiment(experiment.directory);
  assert.equal(result.comparison.conclusion, 'non-inferior'); assert.equal(result.status, 'rejected');
  assert.deepEqual(result.reasons, ['absolute_quality_floor']);
  assert.throws(() => recordExperimentDecision(experiment.directory, review('adopt')), /not_eligible/);
  const high = save(sample({ score: .9 })), strict = protocol(high, { acceptance: { ...acceptance, nonInferiorityMargin: .01 } });
  candidateFor(high, strict.experiment, { score: .87 });
  assert.equal(assessExperiment(strict.experiment.directory).comparison.conclusion, 'regression');
});
test('a per-trial hard floor cannot disappear into a passing average', () => {
  const baseline = save(sample()), { experiment } = protocol(baseline, { acceptance: {
    ...acceptance, absoluteFloors: { answerF1: .7, citationValidity: .9 }, trialFloors: { answerF1: .5 }
  } });
  candidateFor(baseline, experiment, { score: .9, mutate: c => { c.trials[0].metrics.answerF1 = .4; } });
  const result = assessExperiment(experiment.directory);
  assert.equal(result.comparison.conclusion, 'non-inferior');
  assert.ok(Object.values(result.absoluteFloors).every(f => f.passed));
  assert.equal(result.status, 'rejected'); assert.equal(result.trialFailures[0].taskId, 'q0');
});
test('fixture, incomplete and unregistered candidates cannot be adopted', () => {
  const fixture = save(sample({ evidence: 'fixture' })), f = protocol(fixture);
  candidateFor(fixture, f.experiment);
  assert.equal(assessExperiment(f.experiment.directory).status, 'blocked');
  assert.throws(() => recordExperimentDecision(f.experiment.directory, review('adopt')), /not_eligible/);
  const baseline = save(sample()), p = protocol(baseline);
  candidateFor(baseline, p.experiment, { fatal: { failureClass: 'provider', reason: 'synthetic_failure' } });
  assert.equal(assessExperiment(p.experiment.directory).status, 'blocked');
  const missing = protocol(baseline);
  candidateFor(baseline, missing.experiment, { mutate: c => { delete c.manifest.experiment; } });
  assert.throws(() => assessExperiment(missing.experiment.directory), /candidate_binding_changed/);
});
test('adoption binds recomputed evidence and a trace review; decisions and records cannot be silently replaced', () => {
  const baseline = save(sample()), { experiment } = protocol(baseline);
  assert.equal(inspectExperiment(experiment.directory).state, 'registered');
  candidateFor(baseline, experiment);
  const assessment = assessExperiment(experiment.directory);
  assert.equal(assessment.status, 'eligible');
  assert.deepEqual(assessExperiment(experiment.directory), assessment);
  assert.throws(() => recordExperimentDecision(experiment.directory, { ...review('adopt'), reviewedTrials: [] }), /not_eligible/);
  assert.throws(() => recordExperimentDecision(experiment.directory, { ...review('adopt'), reviewedTrials: [{ taskId: 'invented', repeat: 0, finding: 'missing' }] }), /trial_not_found/);
  const decision = recordExperimentDecision(experiment.directory, review('adopt'));
  assert.equal(decision.assessmentHash, assessment.recordHash);
  assert.equal(decision.rollbackSource, baseline.manifest.source.sourceHash);
  assert.equal(inspectExperiment(experiment.directory).state, 'decided');
  assert.throws(() => recordExperimentDecision(experiment.directory, review('reject')), /EEXIST/);
  const file = join(experiment.directory, 'decision.json'), changed = readJson(file);
  changed.review.rationale = 'edited after review'; writeFileSync(file, JSON.stringify(changed));
  assert.throws(() => inspectExperiment(experiment.directory), /record_changed/);
});
test('changed incident, threshold or run evidence invalidates the registered chain', () => {
  const baseline = save(sample()), a = protocol(baseline);
  const incidentPath = join(a.incident.directory, 'incident.json'), incident = readJson(incidentPath);
  incident.analysis.hypothesis = 'different hypothesis'; writeFileSync(incidentPath, JSON.stringify(incident));
  assert.throws(() => inspectExperiment(a.experiment.directory), /record_changed/);
  const b = protocol(baseline), protocolPath = join(b.experiment.directory, 'protocol.json'), changed = readJson(protocolPath);
  changed.spec.acceptance.absoluteFloors.answerF1 = 0; writeFileSync(protocolPath, JSON.stringify(changed));
  assert.throws(() => inspectExperiment(b.experiment.directory), /record_changed/);
  const c = protocol(baseline), candidate = candidateFor(baseline, c.experiment);
  writeFileSync(join(candidate.path, 'trials.json'), '[]');
  assert.throws(() => assessExperiment(c.experiment.directory), /evidence_changed/);
  const d = protocol(baseline); candidateFor(baseline, d.experiment); assessExperiment(d.experiment.directory);
  const assessmentPath = join(d.experiment.directory, 'assessment.json'), assessment = readJson(assessmentPath);
  assessment.status = 'blocked'; writeFileSync(assessmentPath, JSON.stringify(assessment));
  assert.throws(() => inspectExperiment(d.experiment.directory), /record_changed/);
  // Re-sealing edited source evidence does not preserve the registered identity.
  const summaryPath = join(baseline.path, 'summary.json'), summary = readJson(summaryPath);
  summary.metrics.answerF1 = .01; writeFileSync(summaryPath, JSON.stringify(summary));
  const inventory = fileInventory(baseline.path).filter(f => f.path !== 'seal.json');
  writeFileSync(join(baseline.path, 'seal.json'), JSON.stringify({ schemaVersion: 1, inventory, sha256: hash(inventory) }));
  assert.throws(() => inspectExperiment(d.experiment.directory), /run_seal_changed/);
});

test('CLI executes the full incident/experiment/review lifecycle through the real runner with fixture transport', () => {
  const dataset = directory(root, 'dataset');
  const tasks = importQasper(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`paper${i}`, {
    title: 'Synthetic lifecycle paper', abstract: 'Fixture only', full_text: [{ section_name: 'Results', paragraphs: ['The result is 25%.'] }],
    qas: [{ question_id: `question${i}`, question: 'What is the result?', answers: [{ answer: { unanswerable: false,
      extractive_spans: ['25%'], free_form_answer: '', yes_no: null, evidence: ['The result is 25%.'] } }] }]
  }]))).filter(t => t.split === 'development').slice(0, 1);
  assert.equal(tasks.length, 1);
  writeJson(join(dataset, 'tasks.json'), tasks);
  const suite = 'qasper', provenance = { kind: 'synthetic-experiment-lifecycle' }, inventory = fileInventory(dataset);
  writeJson(join(dataset, 'dataset.json'), { suite, provenance, inventory, identity: hash({ suite, provenance, inventory }) });
  const cli = (args, expected = 0) => {
    const result = spawnSync(process.execPath, ['evaluation/lib/cli.mjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 90000 });
    assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(expected === 0 || result.stdout.trim() ? result.stdout : result.stderr);
  };
  const options = ['--suite', suite, '--profile', 'smoke', '--dataset', dataset, '--fixture'];
  const baseline = cli(['run', ...options]);
  const analysisPath = join(root, 'analysis.json'); writeJson(analysisPath, analysis);
  const incident = cli(['incident', baseline.directory, '--task', tasks[0].id, '--repeat', '0', '--analysis', analysisPath]);
  const specPath = join(root, 'experiment.json');
  writeJson(specPath, { schemaVersion: 1, title: 'Fixture CLI lifecycle', hypothesis: 'Checks wiring only.',
    incidents: [incident.directory], allowedChanges: [], acceptance: { nonInferiorityMargin: .05,
      absoluteFloors: { answerF1: 0, evidenceF1: 0, citationValidity: 1 }, trialFloors: { citationValidity: 1 } } });
  const experiment = cli(['experiment', 'create', baseline.directory, '--spec', specPath]);
  // A fixture protocol cannot be switched to paid/live execution. This rejects
  // before opening any real model host or accessing configured credentials.
  const switched = cli(['run', ...options.filter(o => o !== '--fixture'), '--experiment', experiment.directory], 2);
  assert.equal(switched.fatal.reason, 'experiment_contract_mismatch:evidence');
  assert.equal(switched.attempted, 0); assert.equal(switched.cost.costBasis, 'not-dispatched');
  const candidate = cli(['run', ...options, '--experiment', experiment.directory]);
  const run = inspectRun(candidate.directory);
  assert.equal(run.manifest.experiment.protocolHash, experiment.protocolHash);
  assert.equal(run.summary.cost.requests, 2);
  const assessment = cli(['experiment', 'assess', experiment.directory], 2);
  assert.equal(assessment.status, 'blocked'); assert.equal(assessment.comparison.conclusion, 'insufficient');
  const reviewPath = join(root, 'review.json');
  writeJson(reviewPath, { decision: 'reject', reviewer: 'Fixture calibration', rationale: 'Fixture cannot establish model quality.', reviewedTrials: [] });
  cli(['experiment', 'decide', experiment.directory, '--review', reviewPath]);
  assert.equal(cli(['experiment', 'inspect', experiment.directory]).decision.decision, 'reject');
  const retry = cli(['run', ...options, '--experiment', experiment.directory], 2);
  assert.equal(retry.attempted, 0); assert.match(retry.fatal.reason, /EEXIST/);
  // The bound worker really executed the tool and preserved its full transcript.
  const trialDir = join(candidate.directory, `trial-${hash(tasks[0].id).slice(0, 16)}-0`);
  const transcript = readFileSync(join(trialDir, 'transcript.jsonl'), 'utf8');
  assert.match(transcript, /read_file/); assert.equal(readJson(join(trialDir, 'cleanup.json')).processGroupGone, true);
  writeJson(join(root, 'lifecycle-evidence.json'), { baseline: baseline.directory, candidate: candidate.directory,
    incident: incident.directory, experiment: experiment.directory, evidence: 'fixture-only' });
});
