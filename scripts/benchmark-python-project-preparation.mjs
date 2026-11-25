#!/usr/bin/env node

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {cpus, release, tmpdir, totalmem} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createResearchFixture, loadResearchTestApi} from '../tests/unit/fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const {ResearchPythonRuntimeStore} = await importTypeScriptModule('src/main/plugins/research/python-runtime-store.ts', {platform: 'node'});
const {prepareProjectPythonEnvironment} = await importTypeScriptModule('src/main/plugins/research/python-project-environment.ts', {platform: 'node'});
const {runPythonInstallerProcess} = await importTypeScriptModule('src/main/plugins/research/python-installer-process.ts', {platform: 'node'});
function command(name, args) {
  return execFileSync(name, args, {cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000}).trim();
}
function summarize(values) {
  assert.ok(values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((left, right) => left - right);
  return {count: sorted.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length * .5) - 1],
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1)};
}
async function prepared(service, projectId) {
  const operation = await service.prepareAutomatic(projectId), deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const status = service.status({projectId});
    assert.equal(status.operation?.id, operation.id);
    if (status.operation.phase === 'ready') { assert.ok(status.environment); return status.environment; }
    if (['failed', 'cancelled', 'interrupted'].includes(status.operation.phase)) throw new Error(status.operation.errorCode);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('python_preparation_benchmark_timeout');
}
async function sample(api, store, directory, index) {
  const workspace = join(directory, `project-${index + 1}`); await mkdir(workspace);
  const calls = [], fixture = createResearchFixture(api, 'experiment', workspace);
  const service = new api.ResearchPythonEnvironmentService(fixture.repository, join(directory, 'managed'), {
    prepare: input => prepareProjectPythonEnvironment(input, {store, run: request => {
      calls.push({operation: request.args[0], network: request.network, offline: request.args.includes('--offline')});
      return runPythonInstallerProcess(request);
    }})
  });
  try {
    const freshStarted = performance.now();
    const first = await prepared(service, fixture.project.id), freshPrepareMs = performance.now() - freshStarted;
    const snapshot = first.snapshot;
    assert.deepEqual(snapshot.actor, {kind: 'system', id: 'roc-python-environment'});
    assert.equal(snapshot.version, '3.14.10');
    assert.equal(dirname(snapshot.selectedExecutable), join(workspace, '.venv/bin'));
    const files = Object.fromEntries(await Promise.all(['pyproject.toml', 'uv.lock', '.python-version', '.venv/pyvenv.cfg']
      .map(async path => [path, sha256(await readFile(join(workspace, path)))])));
    const reuseStarted = performance.now();
    const reused = await prepared(service, fixture.project.id), reusePrepareMs = performance.now() - reuseStarted;
    assert.equal(reused.snapshot.metadataHash, snapshot.metadataHash);
    assert.equal(reused.snapshot.codeHash, snapshot.codeHash);
    for (const [path, hash] of Object.entries(files)) assert.equal(sha256(await readFile(join(workspace, path))), hash);
    assert.ok(calls.every(call => call.network === 'none'), 'empty projects must prepare from the installed runtime offline');
    return {sample: index + 1, freshPrepareMs, reusePrepareMs, files, metadataHash: snapshot.metadataHash,
      selectedExecutable: relative(workspace, snapshot.selectedExecutable), managedRuntime: snapshot.managedRuntime,
      binarySha256: sha256(await readFile(snapshot.executable)), receiptCount: service.list({projectId: fixture.project.id}).length, calls};
  } finally { await service.shutdown(); await fixture.close(); }
}
async function main(args) {
  assert.ok(args.length >= 1 && args.length <= 2 && args[0].endsWith('.json'),
    'Usage: node scripts/benchmark-python-project-preparation.mjs OUTPUT_JSON [SAMPLES=5]');
  assert.equal(realpathSync(process.cwd()), root);
  const output = resolve(args[0]), samples = Number(args[1] ?? 5);
  assert.ok(Number.isSafeInteger(samples) && samples > 0); assert.ok(!existsSync(output));
  const sourceFiles = ['scripts/benchmark-python-project-preparation.mjs',
    'tests/unit/fixtures/research-test-kit.mjs', 'tests/unit/fixtures/research-test-api.ts',
    'resources/research-runtime/python-tools.lock.json', 'src/main/plugins/research/python-runtime-store.ts',
    'src/main/plugins/research/python-project-environment.ts', 'src/main/plugins/research/python-project-declarations.ts',
    'src/main/plugins/research/python-installer-process.ts', 'src/main/plugins/research/python-environment-leases.ts',
    'src/main/plugins/research/python-environment-service.ts', 'src/main/plugins/research/python-environment-repository.ts',
    'src/main/plugins/research/experiment-python-probe.ts', 'src/main/plugins/research/experiment-python-controls.ts',
    'src/main/plugins/research/experiment-python-code-schema.ts', 'src/shared/schemas/research-python-environments.ts', 'package.json', 'pnpm-lock.yaml'];
  const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, sha256(readFileSync(join(root, path)))]));
  const source = {gitSha: command('git', ['rev-parse', 'HEAD']), trackedDirty: command('git', ['status', '--porcelain', '--untracked-files=no']) !== '', sourceHashes};
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'roc-python-preparation-'))), rows = [];
  const api = await loadResearchTestApi(), measuredAt = new Date().toISOString();
  let runtime, runtimePrepareMs;
  try {
    const download = process.env.ROC_TEST_PYTHON_ARCHIVES ? async (url, hash, target, options) => {
      options.signal.throwIfAborted();
      const path = join(resolve(process.env.ROC_TEST_PYTHON_ARCHIVES), url.includes('/uv/') ? 'uv.tar.gz' : 'python.tar.gz');
      const bytes = await readFile(path); assert.equal(bytes.length, options.expectedSize); assert.equal(sha256(bytes), hash);
      await copyFile(path, target); return target;
    } : undefined;
    const store = new ResearchPythonRuntimeStore(join(directory, 'managed'), undefined, download);
    const started = performance.now();
    runtime = await store.prepare('3.14.10', 'preparation-benchmark', new AbortController().signal);
    runtimePrepareMs = performance.now() - started;
    for (let index = 0; index < samples; index++) {
      const row = await sample(api, store, directory, index); rows.push(row);
      console.error(JSON.stringify({sample: row.sample, freshPrepareMs: row.freshPrepareMs, reusePrepareMs: row.reusePrepareMs}));
    }
    for (const [path, expected] of Object.entries(sourceHashes)) assert.equal(sha256(readFileSync(join(root, path))), expected, `source changed: ${path}`);
  } finally { api.dispose(); await rm(directory, {recursive: true, force: true}); }
  const report = {schemaVersion: 2, kind: 'python-project-preparation', status: 'complete', measuredAt, source,
    host: {platform: process.platform, arch: process.arch, osRelease: release(), chip: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length, totalMemoryBytes: totalmem(), node: process.version},
    fixture: {samples, preparationApi: 'ResearchPythonEnvironmentService.prepareAutomatic',
      runtime: 'real pinned CPython 3.14.10 and uv 0.13.9; production installer and Seatbelt',
      runtimeArchiveSource: process.env.ROC_TEST_PYTHON_ARCHIVES ? 'verified-local-archives' : 'pinned-network-download',
      runtimePrepareMs, managedRuntime: {version: runtime.version, pythonKey: runtime.pythonKey, uvHash: runtime.uvHash, receiptHash: runtime.receiptHash}},
    rows, summary: Object.fromEntries(['freshPrepareMs', 'reusePrepareMs'].map(metric => [metric, summarize(rows.map(row => row[metric]))])),
    limitations: ['Initial shared interpreter installation is measured separately once; project samples share the managed runtime and uv cache.',
      'Samples use independent empty projects; scientific package downloads and calculations have separate integration evidence.',
      'Database fixtures and module imports are outside timed intervals; operation polling adds up to 10 ms.',
      'OS filesystem caches are warm; no physical cold cache or process isolation from other host work is claimed.',
      'P0 measured external venv creation and discovery; these timings measure complete product preparation and are different workloads.']};
  await mkdir(dirname(output), {recursive: true, mode: 0o700});
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({output: relative(root, output), status: report.status, samples, summary: report.summary}));
}
main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
