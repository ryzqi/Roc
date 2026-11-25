import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, realpath, mkdir, copyFile, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

// Export the runner from the same bundle so injected errors retain class identity.
const { build } = await import('esbuild');
const preparedModule = await build({ stdin: { contents: `
  export {prepareProjectPythonEnvironment as prepare} from './src/main/plugins/research/python-project-environment.ts';
  export {runResearchProcess,ResearchProcessError} from './src/main/plugins/research/process-runner.ts';
  export {runPythonInstallerProcess} from './src/main/plugins/research/python-installer-process.ts';
`, resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
const { prepare, runResearchProcess, runPythonInstallerProcess, ResearchProcessError } = await import(
  `data:text/javascript;base64,${Buffer.from(preparedModule.outputFiles[0].text).toString('base64')}`);
const { ResearchPythonRuntimeStore } = await importTypeScriptModule('src/main/plugins/research/python-runtime-store.ts', { platform: 'node' });
let root, store;
const evidence = [];
const signal = () => new AbortController().signal;
before(async () => {
  root = await realpath(await mkdtemp('/private/tmp/roc-project-preparation-'));
  const download = process.env.ROC_TEST_PYTHON_ARCHIVES ? async (url, hash, target, options) => {
    options.signal.throwIfAborted();
    const path = join(process.env.ROC_TEST_PYTHON_ARCHIVES, url.includes('/uv/') ? 'uv.tar.gz' : 'python.tar.gz');
    const bytes = await readFile(path);
    assert.equal(bytes.length, options.expectedSize); assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    await copyFile(path, target); return target;
  } : undefined;
  store = new ResearchPythonRuntimeStore(join(root, 'managed'), undefined, download);
});
after(async () => {
  await mkdir('.artifacts/research-toolchain-p2', { recursive: true });
  await writeFile('.artifacts/research-toolchain-p2/project-preparation.json', JSON.stringify(evidence, null, 2));
  if (root) await rm(root, { recursive: true, force: true });
});
async function project(name, dependencies) {
  const workspace = join(root, name); await mkdir(workspace);
  if (dependencies) await writeFile(join(workspace, 'pyproject.toml'),
    `[project]\nname = "${name}"\nversion = "0.1.0"\nrequires-python = ">=3.14,<3.15"\ndependencies = ${JSON.stringify(dependencies)}\n`);
  return { workspace, projectId: name, rootPath: join(root, 'managed'), signal: signal(), onPhase: () => {} };
}
test('new project gets exact .venv and three declarations; reuse is offline and byte-identical', async () => {
  const input = await project('empty'); const phases = [];
  const first = await prepare({ ...input, onPhase: phase => phases.push(phase) }, { store });
  assert.equal(first.inspected.report.version, '3.14.10');
  assert.deepEqual(first.inspected.report.distributions, []);
  assert.deepEqual(first.inspected.lockFiles.map(file => file.path), ['pyproject.toml', 'uv.lock', '.python-version']);
  assert.equal(await realpath(join(input.workspace, '.venv/bin/python')), first.runtime.executable);
  const again = await prepare({...input, previousCodeHash: first.inspected.code.hash}, { store });
  assert.equal(again.inspected.metadataHash, first.inspected.metadataHash);
  assert.deepEqual(await readdir(first.runtime.jobs), []);
  evidence.push({ scenario: 'new-and-reuse', phases, metadataHash: first.inspected.metadataHash, lockFiles: first.inspected.lockFiles });
});
test('scientific wheels run actual NumPy, Pandas, SciPy and scikit-learn calculations offline', async () => {
  const input = await project('science', ['numpy', 'pandas', 'scipy', 'scikit-learn']);
  const original = await readFile(join(input.workspace, 'pyproject.toml'));
  const first = await prepare(input, { store });
  assert.deepEqual(await readFile(join(input.workspace, 'pyproject.toml')), original);
  const scratch = join(root, 'science-output'); await mkdir(scratch);
  const controls = first.inspected.controls;
  const result = await runResearchProcess({ command: controls.selectedExecutable,
    args: ['-I', '-S', '-B', '-X', 'utf8', '-c', `import sys,json\nsys.path.append(sys.argv[1])\nimport numpy as np,pandas as pd,scipy.linalg as la\nfrom sklearn.linear_model import LinearRegression\nx=np.array([[1.],[2.],[3.]])\ny=np.array([2.,4.,6.])\nmodel=LinearRegression().fit(x,y)\nprint(json.dumps({'mean':float(pd.DataFrame({'y':y}).y.mean()),'slope':float(model.coef_[0]),'determinant':float(la.det(np.array([[2.,0.],[0.,3.]])))}))`, controls.packagePath],
    cwd: scratch, readablePaths: [...controls.codeRoots, ...controls.controls.map(file => file.path), scratch], writablePaths: [scratch],
    environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: scratch }, timeoutMs: 60_000,
    resourceLimits: { mode: 'monitored', cpuTimeMs: 30_000, maxResidentBytes: 1024 ** 3 },
    writeLimits: [{ path: scratch, maxFileBytes: 1024 ** 2, maxTotalBytes: 8 * 1024 ** 2, maxFiles: 100, maxEntries: 200 }],
    admission: { projectId: input.projectId, priority: 'user', resourceClass: 'compute' }, signal: signal(), networkAccess: 'none', allowGpuAcceleration: false });
  assert.equal(result.exitCode, 0, result.stderr);
  const values = JSON.parse(result.stdout);
  assert.equal(values.mean, 4); assert.ok(Math.abs(values.slope - 2) < 1e-12); assert.equal(values.determinant, 6);
  evidence.push({ scenario: 'actual-scientific-calculation', distributions: first.inspected.report.distributions, values, usage: result.resourceUsage });
});
test('direct sources and startup hooks refuse without modifying existing project declarations', async () => {
  const direct = await project('direct', ['bad @ https://example.invalid/bad.whl']);
  const original = await readFile(join(direct.workspace, 'pyproject.toml'));
  await assert.rejects(prepare(direct, { store }), /direct_dependency_unsupported/);
  assert.deepEqual(await readFile(join(direct.workspace, 'pyproject.toml')), original);
  assert.deepEqual(await readdir(direct.workspace), ['pyproject.toml']);
  const clean = await project('hook'); await prepare(clean, { store });
  const marker = join(clean.workspace, 'HOOK_EXECUTED');
  await writeFile(join(clean.workspace, '.venv/lib/python3.14/site-packages/startup.pth'), `import pathlib; pathlib.Path(${JSON.stringify(marker)}).touch()\n`);
  await assert.rejects(prepare(clean, { store }), /startup_hook_unsupported/);
  assert.equal((await readdir(clean.workspace)).includes('HOOK_EXECUTED'), false);
});

test('another project synchronizes scientific wheels from the shared cache with network denied', async () => {
  const input = await project('cached');
  for (const name of ['pyproject.toml', 'uv.lock', '.python-version']) {
    await copyFile(join(root, 'science', name), join(input.workspace, name));
  }
  const calls = [];
  const prepared = await prepare(input, { store, run: async request => {
    calls.push({operation: request.args[0], network: request.network, offline: request.args.includes('--offline')});
    assert.equal(request.network, 'none', 'a complete cache must not request network access');
    return runPythonInstallerProcess(request);
  }});
  const installed = prepared.inspected.report.distributions.map(item => item.name);
  for (const name of ['numpy', 'pandas', 'scipy', 'scikit-learn']) assert.ok(installed.includes(name));
  assert.ok(calls.some(call => call.operation === 'sync' && call.offline));
  assert.notEqual(prepared.inspected.controls.prefix, join(root, 'science/.venv'));
  assert.deepEqual(await readdir(prepared.runtime.jobs), []);
  evidence.push({scenario: 'independent-project-offline-sync', calls, distributions: prepared.inspected.report.distributions});
});

test('cancellation removes only files created by this operation and preserves the original project', async () => {
  const input = await project('cancel', ['numpy']);
  const original = await readFile(join(input.workspace, 'pyproject.toml'));
  const controller = new AbortController(), reason = new Error('actual-project-preparation-cancelled');
  await assert.rejects(prepare({...input, signal: controller.signal, onPhase: phase => {
    if (phase === 'syncing') controller.abort(reason);
  }}, {store}), error => error === reason);
  assert.deepEqual(await readdir(input.workspace), ['pyproject.toml']);
  assert.deepEqual(await readFile(join(input.workspace, 'pyproject.toml')), original);
  evidence.push({scenario: 'cancel-preserves-user-file', contents: await readdir(input.workspace)});
});

test('an unsupported existing Python pin is never silently upgraded', async () => {
  const input = await project('version', []);
  await writeFile(join(input.workspace, '.python-version'), '3.14.7\n');
  const original = await readFile(join(input.workspace, 'pyproject.toml'));
  await assert.rejects(prepare(input, {store}), /research_python_runtime_version_unavailable/);
  assert.equal(await readFile(join(input.workspace, '.python-version'), 'utf8'), '3.14.7\n');
  assert.deepEqual(await readFile(join(input.workspace, 'pyproject.toml')), original);
  assert.deepEqual((await readdir(input.workspace)).sort(), ['.python-version', 'pyproject.toml']);
});

test('changed prepared code cannot be signed again; an unreceipted venv restores wheels from the lock', async () => {
  const workspace = join(root, 'cached');
  const input = {workspace, projectId: 'cached', rootPath: join(root, 'managed'), signal: signal(), onPhase: () => {}};
  const baseline = await prepare(input, {store});
  const path = join(workspace, '.venv/lib/python3.14/site-packages/numpy/__init__.py');
  const original = await readFile(path);
  await writeFile(path, Buffer.concat([original, Buffer.from('\n# unapproved local code change\n')]));
  let dispatches = 0;
  await assert.rejects(prepare({...input, previousCodeHash: baseline.inspected.code.hash}, {store, run: request => {
    dispatches++; return runPythonInstallerProcess(request);
  }}), /research_python_environment_changed/);
  assert.equal(dispatches, 0);
  const calls = [];
  const restored = await prepare(input, {store, run: request => {
    calls.push({operation: request.args[0], reinstall: request.args.includes('--reinstall'), network: request.network});
    return runPythonInstallerProcess(request);
  }});
  assert.ok(calls.some(call => call.operation === 'sync' && call.reinstall));
  assert.deepEqual(await readFile(path), original);
  assert.equal(restored.inspected.metadataHash, baseline.inspected.metadataHash);
  evidence.push({scenario: 'known-code-drift-rejected-and-unreceipted-wheels-restored', calls});
});

test('code changed after either offline check cannot acquire a fresh trusted receipt', async () => {
  const input = await project('late-change');
  const baseline = await prepare(input, {store});
  const mutation = join(input.workspace, '.venv/lib/python3.14/site-packages/late_mutation.py');
  for (const when of [1, 2]) {
    let checks = 0;
    try {
      await assert.rejects(prepare({...input, previousCodeHash: baseline.inspected.code.hash}, {store, run: async request => {
        const result = await runPythonInstallerProcess(request);
        if (request.args[0] === 'sync' && request.args.includes('--check') && ++checks === when) {
          await writeFile(mutation, 'print("unapproved change after read-only check")\n');
        }
        return result;
      }}), /research_python_environment_changed/);
      assert.equal(checks, when);
    } finally { await rm(mutation, {force: true}); }
  }
  assert.equal((await prepare({...input, previousCodeHash: baseline.inspected.code.hash}, {store})).inspected.code.hash, baseline.inspected.code.hash);
  evidence.push({scenario: 'late-code-change-after-either-check-rejected'});
});

test('unproven process cleanup preserves owned files until the process tree can be inspected', async () => {
  for (const code of ['research_process_kill_failed', 'research_process_supervision_failed', 'research_process_completion_failed']) {
    const input = await project(code.replaceAll('_', '-'));
    const runtime = await store.prepare('3.14.10', input.projectId, signal());
    const before = new Set(await readdir(runtime.jobs));
    await assert.rejects(prepare(input, {store, run: async request => {
      if (request.args[0] === 'sync') throw new ResearchProcessError(code);
      return runPythonInstallerProcess(request);
    }}), error => error.code === code);
    assert.deepEqual((await readdir(input.workspace)).sort(), ['.python-version', '.venv', 'pyproject.toml', 'uv.lock']);
    const retained = (await readdir(runtime.jobs)).filter(name => !before.has(name));
    assert.equal(retained.length, 1);
    // This test injected the error without a live process; cleanup is proven here.
    await rm(join(runtime.jobs, retained[0]), {recursive: true});
    evidence.push({scenario: 'unproven-cleanup-preserved', code});
  }
});
