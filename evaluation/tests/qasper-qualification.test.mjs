import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { directory, fileInventory, hash, writeJson } from '../lib/common.mjs';
import { hasQasperQualityProvenance, loadDataset, qasperSourceContract, sealDataset } from '../lib/data.mjs';
import { importQasper } from '../lib/qasper.mjs';
import { applicationContract } from '../lib/application-verifier.mjs';
import { compareRuns, hasApplicationRuntimeEvidence, inspectRun, sealRun, summarize } from '../lib/report.mjs';
import { writeProtocolRecord } from '../lib/comparison.mjs';
import { assertExperimentManifest, captureIncident, claimExperiment, experimentSpecSchema, recordExperimentDecision } from '../lib/experiment.mjs';
import { testArtifacts } from './test-artifacts.mjs';
import { officialQasper, officialQasperFields, officialQasperTest } from './qasper-official.mjs';

// Scores and runtime receipts are sealed counterexample assertions, never model
// measurements. The data are honestly synthetic and self-sealed, not source pins.
const root = testArtifacts('qasper-qualification');
const source = { sourceHash: hash('qualification-test-source'), files: [], lockfileHash: hash('qualification-test-lock') };

function syntheticDataset(provenance = { kind: 'synthetic-quality-counterexample' }) {
  const papers = {};
  for (let i = 0; Object.keys(papers).length < 5; i++) {
    const id = `synthetic-paper-${i}`;
    if (parseInt(hash(id).slice(0, 8), 16) % 5 === 0) continue;
    papers[id] = { title: 'Synthetic paper', abstract: '', full_text: [
      { section_name: 'Results', paragraphs: ['The synthetic result is 25%.'] }
    ], qas: [{ question_id: `synthetic-question-${i}`, question: 'What is the result?', answers: [
      { answer: { unanswerable: false, extractive_spans: ['25%'], free_form_answer: '', yes_no: null,
        evidence: ['The synthetic result is 25%.'] } }
    ] }] };
  }
  return loadDataset(sealDataset(directory(root, 'input'), 'qasper', provenance,
    importQasper(papers), directory(root, 'datasets')));
}

function draft(dataset, score = .8, selection = dataset.tasks) {
  const path = directory(root, 'run');
  const manifest = { schemaVersion: 1, runId: hash(path), suite: 'qasper', evidence: 'live-model',
    profile: 'full', split: 'development', repeats: 3, exclusions: [], source: structuredClone(source),
    dataset: { path: dataset.root, identity: dataset.manifest.identity }, datasetIdentity: dataset.manifest.identity,
    datasetProvenance: structuredClone(dataset.manifest.provenance),
    ...(dataset.qasperQualification ? { qasperQualification: structuredClone(dataset.qasperQualification) } : {}),
    selection: selection.map(task => ({ id: task.id, clusterId: task.clusterId })),
    metrics: ['answerF1', 'evidenceF1', 'citationValidity'], scorerHash: hash('qualification-test-scorer'),
    taskSchemaHash: hash('qualification-test-task-schema'), provider: { model: 'counterexample-no-inference' },
    environment: { node: process.version }, permissions: { worker: 'isolated', host: 'read-only' },
    executionPolicy: { concurrency: 2 }, budget: {}, applicationContract,
    toolManifest: { schemaVersion: 1, tools: [{ modelVisibleName: 'read_file', effect: 'read', executionScopes: ['main'] }] } };
  manifest.metricsHash = hash({ metrics: manifest.metrics, applicability: 'explicit-null-not-applicable-v1',
    scorerHash: manifest.scorerHash });
  const trials = manifest.selection.flatMap(task => Array.from({ length: 3 }, (_, repeat) => ({
    taskId: task.id, clusterId: task.clusterId, repeat, status: 'scored', latencyMs: 100,
    metrics: { answerF1: score, evidenceF1: score, citationValidity: 1 }, toolSchemaHash: hash('qualification-test-tools'),
    runtimeVerification: { status: 'verified', contractHash: hash(applicationContract),
      finalAnswerHash: hash('qualification-test-answer'), evidenceHash: hash('qualification-test-runtime') }
  })));
  return { path, manifest, trials };
}

