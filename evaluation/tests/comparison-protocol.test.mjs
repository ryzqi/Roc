import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { directory, fileInventory, hash, readJson, writeJson } from '../lib/common.mjs';
import { compareRuns, inspectRun, renderComparisonReport, sealRun, summarize, writeComparisonReport } from '../lib/report.mjs';
import { assessAcceptance, assessResourceGates, comparisonFields, hasApplicationRuntimeEvidence,
  hasRagRuntimeEvidence, hasRagSourceBoundaryEvidence, hasReviewedRetrievalProvenance,
  metricState, validMetrics, writeProtocolRecord } from '../lib/comparison.mjs';
import { compareAblation } from '../lib/ablation.mjs';
import { assertExperimentManifest, assertExperimentToolSchema, assertExperimentUnchanged, assessExperiment,
  captureIncident, claimExperiment, experimentSpecSchema, inspectExperiment, recordExperimentDecision,
  resumeExperiment } from '../lib/experiment.mjs';
import { summarizeResources, trialDiagnostics } from '../lib/analysis.mjs';
import { testArtifacts } from './test-artifacts.mjs';
import { officialQasperFields, officialQasperTest } from './qasper-official.mjs';

// Synthetic scores/receipts and reviewed annotations below test evaluator counterexamples.
// They are not production retrieval results, audited data, or holdout evidence.
// QASPER qualification positives use independently pinned real local official data.
// No sourceIdentity(), model, worker, embedding service or CLI runs in this file.
const root = testArtifacts('comparison-protocol');
const fresh = name => realpathSync(directory(root, name));
const source = { sourceHash: hash('test-source'), files: [{ path: 'src/test-only.ts', sha256: hash('test-bytes') }],
  lockfileHash: hash('test-lockfile') };
const applicationContract = { schemaVersion: 2, answerBoundary: 'test-only-frozen-answer',
  responseRequirements: 'optional-json-schema-bound-to-frozen-task-inputs' };
const retrievalConfig = { mode: 'bm25', rerank: 'none', candidateLimit: 50, topK: 20, contextMaxChars: 6000 };
const descriptor = toolBoundary => ({ version: 1, runtime: 'roc-research-repository-embedding-service',
  sourceMapping: 'source-version-sha256-parser-utf16-v1', toolBoundary, verification: 'sqlite-source-ranking-context-transport-v1' });
const ragContract = component => {
  const value = descriptor(component ? 'host-component-request-bound-to-capability-receipt-v1'
    : 'checkpoint-tool-message-bound-to-host-capability-receipt-v1');
  return { ...value, hash: hash(value) };
};
const usage = overrides => ({ requests: 2, inputTokens: 100, outputTokens: 10, totalTokens: 110,
  knownInputTokens: 100, knownOutputTokens: 10, costUsd: .002, knownCostUsd: .002,
  unknownUsageRequests: 0, unknownCostRequests: 0, pendingRequests: 0, usageState: 'measured',
  pricingRevision: 'test-price-v1', ...overrides });
function reviewFor(selection) {
  return { schemaVersion: 1, status: 'reviewed', producer: 'test-producer',
    tasks: selection.map(task => ({ id: task.id, contentHash: task.contentHash,
      annotations: ['test-reviewer-a', 'test-reviewer-b'].map(reviewer => ({ reviewer,
        reviewedAt: '2026-01-01T00:00:00.000Z', contentHash: task.contentHash, judgmentHash: hash(`judgment:${task.id}`) })),
      arbitration: null })) };
}
function draft({ suite = 'qasper', evidence = suite === 'rag-retrieval' ? 'production-component' : 'live-model',
  clusters = 5, repeats = 3, metrics = ['answerF1', 'citationValidity'], values = {} } = {}) {
  const path = fresh('run');
  const official = suite === 'qasper' ? officialQasperFields(clusters) : null;
  const selection = official?.selection ?? Array.from({ length: clusters }, (_, i) => ({ id: `task${i}`, clusterId: `source${i}`,
    contentHash: hash({ visible: { question: `test ${i}` }, expected: { answer: `test answer ${i}` } }) }));
  const manifest = { schemaVersion: 1, runId: hash(path), suite, evidence, profile: 'full', selection, repeats, metrics,
    datasetIdentity: hash('test-dataset'), split: 'development', exclusions: [], source: structuredClone(source),
    provider: { model: 'test-only-no-model-invoked', temperature: 0 }, scorerHash: hash('test-scorer'),
    taskSchemaHash: hash('test-task-schema'), environment: { node: process.version, lockfileHash: source.lockfileHash },
    executionPolicy: { concurrency: 1, isolation: 'test-only' }, permissions: { worker: 'isolated', host: 'read-only', externalTools: false },
    retrievalConfig: structuredClone(retrievalConfig), retrievalProvider: { configHash: hash('test-retrieval-provider') },
    toolManifest: { schemaVersion: 1, tools: [{ modelVisibleName: 'read_file', effect: 'read', executionScopes: ['main'] }] },
    budget: {}, finalAnswerContract: { format: 'test-json-v1' }, testOnly: true };
  manifest.metricsHash = hash({ metrics, applicability: 'explicit-null-not-applicable-v1', scorerHash: manifest.scorerHash });
  if (official) Object.assign(manifest, official);
  if (suite !== 'rag-retrieval') manifest.applicationContract = structuredClone(applicationContract);
  if (['rag-retrieval', 'rag-paper-qa'].includes(suite)) {
    manifest.ragContract = ragContract(suite === 'rag-retrieval');
    manifest.datasetProvenance = { kind: 'human_reviewed', review: { draft: 0 } };
    manifest.datasetReview = reviewFor(selection);
  }
  if (suite === 'rag-retrieval') manifest.provider = null;
  const trials = selection.flatMap(task => Array.from({ length: repeats }, (_, repeat) => ({ taskId: task.id,
    clusterId: task.clusterId, repeat, status: 'scored', latencyMs: 100, retrievalLatencyMs: 10,
    toolSchemaHash: hash('test-schema'), usage: usage(),
    metrics: Object.fromEntries(metrics.map(metric => [metric, values[metric] ?? (['wrongSourceRate', 'staleHitRate'].includes(metric)
      ? 0 : metric === 'citationValidity' ? 1 : .8)])),
    ...(manifest.applicationContract ? { runtimeVerification: { status: 'verified', contractHash: hash(manifest.applicationContract),
      finalAnswerHash: hash('test-answer'), evidenceHash: hash('test-runtime-evidence') } } : {}),
    ...(manifest.ragContract ? { ragVerification: { status: 'verified', contractHash: manifest.ragContract.hash,
      evidenceHash: hash('test-rag-evidence') } } : {}) })));
  return { path, manifest, trials };
}
function copy(run) {
  const path = fresh('run');
  return { path, manifest: { ...structuredClone(run.manifest), runId: hash(path) }, trials: structuredClone(run.trials),
    ...(run.hostUsage ? { hostUsage: structuredClone(run.hostUsage) } : {}) };
}
function save(run) {
  writeJson(join(run.path, 'manifest.json'), run.manifest);
  writeJson(join(run.path, 'trials.json'), run.trials);
  sealRun(run.path, summarize(run.manifest, run.trials, run.fatal ?? null, run.hostUsage ?? null));
  return inspectRun(run.path);
}
function pair(options = {}, mutate = () => {}) {
  const baseline = draft(options), candidate = copy(baseline);
  mutate(baseline, candidate);
  return [save(baseline), save(candidate)];
}
function markNA(run, taskIds, metric) {
  for (const trial of run.trials.filter(trial => taskIds.includes(trial.taskId))) {
    trial.metrics[metric] = null;
    trial.metricApplicability = { ...trial.metricApplicability, [metric]: 'not_applicable' };
  }
}
function register(seed, overrides = {}, recordOverrides = {}) {
  const incident = captureIncident({ runPath: seed.path, analysis: { category: 'unknown',
    observation: 'Test-only evaluator observation.', hypothesis: 'Test-only falsifiable hypothesis.',
    proposedChange: 'No production changes.', expectedOutcome: 'Validate the evaluator.' },
  outputRoot: join(root, 'incidents') });
  const acceptance = { nonInferiorityMargin: .05,
    absoluteFloors: Object.fromEntries(seed.manifest.metrics.map(metric => [metric, ['wrongSourceRate', 'staleHitRate'].includes(metric) ? 0 : .5])),
    trialFloors: {}, primaryMetrics: [seed.manifest.metrics[0]], resourceCeilings: { costUsd: 1 } };
  const spec = experimentSpecSchema.parse({ schemaVersion: 1, title: 'Test-only registered protocol',
    hypothesis: 'Tests contract gates only.', incidents: [incident.directory], allowedChanges: [], acceptance, ...overrides });
  const path = fresh('protocol');
  const protocol = writeProtocolRecord(join(path, 'protocol.json'), 'protocol', { comparisonProtocolVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z', spec, incidents: [{ path: incident.directory, recordHash: incident.recordHash }],
    baseline: { path: seed.path, sealHash: seed.sealHash }, candidateSource: structuredClone(source),
    changedFiles: [], toolSchemaHash: seed.trials[0].toolSchemaHash, ...recordOverrides });
  return { directory: path, protocolHash: protocol.recordHash, protocol, spec };
}
function armDraft(seed, registration, arm) {
  const run = copy(seed), declaration = registration.spec.ablation;
  if (declaration?.retrievalConfig) run.manifest.retrievalConfig = structuredClone(declaration.retrievalConfig[arm]);
  if (declaration?.capabilities) run.manifest.toolManifest = structuredClone(declaration.capabilities[arm].toolManifest);
  const context = claimExperiment(registration.directory, run.path, run.manifest, { arm });
  run.manifest.experiment = context.binding;
  run.trials.forEach(trial => { trial.toolSchemaHash = context.expected.toolSchemaHash; });
  assertExperimentManifest(context, run.manifest);
  assertExperimentToolSchema(context, context.expected.toolSchemaHash);
  return { run, context };
}
const retrievalMetrics = ['recall20', 'ndcg10', 'evidenceChainRecall20', 'wrongSourceRate', 'staleHitRate'];
const ablationDeclaration = () => ({ retrievalConfig: { baseline: structuredClone(retrievalConfig),
  candidate: { ...retrievalConfig, mode: 'hybrid' } } });
