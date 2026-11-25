#!/usr/bin/env node

import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {cpus, release, tmpdir, totalmem} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {createResearchFixture, loadResearchTestApi} from '../tests/unit/fixtures/research-test-kit.mjs';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pythonIdentityCode = 'import json,os,platform,sys;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":platform.python_version(),"implementation":sys.implementation.name,"architecture":platform.machine(),"platform":sys.platform}))';

function command(name, args) {
  return execFileSync(name, args, {cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000}).trim();
}

function summarize(values) {
  assert.ok(values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0),
    'python_preparation_samples_invalid');
  const sorted = [...values].sort((left, right) => left - right);
  return {count: sorted.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length * .5) - 1],
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1)};
}

async function sample(api, python, index) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'roc-python-preparation-')));
  const workspace = join(directory, 'workspace'), venv = join(workspace, '.venv');
  let fixture, service;
  try {
    await mkdir(workspace);
    const venvStarted = performance.now();
    await execute(python.executable, ['-I', '-m', 'venv', '--without-pip', venv],
      {cwd: workspace, timeout: 120_000, maxBuffer: 1024 * 1024});
    const venvCreateMs = performance.now() - venvStarted;
    const venvConfigHash = sha256(await readFile(join(venv, 'pyvenv.cfg')));
    fixture = createResearchFixture(api, 'experiment', workspace);
    service = new api.ResearchPythonEnvironmentService(fixture.repository);
    const request = {projectId: fixture.project.id};
    const coldStarted = performance.now();
    const first = await service.list(request);
    const autoInspectMs = performance.now() - coldStarted;
    assert.equal(first.length, 1, 'python_preparation_initial_receipt_count');
    const snapshot = first[0].snapshot;
    assert.deepEqual(snapshot.actor, {kind: 'system', id: 'roc-python-environment'});
    assert.equal(dirname(snapshot.selectedExecutable), join(venv, 'bin'),
      'python_preparation_selected_outside_project_venv');
    assert.equal(await realpath(snapshot.selectedExecutable), python.executable,
      'python_preparation_selected_interpreter_changed');
    const lockPath = join(workspace, 'roc-python.lock.json');
    const lockBytes = await readFile(lockPath), lock = JSON.parse(lockBytes.toString('utf8'));
    assert.equal(lock.python.version, python.version, 'python_preparation_lock_version_changed');
    assert.deepEqual(lock.distributions, [], 'python_preparation_unexpected_dependencies');
    const warmStarted = performance.now();
    const reused = await service.list(request);
    const reuseInspectMs = performance.now() - warmStarted;
    assert.deepEqual(reused, first, 'python_preparation_reuse_changed_receipt');
    assert.deepEqual(await readFile(lockPath), lockBytes, 'python_preparation_reuse_changed_lock');
    assert.equal(sha256(await readFile(join(venv, 'pyvenv.cfg'))), venvConfigHash,
      'python_preparation_venv_configuration_changed');
    return {sample: index + 1, venvCreateMs, autoInspectMs, reuseInspectMs,
      lockSha256: sha256(lockBytes), venvConfigSha256: venvConfigHash,
      metadataHash: snapshot.metadataHash, selectedExecutable: relative(workspace, snapshot.selectedExecutable),
      selectedBinarySha256: sha256(await readFile(snapshot.selectedExecutable)),
      receiptCount: reused.length, distributions: lock.distributions,
      fixture: 'fresh project directory and in-memory repositories; empty real CPython venv'};
  } finally {
    try { await service?.shutdown(); }
    finally {
      try { await fixture?.close(); }
      finally { await rm(directory, {recursive: true, force: true}); }
    }
  }
}