function save(run) {
  writeJson(join(run.path, 'manifest.json'), run.manifest);
  writeJson(join(run.path, 'trials.json'), run.trials);
  sealRun(run.path, summarize(run.manifest, run.trials));
  return inspectRun(run.path);
}
function copy(run) {
  const path = realpathSync(directory(root, 'fresh-run'));
  return { path, manifest: { ...structuredClone(run.manifest), runId: hash(path) }, trials: structuredClone(run.trials) };
}
function registration(seed, ablation = false) {
  const incident = captureIncident({ runPath: seed.path, analysis: { category: 'unknown',
    observation: 'Synthetic QASPER must remain engineering evidence.', hypothesis: 'Self-declared qualification can bypass a gate.',
    proposedChange: 'Test provenance enforcement only.', expectedOutcome: 'No quality qualification or adoption.' },
  outputRoot: join(root, 'incidents') });
  const spec = experimentSpecSchema.parse({ schemaVersion: 1, title: 'QASPER provenance counterexample',
    hypothesis: 'Synthetic scores and pins cannot qualify data.', incidents: [incident.directory], allowedChanges: [],
    acceptance: { nonInferiorityMargin: .05, absoluteFloors: { answerF1: .7, evidenceF1: .7, citationValidity: 1 },
      trialFloors: {}, primaryMetrics: ['answerF1'], resourceCeilings: { costUsd: 1 } },
    ...(ablation ? { kind: 'ablation', ablation: { capabilities: {
      baseline: { toolManifest: seed.manifest.toolManifest, toolSchemaHash: seed.trials[0].toolSchemaHash },
      candidate: { toolManifest: { ...seed.manifest.toolManifest, tools: [...seed.manifest.toolManifest.tools,
        { modelVisibleName: 'ls', effect: 'read', executionScopes: ['main'] }] }, toolSchemaHash: hash('ablation-candidate-schema') }
    } } } : {}) });
  const path = realpathSync(directory(root, 'protocol'));
  writeProtocolRecord(join(path, 'protocol.json'), 'protocol', { comparisonProtocolVersion: 1,
    createdAt: '2026-11-14T00:00:00.000Z', spec, baseline: { path: seed.path, sealHash: seed.sealHash },
    candidateSource: structuredClone(source), changedFiles: [], toolSchemaHash: seed.trials[0].toolSchemaHash,
    incidents: [{ path: incident.directory, recordHash: incident.recordHash }] });
  return path;
}
function arm(seed, protocol, name, ablation = false) {
  const run = copy(seed);
  if (ablation && name === 'candidate') run.manifest.toolManifest.tools.push({
    modelVisibleName: 'ls', effect: 'read', executionScopes: ['main']
  });
  const context = claimExperiment(protocol, run.path, run.manifest, { arm: name });
  run.manifest.experiment = context.binding;
  run.trials.forEach(trial => { trial.toolSchemaHash = context.expected.toolSchemaHash; });
  assertExperimentManifest(context, run.manifest);
  return save(run);
}
function assertEngineering(comparison) {
  assert.equal(comparison.qualityEvidence, false);
  assert.equal(comparison.reason, 'qasper_quality_provenance_unverified');
  assert.equal(comparison.conclusion, 'insufficient');
  assert.equal(comparison.releaseEligible, false);
  assert.match(comparison.scope, /engineering diagnostics only/);
  for (const metric of Object.values(comparison.metrics)) {
    assert.equal(metric.confidence95, null);
    assert.equal(metric.confidenceAdjusted, null);
    assert.equal(metric.decision, 'insufficient');
    assert.equal(metric.sampleSize.sufficient, false);
    assert.ok(Number.isFinite(metric.baseline) && Number.isFinite(metric.candidate) && Number.isFinite(metric.delta));
    if (metric.superiority) {
      assert.equal(metric.superiority.supported, false);
      assert.equal(metric.superiority.confidence, null);
    }
  }
  if (comparison.acceptance) {
    assert.equal(comparison.acceptance.status, 'blocked');
    assert.equal(comparison.acceptance.releaseEligible, false);
  }
}
function rehash(value) {
  const { hash: omitted, ...payload } = value;
  return { ...payload, hash: hash(payload) };
}

