import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const api = await importTypeScriptModule('scripts/harness-eval/quality-evaluation/index.ts', { platform: 'node' });
const raw = JSON.parse(readFileSync('tests/fixtures/quality-evaluation/manifest.json', 'utf8'));
const frozen = value => api.freezeQualityDataset(value, api.qualityHash(value));
const root = mkdtempSync(join(tmpdir(), 'roc-quality-data-'));
after(() => rmSync(root, { recursive: true, force: true }));

// In-memory contract doubles only. They model complete records, not independent
// sources or human reviews, and are never added to the scientific corpus.
function independentRecord(count = 10, split = 'dev') {
  const base = structuredClone(raw);
  base.evidence = 'independent';
  base.preregistration.clusterSplits = {};
  base.sources = [];
  base.tasks = Array.from({ length: count }, (_, index) => {
    const task = structuredClone(raw.tasks.find(task => task.family === 'file-report'));
    Object.assign(task, { id: `contract-task-${index}`, clusterId: `contract-cluster-${index}`,
      split, sourceIds: [`contract-source-${index}`], review: {
        status: 'reviewed', reviewers: ['reviewer-a', 'reviewer-b'], independent: true,
        annotationRef: 'review.json', annotationHash: api.qualityHash({ contract: true }),
        reviewedAt: '2026-11-06T09:00:00.000Z', disagreement: false, arbitrationRef: null, arbitrationHash: null
      } });
    task.inputHash = api.qualityHash(api.toAgentTaskView(task));
    base.sources.push({ id: task.sourceIds[0], clusterId: task.clusterId, origin: 'synthetic',
      license: 'original contract double', attribution: 'unit test', locator: `contract:${index}`,
      contentHash: api.qualityHash({ index }), permission: 'evaluation-approved' });
    base.preregistration.clusterSplits[task.clusterId] = split;
    return task;
  });
  base.preregistration.registeredAt = '2026-11-06T08:00:00.000Z';
  base.frozenAt = '2026-11-06T10:00:00.000Z';
  return base;
}

function lockInput(mode) {
  return { executionMode: mode, authorizationLevel: 'L2', providerId: 'contract-provider',
    baselineModelId: 'same-model', candidateModelId: 'same-model', baselineCommitSha: 'a'.repeat(40), candidateCommitSha: 'b'.repeat(40),
    toolManifestHash: 'c'.repeat(64), environmentHash: 'd'.repeat(64), promptSetHash: 'e'.repeat(64), isolationHash: 'f'.repeat(64),
      temperature: 0, taskTimeoutMs: 1000,
      userAuthorized: true, approvalReference: 'contract-only' };
}

test('dataset rejects absent license/review fields and content or input hash drift', () => {
  const missing = structuredClone(raw);
  delete missing.sources[0].license;
  assert.throws(() => frozen(missing));
  const changed = structuredClone(raw);
  changed.tasks[0].prompt += ' changed';
  assert.throws(() => api.freezeQualityDataset(changed, api.qualityHash(raw)), /hash_changed/);
  assert.throws(() => frozen(changed), /input_changed/);
  const missingReview = independentRecord();
  missingReview.tasks[0].review.annotationHash = null;
  assert.throws(() => frozen(missingReview), /license_or_review_incomplete/);
});

test('source identity cannot be relabeled into another cluster or leak between splits', () => {
  const relabeled = independentRecord();
  relabeled.sources[1].contentHash = relabeled.sources[0].contentHash;
  assert.throws(() => frozen(relabeled), /source_reclustered/);
  const leaked = independentRecord();
  leaked.sources[1].clusterId = leaked.tasks[1].clusterId = leaked.tasks[0].clusterId;
  leaked.tasks[1].split = 'holdout';
  assert.throws(() => frozen(leaked), /split_leakage/);
  const unregistered = independentRecord();
  unregistered.tasks[0].split = 'holdout';
  assert.throws(() => frozen(unregistered), /split_unregistered/);
});

test('independent data requires permission, independent double review, preregistration and arbitration', () => {
  const mutations = [
    value => { value.sources[0].permission = 'pending'; },
    value => { value.tasks[0].review.reviewers = ['same-reviewer', 'same-reviewer']; },
    value => { value.tasks[0].review.independent = false; },
    value => { value.tasks[0].review.disagreement = true; },
    value => { value.preregistration.registeredAt = value.tasks[0].review.reviewedAt; },
    value => { value.tasks[0].review.reviewedAt = '2026-11-07T10:00:00.000Z'; }
  ];
  for (const mutate of mutations) {
    const value = independentRecord();
    mutate(value);
    assert.throws(() => frozen(value), /license_or_review_incomplete/);
  }
  const science = independentRecord();
  science.tasks[0].family = 'literature-verification';
  science.tasks[0].inputHash = api.qualityHash(api.toAgentTaskView(science.tasks[0]));
  assert.throws(() => frozen(science), /scientific_source_synthetic/);
});

