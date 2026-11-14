import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ROOT, EVAL_ROOT, RUNS, directory, fail, hash, journal, readJson, sha256, snapshotNativeEvidence, sourceIdentity, writeJson } from './common.mjs';
import { loadDataset } from './data.mjs';
import { prepareApplication, executeApplication, recoverApplication } from './application.mjs';
import { applicationContract } from './application-verifier.mjs';
import { qasperInput, gradeQasper } from './qasper.mjs';
import { withQasperResponseContract } from './response-contract.mjs';
import { scienceInput, sciencePreflight, stageScience, executeScience, gradeScience } from './science.mjs';
import { createProvider, validateProviderOptions, budgetOptionsSchema } from './provider.mjs';
import { BudgetController } from './budget.mjs';
import { openRocModel } from './roc-model.mjs';
import { openRocRetrieval } from './roc-retrieval.mjs';
import { fixtureConfig, fixtureCompletion } from './fixture.mjs';
import { sealRun, summarize } from './report.mjs';
import { command } from './process.mjs';
import { claimExperiment, resumeExperiment, assertExperimentManifest, assertExperimentToolSchema, assertExperimentUnchanged } from './experiment.mjs';
import { readComparisonProtocol } from './comparison.mjs';
import { runHarness } from './harness.mjs';
import { applicationArtifact, cancellation, executionPolicy, failure, inspectResumable, openExecution, readGrade,
  recordFailure, runStartedAt, storeGrade, validateVerifiedSeal, verifiedSeal, withinTrial } from './execution.mjs';
import { discardUndispatched, durableJson, scheduleTrials, TrialLifecycle } from './lifecycle.mjs';
import { datasetReview, openRagEnvironment, ragComponentCapability, ragContract, ragInput, ragRetrievalContract, retrievalConfigurationSchema } from '../adapters/rag/environment.mjs';
import { ragEngineeringCompletion } from '../adapters/rag/fixture.mjs';
import { budgetRetrievalTransport, executeRagComponent, recoverRagComponent, researchReference } from '../adapters/rag/run.mjs';
import { gradeRag, gradeRetrieval } from '../graders/rag.mjs';

export const profiles = { smoke: { limit: 1, repeats: 1, split: 'development' }, fast: { limit: 5, repeats: 1, split: 'development' },
  full: { limit: 50, repeats: 3, split: 'development' }, release: { limit: null, repeats: 3, split: 'holdout' } };
export function selectTasks(tasks, profile) {
  const eligible = tasks.filter(task => !task.unsupported && task.split === profile.split), clusters = new Map();
  for (const task of eligible.sort((a, b) => hash(a.id).localeCompare(hash(b.id)))) {
    if (!clusters.has(task.clusterId)) clusters.set(task.clusterId, []);
    clusters.get(task.clusterId).push(task);
  }
  const ordered = [];
  while ([...clusters.values()].some(group => group.length)) for (const group of clusters.values()) if (group.length) ordered.push(group.shift());
  return ordered.slice(0, profile.limit ?? ordered.length);
}
const isRag = suite => ['rag-paper-qa', 'rag-retrieval'].includes(suite);
const usesApplication = suite => ['qasper', 'scienceagentbench', 'rag-paper-qa'].includes(suite);
const inputFor = (suite, task) => suite === 'qasper' ? withQasperResponseContract(qasperInput(task))
  : suite === 'scienceagentbench' ? scienceInput(task) : ragInput(task);