function rewriteRecord(path, mutate) {
  const record = readJson(path); mutate(record);
  const { recordHash, ...payload } = record;
  writeFileSync(path, JSON.stringify({ ...payload, recordHash: hash(payload) }) + '\n');
}

test('pure: only explicitly not_applicable null metrics are legal', () => {
  const valid = [{ metrics: { recall20: .5 } }, { metrics: { recall20: 0 }, metricApplicability: { recall20: 'measured' } },
    { metrics: { recall20: null }, metricApplicability: { recall20: 'not_applicable' } }];
  valid.forEach(trial => assert.equal(validMetrics(trial, ['recall20']), true));
  assert.equal(metricState(valid[2], 'recall20'), 'not_applicable');
  for (const trial of [{ metrics: { recall20: null } }, { metrics: {} }, { metrics: { recall20: NaN } },
    { metrics: { recall20: Infinity } }, { metrics: { recall20: -.1 } }, { metrics: { recall20: 1.01 } },
    { metrics: { recall20: 1 }, metricApplicability: { recall20: 'not_applicable' } },
    { metrics: { recall20: null }, metricApplicability: { recall20: 'measured' } },
    { metrics: { recall20: null }, metricApplicability: { recall20: 'unknown' } },
    { metrics: { recall20: .5 }, metricApplicability: null }, { metrics: { recall20: .5 }, metricApplicability: [] },
    { metrics: { recall20: .5 }, metricApplicability: { missing: 'not_applicable' } }]) {
    assert.equal(validMetrics(trial, ['recall20']), false, JSON.stringify(trial));
  }
});
test('pure: summaries report applicable counts and never impute NA or unmarked null', () => {
  const run = draft({ metrics: ['recall20', 'answerF1'], values: { recall20: .75 } });
  markNA(run, [run.manifest.selection[0].id], 'recall20');
  const summary = summarize(run.manifest, run.trials);
  assert.equal(summary.status, 'complete');
  assert.equal(summary.metrics.recall20, .75);
  assert.deepEqual(summary.metricCounts.recall20, { n: 12, notApplicable: 3, invalid: 0 });
  assert.deepEqual(summary.metricCounts.answerF1, { n: 15, notApplicable: 0, invalid: 0 });
  delete run.trials[0].metricApplicability;
  const invalid = summarize(run.manifest, run.trials);
  assert.equal(invalid.status, 'incomplete');
  assert.equal(invalid.metricCounts.recall20.invalid, 1);
  assert.deepEqual(invalid.metricValidation.invalidTrials[0].invalidMetrics, ['recall20']);
  markNA(run, run.manifest.selection.map(task => task.id), 'recall20');
  const absent = summarize(run.manifest, run.trials);
  assert.equal(absent.metrics.recall20, null);
  assert.deepEqual(absent.metricCounts.recall20, { n: 0, notApplicable: 15, invalid: 0 });
  assert.equal(summarize(run.manifest, [...run.trials, run.trials[0]]).trialSetValid, false);
});
test('pure: applicability is fixed across both arms and every repeat of a task', () => {
  for (const mutation of [(a, b) => markNA(b, [b.manifest.selection[0].id], 'answerF1'), (a, b) => {
    for (const run of [a, b]) { run.trials[0].metrics.answerF1 = null; run.trials[0].metricApplicability = { answerF1: 'not_applicable' }; }
  }]) {
    const [baseline, candidate] = pair({}, mutation), comparison = compareRuns(baseline, candidate);
    assert.equal(comparison.conclusion, 'incompatible');
    assert.deepEqual(comparison.mismatches, ['metricApplicability']);
    assert.match(comparison.reason, /metric_applicability_(mismatch|changed_within_task)/);
  }
});
officialQasperTest('pure: each metric requires five applicable independent clusters; NA tasks cannot inflate the sample', () => {
  const [baseline, candidate] = pair({ clusters: 7 }, (a, b) => {
    [a, b].forEach(run => markNA(run, run.manifest.selection.slice(0, 3).map(task => task.id), 'answerF1'));
  });
  const comparison = compareRuns(baseline, candidate);
  assert.equal(comparison.clusters, 7);
  assert.equal(comparison.metrics.answerF1.sampleSize.clusters, 4);
  assert.equal(comparison.metrics.answerF1.sampleSize.pairedTrials, 12);
  assert.equal(comparison.metrics.answerF1.sampleSize.notApplicableTrials, 9);
  assert.equal(comparison.metrics.answerF1.confidence95, null);
  assert.equal(comparison.metrics.citationValidity.sampleSize.clusters, 7);
  assert.equal(comparison.conclusion, 'insufficient');
  const allNA = pair({}, (a, b) => [a, b].forEach(run => markNA(run, run.manifest.selection.map(task => task.id), 'answerF1')));
  const absent = compareRuns(...allNA);
  assert.equal(absent.metrics.answerF1.delta, null);
  assert.equal(absent.metrics.answerF1.sampleSize.clusters, 0);
  assert.equal(absent.perTask[0].metrics.answerF1.applicability, 'not_applicable');
  assert.equal(absent.perTask[0].trials[0].metrics.answerF1.delta, null);
  const acceptance = { nonInferiorityMargin: .05, absoluteFloors: { answerF1: 0, citationValidity: 1 }, trialFloors: { answerF1: .5 } };
  const gate = assessAcceptance(acceptance, ...allNA, absent);
  assert.equal(gate.absoluteFloors.answerF1.passed, false);
  assert.deepEqual(gate.trialFailures, []);
  assert.equal(gate.status, 'blocked');
});
test('pure: repeated tasks are not independent clusters and registered sample minima only tighten', () => {
  const [baseline, candidate] = pair({}, (a, b) => {
    for (const run of [a, b]) {
      run.manifest.selection.forEach(task => { task.clusterId = 'one-source'; });
      run.trials.forEach(trial => { trial.clusterId = 'one-source'; });
    }
  });
  assert.equal(compareRuns(baseline, candidate).conclusion, 'insufficient');
  assert.equal(compareRuns(...pair({ repeats: 2 })).conclusion, 'insufficient');
  for (const minimum of [{ minimumClusters: 6 }, { minimumRepeats: 4 }]) {
    const seed = save(draft()), registration = register(seed, { acceptance: { nonInferiorityMargin: .05,
      absoluteFloors: { answerF1: .5, citationValidity: 1 }, trialFloors: {}, primaryMetrics: ['answerF1'], ...minimum } });
    const candidate = save(armDraft(seed, registration, 'candidate').run);
    const comparison = compareRuns(seed, candidate, { protocol: registration });
    assert.equal(comparison.conclusion, 'insufficient');
    assert.equal(comparison.acceptance.status, 'blocked');
  }
});
test('pure: ordinary comparison rejects tool/schema and every frozen contract difference', () => {
  const changes = { toolManifest: { tools: [{ modelVisibleName: 'new_tool' }] }, retrievalConfig: { mode: 'hybrid' },
    retrievalProvider: { configHash: hash('changed') }, permissions: { host: 'write' }, provider: { model: 'changed' },
    environment: { node: 'changed' }, executionPolicy: { concurrency: 2 }, metricsHash: hash('changed-metrics'),
    taskSchemaHash: hash('changed-schema'), scorerHash: hash('changed-grader'), finalAnswerContract: { format: 'changed' },
    budget: { maxModelRequests: 999 }, qasperQualification: { status: 'verified', hash: hash('self-declared-qualification') } };
  for (const [field, value] of Object.entries(changes)) {
    assert.ok(comparisonFields.includes(field));
    const [baseline, candidate] = pair({}, (a, b) => { b.manifest[field] = value; });
    const comparison = compareRuns(baseline, candidate, { allowToolChanges: true });
    assert.equal(comparison.conclusion, 'incompatible', field);
    assert.ok(comparison.mismatches.includes(field), field);
  }
  const changedSchema = pair({}, (a, b) => b.trials.forEach(trial => { trial.toolSchemaHash = hash('changed-schema'); }));
  assert.deepEqual(compareRuns(...changedSchema).mismatches, ['toolSchemaHash']);
  const varyingSchema = pair({}, (a, b) => { b.trials[0].toolSchemaHash = hash('varying-schema'); });
  assert.equal(compareRuns(...varyingSchema).reason, 'tool_schema_changed_within_run');
  const missingTools = pair({}, (a, b) => [a, b].forEach(run => { delete run.manifest.toolManifest; }));
  assert.equal(compareRuns(...missingTools).reason, 'tool_contract_evidence_missing');
  const missingSchema = pair({}, (a, b) => [a, b].forEach(run => run.trials.forEach(trial => { delete trial.toolSchemaHash; })));
  assert.equal(compareRuns(...missingSchema).reason, 'tool_contract_evidence_missing');
});
test('pure: unsupported, missing or stale application evidence never becomes quality evidence', () => {
  for (const mutation of [run => { delete run.manifest.applicationContract; }, run => {
    run.manifest.applicationContract.schemaVersion = 3;
    run.trials.forEach(trial => { trial.runtimeVerification.contractHash = hash(run.manifest.applicationContract); });
  }, run => { run.manifest.applicationContract.responseRequirements = 'permissive-v2'; },
  run => { run.trials[0].runtimeVerification.contractHash = hash('stale'); },
  run => { run.trials[0].runtimeVerification.evidenceHash = 'missing'; },
  run => { run.trials[0].runtimeVerification.status = 'invalid'; }]) {
    const [baseline, candidate] = pair({}, (a, b) => [a, b].forEach(mutation));
    assert.equal(hasApplicationRuntimeEvidence(baseline), false);
    assert.equal(compareRuns(baseline, candidate).reason, 'application_runtime_evidence_missing');
  }
  const v1 = draft(); v1.manifest.applicationContract.schemaVersion = 1;
  v1.trials.forEach(trial => { trial.runtimeVerification.contractHash = hash(v1.manifest.applicationContract); });
  assert.equal(hasApplicationRuntimeEvidence(v1), true);
});
test('pure: production retrieval uses independent component evidence without an application checkpoint', () => {
  const [baseline, candidate] = pair({ suite: 'rag-retrieval', metrics: retrievalMetrics });
  assert.equal(baseline.manifest.provider, null);
  assert.equal(baseline.manifest.applicationContract, undefined);
  assert.equal(baseline.trials[0].runtimeVerification, undefined);
  assert.equal(hasRagRuntimeEvidence(baseline), true);
  assert.equal(hasReviewedRetrievalProvenance(baseline.manifest), true);
  const comparison = compareRuns(baseline, candidate);
  assert.equal(comparison.conclusion, 'non-inferior');
  assert.equal(comparison.qualityEvidence, true);
  assert.match(comparison.scope, /component evidence only; no generation/);
  assert.equal(baseline.summary.qualityConclusion, 'component-comparison-required');
  assert.equal(comparison.releaseEligible, false);
});
test('pure: component and E2E RAG contracts cannot substitute for each other', () => {
  for (const suite of ['rag-retrieval', 'rag-paper-qa']) {
    const [baseline, candidate] = pair({ suite, metrics: retrievalMetrics }, (a, b) => {
      for (const run of [a, b]) {
        run.manifest.ragContract = ragContract(suite !== 'rag-retrieval');
        run.trials.forEach(trial => { trial.ragVerification.contractHash = run.manifest.ragContract.hash; });
      }
    });
    assert.equal(hasRagRuntimeEvidence(baseline), false);
    assert.equal(compareRuns(baseline, candidate).reason, 'rag_runtime_evidence_missing');
  }
  const [baseline, candidate] = pair({ suite: 'rag-paper-qa', metrics: retrievalMetrics, evidence: 'production-component' });
  assert.equal(hasRagRuntimeEvidence(baseline), true);
  assert.equal(compareRuns(baseline, candidate).conclusion, 'insufficient');
  const missingApp = pair({ suite: 'rag-paper-qa', metrics: retrievalMetrics }, (a, b) => [a, b].forEach(run => {
    delete run.manifest.applicationContract; delete run.trials[0].runtimeVerification;
  }));
  assert.equal(compareRuns(...missingApp).reason, 'application_runtime_evidence_missing');
});
test('pure: RAG runtime hashes and zero source boundary evidence are mandatory', () => {
  for (const suite of ['rag-retrieval', 'rag-paper-qa']) {
    for (const mutation of [run => { run.trials[0].ragVerification.contractHash = hash('stale'); },
      run => { run.trials[0].ragVerification.evidenceHash = null; },
      run => { run.trials[0].ragVerification.status = 'invalid'; },
      run => { run.manifest.ragContract.hash = hash('incorrect'); },
      run => {
        const legacy = { ...run.manifest.ragContract, verification: 'sqlite-source-ranking-context-v1' };
        delete legacy.hash;
        run.manifest.ragContract = { ...legacy, hash: hash(legacy) };
        run.trials.forEach(trial => { trial.ragVerification.contractHash = run.manifest.ragContract.hash; });
      }]) {
      const [baseline, candidate] = pair({ suite, metrics: retrievalMetrics }, (a, b) => [a, b].forEach(mutation));
      assert.equal(hasRagRuntimeEvidence(baseline), false);
      assert.equal(hasRagRuntimeEvidence(candidate), false);
      assert.equal(compareRuns(baseline, candidate).reason, 'rag_runtime_evidence_missing');
    }
  }
  for (const metric of ['wrongSourceRate', 'staleHitRate']) {
    for (const value of [null, .01]) {
      const [baseline, candidate] = pair({ suite: 'rag-retrieval', metrics: retrievalMetrics }, (a, b) => {
        for (const run of [a, b]) {
          run.trials[0].metrics[metric] = value;
          if (value === null) run.trials[0].metricApplicability = { [metric]: 'not_applicable' };
        }
      });
      assert.equal(hasRagSourceBoundaryEvidence(baseline), false);
      assert.equal(compareRuns(baseline, candidate).reason, 'rag_source_boundary_evidence_missing_or_violated');
    }
  }
});
test('pure: retrieval provenance requires content-bound independent reviews and arbitration', () => {
  const mutations = [manifest => { manifest.datasetProvenance.kind = 'synthetic'; },
    manifest => { manifest.datasetProvenance.review.draft = 1; }, manifest => { manifest.datasetReview.status = 'draft'; },
    manifest => { manifest.datasetReview.tasks[0].annotations[0].reviewer = ' TEST-PRODUCER '; },
    manifest => { manifest.datasetReview.tasks[0].annotations[1].reviewer = 'TEST-REVIEWER-A'; },
    manifest => { manifest.datasetReview.tasks[0].annotations[0].contentHash = hash('wrong-content'); },
    manifest => { manifest.selection[0].contentHash = hash('selection-drift'); },
    manifest => { manifest.datasetReview.tasks[0].annotations[0].reviewedAt = 'unknown'; },
    manifest => { manifest.datasetReview.tasks[0].annotations[0].judgmentHash = hash('disagree'); }];
  for (const mutate of mutations) {
    const [baseline, candidate] = pair({ suite: 'rag-retrieval', metrics: retrievalMetrics }, (a, b) => [a, b].forEach(run => mutate(run.manifest)));
    assert.equal(hasReviewedRetrievalProvenance(baseline.manifest), false);
    const comparison = compareRuns(baseline, candidate);
    assert.equal(comparison.qualityEvidence, false);
    assert.equal(comparison.conclusion, 'insufficient');
  }
  const reviewed = draft({ suite: 'rag-retrieval', metrics: retrievalMetrics });
  const task = reviewed.manifest.datasetReview.tasks[0];
  task.annotations[0].judgmentHash = hash('disagree');
  task.arbitration = { reviewer: 'test-arbitrator', reviewedAt: '2026-01-02T00:00:00.000Z',
    contentHash: task.contentHash, resolution: 'Test-only resolution.' };
  assert.equal(hasReviewedRetrievalProvenance(reviewed.manifest), true);
  task.arbitration.reviewer = 'test-reviewer-a';
  assert.equal(hasReviewedRetrievalProvenance(reviewed.manifest), false);
});
test('pure: fixtures and controlled RAG remain unadoptable even with sufficient clusters', () => {
  for (const evidence of ['fixture', 'engineering-fixture', 'controlled-rag', 'live-model']) {
    const [baseline, candidate] = pair({ suite: 'rag-retrieval', metrics: retrievalMetrics, evidence });
    const comparison = compareRuns(baseline, candidate);
    assert.equal(comparison.conclusion, 'insufficient');
    assert.equal(comparison.qualityEvidence, false);
    assert.equal(comparison.releaseEligible, false);
  }
  assert.equal(compareRuns(...pair({ evidence: 'fixture' })).conclusion, 'insufficient');
});
test('pure: live E2E RAG never upgrades synthetic, draft or missing dataset reviews to quality evidence', () => {
  const reviewed = pair({ suite: 'rag-paper-qa', metrics: retrievalMetrics });
  assert.equal(compareRuns(...reviewed).conclusion, 'non-inferior');
  for (const mutate of [
    manifest => { manifest.datasetProvenance.kind = 'engineering_fixture'; },
    manifest => { manifest.datasetProvenance.kind = 'synthetic'; },
    manifest => { manifest.datasetProvenance.review.draft = 1; },
    manifest => { manifest.datasetReview.status = 'draft'; },
    manifest => { delete manifest.datasetReview; }
  ]) {
    const runs = pair({ suite: 'rag-paper-qa', metrics: retrievalMetrics }, (a, b) =>
      [a, b].forEach(run => mutate(run.manifest)));
    const comparison = compareRuns(...runs);
    assert.equal(comparison.conclusion, 'insufficient');
    assert.equal(comparison.qualityEvidence, false);
    assert.equal(comparison.releaseEligible, false);
  }
});
officialQasperTest('pure: superiority requires a durable primary; noninferiority never means release', () => {
  const seed = save(draft()), registration = register(seed), { run } = armDraft(seed, registration, 'candidate');
  run.trials.forEach(trial => { trial.metrics.answerF1 = .9; });
  const candidate = save(run), ordinary = compareRuns(seed, candidate, { primaryMetrics: ['answerF1'] });
  assert.equal(ordinary.conclusion, 'non-inferior');
  assert.equal(ordinary.metrics.answerF1.superiority, undefined);
  const registered = compareRuns(seed, candidate, { protocol: registration });
  assert.equal(registered.conclusion, 'superior');
  assert.ok(registered.metrics.answerF1.superiority.benefitConfidence.low > 0);
  assert.equal(registered.acceptance.status, 'eligible');
  assert.equal(registered.releaseEligible, false);
  assert.throws(() => compareRuns(seed, candidate, { protocol: registration.spec }), /protocol_reference_required/);
  for (const margin of [-.01, .06, NaN]) assert.throws(() => compareRuns(seed, candidate, { margin }), /margin_invalid/);
  assert.throws(() => compareRuns(seed, candidate, { margin: .01, protocol: registration }), /protocol_margin_mismatch/);
  assert.throws(() => compareRuns(seed, candidate, { protocol: { ...registration, protocolHash: hash('wrong') } }), /protocol_changed/);
});
officialQasperTest('pure: fixed-sequence superiority stops at the first unsupported primary', () => {
  const seed = save(draft({ values: { citationValidity: .8 } }));
  const registration = register(seed, { acceptance: { nonInferiorityMargin: .05,
    absoluteFloors: { answerF1: .5, citationValidity: .5 }, trialFloors: {},
    primaryMetrics: ['answerF1', 'citationValidity'], multiplicity: 'fixed-sequence' } });
  const { run } = armDraft(seed, registration, 'candidate');
  run.trials.forEach(trial => { trial.metrics.citationValidity = 1; });
  const comparison = compareRuns(seed, save(run), { protocol: registration });
  assert.equal(comparison.metrics.answerF1.superiority.supported, false);
  assert.equal(comparison.metrics.citationValidity.superiority.tested, false);
  assert.equal(comparison.metrics.citationValidity.superiority.supported, false);
  assert.equal(comparison.conclusion, 'non-inferior');
  assert.equal(comparison.multiplicity.quality, 'bonferroni');
});
officialQasperTest('pure: multiple primary superiority uses the registered Bonferroni policy', () => {
  const seed = save(draft({ values: { citationValidity: .8 } }));
  const registration = register(seed, { acceptance: { nonInferiorityMargin: .05,
    absoluteFloors: { answerF1: .5, citationValidity: .5 }, trialFloors: {},
    primaryMetrics: ['answerF1', 'citationValidity'], multiplicity: 'bonferroni' } });
  const { run } = armDraft(seed, registration, 'candidate');
  run.trials.forEach(trial => { trial.metrics = { answerF1: .9, citationValidity: .9 }; });
  const comparison = compareRuns(seed, save(run), { protocol: registration });
  assert.equal(comparison.conclusion, 'superior');
  assert.equal(comparison.multiplicity.superiority, 'bonferroni');
  assert.ok(Object.values(comparison.metrics).every(metric => metric.superiority.supported));
});
officialQasperTest('pure: low-to-low quality and per-trial defects fail frozen floors despite noninferiority', () => {
  const [baseline, candidate] = pair({ values: { answerF1: .4 } });
  const acceptance = { nonInferiorityMargin: .05, absoluteFloors: { answerF1: .7, citationValidity: 1 }, trialFloors: {} };
  const comparison = compareRuns(baseline, candidate), gate = assessAcceptance(acceptance, baseline, candidate, comparison);
  assert.equal(comparison.conclusion, 'non-inferior');
  assert.equal(gate.status, 'rejected');
  assert.ok(gate.reasons.includes('absolute_quality_floor'));
  const defect = pair({}, (a, b) => { b.trials[0].metrics.citationValidity = .9; });
  const strict = assessAcceptance({ ...acceptance, absoluteFloors: { answerF1: .7, citationValidity: .9 },
    trialFloors: { citationValidity: 1 } }, ...defect, compareRuns(...defect));
  assert.equal(strict.trialFailures.length, 1);
  assert.equal(strict.status, 'rejected');
});
test('pure: resource distributions use recorded values and explicit successful outcomes only', () => {
  const run = draft();
  run.trials.forEach((trial, i) => { const n = i + 1;
    trial.usage = usage({ requests: n, inputTokens: n * 100, outputTokens: n * 10, totalTokens: n * 110,
      knownInputTokens: n * 100, knownOutputTokens: n * 10, costUsd: n / 1000, knownCostUsd: n / 1000 });
    trial.success = i % 2 === 0;
  });
  const result = summarizeResources(run.trials);
  assert.equal(result.requests.total, 120);
  assert.equal(result.requests.p50, 8);
  assert.equal(result.requests.p95, 15);
  assert.equal(result.inputTokens.mean, 800);
  assert.equal(result.costUsd.unknown, 0);
  assert.equal(result.successfulTrials, 8);
  assert.equal(result.costPerSuccessfulTaskUsd, result.costUsd.total / 8);
  run.trials.forEach(trial => { delete trial.success; });
  assert.equal(summarizeResources(run.trials).costPerSuccessfulTaskUsd, null);
  run.trials.forEach(trial => { trial.success = false; });
  assert.equal(summarizeResources(run.trials).costPerSuccessfulTaskUsd, null);
  assert.equal(summarizeResources([]).costUsd.total, null);
});
test('pure: unknown and partial host usage never becomes measured cost or a passing cost gate', () => {
  const run = draft();
  run.trials.forEach(trial => { trial.success = true; });
  const host = usage({ requests: 15, inputTokens: null, outputTokens: null, totalTokens: null,
    knownInputTokens: 1400, knownOutputTokens: 140, costUsd: null, knownCostUsd: .028,
    unknownUsageRequests: 1, unknownCostRequests: 1, usageState: 'unknown',
    accounted: { inputTokens: 999999, outputTokens: 999999, estimatedCostUsd: 999 } });
  const result = summarizeResources(run.trials, host);
  assert.equal(result.inputTokens.total, null);
  assert.equal(result.inputTokens.knownTotal, 1400);
  assert.equal(result.costUsd.total, null);
  assert.equal(result.costUsd.knownTotal, .028);
  assert.equal(result.costPerSuccessfulTaskUsd, null);
  assert.equal(result.unknownUsageRequests, 1);
  assert.equal(result.unknownCostRequests, 1);
  assert.equal(result.budgetAccounting.estimatedCostUsd, 999);
  run.hostUsage = host; run.manifest.budget = { maxEstimatedCostUsd: 1000 };
  const baseline = save(copy(run)), candidate = save(run);
  const gates = assessResourceGates({ resourceCeilings: { costUsd: 1000, costPerSuccessfulTaskUsd: 1000 } }, baseline, candidate);
  assert.equal(gates.passed, false);
  assert.equal(gates.ceilings.costUsd.reason, 'measurement_unknown');
  assert.equal(gates.budget.maxEstimatedCostUsd.reason, 'measurement_unknown');
  const legacy = summarizeResources(candidate.trials, { requests: 15, inputTokens: 1500, outputTokens: 150 });
  assert.equal(legacy.inputTokens.knownTotal, 1500);
  assert.equal(legacy.inputTokens.total, null);
  assert.equal(legacy.costUsd.total, null);
  assert.equal(summarizeResources(candidate.trials, { requests: null }).requests.total, null);
});
test('pure: missing per-trial usage keeps quantiles unknown even when a host total is known', () => {
  const run = draft();
  run.trials.forEach(trial => { delete trial.usage; });
  const resources = summarizeResources(run.trials, usage({ requests: 30, inputTokens: 1500, outputTokens: 150, totalTokens: 1650, costUsd: .03 }));
  assert.equal(resources.inputTokens.total, 1500);
  assert.equal(resources.inputTokens.p50, null);
  assert.equal(resources.inputTokens.unknown, 15);
  assert.equal(resources.costUsd.total, .03);
  assert.equal(resources.costUsd.p95, null);
});
test('pure: absolute resource ceilings, degradation and budget durations fail independently', () => {
  const [baseline, candidate] = pair({}, (a, b) => {
    for (const run of [a, b]) run.manifest.budget = { maxModelRequests: 1, maxTaskDurationMs: 50, maxRunDurationMs: 500 };
    a.hostUsage = usage({ requests: 30, elapsedMs: 1000 });
    b.hostUsage = usage({ requests: 30, elapsedMs: 1000 });
    a.trials.forEach(trial => { trial.retrievalLatencyMs = 0; });
  });
  const gates = assessResourceGates({ resourceCeilings: { latencyP95Ms: 50 }, maxResourceDegradation: { retrievalP95Ms: .1 } }, baseline, candidate);
  assert.equal(gates.ceilings.latencyP95Ms.reason, 'ceiling_exceeded');
  assert.equal(gates.degradation.retrievalP95Ms.reason, 'increase_from_zero_baseline');
  assert.equal(gates.budget.maxModelRequests.reason, 'budget_exceeded');
  assert.equal(gates.budget.maxTaskDurationMs.reason, 'budget_exceeded');
  assert.equal(gates.budget.maxRunDurationMs.reason, 'budget_exceeded');
  assert.equal(gates.passed, false);
});
test('pure: ablations require two fresh explicit arms bound before execution', () => {
  const seed = save(draft({ suite: 'rag-retrieval', metrics: retrievalMetrics }));
  const registration = register(seed, { kind: 'ablation', ablation: ablationDeclaration() });
  const baseline = armDraft(seed, registration, 'baseline'), candidate = armDraft(seed, registration, 'candidate');
  candidate.run.trials.forEach(trial => { trial.metrics.recall20 = .9; });
  const a = save(baseline.run), b = save(candidate.run);
  assert.equal(compareRuns(a, b).conclusion, 'incompatible');
  const comparison = compareRuns(a, b, { protocol: registration });
  assert.equal(comparison.protocolKind, 'ablation');
  assert.equal(comparison.conclusion, 'superior');
  assert.deepEqual(compareAblation(a, b, { protocol: registration }), comparison);
  assert.equal(comparison.actualDifferences.retrievalConfig.candidate.mode, 'hybrid');
  assert.equal(comparison.acceptance.status, 'eligible');
  assert.equal(comparison.releaseEligible, false);
  assert.throws(() => compareAblation(a, b), /protocol_reference_required/);
  assert.throws(() => compareRuns(a, b, { protocol: registration.spec }), /protocol_reference_required/);
});
officialQasperTest('pure: capability ablation accepts only declared tool manifests and schema hashes', () => {
  const seed = save(draft()), before = { toolManifest: seed.manifest.toolManifest, toolSchemaHash: seed.trials[0].toolSchemaHash };
  const after = { toolManifest: { ...seed.manifest.toolManifest,
    tools: [...seed.manifest.toolManifest.tools, { modelVisibleName: 'search', effect: 'read', executionScopes: ['main'] }] },
  toolSchemaHash: hash('new-schema') };
  const registration = register(seed, { kind: 'ablation', ablation: { capabilities: { baseline: before, candidate: after } } });
  const a = save(armDraft(seed, registration, 'baseline').run), b = save(armDraft(seed, registration, 'candidate').run);
  assert.equal(compareRuns(a, b).conclusion, 'incompatible');
  const comparison = compareAblation(a, b, { protocol: registration });
  assert.equal(comparison.conclusion, 'non-inferior');
  assert.equal(comparison.toolSchemaHashes.candidate, after.toolSchemaHash);
});
test('pure: fresh claims reject seed reuse, same directories, prior dispatch and preexisting artifacts', () => {
  const seed = save(draft()), registration = register(seed, { kind: 'ablation', ablation: ablationDeclaration() });
  const run = copy(seed);
  assert.throws(() => claimExperiment(registration.directory, run.path, run.manifest), /arm_required/);
  assert.throws(() => claimExperiment(registration.directory, seed.path, seed.manifest, { arm: 'baseline' }), /requires_fresh_run/);
  for (const prior of ['manifest', 'trial', 'dispatch']) {
    const abandoned = copy(seed);
    if (prior === 'manifest') writeJson(join(abandoned.path, 'manifest.json'), abandoned.manifest);
    if (prior === 'trial') mkdirSync(join(abandoned.path, 'trial-task0-0'));
    if (prior === 'dispatch') writeFileSync(join(abandoned.path, 'events.jsonl'), JSON.stringify({ type: 'provider_admitted' }) + '\n');
    assert.throws(() => claimExperiment(registration.directory, abandoned.path, abandoned.manifest, { arm: 'baseline' }),
      /requires_fresh_run|execution_already_started/);
  }
  const context = claimExperiment(registration.directory, run.path, run.manifest, { arm: 'baseline' });
  const candidateManifest = { ...run.manifest, retrievalConfig: registration.spec.ablation.retrievalConfig.candidate };
  assert.throws(() => claimExperiment(registration.directory, run.path, candidateManifest, { arm: 'candidate' }), /distinct_fresh_runs/);
  assert.throws(() => claimExperiment(registration.directory, run.path, run.manifest, { arm: 'baseline' }), /EEXIST/);
  assert.equal(context.claim.preExecution.executionAbsent, true);
});
test('pure: an ablation cannot unfreeze undeclared model, permissions, dataset or runtime contracts', () => {
  const seed = save(draft()), registration = register(seed, { kind: 'ablation', ablation: ablationDeclaration() });
  const { run, context } = armDraft(seed, registration, 'candidate');
  for (const field of ['provider', 'permissions', 'environment', 'executionPolicy', 'metricsHash', 'taskSchemaHash',
    'datasetIdentity', 'selection', 'qasperQualification', 'retrievalProvider', 'finalAnswerContract', 'budget']) {
    const changed = structuredClone(run.manifest); changed[field] = { drift: true };
    assert.throws(() => assertExperimentManifest(context, changed), /experiment_contract_mismatch/, field);
  }
  assert.throws(() => assertExperimentToolSchema(context, hash('undeclared')), /tool_schema_mismatch/);
  const changed = structuredClone(run.manifest); changed.retrievalConfig.topK = 19;
  assert.throws(() => assertExperimentManifest(context, changed), /contract_mismatch:retrievalConfig/);
  run.manifest.retrievalConfig.topK = 19;
  const baseline = save(armDraft(seed, registration, 'baseline').run);
  assert.throws(() => compareAblation(baseline, save(run), { protocol: registration }), /contract_mismatch:retrievalConfig/);
});
test('pure: posthoc, missing and legacy arm claims never qualify as preregistered ablations', () => {
  for (const change of [claim => { delete claim.claimVersion; }, claim => { delete claim.preExecution; },
    claim => { claim.sourceHash = hash('undeclared-source'); }, claim => { claim.contractHash = hash('undeclared-contract'); }]) {
    const seed = save(draft()), registration = register(seed, { kind: 'ablation', ablation: ablationDeclaration() });
    const a = save(armDraft(seed, registration, 'baseline').run), b = save(armDraft(seed, registration, 'candidate').run);
    rewriteRecord(join(registration.directory, 'baseline.json'), change);
    assert.throws(() => compareAblation(a, b, { protocol: registration }),
      /ablation_run_binding_changed|experiment_preregistration_missing|ablation_claim_contract_changed/);
  }
  const seed = save(draft()), registration = register(seed, { kind: 'ablation', ablation: ablationDeclaration() },
    { comparisonProtocolVersion: undefined });
  assert.throws(() => claimExperiment(registration.directory, copy(seed).path, seed.manifest, { arm: 'baseline' }), /preregistration_missing/);
});
test('pure: resume reuses the exclusive fresh claim and never rewrites it or authorizes replay', () => {
  const seed = save(draft()), registration = register(seed, { kind: 'ablation', ablation: ablationDeclaration() });
  const run = copy(seed);
  writeFileSync(join(run.path, 'events.jsonl'), JSON.stringify({ type: 'run_started', sequence: 0, at: 'test' }) + '\n');
  const context = claimExperiment(registration.directory, run.path, run.manifest, { arm: 'baseline' });
  run.manifest.experiment = context.binding;
  writeJson(join(run.path, 'manifest.json'), run.manifest);
  appendFileSync(join(run.path, 'events.jsonl'), JSON.stringify({ type: 'experiment_claimed', sequence: 1 }) + '\n');
  const before = fileInventory(registration.directory), journalBefore = readFileSync(join(run.path, 'events.jsonl'));
  const resumed = resumeExperiment(registration.directory, run.path, run.manifest, { arm: 'baseline' });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.claim, context.claim);
  assert.deepEqual(resumed.binding, context.binding);
  assert.deepEqual(fileInventory(registration.directory), before);
  assert.deepEqual(readFileSync(join(run.path, 'events.jsonl')), journalBefore);
  assert.equal(resumed.replayAuthorized, undefined);
  assert.throws(() => resumeExperiment(registration.directory, run.path, run.manifest), /arm_required/);
});
test('pure: resume rejects missing claims, changed bindings/source/contracts and persisted manifest drift', () => {
  const seed = save(draft()), registration = register(seed);
  const missing = copy(seed);
  assert.throws(() => resumeExperiment(registration.directory, missing.path, missing.manifest), /resume_claim_missing/);
  const { run, context } = armDraft(seed, registration, 'candidate');
  for (const changed of [{ ...run.manifest, source: { ...source, sourceHash: hash('changed') } },
    { ...run.manifest, provider: { model: 'changed' } },
    { ...run.manifest, experiment: { ...context.binding, protocolHash: hash('changed') } }]) {
    assert.throws(() => resumeExperiment(registration.directory, run.path, changed),
      /candidate_source_changed|contract_mismatch|resume_binding_changed/);
  }
  const other = copy(run);
  assert.throws(() => resumeExperiment(registration.directory, other.path, other.manifest), /resume_binding_changed/);
  writeJson(join(run.path, 'manifest.json'), { ...run.manifest, command: ['changed-command'] });
  assert.throws(() => resumeExperiment(registration.directory, run.path, run.manifest), /resume_manifest_changed/);
});
test('pure: resume requires the unchanged pre-execution journal prefix and an unsealed run', () => {
  const seed = save(draft()), registration = register(seed);
  const run = copy(seed);
  writeFileSync(join(run.path, 'events.jsonl'), JSON.stringify({ type: 'run_started', sequence: 0 }) + '\n');
  const context = claimExperiment(registration.directory, run.path, run.manifest);
  run.manifest.experiment = context.binding;
  writeFileSync(join(run.path, 'events.jsonl'), JSON.stringify({ type: 'run_started', sequence: 2 }) + '\n');
  assert.throws(() => resumeExperiment(registration.directory, run.path, run.manifest), /preexecution_evidence_changed/);
  const second = register(seed), bound = armDraft(seed, second, 'candidate');
  save(bound.run);
  assert.throws(() => resumeExperiment(second.directory, bound.run.path, bound.run.manifest), /requires_unsealed_run/);
  const third = register(seed), pending = armDraft(seed, third, 'candidate');
  const claimPath = join(third.directory, 'candidate.json');
  const claim = readJson(claimPath); claim.contractHash = hash('tampered');
  writeFileSync(claimPath, JSON.stringify(claim));
  assert.throws(() => assertExperimentUnchanged(pending.context), /record_changed/);
});
officialQasperTest('pure: assessment and decisions bind recomputed evidence and remain local write-once records', () => {
  const seed = save(draft()), registration = register(seed), { run } = armDraft(seed, registration, 'candidate');
  run.trials.forEach(trial => { trial.metrics.answerF1 = .9; });
  save(run);
  const assessment = assessExperiment(registration.directory);
  assert.equal(assessment.status, 'eligible');
  assert.equal(assessment.comparison.conclusion, 'superior');
  assert.deepEqual(assessExperiment(registration.directory), assessment);
  assert.throws(() => recordExperimentDecision(registration.directory, { decision: 'adopt', reviewer: 'test-reviewer',
    rationale: 'Test only.', reviewedTrials: [] }), /not_eligible_for_adoption/);
  const decision = recordExperimentDecision(registration.directory, { decision: 'adopt', reviewer: 'test-reviewer',
    rationale: 'Test only.', reviewedTrials: [{ taskId: seed.manifest.selection[0].id, repeat: 0, finding: 'Synthetic evaluator scores on pinned official inputs.' }] });
  assert.equal(decision.assessmentHash, assessment.recordHash);
  assert.match(decision.effect, /local review record only/);
  assert.equal(inspectExperiment(registration.directory).state, 'decided');
  assert.throws(() => recordExperimentDecision(registration.directory, { decision: 'reject', reviewer: 'test-reviewer',
    rationale: 'Test only.', reviewedTrials: [] }), /EEXIST/);
});
test('pure: layered diagnostics retain failed criteria, multiple labels, NA stages and trace pointers', () => {
  const run = draft(), trial = run.trials[0];
  trial.status = 'failed'; trial.failureClass = 'agent'; trial.reason = 'citation_invalid';
  trial.checks = [{ criterion: 'citations-supported', passed: false }, { criterion: 'answer-json', passed: true }];
  trial.diagnostics = { indexContainsGold: true, goldInCandidates: false, goldInContext: false,
    stages: { rerank: 'not_applicable' }, failureLabels: ['wrong_evidence'] };
  trial.tracePointers = ['trial-task0-0/rag-verification.json'];
  const summary = summarize(run.manifest, run.trials), row = summary.diagnostics.trials[0];
  assert.equal(row.firstAbnormalStage, 'retrieval');
  assert.ok(row.failureLabels.includes('retrieval_miss'));
  assert.ok(row.failureLabels.includes('context_loss'));
  assert.ok(row.failureLabels.includes('citation_invalid'));
  assert.deepEqual(row.failedCriteria, ['citations-supported']);
  assert.equal(summary.diagnostics.stages.rerank.notApplicable, 1);
  assert.deepEqual(row.traces.artifacts, trial.tracePointers);
  const unknown = trialDiagnostics({ status: 'failed' });
  assert.ok(unknown.failureLabels.includes('unknown'));
  assert.ok(unknown.failureLabels.includes('needs_review'));
});
test('pure: reports and comparisons preserve sealed bytes and provide per-task trace drilldown', () => {
  const run = draft(), task = run.trials[0], trialPath = `trial-${hash(task.taskId).slice(0, 16)}-${task.repeat}`;
  mkdirSync(join(run.path, trialPath));
  writeJson(join(run.path, trialPath, 'grade.json'), task);
  task.tracePointers = [`${trialPath}/grade.json`];
  const baseline = save(run), candidate = save(copy(run));
  const before = fileInventory(baseline.path), sealBefore = readFileSync(join(baseline.path, 'seal.json'));
  assert.throws(() => sealRun(baseline.path, baseline.summary), /EEXIST/);
  const comparison = compareRuns(baseline, candidate);
  assert.equal(comparison.perTask[0].trials[0].baseline.traces.artifacts[0], `${trialPath}/grade.json`);
  const reportDirectory = fresh('comparison-report');
  writeComparisonReport(reportDirectory, comparison);
  assert.deepEqual(readJson(join(reportDirectory, 'comparison.json')), comparison);
  assert.match(renderComparisonReport(comparison), /Per-task differences/);
  assert.match(readFileSync(join(baseline.path, 'report.md'), 'utf8'), new RegExp(`${trialPath}/grade.json`));
  assert.throws(() => writeComparisonReport(baseline.path, comparison), /requires_fresh_directory/);
  assert.throws(() => writeComparisonReport(reportDirectory, comparison), /requires_fresh_directory/);
  assert.deepEqual(fileInventory(baseline.path), before);
  assert.deepEqual(readFileSync(join(baseline.path, 'seal.json')), sealBefore);
  assert.equal(inspectRun(baseline.path).sealHash, baseline.sealHash);
  writeFileSync(join(candidate.path, 'trials.json'), '[]');
  assert.throws(() => inspectRun(candidate.path), /run_evidence_changed/);
});
test('pure: reports retain runner traces.artifacts receipt and verification pointers with hashes', () => {
  const run = draft(), trial = run.trials[0], trialPath = `trial-${hash(trial.taskId).slice(0, 16)}-${trial.repeat}`;
  mkdirSync(join(run.path, trialPath));
  for (const artifact of ['capability-receipts.jsonl', 'reranker-transport-receipts.json', 'rag-verification.json']) {
    writeJson(join(run.path, trialPath, artifact), { testOnly: true, artifact });
  }
  const pointers = fileInventory(join(run.path, trialPath))
    .map(file => ({ artifact: `${trialPath}/${file.path}`, sha256: file.sha256 }));
  trial.traces = { traceId: hash('test-only-trace'), artifacts: pointers };
  const baseline = save(run), candidate = save(copy(run));
  assert.deepEqual(baseline.summary.diagnostics.trials[0].traces.artifacts, pointers);
  const report = readFileSync(join(baseline.path, 'report.md'), 'utf8');
  for (const { artifact } of pointers) assert.ok(report.includes(`[${artifact}](${artifact})`), artifact);
  const comparison = compareRuns(baseline, candidate);
  assert.deepEqual(comparison.perTask[0].trials[0].baseline.traces.artifacts, pointers);
  assert.deepEqual(comparison.perTask[0].trials[0].candidate.traces.artifacts, pointers);
  const comparisonReport = renderComparisonReport(comparison);
  for (const { artifact, sha256 } of pointers) {
    assert.ok(comparisonReport.includes(artifact));
    assert.ok(comparisonReport.includes(sha256));
  }
});