test('offline: five-cluster x3 self-sealed synthetic QASPER cannot qualify despite matched runtime and tools', () => {
  const dataset = syntheticDataset(), datasetBefore = fileInventory(dataset.root);
  const baseline = save(draft(dataset)), candidate = save(draft(dataset, .9));
  const before = [baseline, candidate].map(run => fileInventory(run.path));
  assert.equal(baseline.summary.status, 'complete');
  assert.equal(candidate.summary.status, 'complete');
  assert.equal(baseline.trials.length, 15);
  assert.equal(new Set(baseline.manifest.selection.map(task => task.clusterId)).size, 5);
  assert.ok([baseline, candidate].every(hasApplicationRuntimeEvidence));
  const comparison = compareRuns(baseline, candidate);
  assertEngineering(comparison);
  assert.equal(comparison.perTask.length, 5);
  assert.deepEqual([baseline, candidate].map(run => fileInventory(run.path)), before);
  assert.deepEqual(fileInventory(dataset.root), datasetBefore);
});

test('offline: self-declared official provenance, reviewed status and freshly rehashed pins cannot qualify synthetic QASPER', () => {
  const contract = qasperSourceContract();
  const dataset = syntheticDataset({ ...contract.source, adaptation: contract.adaptation, split: contract.split });
  assert.equal(dataset.qasperQualification.status, 'unverified');
  const baseline = draft(dataset), candidate = draft(dataset, .9);
  for (const run of [baseline, candidate]) {
    run.manifest.qasperQualification = rehash({ ...dataset.qasperQualification, status: 'verified',
      sourceContract: rehash({ ...contract, source: { ...contract.source,
        archiveSha256: hash('arbitrary-archive-pin'), memberSha256: hash('arbitrary-member-pin') } }),
      derivedDatasetIdentity: dataset.manifest.identity, adaptedTasksHash: hash(dataset.tasks) });
    run.manifest.official = true;
    run.manifest.datasetReview = { status: 'reviewed', official: true };
    assert.equal(hasQasperQualityProvenance(run.manifest), false);
  }
  assertEngineering(compareRuns(save(baseline), save(candidate)));
});

test('offline: fixed and fresh two-arm ablation protocols cannot upgrade synthetic QASPER with self-sealed qualification', () => {
  const dataset = syntheticDataset();
  for (const ablation of [false, true]) {
    const run = draft(dataset);
    run.manifest.qasperQualification = rehash({ ...dataset.qasperQualification, status: 'verified' });
    const seed = save(run), protocol = registration(seed, ablation);
    const baseline = ablation ? arm(seed, protocol, 'baseline', true) : seed;
    const candidate = arm(seed, protocol, 'candidate', ablation);
    assert.ok([baseline, candidate].every(hasApplicationRuntimeEvidence));
    const before = [baseline, candidate].map(record => fileInventory(record.path));
    if (ablation) {
      assert.equal(compareRuns(baseline, candidate).conclusion, 'incompatible');
      assert.notEqual(baseline.manifest.experiment.arm, candidate.manifest.experiment.arm);
    }
    assertEngineering(compareRuns(baseline, candidate, { protocol }));
    assert.throws(() => recordExperimentDecision(protocol, { decision: 'adopt', reviewer: 'test-only-reviewer',
      rationale: 'Synthetic assertions are never quality.', reviewedTrials: [
        { taskId: candidate.manifest.selection[0].id, repeat: 0, finding: 'Counterexample evidence only.' }
      ] }), /not_eligible/);
    assert.deepEqual([baseline, candidate].map(record => fileInventory(record.path)), before);
  }
});

officialQasperTest('offline: independently pinned official archive, member and complete deterministic tasks qualify without changing data bytes', () => {
  const before = fileInventory(officialQasper.root), fields = officialQasperFields();
  const loaded = loadDataset(officialQasper.root), qualification = loaded.qasperQualification;
  assert.equal(qualification.status, 'verified');
  assert.equal(qualification.taskCount, 1005);
  assert.equal(qualification.supportedTaskCount, 772);
  assert.equal(qualification.adaptedTasksHash, 'e0dff51e147832616bda023ee97422961eab091848d9f43d538cb42f199b221c');
  assert.equal(qualification.derivedDatasetIdentity, loaded.manifest.identity);
  assert.deepEqual(qualification.sourceContract, qasperSourceContract());
  const baseline = draft(loaded, .8, fields.selection), candidate = draft(loaded, .9, fields.selection);
  assert.ok([baseline, candidate].every(run => hasQasperQualityProvenance(run.manifest)));
  const comparison = compareRuns(save(baseline), save(candidate));
  assert.equal(comparison.qualityEvidence, true);
  assert.equal(comparison.conclusion, 'non-inferior');
  assert.ok(comparison.metrics.answerF1.confidence95.low > 0);
  assert.equal(comparison.releaseEligible, false);
  assert.deepEqual(fileInventory(officialQasper.root), before);
});

