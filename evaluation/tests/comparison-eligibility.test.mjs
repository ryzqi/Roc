import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { directory, fileInventory, hash, readJson, ROOT, sha256, writeJson } from '../lib/common.mjs';
import { loadDataset, prepareScience } from '../lib/data.mjs';
import { sciencePreflight } from '../lib/science.mjs';
import { compareRuns, hasApplicationRuntimeEvidence, inspectRun, sealRun, summarize } from '../lib/report.mjs';
import { writeProtocolRecord } from '../lib/comparison.mjs';
import { assertExperimentManifest, assessExperiment, captureIncident, claimExperiment,
  experimentSpecSchema, recordExperimentDecision } from '../lib/experiment.mjs';
import { scienceFixture } from './science-fixture.mjs';
import { testArtifacts } from './test-artifacts.mjs';
import { officialQasperFields, officialQasperTest } from './qasper-official.mjs';

// These records exercise eligibility and the actual compare CLI without sourceIdentity,
// workers, models, network services or production databases. Receipts/reviewer names
// are test assertions, not independent quality evidence or an official Science source.
// QASPER positive qualification uses independently pinned real local official data.
const root = testArtifacts('comparison-eligibility');
const fresh = name => realpathSync(directory(root, name));
const source = { sourceHash: hash('test-only-source'), files: [], lockfileHash: hash('test-only-lockfile') };
const contract = { schemaVersion: 1, answerBoundary: 'test-only-checkpoint-answer' };
const usage = { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15,
  knownInputTokens: 10, knownOutputTokens: 5, costUsd: .001, knownCostUsd: .001,
  unknownUsageRequests: 0, unknownCostRequests: 0, pendingRequests: 0, usageState: 'measured' };