test('hidden expectation loader rejects tampering and traversal including symlinks', () => {
  const task = structuredClone(raw.tasks[0]);
  const value = { ...structuredClone(raw), tasks: [task] };
  const expected = JSON.parse(readFileSync(`tests/fixtures/quality-evaluation/${task.expectedRef}`, 'utf8'));
  writeFileSync(join(root, 'expected.json'), JSON.stringify(expected));
  task.expectedRef = 'expected.json';
  const dataset = frozen(value);
  assert.ok(api.loadQualityExpectations(dataset, root)[task.id]);
  writeFileSync(join(root, 'expected.json'), '{}');
  assert.throws(() => api.loadQualityExpectations(dataset, root), /expected_hash_changed/);
  symlinkSync(join(process.cwd(), 'tests/fixtures/quality-evaluation', raw.tasks[0].expectedRef), join(root, 'escape.json'));
  task.expectedRef = 'escape.json';
  assert.throws(() => api.loadQualityExpectations(frozen(value), root), /expected_path_outside/);
  mkdirSync(join(root, 'nested'));
  task.expectedRef = '../expected.json';
  assert.throws(() => api.loadQualityExpectations(frozen(value), join(root, 'nested')), /expected_path_outside/);
  task.expectedRef = join(process.cwd(), 'tests/fixtures/quality-evaluation', raw.tasks[0].expectedRef);
  assert.throws(() => api.loadQualityExpectations(frozen(value), root), /expected_path_outside/);
});

test('pilot/full use one dataset contract and cannot relax model, quota or preregistration locks', () => {
  const data = frozen(independentRecord());
  const draft = api.createQualityProtocolDraft(data, 'contract-pilot');
  const pilot = api.lockQualityProtocol(data, draft, lockInput('pilot'));
  assert.doesNotThrow(() => api.assertQualityProtocolAuthorized(data, pilot));
  assert.throws(() => api.lockQualityProtocol(data, draft, lockInput('full')), /full_dataset_incomplete/);
  const small = frozen(independentRecord(9));
  assert.throws(() => api.lockQualityProtocol(small, api.createQualityProtocolDraft(small, 'small'), lockInput('pilot')), /pilot_too_small/);
  assert.throws(() => api.lockQualityProtocol(data, { ...draft, repeatsPerTask: 2 }, lockInput('pilot')), /preregistration_changed/);
  assert.throws(() => api.lockQualityProtocol(data, draft, { ...lockInput('pilot'), candidateModelId: 'different-model' }), /same_model_required/);
  assert.throws(() => api.lockQualityProtocol(data, draft, { ...lockInput('pilot'), authorizationLevel: 'L3' }), /l3_approval_or_rollback_required/);
  assert.equal(api.auditQualityDataset(data).scientificStatus, 'insufficient');
});

test('full readiness is derived from holdout family and cluster quotas', () => {
  const value = independentRecord(200, 'holdout');
  let index = 0;
  for (const family of api.QUALITY_FAMILIES) {
    for (let count = 0; count < api.QUALITY_TARGETS[family]; count++, index++) {
      const task = value.tasks[index];
      task.family = family;
      task.provenance = 'real';
      value.sources[index].origin = 'real'; // Contract schema doubles, never real provenance evidence.
      task.inputHash = api.qualityHash(api.toAgentTaskView(task));
    }
  }
  const full = frozen(value);
  assert.equal(api.auditQualityDataset(full).fullDatasetReady, true);
  assert.doesNotThrow(() => api.lockQualityProtocol(full, api.createQualityProtocolDraft(full, 'contract-full'), lockInput('full')));
  // Exercise the statistical gate with schema doubles, never report these as model evidence.
  const trials = full.tasks.flatMap(task => Array.from({ length: 3 }, (_, repeatIndex) => ({
    taskId: task.id, family: task.family, clusterId: task.clusterId, repeatIndex,
    baseline: { status: 'success', score: 0.5, latencyMs: 100, },
    candidate: { status: 'success', score: 0.8, latencyMs: 90, }
  })));
  const options = { dataset: full, evidence: 'live-model', bootstrapIterations: 200 };
  const gain = api.summarizePairedQualityTrials(trials, options);
  assert.equal(gain.evidenceStatus, 'sufficient');
  assert.equal(gain.conclusion, 'candidate-gain-supported');
  assert.equal(gain.subjectiveReviewStatus, 'not_run');
  assert.equal(api.summarizePairedQualityTrials(trials.slice(3), options).evidenceStatus, 'insufficient');
  const regression = api.summarizePairedQualityTrials(trials.map(trial => trial.family === 'long-memory'
    ? { ...trial, candidate: { ...trial.candidate, score: 0.4 } } : trial), options);
  assert.equal(regression.conclusion, 'candidate-regression');
  const longTasks = full.tasks.filter(task => task.family === 'long-memory').map(task => task.id);
  const uncertain = api.summarizePairedQualityTrials(trials.map(trial => trial.family === 'long-memory'
    ? { ...trial, candidate: { ...trial.candidate, score: longTasks.indexOf(trial.taskId) < 12 ? 0.2 : 0.8 } }
    : trial), options);
  assert.ok(uncertain.confidence95.low > 0);
  assert.equal(uncertain.familyStatistics['long-memory'].candidateRegression, false);
  assert.ok(uncertain.familyStatistics['long-memory'].confidence95.low < -0.05);
  assert.equal(uncertain.conclusion, 'uncertain');
  value.tasks.pop();
  assert.equal(api.auditQualityDataset(frozen(value)).fullDatasetReady, false);
});