officialQasperTest('offline: authentic official source bytes combined with substituted tasks cannot qualify a self-sealed dataset', () => {
  const before = fileInventory(officialQasper.root), staging = directory(root, 'substituted-tasks');
  for (const name of ['source.tgz', 'qasper-dev-v0.3.json']) copyFileSync(join(officialQasper.root, name), join(staging, name));
  const synthetic = syntheticDataset(), dataset = loadDataset(sealDataset(staging, 'qasper',
    structuredClone(officialQasper.manifest.provenance), synthetic.tasks, directory(root, 'substituted-cache')));
  assert.equal(dataset.qasperQualification.status, 'unverified');
  assert.equal(dataset.qasperQualification.reason, 'qasper_adapted_tasks_not_derived_from_locked_member');
  const baseline = draft(dataset), candidate = draft(dataset, .9);
  for (const run of [baseline, candidate]) {
    run.manifest.qasperQualification = rehash({ ...officialQasper.qasperQualification,
      datasetIdentity: dataset.manifest.identity, derivedDatasetIdentity: dataset.manifest.identity,
      inventoryHash: hash(dataset.manifest.inventory), tasksSha256: dataset.qasperQualification.tasksSha256,
      adaptedTasksHash: hash(dataset.tasks) });
    assert.equal(hasQasperQualityProvenance(run.manifest), false);
  }
  assertEngineering(compareRuns(save(baseline), save(candidate)));
  assert.deepEqual(fileInventory(officialQasper.root), before);
});

officialQasperTest('offline: legacy or rehashed stale source-lock/derivation/schema claims remain unqualified on real official data', () => {
  const fields = officialQasperFields();
  for (const mutate of [
    manifest => { delete manifest.qasperQualification; },
    manifest => { manifest.qasperQualification.schemaVersion = 2; },
    manifest => { manifest.qasperQualification.sourceContract.sourceLockSha256 = hash('self-declared-lock'); },
    manifest => { manifest.qasperQualification.sourceContract.derivation.files[0].sha256 = hash('self-declared-derivation'); },
    manifest => { manifest.qasperQualification.sourceContract.source.archiveSha256 = hash('self-declared-official-pin'); }
  ]) {
    const baseline = draft(officialQasper, .8, fields.selection), candidate = draft(officialQasper, .9, fields.selection);
    for (const run of [baseline, candidate]) {
      mutate(run.manifest);
      if (run.manifest.qasperQualification) run.manifest.qasperQualification = rehash(run.manifest.qasperQualification);
      assert.equal(hasQasperQualityProvenance(run.manifest), false);
    }
    assertEngineering(compareRuns(save(baseline), save(candidate)));
  }
  assert.equal(JSON.parse(readFileSync(join(officialQasper.root, 'dataset.json'))).qasperQualification, undefined);
});

officialQasperTest('offline: locked qualification also requires rereadable data and official supported task/cluster/split selections', () => {
  const fields = officialQasperFields(), unsupported = officialQasper.tasks.find(task => task.unsupported);
  assert.ok(unsupported);
  for (const change of ['missing-data', 'unknown-task', 'unsupported-task', 'cluster', 'split']) {
    const selection = structuredClone(fields.selection);
    if (change === 'unknown-task') selection[0].id = 'self-declared-official-task';
    if (change === 'unsupported-task') selection[0] = { id: unsupported.id, clusterId: unsupported.clusterId };
    if (change === 'cluster') selection[0].clusterId = 'self-declared-independent-cluster';
    const baseline = draft(officialQasper, .8, selection), candidate = draft(officialQasper, .9, selection);
    for (const run of [baseline, candidate]) {
      if (change === 'missing-data') run.manifest.dataset.path = join(root, 'unavailable-official-data');
      if (change === 'split') run.manifest.split = 'holdout';
      assert.equal(hasQasperQualityProvenance(run.manifest), false, change);
    }
    assertEngineering(compareRuns(save(baseline), save(candidate)));
  }
});
