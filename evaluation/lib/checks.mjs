import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { directory, EVAL_ROOT, fail, hash, journal, readJson, ROOT, RUNS, sha256, sourceIdentity } from './common.mjs';
import { executionPolicy, failure, openExecution, recordFailure, storeGrade, verifiedSeal, withinTrial } from './execution.mjs';
import { durableJson } from './lifecycle.mjs';
import { sealRun, summarize } from './report.mjs';
import { loadDataset } from './data.mjs';
import { capabilityReadiness, validateCapabilityDataset } from '../adapters/capability/data.mjs';

// Contract/readiness audits deliberately perform no agent or model trial.
// They still retain the same durable journal, budget and evidence-seal format.
export async function checkSuite(options) {
  const suite = options.suite;
  const capability = ['roc-capability', 'roc-e2e-research', 'roc-security'].includes(suite);
  if (!['frozen-retrieval', 'roc-s01'].includes(suite) && !capability) fail('policy', 'check_requires_contract_or_engineering_suite');
  if (options.profile || options.resume || options.fixture || options.providerOptions || options.budgetOptions
    || options.retrievalOptions || options.experiment || options.task || options.concurrency) fail('policy', 'offline_check_options_invalid');
  if (capability && !options.dataset) fail('data', 'capability_audit_dataset_required');
  const input = capability ? options.dataset : suite === 'frozen-retrieval' ? options.corpus
    : options.dataset ?? join(ROOT, 'tests/fixtures/quality-evaluation/manifest.json');
  if (!input) fail('data', 'frozen_retrieval_corpus_required');
  if (suite === 'roc-s01' && options.dataset && !options.datasetSha256) fail('data', 's01_manifest_hash_required');
  const capabilityDataset = capability ? loadDataset(input) : null;
  if (capabilityDataset && capabilityDataset.manifest.suite !== suite) fail('data', 'dataset_suite_mismatch');
  const inputPath = capabilityDataset ? join(capabilityDataset.root, 'dataset.json') : resolve(input), bytes = readFileSync(inputPath);
  const root = directory(options.outputRoot ?? RUNS, suite);
  const events = journal(join(root, 'events.jsonl')), started = Date.now();
  events.append({ type: 'run_started', suite, startedAtMs: started });
  const registered = readJson(new URL('./registry.json', import.meta.url)).suites.find(item => item.id === suite);
  const taskId = `${suite}-input-audit`;
  const manifest = { schemaVersion: 1, suite, adapter: registered.adapter, profile: 'offline-audit', trigger: 'manual',
    evidence: 'engineering-fixture', command: process.argv.slice(2), source: sourceIdentity(),
    selection: [{ id: taskId, clusterId: taskId }], repeats: 1, split: 'engineering', exclusions: [],
    metrics: ['auditPassRate'], datasetIdentity: sha256(bytes), dataset: { path: inputPath, sha256: sha256(bytes) },
    scorerHash: hash([sha256(readFileSync(new URL('./checks.mjs', import.meta.url))), registered.adapter]),
    provider: null, executionPolicy: executionPolicy({ budget: {}, taskTimeoutMs: 300000 }, 1),
    permissions: { worker: 'no-agent-worker', modelRequests: 0, externalCalls: 0, configuration: 'none' },
    environment: { platform: process.platform, arch: process.arch, node: process.version }, releaseEligible: false };
  manifest.metricsHash = hash({ metrics: manifest.metrics, scorerHash: manifest.scorerHash });
  manifest.taskSchemaHash = hash({ suite, auditSchemaVersion: 1 });
  durableJson(join(root, 'manifest.json'), manifest);
  const execution = openExecution(root, manifest, events), [trial] = execution.plan.trials;
  const trialDirectory = join(root, trial.trialId);
  mkdirSync(trialDirectory, { mode: 0o700 });
  let report, result, fatal = null;
  try {
    await withinTrial(execution, trial, new AbortController().signal, async () => {
      execution.lifecycle.transition(trial, 'dispatched', { operation: 'offline-input-audit', modelRequests: 0 });
      if (suite === 'frozen-retrieval') {
        const { evaluateLocalRetrieval } = await import('../adapters/frozen-retrieval/index.mjs');
        report = { ...await evaluateLocalRetrieval(JSON.parse(bytes)), inputSha256: sha256(bytes),
          executionMode: 'offline-regression', modelCalls: 0, externalCalls: 0 };
      } else if (capability) {
        validateCapabilityDataset(capabilityDataset);
        report = { ...capabilityReadiness(capabilityDataset), executionMode: 'offline-readiness-audit', modelCalls: 0, externalCalls: 0 };
      } else {
        const datasetHash = options.datasetSha256
          ?? readFileSync(join(ROOT, 'tests/fixtures/quality-evaluation/manifest.sha256'), 'utf8').trim();
        const { auditQualityDataset, loadQualityDatasetPackage } = await importTypeScriptModule(
          join(EVAL_ROOT, 'adapters/s01/dataset.ts'), { platform: 'node' });
        const { dataset } = loadQualityDatasetPackage(inputPath, datasetHash);
        report = { ...auditQualityDataset(dataset), executionMode: 'offline-audit', modelCalls: 0, externalCalls: 0 };
      }
      durableJson(join(trialDirectory, 'audit.json'), report);
      execution.lifecycle.transition(trial, 'completed');
      verifiedSeal(trialDirectory, execution.lifecycle, trial);
    });
    if (sha256(readFileSync(inputPath)) !== manifest.datasetIdentity) fail('data', 'audit_input_changed_during_run');
    if (capabilityDataset && loadDataset(capabilityDataset.root).manifest.identity !== capabilityDataset.manifest.identity) fail('data', 'audit_dataset_changed_during_run');
    if (sourceIdentity().sourceHash !== manifest.source.sourceHash) fail('state', 'source_changed_during_run');
    result = storeGrade(root, execution, trial, {
      status: 'scored', metrics: { auditPassRate: 1 }, requests: 0, failureClass: null, reason: null,
      audit: { operation: report.executionMode, scientificStatus: report.scientificStatus ?? 'engineering-only' }
    }, started);
  } catch (error) {
    fatal = failure(error); result = recordFailure(root, execution, trial, error, undefined, started);
    events.append({ type: 'run_failed', ...fatal });
  }
  const trials = [result];
  durableJson(join(root, 'trials.json'), trials);
  const summary = { ...summarize(manifest, trials, fatal, execution.budget.snapshot()),
    qualityConclusion: 'engineering-audit-only', modelCalls: 0, externalCalls: 0,
    regressionAcceptance: 'not_evaluated',
    scientificStatus: report?.scientificStatus ?? 'insufficient', fullDatasetReady: report?.fullDatasetReady ?? false,
    ...(capability ? { capabilityReadiness: report } : {}),
    audit: { artifact: `${trial.trialId}/audit.json`, tasks: report?.tasks,
      queries: report?.rows ? new Set(report.rows.map(row => row.queryId)).size : undefined } };
  events.append({ type: 'run_finished', status: summary.status }); events.close(); sealRun(root, summary);
  return { directory: root, ...summary };
}