function scorerHash(suite) {
  const names = ['lib/report.mjs', 'lib/data.mjs', 'lib/comparison.mjs', 'lib/analysis.mjs'];
  if (usesApplication(suite)) names.push('lib/application-verifier.mjs', 'lib/application.mjs');
  if (suite === 'qasper') names.push('lib/qasper.mjs', 'lib/response-contract.mjs', 'analysis/qasper.mjs');
  else if (suite === 'scienceagentbench') names.push('lib/science.mjs');
  else if (isRag(suite)) names.push('adapters/rag/data.mjs', 'adapters/rag/evidence.mjs', 'adapters/rag/verification.mjs',
    'graders/source-evidence.mjs', 'graders/rag.mjs', 'analysis/failures.mjs');
  else if (suite === 'roc-native') names.push('adapters/native/run.mjs', 'adapters/native/scenarios.mjs', 'adapters/native/inventory.mjs');
  return hash(names.map(name => [name, sha256(readFileSync(join(EVAL_ROOT, name)))]));
}
function configuration(options) {
  if (options.fixture && options.providerOptions) fail('policy', 'fixture_and_provider_are_exclusive');
  const values = options.fixture ? { requestTimeoutMs: 30000, taskTimeoutMs: 30000 }
    : options.suite === 'roc-native' ? { taskTimeoutMs: 600000 } : options.providerOptions ? readJson(options.providerOptions) : {};
  const config = { ...validateProviderOptions(values), temperature: 0, ...(options.fixture ? fixtureConfig : {}) };
  if (options.budgetOptions) config.budget = budgetOptionsSchema.parse({ ...config.budget, ...readJson(options.budgetOptions) });
  return config;
}
function declaration(options) {
  if (!options.experiment) return null;
  const { protocol } = readComparisonProtocol(options.experiment);
  if (protocol.spec.kind === 'ablation' && !['baseline', 'candidate'].includes(options.experimentArm)) fail('policy', 'experiment_arm_required');
  return protocol.spec.kind === 'ablation' ? protocol.spec.ablation : null;
}
function retrievalConfig(options, ablation) {
  const supplied = options.retrievalOptions ? readJson(options.retrievalOptions) : {}, declared = ablation?.retrievalConfig?.[options.experimentArm];
  const config = retrievalConfigurationSchema.parse(declared ?? supplied);
  if (declared && options.retrievalOptions && hash(config) !== hash(retrievalConfigurationSchema.parse(supplied))) fail('policy', 'ablation_retrieval_options_changed');
  if (options.fixture && (config.mode !== 'bm25' || config.rerank !== 'none')) fail('policy', 'fixture_requires_no_live_retrieval_models');
  return config;
}
function hostSelection(config, ablation) {
  const arms = ablation?.retrievalConfig ? Object.values(ablation.retrievalConfig).map(value => retrievalConfigurationSchema.parse(value)) : [config];
  const ids = [...new Set(arms.map(value => value.embeddingConfigId).filter(Boolean))];
  if (ids.length > 1) fail('policy', 'ablation_embedding_provider_must_be_frozen');
  return { mode: arms.some(value => value.mode === 'hybrid') ? 'hybrid' : 'bm25',
    rerank: arms.some(value => value.rerank === 'semantic') ? 'semantic' : 'none',
    embeddingConfigId: ids[0] ?? config.embeddingConfigId ?? null };
}
function suiteContracts(manifest, suite, config, count) {
  manifest.scorerHash = scorerHash(suite.id); manifest.metrics = suite.metrics; manifest.adapter = suite.adapter;
  manifest.metricsHash = hash({ metrics: manifest.metrics, applicability: 'explicit-null-not-applicable-v1', scorerHash: manifest.scorerHash });
  manifest.taskSchemaHash = hash({ suite: suite.id, adapter: suite.adapter, taskSchemaVersion: suite.taskSchemaVersion ?? 1 });
  manifest.executionPolicy = executionPolicy(config, count); manifest.budget = config.budget;
  manifest.permissions = { schemaVersion: 1, worker: 'macos-deny-default-no-network', credentials: 'privileged-host-only',
    configuration: 'read-only', externalExecution: suite.id === 'scienceagentbench' ? 'verified-fixed-python-entrypoint' : 'none' };
  if (usesApplication(suite.id)) manifest.applicationContract = applicationContract;
  if (isRag(suite.id)) manifest.ragContract = suite.id === 'rag-retrieval' ? ragRetrievalContract : ragContract;
}
async function grade(suite, dataset, task, result, directory, signal) {
  const scored = suite === 'qasper' ? gradeQasper(task, result.output, { directory })
    : suite === 'scienceagentbench' ? await gradeScience(dataset, task, result.workspace,
      directoryForGrading(directory), signal)
      : suite === 'rag-retrieval' ? gradeRetrieval(task, result.ragEvidence) : gradeRag(task, result.output, result.ragEvidence);
  return { ...scored, requests: result.requests, toolSchemaHash: result.toolSchemaHash ?? null,
    ...(result.runtimeVerification ? { runtimeVerification: result.runtimeVerification } : {}),
    ...(result.ragVerification ? { ragVerification: result.ragVerification } : {}) };
}
function directoryForGrading(trialDirectory) {
  const grading = join(trialDirectory, 'grading');
  mkdirSync(grading, { recursive: true, mode: 0o700 });
  return directory(grading, 'attempt');
}
function nativeResult(directory) {
  const result = readJson(join(directory, 'native-process.json')), report = readJson(join(directory, 'native-report.json'));
  if (result.exitCode !== 0 || !Array.isArray(report.results) || report.results.length !== 94
    || new Set(report.results.map(item => item.id ?? item.name)).size !== 94) fail('harness', 'native_report_invalid');
  const passed = report.results.filter(item => item.passed).length;
  return { status: report.passed && passed === 94 ? 'scored' : 'failed', success: report.passed && passed === 94,
    failureClass: report.passed && passed === 94 ? null : 'agent', reason: report.error ?? (passed === 94 ? null : 'native_contracts_failed'),
    metrics: { contractPassRate: passed / 94 }, cases: report.results.length, passed, requests: 0 };
}
async function executeNative({ root, directory, signal, lifecycle }) {
  const staging = join(EVAL_ROOT, '.runtime/native', basename(root));
  lifecycle('dispatched');
  const result = await command(process.execPath, ['evaluation/adapters/native/run.mjs', '--output-root', staging],
    { cwd: ROOT, signal, timeoutMs: 600000 });
  durableJson(join(directory, 'native-process.json'), result);
  const line = result.stdout.trim().split('\n').findLast(value => value.startsWith('{"passed":'));
  if (!line) fail('harness', 'native_report_missing');
  const output = JSON.parse(line), report = readJson(output.report);
  durableJson(join(directory, 'native-report.json'), report); lifecycle('completed');
  const links = snapshotNativeEvidence(dirname(output.report), join(directory, 'native-evidence'));
  durableJson(join(directory, 'native-links.json'), { representation: 'link definitions only; targets never dereferenced', links });
  const scored = nativeResult(directory);
  if (dirname(dirname(output.report)) !== staging) fail('state', 'native_staging_path_invalid');
  // Only this dispatch's staging tree is disposable after the complete snapshot.
  rmSync(staging, { recursive: true });
  return scored;
}
function prevalidateRecovery(resume, options) {
  const { root, manifest, events, plan } = resume;
  if (manifest.scorerHash !== scorerHash(manifest.suite)) fail('state', 'resume_scorer_changed');
  const dataset = manifest.suite === 'roc-native' ? null : loadDataset(options.dataset ?? manifest.dataset.path);
  if (dataset && (dataset.manifest.identity !== manifest.datasetIdentity || dataset.manifest.suite !== manifest.suite)) fail('state', 'resume_dataset_changed');
  if (manifest.suite === 'qasper' && (!manifest.qasperQualification
    || hash(manifest.qasperQualification) !== hash(dataset.qasperQualification))) fail('state', 'resume_qasper_qualification_changed');
  const artifact = usesApplication(manifest.suite) ? applicationArtifact(root, manifest) : null;
  const capability = manifest.suite === 'rag-retrieval' ? readJson(join(root, 'component-capability.json')) : null;
  if (capability && (hash(capability.toolManifest) !== hash(manifest.toolManifest)
    || hash(capability.schemas) !== manifest.componentSchemaHash)) fail('state', 'resume_component_schema_changed');
  const lifecycle = new TrialLifecycle(plan, () => fail('state', 'resume_validation_is_readonly'), events);
  const tasks = new Map(dataset?.tasks.map(task => [task.id, task]) ?? []), recovered = new Map();
  for (const trial of plan.trials) {
    if (lifecycle.recovery(trial) === 'never-dispatched') continue;
    validateVerifiedSeal(root, lifecycle, trial);
    const saved = readGrade(root, { lifecycle }, trial), directory = join(root, trial.trialId), task = tasks.get(trial.taskId);
    const result = manifest.suite === 'roc-native' ? nativeResult(directory) : manifest.suite === 'rag-retrieval'
      ? recoverRagComponent({ dataset, task, directory, capability, retrievalProvider: manifest.retrievalProvider })
      : recoverApplication({ artifact, input: inputFor(manifest.suite, task), directory, config: manifest.provider,
        research: isRag(manifest.suite) ? researchReference(dataset, task, directory, manifest.retrievalProvider) : undefined });
    recovered.set(trial.trialId, { result, saved });
  }
  return { dataset, artifact, capability, recovered };
}