async function main(args) {
  assert.ok(args.length >= 1 && args.length <= 3 && args[0].endsWith('.json'),
    'Usage: node scripts/benchmark-python-project-preparation.mjs OUTPUT_JSON [PYTHON_EXECUTABLE] [SAMPLES=5]');
  assert.equal(realpathSync(process.cwd()), root, 'python_preparation_run_from_repository_root');
  const output = resolve(args[0]), samples = Number(args[2] ?? 5);
  assert.ok(Number.isSafeInteger(samples) && samples > 0, 'python_preparation_sample_count_invalid');
  assert.ok(!existsSync(output), 'python_preparation_output_exists');
  const requestedExecutable = args[1] ?? 'python3';
  const python = JSON.parse(command(requestedExecutable, ['-I', '-S', '-c', pythonIdentityCode]));
  assert.equal(python.implementation, 'cpython');
  assert.match(python.version, /^3\.14\.\d+$/u);
  assert.equal(python.platform, 'darwin');
  assert.equal(python.architecture, 'arm64');
  python.executable = realpathSync(python.executable);
  python.binarySha256 = sha256(readFileSync(python.executable));
  const sourceFiles = ['scripts/benchmark-python-project-preparation.mjs',
    'tests/unit/fixtures/research-test-kit.mjs', 'tests/unit/fixtures/research-test-api.ts',
    'src/main/plugins/research/python-environment-service.ts',
    'src/main/plugins/research/python-environment-discovery.ts',
    'src/main/plugins/research/python-environment-repository.ts',
    'src/main/plugins/research/experiment-python-probe.ts',
    'src/main/plugins/research/experiment-python-controls.ts',
    'src/main/plugins/research/experiment-python-code-schema.ts',
    'src/shared/schemas/research-python-environments.ts', 'package.json', 'pnpm-lock.yaml'];
  const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, sha256(readFileSync(join(root, path)))]));
  const source = {gitSha: command('git', ['rev-parse', 'HEAD']),
    trackedDirty: command('git', ['status', '--porcelain', '--untracked-files=no']) !== '',
    packageSha256: sourceHashes['package.json'], packageLockSha256: sourceHashes['pnpm-lock.yaml'], sourceHashes};
  const measuredAt = new Date().toISOString(), api = await loadResearchTestApi(), rows = [];
  try {
    for (let index = 0; index < samples; index++) {
      const row = await sample(api, python, index);
      assert.equal(row.selectedBinarySha256, python.binarySha256, 'python_preparation_binary_changed');
      rows.push(row);
      console.error(JSON.stringify({sample: row.sample, venvCreateMs: row.venvCreateMs,
        autoInspectMs: row.autoInspectMs, reuseInspectMs: row.reuseInspectMs}));
    }
  } finally { api.dispose(); }
  assert.equal(sha256(readFileSync(python.executable)), python.binarySha256, 'python_preparation_binary_changed');
  for (const [path, expected] of Object.entries(sourceHashes)) {
    assert.equal(sha256(readFileSync(join(root, path))), expected, `python_preparation_source_changed:${path}`);
  }
  const report = {schemaVersion: 1, kind: 'python-project-preparation-baseline', status: 'complete', measuredAt,
    source, python: {...python, requestedExecutable},
    host: {platform: process.platform, arch: process.arch, osRelease: release(),
      chip: cpus()[0]?.model ?? null, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), node: process.version},
    fixture: {samples, venvCommand: ['-I', '-m', 'venv', '--without-pip', '<project>/.venv'],
      preparationApi: 'ResearchPythonEnvironmentService.list', runtime: 'real CPython, production environment probe'},
    rows, summary: Object.fromEntries(['venvCreateMs', 'autoInspectMs', 'reuseInspectMs']
      .map(metric => [metric, summarize(rows.map(row => row[metric]))])),
    limitations: [
      'The current product discovers and inspects existing environments; it does not create this venv.',
      'venvCreateMs measures explicit external preparation; autoInspectMs and reuseInspectMs measure the production list API.',
      'Interpreter and packages are already local. No download, pip, uv resolution or real scientific dependency installation is measured.',
      'Each sample uses a new project and empty real venv. Imports, fixture database setup and cleanup are excluded from measured intervals.',
      'Warm inspection reuses the same service and receipt; OS filesystem caches are not flushed.',
      'Temporary project paths differ between samples and are included in environment identity; metadata hashes need not match between samples.'
    ]};
  await mkdir(dirname(output), {recursive: true, mode: 0o700});
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({output: relative(root, output), status: report.status, samples, summary: report.summary}));
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
