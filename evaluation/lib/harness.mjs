import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { directory, EVAL_ROOT, fail, fileInventory, hash, journal, readJson, ROOT, RUNS, sha256, sourceIdentity, writeJson } from './common.mjs';
import { harnessCases, harnessCompletion, selectHarnessCases } from './harness-cases.mjs';
import { readHarnessState, summarizeHarness, verifyHarnessCase } from './harness-verifier.mjs';
import { sealRun } from './report.mjs';
import { budgetOptionsSchema } from './budget.mjs';
import { summarizeDiagnostics, summarizeResources } from './analysis.mjs';
import { cancellation, executionPolicy, failure, inspectResumable, openExecution, readGrade, recordFailure,
  runStartedAt, storeGrade, validateVerifiedSeal, verifiedSeal, withinTrial } from './execution.mjs';
import { discardUndispatched, durableJson, scheduleTrials, TrialLifecycle } from './lifecycle.mjs';

async function prepareWorker(root) {
  const path = join(root, 'harness-worker.mjs');
  const built = await build({ entryPoints: [join(EVAL_ROOT, 'runtime/harness-worker.ts')], outfile: path,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', metafile: true, loader: { '.md': 'text' }, logLevel: 'silent' });
  const inputs = Object.keys(built.metafile.inputs);
  if (inputs.some(p => /fixtures|evaluation\/(?:lib|adapters|graders|analysis|tests|tasks)\//.test(p))) fail('policy', 'harness_verifier_in_worker_graph');
  const artifact = { path, sha256: sha256(readFileSync(path)), inputs, nodeModulesPath: realpathSync(join(ROOT, 'node_modules')) };
  writeJson(join(root, 'worker.json'), artifact);
  return artifact;
}
async function backup(path, target) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { await db.backup(target); } finally { db.close(); }
}
async function runPhase({ artifact, root, trial, scenario, phase, runId, signal, record, execution, correlation }) {
  const node = realpathSync(process.execPath), quote = p => JSON.stringify(realpathSync(p));
  const policy = `(version 1)(deny default)(import "system.sb")
    (allow process-fork)(allow process-exec (literal ${quote(node)}))
    (allow sysctl-read file-read-metadata)
    (deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid))
    (allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/usr/share") (subpath "/System/Library")
      (subpath "/opt/homebrew/opt") (subpath "/opt/homebrew/Cellar") (subpath ${quote(artifact.nodeModulesPath)}))
    (allow file-read* file-write* file-map-executable (subpath ${quote(root)}))
    (allow file-read* file-write-data (literal "/dev/null") (literal "/dev/urandom"))
    (allow signal (target self))`;
  writeFileSync(join(trial, `${phase}.sb`), policy, { mode: 0o600 });
  const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, node, join(root, 'harness-worker.mjs')], {
    cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'en_US.UTF-8', OPENSSL_CONF: '/dev/null',
      LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' }
  });
  record({ type: 'worker_started', phase, pid: child.pid });
  const { terminateProcessTreeWithRetry } = await importTypeScriptModule(join(ROOT, 'src/main/services/process-tree.ts'), { platform: 'node' });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  void closed.catch(() => {});
  let cleanup, timedOut = false, oversized = false, size = 0, requests = 0;
  const stop = () => { cleanup ??= terminateProcessTreeWithRetry(child); void cleanup.catch(() => {}); return cleanup; };
  const abort = () => { void stop(); };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; void stop(); }, 30000);
  const retain = (name, text) => {
    size += Buffer.byteLength(text);
    if (size > 32 * 1024 * 1024) { oversized = true; void stop(); }
    else appendFileSync(join(trial, name), text, { mode: 0o600 });
  };
  child.stderr.on('data', text => retain(`${phase}.stderr.log`, text));
  // Bound unterminated output before readline can buffer it.
  let stdoutSize = 0;
  child.stdout.on('data', chunk => { stdoutSize += chunk.length; if (stdoutSize > 32 * 1024 * 1024) { oversized = true; void stop(); } });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  try {
    signal.throwIfAborted();
    send({ phase, prompt: scenario.prompt, tools: scenario.tools, fault: scenario.fault,
      protectedPath: join(trial, 'protected-truth.txt'), ...(runId ? { runId } : {}) });
    for await (const line of lines) {
      retain(`${phase}.jsonl`, line + '\n');
      const message = JSON.parse(line);
      if (message.type === 'request') {
        const binding = { trialId: correlation?.trialId ?? 'unscoped',
          requestId: `controlled-${correlation?.traceId ?? hash(trial).slice(0, 32)}-${phase}-${requests + 1}`, requestHash: hash(message.body) };
        record({ type: 'model_request', phase, request: requests + 1, ...binding });
        if (requests++ >= 12) fail('harness', 'harness_controlled_request_limit');
        if (execution) {
          execution.budget.reserve({ ...binding, kind: 'chat', providerId: 'roc-harness-controlled', model: 'roc-harness-scripted',
            inputTokens: Buffer.byteLength(JSON.stringify(message.body)) + 64, outputTokens: 4096 });
          execution.budget.dispatch(binding.requestId, binding);
        }
        if (phase === 'start' && scenario.fault === 'model-pending') {
          execution?.budget.unknown(binding.requestId, 'controlled_request_interrupted'); continue;
        }
        if (scenario.cancel) { execution?.budget.unknown(binding.requestId, 'controlled_request_cancelled'); send({ type: 'cancel' }); continue; }
        const body = harnessCompletion(scenario, message.body, requests - 1);
        execution?.budget.settle(binding.requestId, body.usage);
        retain(`${phase}.responses.jsonl`, JSON.stringify({ request: requests - 1, ...binding, body }) + '\n');
        send({ type: 'response', body });
      } else if (message.type === 'approval') {
        if (phase !== 'start' || !scenario.decision) fail('environment', 'harness_unexpected_approval');
        await backup(join(root, 'agent.sqlite'), join(trial, 'approval.sqlite'));
        await backup(join(root, 'workspace.sqlite'), join(trial, 'approval-workspace.sqlite'));
        writeJson(join(trial, 'approval-files.json'), fileInventory(join(root, 'workspace')));
        const decision = { type: 'decision', decision: scenario.decision };
        retain(`${phase}.decisions.jsonl`, JSON.stringify(decision) + '\n');
        record({ type: 'approval_released', phase, decision: scenario.decision });
        send(decision);
      } else if (!['isolation', 'event', 'task-event', 'started', 'boundary', 'reconciled', 'model-aborted', 'cancelled', 'result', 'bus-error'].includes(message.type)) {
        fail('infrastructure', 'harness_worker_protocol_invalid');
      }
    }
    const result = await closed;
    signal.throwIfAborted();
    if (timedOut) fail('environment', 'harness_worker_timeout');
    if (oversized) fail('infrastructure', 'harness_evidence_limit');
    if (![0, 73].includes(result.code) || result.signal !== null) fail('harness', 'harness_worker_unexpected_exit');
    await stop();
    let processGroupGone = false;
    try { process.kill(-child.pid, 0); }
    catch (error) { processGroupGone = error.code === 'ESRCH'; }
    if (!processGroupGone) fail('infrastructure', 'harness_process_group_remaining');
    return { phase, ...result, pid: child.pid, requests, processGroupGone };
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort); lines.close(); child.stdin.end();
    await stop();
  }
}
export async function runHarnessCase({ artifact, scenario, trial, signal, record = () => {}, execution, correlation, lifecycle = () => {} }) {
  const root = join(trial, 'worker');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, 'workspace'), { mode: 0o700 });
  for (const [name, text] of Object.entries(scenario.files)) writeFileSync(join(root, 'workspace', name), text, { mode: 0o600, flag: 'wx' });
  copyFileSync(artifact.path, join(root, 'harness-worker.mjs'));
  if (sha256(readFileSync(join(root, 'harness-worker.mjs'))) !== artifact.sha256) fail('state', 'harness_worker_changed');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  writeFileSync(join(trial, 'protected-truth.txt'), 'controller-only-verifier-sentinel', { mode: 0o600 });
  symlinkSync(artifact.nodeModulesPath, join(root, 'node_modules'));
  const phases = [];
  let cleaned = false;
  try {
    lifecycle('dispatched');
    phases.push(await runPhase({ artifact, root, trial, scenario, phase: 'start', signal, record, execution, correlation }));
    if (scenario.recover) {
      await backup(join(root, 'agent.sqlite'), join(trial, 'before.sqlite'));
      const before = readHarnessState(join(trial, 'before.sqlite'));
      writeJson(join(trial, 'before-state.json'), before);
      if (before.runs.length !== 1) fail('harness', 'harness_crash_run_missing');
      phases.push(await runPhase({ artifact, root, trial, scenario, phase: 'recover', runId: before.runs[0].id, signal, record, execution, correlation }));
    }
    await backup(join(root, 'agent.sqlite'), join(trial, 'final.sqlite'));
    await backup(join(root, 'workspace.sqlite'), join(trial, 'final-workspace.sqlite'));
    writeJson(join(trial, 'final-state.json'), readHarnessState(join(trial, 'final.sqlite')));
  } finally {
    writeJson(join(trial, 'phases.json'), phases);
    if (existsSync(join(root, 'node_modules'))) unlinkSync(join(root, 'node_modules'));
    cleaned = !existsSync(join(root, 'node_modules'));
    writeJson(join(trial, 'cleanup.json'), { processGroupsGone: phases.length > 0 && phases.every(p => p.processGroupGone),
      dependencyLinkRemoved: cleaned });
  }
  if (!cleaned) fail('infrastructure', 'harness_dependency_cleanup_failed');
  lifecycle('completed');
  return verifyHarnessCase(scenario, trial);
}
export function recoverHarnessCase(scenario, directory) {
  const phases = readJson(join(directory, 'phases.json')), cleanup = readJson(join(directory, 'cleanup.json'));
  if (!cleanup.processGroupsGone || !cleanup.dependencyLinkRemoved || !phases.length) fail('state', 'resume_harness_cleanup_unconfirmed');
  for (const phase of phases) {
    if (!phase.processGroupGone || !Number.isSafeInteger(phase.pid) || phase.pid <= 0) fail('state', 'resume_harness_cleanup_unconfirmed');
    try { process.kill(-phase.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') continue; throw error; }
    fail('state', 'resume_harness_process_group_remaining');
  }
  const grade = verifyHarnessCase(scenario, directory);
  if (grade.status === 'invalid') fail('state', 'resume_harness_evidence_invalid');
  return grade;
}
export async function runHarness(options = {}) {
  const resume = options.resumeContext ?? (options.resume ? inspectResumable(options.resume) : null);
  const recovered = new Map();
  if (resume) {
    if (resume.manifest.suite !== 'roc-harness' || resume.manifest.datasetIdentity !== hash(harnessCases)
      || resume.manifest.scorerHash !== sha256(readFileSync(new URL('./harness-verifier.mjs', import.meta.url)))) fail('state', 'resume_harness_contract_changed');
    const lifecycle = new TrialLifecycle(resume.plan, () => fail('state', 'resume_validation_is_readonly'), resume.events);
    for (const trial of resume.plan.trials) {
      if (lifecycle.recovery(trial) === 'never-dispatched') continue;
      validateVerifiedSeal(resume.root, lifecycle, trial);
      const saved = readGrade(resume.root, { lifecycle }, trial);
      const scenario = harnessCases.find(item => item.id === trial.taskId);
      recovered.set(trial.trialId, { grade: recoverHarnessCase(scenario, join(resume.root, trial.trialId)), saved });
    }
  }
  const root = resume?.root ?? directory(options.outputRoot ?? RUNS, 'roc-harness');
  const events = journal(join(root, 'events.jsonl'), { resume: Boolean(resume) });
  const startedAtMs = resume ? runStartedAt(resume.events) : Date.now(), cancel = cancellation(startedAtMs);
  const trials = new Map();
  const manifest = resume?.manifest ?? { schemaVersion: 1, suite: 'roc-harness', trigger: 'manual', command: process.argv.slice(2),
    profile: options.profile ?? 'fast', selection: [], repeats: 1, exclusions: [], metrics: ['scenarioPassRate'],
    split: 'controlled', evidence: 'controlled-model', datasetIdentity: hash(harnessCases), adapter: 'production-runtime-controlled-model-v1',
    provider: { model: 'roc-harness-scripted', transport: 'local-stdio', inferenceRequests: 0 },
    permissions: { schemaVersion: 1, worker: 'macos-deny-default-no-network', credentials: 'none', configuration: 'none', externalExecution: 'none' },
    environment: { platform: process.platform, arch: process.arch, node: process.version }, source: null,
    scorerHash: sha256(readFileSync(new URL('./harness-verifier.mjs', import.meta.url))) };
  let fatal = null, execution;
  if (!resume) events.append({ type: 'run_started', suite: manifest.suite, profile: manifest.profile, startedAtMs });
  try {
    if (process.platform !== 'darwin') fail('environment', 'macos_sandbox_required');
    if (options.dataset || options.providerOptions || options.rocRoot || options.providerId || options.modelId || options.appName || options.fixture || options.experiment || options.retrievalOptions) {
      fail('policy', 'harness_uses_controlled_provider_and_private_workspaces');
    }
    let artifact;
    if (!resume) {
      const selected = selectHarnessCases(manifest.profile, options.task);
      manifest.selection = selected.cases.map(({ id, dimension }) => ({ id, clusterId: dimension, dimension }));
      manifest.exclusions = harnessCases.filter(item => !selected.cases.includes(item)).map(item => ({ id: item.id, reason: 'profile_or_task_selection' }));
      manifest.repeats = selected.repeats; manifest.source = sourceIdentity();
      manifest.metricsHash = hash({ metrics: manifest.metrics, applicability: 'explicit-null-not-applicable-v1', scorerHash: manifest.scorerHash });
      manifest.taskSchemaHash = hash({ suite: manifest.suite, taskSchemaVersion: 1 });
      const budget = budgetOptionsSchema.parse({ maxTaskDurationMs: 120000, ...(options.budgetOptions ? readJson(options.budgetOptions) : {}) });
      manifest.budget = budget; manifest.provider.budget = budget;
      manifest.executionPolicy = executionPolicy({ taskTimeoutMs: 120000, budget }, options.concurrency ?? 2);
      cancel.configure(manifest.executionPolicy);
      artifact = await prepareWorker(root);
      manifest.workerHash = artifact.sha256; manifest.environment.lockfileHash = manifest.source.lockfileHash;
      durableJson(join(root, 'manifest.json'), manifest);
    } else {
      cancel.configure(manifest.executionPolicy);
      artifact = readJson(join(root, 'worker.json'));
      if (artifact.sha256 !== manifest.workerHash || sha256(readFileSync(artifact.path)) !== artifact.sha256) fail('state', 'resume_harness_worker_changed');
    }
    execution = openExecution(root, manifest, events, resume?.events);
    const { lifecycle, plan } = execution;
    for (const trial of plan.trials) {
      const existing = recovered.get(trial.trialId);
      if (!existing) continue;
      if (existing.saved) trials.set(trial.trialId, existing.saved);
      else {
        verifiedSeal(join(root, trial.trialId), lifecycle, trial);
        const admission = lifecycle.events(trial.trialId).find(event => event.to === 'admitted');
        trials.set(trial.trialId, storeGrade(root, execution, trial,
          { ...existing.grade, success: existing.grade.status === 'passed', dimension: trial.clusterId }, admission.startedAtMs));
      }
      lifecycle.record(trial, { type: 'recovery_evidence_verified' });
    }
    const scheduled = await scheduleTrials(plan.trials.filter(trial => !trials.has(trial.trialId)), {
      maxConcurrentTrials: plan.maxConcurrentTrials, signal: cancel.signal, stopOnError: false, execute: async trial => {
        const directory = join(root, trial.trialId), scenario = harnessCases.find(item => item.id === trial.taskId);
        if (resume) discardUndispatched(root, trial, lifecycle);
        mkdirSync(directory, { mode: 0o700 });
        let started = Date.now(), grade, requests = 0;
        const record = event => {
          if (event.type === 'model_request') requests++;
          lifecycle.record(trial, event);
        };
        try {
          await withinTrial(execution, trial, cancel.signal, async (signal, startedAt) => {
            started = startedAt; record({ type: 'trial_started' });
            grade = await runHarnessCase({ artifact, scenario, trial: directory, signal, record, execution, correlation: trial,
              lifecycle: (to, detail) => lifecycle.transition(trial, to, detail) });
            if (grade.status === 'invalid') fail(grade.failureClass, grade.reason);
            verifiedSeal(directory, lifecycle, trial);
          });
        } catch (error) {
          trials.set(trial.trialId, { ...recordFailure(root, execution, trial, error, cancel.signal, started), dimension: scenario.dimension, requests });
          return;
        }
        trials.set(trial.trialId, storeGrade(root, execution, trial,
          { ...grade, dimension: scenario.dimension, success: grade.status === 'passed', requests }, started));
      }
    });
    if (scheduled.error) throw scheduled.error;
    if (sourceIdentity().sourceHash !== manifest.source.sourceHash) fail('state', 'source_changed_during_run');
  } catch (error) {
    if (resume && !execution) { events.close(); throw error; }
    fatal = failure(error, cancel.signal); events.append({ type: 'run_failed', ...fatal });
  }
  finally { cancel.close(); }
  if (!existsSync(join(root, 'manifest.json'))) durableJson(join(root, 'manifest.json'), manifest);
  const ordered = execution ? execution.plan.trials.map(trial => trials.get(trial.trialId)).filter(Boolean) : [...trials.values()];
  durableJson(join(root, 'trials.json'), ordered);
  const usage = execution?.budget.snapshot() ?? null;
  const summary = { ...summarizeHarness(manifest, ordered, fatal), diagnostics: summarizeDiagnostics(ordered),
    resources: summarizeResources(ordered, usage), usage: { ...usage, inferenceRequests: 0 } };
  events.append({ type: 'run_finished', status: summary.status, assessment: summary.assessment }); events.close(); sealRun(root, summary);
  return { directory: root, ...summary };
}