function draft({ dataset, evidence = 'live-model', scores = [.8, .8, .8, .8, .8] } = {}) {
  const path = fresh('run'), suite = dataset ? 'scienceagentbench' : 'qasper';
  const official = dataset ? null : officialQasperFields(scores.length);
  const tasks = dataset?.tasks ?? official?.selection ?? scores.map((_, i) => ({ id: `q${i}`, clusterId: `paper${i}`, visible: { question: `test ${i}` } }));
  const selection = tasks.map(task => ({ id: task.id, clusterId: task.clusterId,
    contentHash: hash({ visible: task.visible, expected: task.expected }) }));
  const metric = dataset ? 'successRate' : 'answerF1';
  const manifest = { schemaVersion: 1, runId: hash(path), suite, evidence, profile: 'full', split: 'development',
    selection, repeats: 3, metrics: [metric], exclusions: [], datasetIdentity: dataset?.manifest.identity ?? hash('test-only-dataset'),
    ...(dataset ? { datasetProvenance: structuredClone(dataset.manifest.provenance) } : {}),
    provider: { model: 'test-only-no-inference' }, environment: { node: process.version }, source: structuredClone(source),
    permissions: { worker: 'test-only-isolated', host: 'read-only' }, executionPolicy: { concurrency: 2 },
    applicationContract: structuredClone(contract), scorerHash: hash('test-only-scorer'), taskSchemaHash: hash('test-only-task-schema'),
    toolManifest: { tools: [{ modelVisibleName: 'read_file', executionScopes: ['main'], effect: 'read' }] }, budget: {} };
  manifest.metricsHash = hash({ metrics: manifest.metrics, applicability: 'explicit-null-not-applicable-v1', scorerHash: manifest.scorerHash });
  if (official) Object.assign(manifest, official);
  const trials = selection.flatMap((task, i) => Array.from({ length: 3 }, (_, repeat) => ({
    taskId: task.id, clusterId: task.clusterId, repeat, status: 'scored', latencyMs: 100,
    metrics: { [metric]: scores[i] }, usage: structuredClone(usage), toolSchemaHash: hash('test-only-schema'),
    runtimeVerification: { status: 'verified', contractHash: hash(contract),
      finalAnswerHash: hash('test-only-answer'), evidenceHash: hash('test-only-runtime') }
  })));
  return { path, manifest, trials };
}
function copy(run) {
  const path = fresh('run');
  return { path, manifest: { ...structuredClone(run.manifest), runId: hash(path) }, trials: structuredClone(run.trials) };
}
function save(run) {
  writeJson(join(run.path, 'manifest.json'), run.manifest);
  writeJson(join(run.path, 'trials.json'), run.trials);
  sealRun(run.path, summarize(run.manifest, run.trials));
  return inspectRun(run.path);
}
function register(baseline, acceptance = {}) {
  const incident = captureIncident({ runPath: baseline.path, analysis: { category: 'unknown',
    observation: 'Test-only eligibility observation.', hypothesis: 'Test-only evaluator hypothesis.',
    proposedChange: 'No production change.', expectedOutcome: 'Enforce frozen gates.' }, outputRoot: join(root, 'incidents') });
  const spec = experimentSpecSchema.parse({ schemaVersion: 1, title: 'Test-only eligibility protocol',
    hypothesis: 'Counterexample records must not bypass acceptance.', incidents: [incident.directory], allowedChanges: [],
    acceptance: { nonInferiorityMargin: .05, absoluteFloors: { [baseline.manifest.metrics[0]]: .5 },
      trialFloors: {}, primaryMetrics: baseline.manifest.metrics, resourceCeilings: { costUsd: 1 }, ...acceptance } });
  const path = fresh('protocol');
  writeProtocolRecord(join(path, 'protocol.json'), 'protocol', { comparisonProtocolVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z', spec, baseline: { path: baseline.path, sealHash: baseline.sealHash },
    candidateSource: structuredClone(source), changedFiles: [], toolSchemaHash: baseline.trials[0].toolSchemaHash,
    incidents: [{ path: incident.directory, recordHash: incident.recordHash }] });
  return path;
}
function claimAndSave(run, protocol) {
  const context = claimExperiment(protocol, run.path, run.manifest, { arm: 'candidate' });
  run.manifest.experiment = context.binding;
  assertExperimentManifest(context, run.manifest);
  return save(run);
}
function registeredPair({ scores, evidence, acceptance, mutate = () => {} } = {}) {
  const left = draft({ scores, evidence }), right = copy(left);
  mutate(left, right);
  const baseline = save(left), protocol = register(baseline, acceptance), candidate = claimAndSave(right, protocol);
  return { baseline, candidate, protocol };
}
function cliCompare({ baseline, candidate, protocol }, registered = true) {
  const result = spawnSync(process.execPath, [join(ROOT, 'evaluation/lib/cli.mjs'), 'compare', baseline.path, candidate.path,
    '--output-root', join(root, 'comparisons'), ...(registered ? ['--protocol', protocol] : [])],
  { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '', result.stderr);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

let scienceInputs;
async function syntheticScience() {
  scienceInputs ??= (async () => {
    const fixture = await scienceFixture(fresh('science-inputs')), originalInventory = fileInventory(fixture.source);
    const input = fresh('five-cluster-input'), metadataPath = join(input, 'verified.json');
    const metadata = [], clusters = [];
    for (let i = 0; clusters.length < 5; i++) {
      const name = `synthetic-independent-repo-${i}`;
      if (parseInt(hash(name).slice(0, 8), 16) % 5 !== 0) clusters.push(name);
    }
    const template = readJson(join(fixture.source, 'verified.json'))[0];
    clusters.forEach((github_name, i) => metadata.push({ ...template, instance_id: i + 1, github_name }));
    writeJson(metadataPath, metadata);
    const recipe = { ...fixture.recipe, sourceRevision: 'self-declared-official-revision',
      metadataSha256: sha256(readFileSync(metadataPath)), tasks: metadata.map(row => ({ ...fixture.recipe.tasks[0],
        id: String(row.instance_id), ...Object.fromEntries(['publicDir', 'hiddenDir', 'verifierDir', 'calibrationDir']
          .map(key => [key, resolve(fixture.source, fixture.recipe.tasks[0][key])])) })) };
    const recipePath = join(input, 'recipe.json'); writeJson(recipePath, recipe);
    const bundlePath = join(fixture.source, 'benchmark_verified.zip');
    const dataset = loadDataset(prepareScience(metadataPath, recipePath, bundlePath, { cacheRoot: join(input, 'cache') }));
    return { fixture, originalInventory, dataset, recipePath, metadataPath, bundlePath };
  })();
  return scienceInputs;
}

// Create the shared fixture at file scope so its venv cleanup belongs to the
// whole test file rather than the first test that consumes it.
await syntheticScience();

test('offline: synthetic Science with five clusters and three repeats cannot earn quality eligibility', async () => {
  const { dataset } = await syntheticScience();
  assert.equal(dataset.tasks.length, 5);
  assert.equal(new Set(dataset.tasks.map(task => task.clusterId)).size, 5);
  assert.ok(dataset.tasks.every(task => task.split === 'development'));
  const left = draft({ dataset, scores: [1, 1, 1, 1, 1] });
  // Reproduce a legacy manifest: local recipe, arbitrary revision and live-model label.
  delete left.manifest.datasetProvenance.kind;
  const baseline = save(left), candidate = save(copy(left));
  assert.equal(baseline.summary.status, 'complete');
  assert.equal(candidate.summary.status, 'complete');
  assert.ok([baseline, candidate].every(hasApplicationRuntimeEvidence));
  assert.notEqual(baseline.sealHash, candidate.sealHash);
  const comparison = compareRuns(baseline, candidate);
  assert.equal(comparison.conclusion, 'insufficient');
  assert.equal(comparison.qualityEvidence, false);
  assert.equal(comparison.reason, 'science_quality_provenance_unverified');
  assert.equal(comparison.metrics.successRate.baseline, 1);
  assert.equal(comparison.metrics.successRate.candidate, 1);
  assert.equal(comparison.metrics.successRate.confidence95, null);
  assert.equal(comparison.perTask.length, 5);
  assert.equal(comparison.releaseEligible, false);
});

test('offline: Science import and actual calibration remain engineering diagnostics without changing input bytes', async () => {
  const { fixture, originalInventory, dataset, recipePath, metadataPath, bundlePath } = await syntheticScience();
  const inputs = [recipePath, metadataPath, bundlePath, join(dataset.root, 'dataset.json')];
  const before = inputs.map(path => readFileSync(path));
  assert.equal(dataset.manifest.provenance.kind, 'engineering_fixture');
  assert.equal(dataset.manifest.provenance.sourceRevision, 'self-declared-official-revision');
  const preflight = await sciencePreflight(dataset, [dataset.tasks[0]], fresh('calibration'));
  assert.equal(preflight.evidenceKind, 'engineering-fixture');
  assert.equal(preflight.backend, 'macos-local-python-v2');
  assert.equal(preflight.calibration.length, 5);
  assert.ok(preflight.calibration.every(entry => entry.expected === entry.observed));
  assert.deepEqual(inputs.map(path => readFileSync(path)), before);
  assert.deepEqual(fileInventory(fixture.source), originalInventory);
  assert.equal(loadDataset(dataset.root).manifest.identity, dataset.manifest.identity);
});

test('offline: self-declared Science source and review flags cannot unlock adoption or alter sealed runs', async () => {
  const { dataset } = await syntheticScience();
  for (const provenance of [undefined, { ...dataset.manifest.provenance, sourceRevision: 'a'.repeat(40) },
    { ...dataset.manifest.provenance, kind: 'human_reviewed', review: { draft: 0 }, official: true }]) {
    const left = draft({ dataset, scores: [1, 1, 1, 1, 1] });
    left.manifest.datasetProvenance = provenance;
    left.manifest.datasetReview = { schemaVersion: 1, status: 'reviewed', producer: 'test-only-producer',
      tasks: left.manifest.selection.map(task => ({ ...task, annotations: ['test-only-a', 'test-only-b'].map(reviewer => ({
        reviewer, reviewedAt: '2026-01-01T00:00:00.000Z', contentHash: task.contentHash, judgmentHash: hash('test-only-judgment')
      })), arbitration: null })) };
    const right = copy(left), baseline = save(left), protocol = register(baseline), candidate = claimAndSave(right, protocol);
    const before = [baseline, candidate].map(run => fileInventory(run.path));
    const comparison = compareRuns(baseline, candidate, { protocol });
    assert.equal(comparison.conclusion, 'insufficient');
    assert.equal(comparison.acceptance.status, 'blocked');
    assert.equal(assessExperiment(protocol).status, 'blocked');
    assert.throws(() => recordExperimentDecision(protocol, { decision: 'adopt', reviewer: 'test-only-reviewer',
      rationale: 'Test-only attempted bypass.', reviewedTrials: [{ taskId: candidate.trials[0].taskId, repeat: 0,
        finding: 'Test-only synthetic receipt.' }] }), /experiment_not_eligible_for_adoption/);
    assert.deepEqual([baseline, candidate].map(run => fileInventory(run.path)), before);
    assert.equal(inspectRun(baseline.path).sealHash, baseline.sealHash);
    assert.equal(inspectRun(candidate.path).sealHash, candidate.sealHash);
  }
});

officialQasperTest('offline: compare CLI rejects a frozen absolute floor despite statistical noninferiority', () => {
  const pair = registeredPair({ scores: [.4, .4, .4, .4, .4] });
  const { status, report } = cliCompare(pair);
  assert.equal(report.conclusion, 'non-inferior');
  assert.equal(report.acceptance.status, 'rejected');
  assert.ok(report.acceptance.reasons.includes('absolute_quality_floor'));
  assert.equal(status, 3);
});

officialQasperTest('offline: compare CLI rejects unknown cost despite statistical noninferiority', () => {
  const pair = registeredPair({ mutate: (_left, right) => right.trials.forEach(trial => {
    Object.assign(trial.usage, { costUsd: null, knownCostUsd: 0, unknownCostRequests: 1 });
  }) });
  const { status, report } = cliCompare(pair);
  assert.equal(report.conclusion, 'non-inferior');
  assert.equal(report.acceptance.status, 'rejected');
  assert.equal(report.acceptance.resources.ceilings.costUsd.reason, 'measurement_unknown');
  assert.equal(status, 3);
});

officialQasperTest('offline: compare CLI rejects a frozen trial floor despite statistical noninferiority', () => {
  const pair = registeredPair({ scores: [1, 1, 1, 1, 0], acceptance: { trialFloors: { answerF1: .5 } } });
  const { status, report } = cliCompare(pair);
  assert.equal(report.conclusion, 'non-inferior');
  assert.equal(report.acceptance.status, 'rejected');
  assert.ok(report.acceptance.reasons.includes('per_trial_quality_floor'));
  assert.equal(status, 3);
});

officialQasperTest('offline: compare CLI succeeds only when registered acceptance is eligible', () => {
  for (const superior of [false, true]) {
    const pair = registeredPair({ mutate: (_left, right) => {
      if (superior) right.trials.forEach(trial => { trial.metrics.answerF1 = .9; });
    } });
    const { status, report } = cliCompare(pair);
    assert.equal(report.conclusion, superior ? 'superior' : 'non-inferior');
    assert.equal(report.acceptance.status, 'eligible');
    assert.equal(report.releaseEligible, false);
    assert.equal(status, 0);
  }
});

officialQasperTest('offline: compare CLI maps registered blocked acceptance to two and preserves ordinary statistical exits', () => {
  const pair = registeredPair({ acceptance: { absoluteFloors: { answerF1: .1 } },
    mutate: (left, right) => {
      left.trials.forEach(trial => { trial.metrics.answerF1 = .5; });
      right.trials.forEach(trial => { trial.metrics.answerF1 = [.3, .5, .7, .6, .4]
        [right.manifest.selection.findIndex(task => task.id === trial.taskId)]; });
    } });
  const registered = cliCompare(pair), ordinary = cliCompare(pair, false);
  assert.equal(registered.report.conclusion, 'inconclusive');
  assert.equal(registered.report.acceptance.status, 'blocked');
  assert.equal(registered.status, 2);
  assert.equal(ordinary.report.conclusion, 'inconclusive');
  assert.equal(ordinary.report.acceptance, undefined);
  assert.equal(ordinary.status, 3);
  const fixture = cliCompare(registeredPair({ evidence: 'fixture' }));
  assert.equal(fixture.report.conclusion, 'insufficient');
  assert.equal(fixture.report.acceptance.status, 'blocked');
  assert.equal(fixture.status, 2);
});
