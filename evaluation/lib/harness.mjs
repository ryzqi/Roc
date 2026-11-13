import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { directory, EVAL_ROOT, fail, fileInventory, hash, journal, ROOT, RUNS, sha256, sourceIdentity, writeJson } from './common.mjs';
import { harnessCases, harnessCompletion, selectHarnessCases } from './harness-cases.mjs';
import { readHarnessState, summarizeHarness, verifyHarnessCase } from './harness-verifier.mjs';
import { sealRun } from './report.mjs';

async function prepareWorker(root) {
  const path = join(root, 'harness-worker.mjs');
  const built = await build({ entryPoints: [join(EVAL_ROOT, 'runtime/harness-worker.ts')], outfile: path,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', metafile: true, loader: { '.md': 'text' }, logLevel: 'silent' });
  const inputs = Object.keys(built.metafile.inputs);
  if (inputs.some(p => /fixtures|evaluation\/(?:lib|tests|tasks)\//.test(p))) fail('policy', 'harness_verifier_in_worker_graph');
  const artifact = { path, sha256: sha256(readFileSync(path)), inputs, nodeModulesPath: realpathSync(join(ROOT, 'node_modules')) };
  writeJson(join(root, 'worker.json'), artifact);
  return artifact;
}
async function backup(path, target) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { await db.backup(target); } finally { db.close(); }
}
async function runPhase({ artifact, root, trial, scenario, phase, runId, signal, record }) {
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
        record({ type: 'model_request', phase, request: requests + 1, requestHash: hash(message.body) });
        if (requests++ >= 12) fail('harness', 'harness_controlled_request_limit');
        if (phase === 'start' && scenario.fault === 'model-pending') continue;
        if (scenario.cancel) { send({ type: 'cancel' }); continue; }
        const body = harnessCompletion(scenario, message.body, requests - 1);
        retain(`${phase}.responses.jsonl`, JSON.stringify({ request: requests - 1, body }) + '\n');
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
export async function runHarnessCase({ artifact, scenario, trial, signal, record = () => {} }) {
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
    phases.push(await runPhase({ artifact, root, trial, scenario, phase: 'start', signal, record }));
    if (scenario.recover) {
      await backup(join(root, 'agent.sqlite'), join(trial, 'before.sqlite'));
      const before = readHarnessState(join(trial, 'before.sqlite'));
      writeJson(join(trial, 'before-state.json'), before);
      if (before.runs.length !== 1) fail('harness', 'harness_crash_run_missing');
      phases.push(await runPhase({ artifact, root, trial, scenario, phase: 'recover', runId: before.runs[0].id, signal, record }));
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
  return verifyHarnessCase(scenario, trial);
}
export async function runHarness(options = {}) {
  const root = directory(options.outputRoot ?? RUNS, 'roc-harness'), events = journal(join(root, 'events.jsonl'));
  const controller = new AbortController(), cancel = () => controller.abort(new Error('operator_interrupt'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const trials = [];
  const manifest = { schemaVersion: 1, suite: 'roc-harness', trigger: 'manual', command: process.argv.slice(2),
    profile: options.profile ?? 'fast', selection: [], repeats: 1, exclusions: [], metrics: ['scenarioPassRate'],
    split: 'controlled', evidence: 'controlled-model', datasetIdentity: hash(harnessCases),
    provider: { model: 'roc-harness-scripted', transport: 'local-stdio', inferenceRequests: 0 },
    environment: { platform: process.platform, arch: process.arch, node: process.version }, source: null,
    scorerHash: sha256(readFileSync(new URL('./harness-verifier.mjs', import.meta.url))) };
  let fatal = null;
  try {
    if (process.platform !== 'darwin') fail('environment', 'macos_sandbox_required');
    if (options.dataset || options.providerOptions || options.rocRoot || options.providerId || options.modelId || options.appName || options.fixture || options.experiment) {
      fail('policy', 'harness_uses_controlled_provider_and_private_workspaces');
    }
    const selected = selectHarnessCases(manifest.profile, options.task);
    manifest.selection = selected.cases.map(({ id, dimension }) => ({ id, clusterId: dimension, dimension }));
    manifest.exclusions = harnessCases.filter(c => !selected.cases.includes(c)).map(c => ({ id: c.id, reason: 'profile_or_task_selection' }));
    manifest.repeats = selected.repeats; manifest.source = sourceIdentity();
    const artifact = await prepareWorker(root);
    manifest.workerHash = artifact.sha256; manifest.environment.lockfileHash = manifest.source.lockfileHash;
    writeJson(join(root, 'manifest.json'), manifest);
    for (const scenario of selected.cases) for (let repeat = 0; repeat < selected.repeats; repeat++) {
      controller.signal.throwIfAborted();
      const trial = join(root, `trial-${scenario.id}-${repeat}`); mkdirSync(trial, { mode: 0o700 });
      const started = Date.now();
      let requests = 0;
      const record = event => {
        if (event.type === 'model_request') requests++;
        events.append({ ...event, taskId: scenario.id, repeat });
      };
      record({ type: 'trial_started' });
      let grade;
      try { grade = await runHarnessCase({ artifact, scenario, trial, signal: controller.signal, record }); }
      catch (error) {
        grade = { status: 'invalid', checks: [], metrics: null,
          failureClass: controller.signal.aborted ? 'operator' : error.failureClass ?? 'infrastructure',
          reason: String(error.message).slice(0, 320) };
      }
      const result = { taskId: scenario.id, clusterId: scenario.dimension, dimension: scenario.dimension, repeat,
        ...grade, requests, latencyMs: Date.now() - started };
      trials.push(result); writeJson(join(trial, 'grade.json'), result); record({ type: 'trial_finished', ...result });
      // Continue independent cases, so one harness defect does not hide other
      // dimensions. Operator cancellation still stops dispatch immediately.
    }
    if (sourceIdentity().sourceHash !== manifest.source.sourceHash) fail('state', 'source_changed_during_run');
  } catch (error) {
    fatal = { failureClass: controller.signal.aborted ? 'operator' : error.failureClass ?? 'infrastructure', reason: String(error.message).slice(0, 320) };
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
  if (!existsSync(join(root, 'manifest.json'))) writeJson(join(root, 'manifest.json'), manifest);
  writeJson(join(root, 'trials.json'), trials);
  const summary = summarizeHarness(manifest, trials, fatal);
  events.append({ type: 'run_finished', status: summary.status, assessment: summary.assessment }); events.close();
  sealRun(root, summary);
  return { directory: root, ...summary };
}