export async function runBenchmark(requested = {}) {
  let options = { suite: 'roc-harness', profile: 'fast', ...requested };
  const resume = options.resume ? inspectResumable(options.resume) : null;
  if (resume) {
    if (requested.suite !== undefined && requested.suite !== resume.manifest.suite
      || requested.profile !== undefined && requested.profile !== resume.manifest.profile
      || requested.concurrency !== undefined && Number(requested.concurrency) !== resume.plan.maxConcurrentTrials
      || options.fixture || options.providerOptions || options.budgetOptions || options.retrievalOptions || options.task) fail('policy', 'resume_options_must_use_frozen_manifest');
    options = { ...options, suite: resume.manifest.suite, profile: resume.manifest.profile };
  }
  if (options.suite === 'roc-harness') return runHarness({ ...options, resumeContext: resume });
  const recovery = resume ? prevalidateRecovery(resume, options) : null;
  const root = resume?.root ?? directory(options.outputRoot ?? RUNS, options.suite);
  const events = journal(join(root, 'events.jsonl'), { resume: Boolean(resume) });
  const startedAtMs = resume ? runStartedAt(resume.events) : Date.now(), cancel = cancellation(startedAtMs);
  const trials = new Map(); let fatal = null, artifact = recovery?.artifact, capability = recovery?.capability,
    modelHost, retrievalHost, execution, experiment, dataset = recovery?.dataset;
  const profile = profiles[options.profile];
  const manifest = resume?.manifest ?? { schemaVersion: 1, trigger: 'manual', command: process.argv.slice(2), suite: options.suite,
    profile: options.profile, selection: [], exclusions: [], repeats: profile?.repeats ?? 1, split: profile?.split ?? null,
    metrics: [], datasetIdentity: null, provider: null, environment: { platform: process.platform, arch: process.arch, node: process.version },
    evidence: options.fixture || options.suite === 'roc-native' ? 'fixture' : options.suite === 'scienceagentbench' ? 'engineering-fixture'
      : options.suite === 'rag-retrieval' ? 'production-component' : 'live-model',
    source: null, scorerHash: null };
  if (!resume) events.append({ type: 'run_started', startedAtMs, suite: options.suite, profile: options.profile });
  try {
    if (!profile) fail('policy', 'unknown_profile');
    const registry = readJson(new URL('./registry.json', import.meta.url)), suite = registry.suites.find(item => item.id === options.suite);
    if (!suite || !['available', 'requires-verified-environment'].includes(suite.status)) fail('environment', 'suite_not_implemented');
    const config = resume ? manifest.provider ?? { taskTimeoutMs: manifest.executionPolicy.taskTimeoutMs, budget: manifest.executionPolicy.budget }
      : configuration(options);
    const ablation = declaration({ ...options, experiment: options.experiment ?? manifest.experiment?.path,
      experimentArm: options.experimentArm ?? manifest.experiment?.arm });
    if (!resume) {
      manifest.source = sourceIdentity(); suiteContracts(manifest, suite, config, options.concurrency ?? 2);
      cancel.configure(manifest.executionPolicy);
      if (options.suite === 'roc-native') {
        if (options.providerOptions || options.dataset || options.task || options.retrievalOptions || options.fixture) fail('policy', 'native_does_not_use_model_or_dataset');
        manifest.selection = [{ id: 'native-contracts', clusterId: 'native-contracts' }]; manifest.repeats = 1; manifest.split = 'fixture';
        manifest.datasetIdentity = sha256(readFileSync(join(EVAL_ROOT, 'adapters/native/scenarios.mjs')));
      } else {
        if (!options.dataset) fail('data', 'explicit_dataset_path_required');
        dataset = loadDataset(options.dataset);
        if (dataset.manifest.suite !== options.suite) fail('data', 'dataset_suite_mismatch');
        if (options.fixture && options.suite === 'scienceagentbench') fail('policy', 'science_fixture_transport_unavailable');
        if (options.fixture && profile.split === 'holdout') fail('policy', 'fixture_cannot_enter_holdout');
        const selected = selectTasks(dataset.tasks.filter(task => !options.task || task.id === options.task), profile);
        const selectedIds = new Set(selected.map(task => task.id));
        manifest.selection = selected.map(task => ({ id: task.id, clusterId: task.clusterId,
          ...(isRag(options.suite) ? { contentHash: hash({ visible: task.visible, expected: task.expected }) } : {}) }));
        manifest.exclusions = dataset.tasks.filter(task => !selectedIds.has(task.id)).map(task => ({ id: task.id,
          reason: task.unsupported ?? (task.split !== profile.split ? 'other_split' : options.task ? 'task_filter' : 'profile_limit') }));
        manifest.datasetIdentity = dataset.manifest.identity; manifest.datasetProvenance = dataset.manifest.provenance;
        manifest.dataset = { path: dataset.root, identity: dataset.manifest.identity };
        if (options.suite === 'qasper') {
          manifest.qasperQualification = dataset.qasperQualification;
          if (!options.fixture && dataset.qasperQualification.status !== 'verified') manifest.evidence = 'engineering-fixture';
        }
        if (!selected.length) fail('data', 'no_supported_tasks_in_split');
        if (isRag(options.suite)) {
          manifest.datasetReview = datasetReview(selected, dataset.manifest.provenance);
          manifest.retrievalConfig = retrievalConfig(options, ablation);
        } else if (options.retrievalOptions) fail('policy', 'retrieval_options_require_rag_suite');
      }
      if (options.experiment) {
        experiment = claimExperiment(options.experiment, root, manifest, { arm: options.experimentArm });
        manifest.experiment = experiment.binding; events.append({ type: 'experiment_claimed', ...experiment.binding });
      }
      if (dataset) writeJson(join(root, 'dataset-manifest.json'), dataset.manifest);
      if (usesApplication(options.suite)) {
        if (options.fixture) Object.assign(config, fixtureConfig);
        else { modelHost = await openRocModel(options); Object.assign(config, modelHost.identity); }
        manifest.provider = config;
        if (options.suite === 'scienceagentbench') manifest.environment.science = await sciencePreflight(dataset,
          dataset.tasks.filter(task => manifest.selection.some(selected => selected.id === task.id)), root, cancel.signal);
        artifact = await prepareApplication(root, { kind: options.suite,
          toolNames: ablation?.capabilities?.[options.experimentArm]?.toolManifest.tools.map(tool => tool.modelVisibleName) });
        manifest.workerHash = artifact.sha256; manifest.toolManifest = artifact.manifests[options.suite];
      }
      if (isRag(options.suite)) {
        const selection = hostSelection(manifest.retrievalConfig, ablation);
        if (selection.mode === 'hybrid' || selection.rerank === 'semantic') retrievalHost = await openRocRetrieval({
          ...(options.rocRoot ? { rocRoot: options.rocRoot } : {}), ...(options.appName ? { appName: options.appName } : {}), ...selection, signal: cancel.signal });
        manifest.retrievalProvider = retrievalHost?.identity ?? { embedding: null, reranker: null };
      }
      if (options.suite === 'rag-retrieval') {
        capability = await ragComponentCapability();
        manifest.toolManifest = capability.toolManifest; manifest.componentSchemaHash = hash(capability.schemas);
        durableJson(join(root, 'component-capability.json'), capability);
      }
      manifest.environment.lockfileHash = manifest.source.lockfileHash;
      if (experiment) assertExperimentManifest(experiment, manifest);
      durableJson(join(root, 'manifest.json'), manifest);
    } else {
      cancel.configure(manifest.executionPolicy);
      if (manifest.experiment) experiment = resumeExperiment(manifest.experiment.path, root, manifest, { arm: manifest.experiment.arm });
    }
    execution = openExecution(root, manifest, events, resume?.events);
    const { lifecycle, plan, budget } = execution, tasks = new Map(dataset?.tasks.map(task => [task.id, task]) ?? []);
    let runToolSchemaHash = null;
    const observeSchema = schemaHash => {
      if (!schemaHash) return;
      if (experiment) assertExperimentToolSchema(experiment, schemaHash);
      if (runToolSchemaHash && runToolSchemaHash !== schemaHash) fail('harness', 'tool_schema_changed_during_run');
      runToolSchemaHash = schemaHash;
    };
    const recordFor = trial => event => {
      if (event.type === 'model_request') observeSchema(event.toolSchemaHash);
      lifecycle.record(trial, event);
    };
    if (resume) for (const trial of plan.trials) {
      const recovered = recovery.recovered.get(trial.trialId);
      if (!recovered) continue;
      const { result, saved } = recovered, trialDir = join(root, trial.trialId), task = tasks.get(trial.taskId);
      observeSchema(saved?.toolSchemaHash ?? result.toolSchemaHash);
      lifecycle.record(trial, { type: 'recovery_evidence_verified' });
      if (saved) trials.set(trial.trialId, saved);
      else {
        verifiedSeal(trialDir, lifecycle, trial);
        const scored = options.suite === 'roc-native' ? result : await grade(options.suite, dataset, task, result, trialDir, cancel.signal);
        const admission = lifecycle.events(trial.trialId).find(event => event.to === 'admitted');
        trials.set(trial.trialId, storeGrade(root, execution, trial, scored, admission.startedAtMs));
      }
    }
    const pending = plan.trials.filter(trial => !trials.has(trial.trialId));
    if (pending.length && resume && usesApplication(options.suite) && manifest.evidence !== 'fixture') {
      modelHost = await openRocModel(options);
      if (Object.entries(modelHost.identity).some(([key, value]) => hash(value) !== hash(config[key]))) fail('state', 'resume_model_configuration_changed');
    }
    if (pending.length && resume && isRag(options.suite)) {
      const selection = hostSelection(manifest.retrievalConfig, ablation);
      if (selection.mode === 'hybrid' || selection.rerank === 'semantic') retrievalHost = await openRocRetrieval({
        ...(options.rocRoot ? { rocRoot: options.rocRoot } : {}), ...(options.appName ? { appName: options.appName } : {}), ...selection, signal: cancel.signal });
      if (hash(retrievalHost?.identity ?? { embedding: null, reranker: null }) !== hash(manifest.retrievalProvider)) fail('state', 'resume_retrieval_configuration_changed');
    }
    const complete = usesApplication(options.suite) && pending.length
      ? createProvider(config, event => execution.append(event), { budget,
        complete: manifest.evidence === 'fixture' ? options.suite === 'qasper' ? fixtureCompletion : ragEngineeringCompletion : modelHost.complete }) : null;
    await scheduleTrials(pending, { maxConcurrentTrials: plan.maxConcurrentTrials, signal: cancel.signal, execute: async trial => {
      const trialDir = join(root, trial.trialId), task = tasks.get(trial.taskId), record = recordFor(trial);
      if (resume) discardUndispatched(root, trial, lifecycle);
      mkdirSync(trialDir, { mode: 0o700 });
      let started = Date.now(), result, scored;
      try {
        await withinTrial(execution, trial, cancel.signal, async (signal, startedAt) => {
          started = startedAt; record({ type: 'trial_started' });
          const transition = (to, detail) => { if (lifecycle.state(trial.trialId) !== to) lifecycle.transition(trial, to, detail); };
          if (options.suite === 'roc-native') {
            scored = await executeNative({ root, directory: trialDir, signal, lifecycle: transition });
            verifiedSeal(trialDir, lifecycle, trial);
          } else if (options.suite === 'rag-retrieval') {
            result = await executeRagComponent({ dataset, task, directory: trialDir, config: manifest.retrievalConfig, capability,
              transport: budgetRetrievalTransport(retrievalHost, execution, trial), signal, record, lifecycle: transition });
            observeSchema(result.toolSchemaHash);
            verifiedSeal(trialDir, lifecycle, trial);
            scored = await grade(options.suite, dataset, task, result, trialDir, signal);
          } else {
            let research;
            if (isRag(options.suite)) {
              transition('dispatched');
              research = await openRagEnvironment({ dataset, task, directory: trialDir, config: manifest.retrievalConfig,
                transport: budgetRetrievalTransport(retrievalHost, execution, trial), signal, record });
            }
            try {
              result = await executeApplication({ artifact, input: inputFor(options.suite, task), directory: trialDir, config, signal, record,
                correlation: { trialId: trial.trialId, traceId: trial.traceId }, lifecycle: transition, research,
                protectedPaths: [join(root, 'manifest.json'), join(root, 'run-plan.json'), join(root, 'budget-state.json'),
                  ...(dataset ? [join(dataset.root, 'tasks.json')] : []), ...(research ? [research.databasePath] : [])],
                complete: (body, requestSignal, binding) => complete.complete(body, requestSignal, { trialId: trial.trialId, requestId: binding.requestId }),
                stage: options.suite === 'scienceagentbench' ? workspace => stageScience(dataset, task, workspace) : undefined,
                execute: options.suite === 'scienceagentbench' ? (workspace, executionSignal, limits) => executeScience(task, workspace, executionSignal, limits) : undefined });
            } finally { await research?.close(); }
            scored = await grade(options.suite, dataset, task, result, trialDir, signal);
          }
        });
      } catch (error) {
        const invalid = recordFailure(root, execution, trial, error, cancel.signal, started);
        trials.set(trial.trialId, invalid); throw error;
      }
      trials.set(trial.trialId, storeGrade(root, execution, trial, scored, started));
    } });
    if (dataset) {
      const current = loadDataset(dataset.root);
      if (current.manifest.identity !== manifest.datasetIdentity) fail('data', 'dataset_changed_during_run');
      if (options.suite === 'qasper' && hash(current.qasperQualification) !== hash(manifest.qasperQualification)) {
        fail('data', 'qasper_qualification_changed_during_run');
      }
    }
    if (sourceIdentity().sourceHash !== manifest.source.sourceHash) fail('state', 'source_changed_during_run');
    if (experiment) assertExperimentUnchanged(experiment);
  } catch (error) {
    // A rejected resumer must not finalize another owner's run or rewrite its
    // journal. Admission failures leave the existing evidence for reconciliation.
    if (resume && !execution) { events.close(); throw error; }
    fatal = failure(error, cancel.signal); events.append({ type: 'run_failed', ...fatal });
  }
  finally {
    for (const host of [modelHost, retrievalHost]) if (host) {
      try { await host.close(); } catch { fatal = { failureClass: 'infrastructure', reason: 'privileged_host_cleanup_failed' }; }
    }
    cancel.close();
  }
  if (!existsSync(join(root, 'manifest.json'))) durableJson(join(root, 'manifest.json'), manifest);
  const ordered = execution ? execution.plan.trials.map(trial => trials.get(trial.trialId)).filter(Boolean) : [...trials.values()];
  durableJson(join(root, 'trials.json'), ordered);
  // Every generation/retrieval dispatch happens after openExecution returns.
  // Admission refusals therefore have known empty accounting, including setup time.
  const capturedAtMs = Date.now();
  const usage = execution?.budget.snapshot() ?? {
    ...new BudgetController(manifest.executionPolicy?.budget ?? {}, undefined, { now: () => capturedAtMs }).snapshot(),
    startedAtMs, elapsedMs: Math.max(0, capturedAtMs - startedAtMs)
  };
  const summary = summarize(manifest, ordered, fatal, usage);
  if (options.suite === 'roc-native') summary.assessment = summary.status === 'complete' && ordered.every(trial => trial.success) ? 'pass' : 'fail';
  events.append({ type: 'run_finished', status: summary.status }); events.close(); sealRun(root, summary);
  return { directory: root, ...summary };
}
