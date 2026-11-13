import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT, EVAL_ROOT, RUNS, directory, fail, hash, journal, readJson, sha256, snapshotNativeEvidence, sourceIdentity, writeJson } from './common.mjs';
import { loadDataset } from './data.mjs';
import { prepareApplication, executeApplication } from './application.mjs';
import { qasperInput, gradeQasper } from './qasper.mjs';
import { scienceInput, sciencePreflight, stageScience, executeScience, gradeScience } from './science.mjs';
import { createProvider, validateProviderOptions } from './provider.mjs';
import { openRocModel } from './roc-model.mjs';
import { fixtureConfig, fixtureCompletion } from './fixture.mjs';
import { sealRun, summarize } from './report.mjs';
import { command } from './process.mjs';
import { claimExperiment, assertExperimentManifest, assertExperimentToolSchema, assertExperimentUnchanged } from './experiment.mjs';
import { runHarness } from './harness.mjs';

export const profiles = { smoke: { limit: 1, repeats: 1, split: 'development' }, fast: { limit: 5, repeats: 1, split: 'development' }, full: { limit: 50, repeats: 3, split: 'development' }, release: { limit: null, repeats: 3, split: 'holdout' } };
export function selectTasks(tasks, profile) {
  const eligible = tasks.filter(t => !t.unsupported && t.split === profile.split);
  const clusters = new Map();
  for (const t of eligible.sort((a, b) => hash(a.id).localeCompare(hash(b.id)))) {
    if (!clusters.has(t.clusterId)) clusters.set(t.clusterId, []);
    clusters.get(t.clusterId).push(t);
  }
  const ordered = [];
  while ([...clusters.values()].some(ts => ts.length)) for (const ts of clusters.values()) if (ts.length) ordered.push(ts.shift());
  return ordered.slice(0, profile.limit ?? ordered.length);
}
const errorRecord = error => ({ failureClass: error.failureClass ?? 'infrastructure', reason: String(error.message ?? error).slice(0, 320) });
function scorerHash(suite) {
  const names = ['report.mjs', 'data.mjs', suite === 'qasper' ? 'qasper.mjs' : suite === 'scienceagentbench' ? 'science.mjs' : '../../scripts/harness-eval/run.mjs'];
  return hash(names.map(name => [name, sha256(readFileSync(new URL(name, import.meta.url)))]));
}
export async function runBenchmark(options) {
  if (options.suite === 'roc-harness') return runHarness(options);
  const root = directory(options.outputRoot ?? RUNS, options.suite), events = journal(join(root, 'events.jsonl'));
  const controller = new AbortController(), cancel = () => controller.abort(new Error('operator_interrupt'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const trials = []; let provider = null, fatal = null, artifact, modelHost, runToolSchemaHash = null, experiment;
  const profile = profiles[options.profile];
  let manifest = { schemaVersion: 1, trigger: 'manual', command: process.argv.slice(2), suite: options.suite, profile: options.profile,
    selection: [], exclusions: [], repeats: profile?.repeats ?? 1, split: profile?.split ?? null,
    metrics: [], datasetIdentity: null, provider: null, environment: { platform: process.platform, arch: process.arch, node: process.version },
    evidence: options.fixture || options.suite === 'roc-native' ? 'fixture' : 'live-model', source: null, scorerHash: null };
  events.append({ type: 'run_started', suite: options.suite, profile: options.profile });
  try {
    if (!profile) fail('policy', 'unknown_profile');
    if (options.task !== undefined) fail('policy', 'task_filter_requires_harness_suite');
    const registry = readJson(new URL('./registry.json', import.meta.url));
    const suite = registry.suites.find(s => s.id === options.suite);
    if (!suite || !['available', 'requires-verified-environment'].includes(suite.status)) fail('environment', 'suite_not_implemented');
    manifest.source = sourceIdentity(); manifest.scorerHash = scorerHash(options.suite); manifest.metrics = suite.metrics;
    if (options.experiment) {
      experiment = claimExperiment(options.experiment, root, manifest);
      manifest.experiment = experiment.binding;
      events.append({ type: 'experiment_claimed', ...experiment.binding });
    }
    if (options.suite === 'roc-native') {
      if (options.providerOptions || options.dataset) fail('policy', 'native_does_not_use_provider_or_dataset');
      manifest.selection = [{ id: 'native-contracts', clusterId: 'native-contracts' }]; manifest.repeats = 1; manifest.split = 'fixture';
      manifest.datasetIdentity = sha256(readFileSync(join(ROOT, 'scripts/harness-eval/scenarios.mjs')));
      writeJson(join(root, 'manifest.json'), manifest);
      const result = await command(process.execPath, ['scripts/harness-eval/run.mjs', '--output-root', join(EVAL_ROOT, '.runtime/native', root.split('/').at(-1))], { cwd: ROOT, signal: controller.signal, timeoutMs: 600000 });
      writeJson(join(root, 'native-process.json'), result);
      const line = result.stdout.trim().split('\n').findLast(s => s.startsWith('{"passed":'));
      if (!line) fail('harness', 'native_report_missing');
      const output = JSON.parse(line), report = readJson(output.report);
      const links = snapshotNativeEvidence(dirname(output.report), join(root, 'native-evidence'));
      writeJson(join(root, 'native-links.json'), { representation: 'link definitions only; targets never dereferenced', links });
      trials.push({ taskId: 'native-contracts', clusterId: 'native-contracts', repeat: 0, status: report.passed ? 'scored' : 'failed',
        failureClass: report.passed ? null : 'harness', reason: report.error ?? null, latencyMs: result.durationMs,
        metrics: { contractPassRate: report.results.filter(t => t.passed).length / 94 }, cases: report.results.length, passed: report.results.filter(t => t.passed).length });
      if (result.exitCode !== 0 || !report.passed || report.results.length !== 94) fail('harness', 'native_contracts_failed');
    } else {
      if (!options.dataset) fail('data', 'explicit_dataset_path_required');
      const dataset = loadDataset(options.dataset);
      if (dataset.manifest.suite !== options.suite) fail('data', 'dataset_suite_mismatch');
      manifest.datasetIdentity = dataset.manifest.identity;
      const selected = selectTasks(dataset.tasks, profile), selectedIds = new Set(selected.map(t => t.id));
      manifest.selection = selected.map(({ id, clusterId }) => ({ id, clusterId }));
      manifest.exclusions = dataset.tasks.filter(t => !selectedIds.has(t.id)).map(t => ({ id: t.id, reason: t.unsupported ?? (t.split !== profile.split ? 'other_split' : 'profile_limit') }));
      manifest.datasetProvenance = dataset.manifest.provenance;
      writeJson(join(root, 'dataset-manifest.json'), dataset.manifest);
      if (!selected.length) fail('data', 'no_supported_tasks_in_split');
      if (options.fixture && options.providerOptions) fail('policy', 'fixture_and_provider_are_exclusive');
      if (options.fixture && options.suite !== 'qasper') fail('policy', 'fixture_transport_supports_qasper_only');
      const config = options.fixture ? fixtureConfig : { ...validateProviderOptions(options.providerOptions ? readJson(options.providerOptions) : {}), temperature: 0 };
      if (!options.fixture) {
        modelHost = await openRocModel(options);
        Object.assign(config, modelHost.identity);
      }
      manifest.provider = config;
      if (options.suite === 'scienceagentbench') manifest.environment.science = await sciencePreflight(dataset, selected, root, controller.signal);
      artifact = await prepareApplication(root);
      manifest.workerHash = artifact.sha256; manifest.toolManifest = artifact.manifests[options.suite];
      // Dependency changes are captured for investigation, not silently mixed into the baseline.
      manifest.environment.lockfileHash = manifest.source.lockfileHash;
      if (experiment) assertExperimentManifest(experiment, manifest);
      writeJson(join(root, 'manifest.json'), manifest);
      provider = options.fixture ? null : createProvider(config, e => events.append(e), { complete: modelHost.complete });
      for (const task of selected) for (let repeat = 0; repeat < profile.repeats; repeat++) {
        controller.signal.throwIfAborted();
        const trialDir = join(root, `trial-${hash(task.id).slice(0, 16)}-${repeat}`); mkdirSync(trialDir, { mode: 0o700 });
        let trialToolSchemaHash = null;
        const started = Date.now(), record = e => {
          if (e.type === 'model_request') {
            trialToolSchemaHash = e.toolSchemaHash;
            if (experiment) assertExperimentToolSchema(experiment, trialToolSchemaHash);
            if (runToolSchemaHash !== null && runToolSchemaHash !== trialToolSchemaHash) fail('harness', 'tool_schema_changed_during_run');
            runToolSchemaHash = trialToolSchemaHash;
          }
          events.append({ ...e, taskId: task.id, repeat });
        };
        record({ type: 'trial_started' });
        let grade;
        try {
          const result = await executeApplication({ artifact, input: options.suite === 'qasper' ? qasperInput(task) : scienceInput(task), directory: trialDir,
            config, signal: controller.signal, record, complete: options.fixture ? fixtureCompletion : (body, signal) => provider.complete(body, signal),
            stage: options.suite === 'scienceagentbench' ? workspace => stageScience(dataset, task, workspace) : undefined,
            execute: options.suite === 'scienceagentbench' ? (workspace, signal, limits) => executeScience(task, workspace, signal, limits) : undefined });
          grade = options.suite === 'qasper' ? gradeQasper(task, result.output) : await gradeScience(dataset, task, result.workspace, trialDir, controller.signal);
          grade.requests = result.requests;
        } catch (error) {
          const failure = controller.signal.aborted ? { failureClass: 'operator', reason: 'run_cancelled' } : errorRecord(error);
          grade = { status: failure.failureClass === 'agent' ? 'failed' : 'invalid', ...failure,
            metrics: failure.failureClass === 'agent' ? Object.fromEntries(manifest.metrics.map(m => [m, 0])) : null };
        }
        const trial = { taskId: task.id, clusterId: task.clusterId, repeat, ...grade, toolSchemaHash: trialToolSchemaHash, latencyMs: Date.now() - started };
        trials.push(trial); writeJson(join(trialDir, 'grade.json'), trial); record({ type: 'trial_finished', ...trial });
        // Infrastructure, provider and scoring failures invalidate this run.
        if (grade.failureClass && grade.failureClass !== 'agent') fail(grade.failureClass, grade.reason);
      }
      if (loadDataset(options.dataset).manifest.identity !== manifest.datasetIdentity) fail('data', 'dataset_changed_during_run');
    }
    if (sourceIdentity().sourceHash !== manifest.source.sourceHash) fail('state', 'source_changed_during_run');
    if (experiment) assertExperimentUnchanged(experiment);
  } catch (error) {
    fatal = controller.signal.aborted ? { failureClass: 'operator', reason: 'run_cancelled' } : errorRecord(error);
    events.append({ type: 'run_failed', ...fatal });
  } finally {
    if (modelHost) { try { await modelHost.close(); } catch { fatal = { failureClass: 'infrastructure', reason: 'model_host_cleanup_failed' }; } }
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
  // Preflight failures also get a complete diagnostic report. SIGKILL leaves no seal and is incomplete.
  try { writeJson(join(root, 'manifest.json'), manifest); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  writeJson(join(root, 'trials.json'), trials);
  const summary = { ...summarize(manifest, trials, fatal), usage: provider?.snapshot() ?? { requests: trials.reduce((n, t) => n + (t.requests ?? 0), 0) } };
  events.append({ type: 'run_finished', status: summary.status }); events.close();
  sealRun(root, summary);
  return { directory: root, ...summary };
}
