import {writePythonProjectFiles, createPythonFixtureService, preparePythonFixture, waitPythonPreparation} from '../unit/fixtures/python-environment.mjs';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { loadResearchTestApi, createResearchFixture } from '../unit/fixtures/research-test-kit.mjs';

const python = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
  'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":sys.version.split()[0]}))'], { encoding: 'utf8' }));
assert.match(python.version, /^3\.14\.\d+$/u);
let api, root;
const receipts = [];
before(async () => { api = await loadResearchTestApi(); root = await realpath(await mkdtemp('/private/tmp/roc-python-preparation-')); });
after(async () => {
  const output = join(process.cwd(), '.artifacts/research-toolchain-p2/service-preparation');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'python-preparation.json'), JSON.stringify({
    python, actualIsolatedPython: true, preparation: 'fixture installer with real isolated Python inspection', receipts
  }, null, 2));
  await rm(root, { recursive: true, force: true }); api.dispose();
});

async function fixture(options = {}) {
  const path = await mkdtemp(join(root, 'case-')), workspace = join(path, 'workspace'), venv = join(path, 'venv'), jobDir = join(path, 'jobs');
  const packagePath = join(venv, 'lib/python3.14/site-packages');
  for (const dir of [workspace, packagePath, join(venv, 'bin'), jobDir]) await mkdir(dir, { recursive: true });
  const executable = join(venv, 'bin/python3');
  await symlink(python.executable, executable);
  await writeFile(join(venv, 'pyvenv.cfg'), `home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion_info = ${python.version}\nimplementation = CPython\nuv = 0.13.9\n`);
  await writePythonProjectFiles(workspace, python.version);
  await writeFile(join(packagePath, 'sitecustomize.py'), 'raise RuntimeError("UNTRUSTED_HOOK_EXECUTED")\n');
  const f = createResearchFixture(api, 'experiment', workspace);
  const counts = {dispatches: 0};
  const service = createPythonFixtureService(api, f.repository, path, executable, {run: async request => {
    counts.dispatches++;
    const result = await api.runResearchProcess(request);
    receipts.push({scenario: options.scenario ?? 'preparation', admission: request.admission, result});
    return options.afterRun === undefined ? result : options.afterRun(result, f);
  }});
  const request = { projectId: f.project.id, requestId: 'explicit-preparation' };
  const human = (action, projectId = f.project.id, windowId = 72) => api.withResearchHumanContext({
    capability: 'research.pythonEnvironments.prepare', projectId, windowId
  }, action);
  return { ...f, path, workspace, venv, packagePath, jobDir, executable, counts, service, request, human,
    admission: { projectId: f.project.id, priority: 'user' },
    prepare: input => human(() => service.prepare(input ?? request)),
    ready: async input => {
      const operation = await human(() => service.prepare(input ?? request));
      const state = await waitPythonPreparation(service, f.project.id, operation.id);
      assert.equal(state.operation.phase, 'ready', state.operation.errorCode); return state.environment;
    },
    reference: preparation => ({ projectId: f.project.id, environmentId: preparation.snapshot.id, expectedHash: preparation.snapshotHash }),
    async cleanup() { await service.shutdown(); f.close(); } };
}

test('missing or invalid project inputs fail observably without a receipt and can be retried', async () => {
  const f = await fixture();
  try {
    await rm(join(f.workspace, '.python-version'));
    for (const [requestId, contents] of [['missing', null], ['invalid', '3.12']]) {
      if (contents !== null) await writeFile(join(f.workspace, '.python-version'), contents);
      const operation = await f.prepare({...f.request, requestId});
      const state = await waitPythonPreparation(f.service, f.project.id, operation.id);
      assert.equal(state.operation.phase, 'failed'); assert.ok(state.operation.errorCode);
      assert.equal(state.environment, null); assert.deepEqual(f.counts, {dispatches: 0});
    }
    await writePythonProjectFiles(f.workspace, python.version);
    assert.ok(await f.ready({...f.request, requestId: 'repaired'}));
  } finally {await f.cleanup();}
});

test('human preparation binds isolated CPython and project; replay is pure and leased verification rechecks bytes', async () => {
  const f = await fixture();
  try {
    const selected = await f.ready();
    assert.equal(selected.snapshot.selectedExecutable, f.executable);
    assert.equal(selected.snapshot.executable, python.executable);
    assert.equal(selected.snapshot.workspacePath, f.workspace);
    assert.deepEqual(selected.snapshot.actor, { kind: 'user', id: 'window:72' });
    assert.equal(selected.snapshot.version, python.version);
    assert.equal(f.counts.dispatches, 1);
    const changes = f.db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(await f.ready(), selected);
    assert.equal(f.counts.dispatches, 1);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
    const observed = [];
    const resolved = await f.service.acquireRuntime(f.reference(selected), f.jobDir, new AbortController().signal, f.admission, receipt => observed.push(receipt));
    assert.equal(resolved.environment.metadataHash, selected.snapshot.metadataHash);
    assert.equal(resolved.environment.code.hash, selected.snapshot.codeHash);
    assert.equal(observed.length, 1); assert.equal(observed[0].outcome, 'returned'); assert.equal(observed[0].exitCode, 0);
    resolved.release();
    const actual = receipts.at(-1).result;
    assert.deepEqual(observed[0].usage, actual.resourceUsage); assert.deepEqual(observed[0].admission, actual.admission);
  } finally { await f.cleanup(); }
});

test('installed direct dependencies fail preparation with a specific error and no receipt', async () => {
  const f = await fixture();
  try {
    const metadata = join(f.packagePath, 'local_pkg-1.0.dist-info');
    await mkdir(metadata);
    await writeFile(join(metadata, 'METADATA'), 'Metadata-Version: 2.4\nName: local-pkg\nVersion: 1.0\n');
    await writeFile(join(metadata, 'direct_url.json'), '{"url":"file:///private/tmp/local-pkg"}');
    const operation = await f.prepare();
    const state = await waitPythonPreparation(f.service, f.project.id, operation.id);
    assert.equal(state.operation.phase, 'failed');
    assert.match(state.operation.errorCode, /direct_url|direct_dependency/u);
    assert.deepEqual(f.repository.pythonEnvironments.list({ projectId: f.project.id }), []);
    assert.deepEqual(f.counts, {dispatches: 1 });
  } finally { await f.cleanup(); }
});

test('existing environment API rechecks prepared Python identity and refuses incomplete computation contracts', async () => {
  const f = await fixture({ scenario: 'environment-api' });
  const environments = new api.ResearchExperimentEnvironmentService({
    typescriptRuntime: async () => assert.fail('Python preview must not resolve TypeScript')
  }, f.service);
  const experiments = new api.ResearchExperimentService(f.repository, environments, f.path,
    { error: (...args) => assert.fail(JSON.stringify(args)) },
    async () => assert.fail('environment preview must not dispatch a computation'));
  try {
    const selected = await f.ready();
    const runtime = { kind: 'python', environmentId: selected.snapshot.id, expectedHash: selected.snapshotHash };
    const handlers = new Map();
    api.registerResearchExperimentCapabilities({ pluginId: '@roc/plugin-research', capabilities: {
      register(_plugin, descriptor, handler) { handlers.set(descriptor.name, input => handler(descriptor.inputSchema.parse(input))); }
    } }, f.repository.experiments, experiments);
    const adapter = api.createPluginCapabilityAdapter({ invokeCapability(name, input) { return handlers.get(name)(input); } });
    const request = { projectId: f.project.id, runtime };
    const first = await adapter.invoke('research.inspectExperimentEnvironment', [request], 72);
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await adapter.invoke('research.inspectExperimentEnvironment', [request], 72);
    assert.equal(second.ok, true, JSON.stringify(second)); assert.deepEqual(second.data, first.data);
    const environment = first.data;
    assert.deepEqual(environment.runtime, runtime);
    assert.equal(environment.executable, f.executable);
    assert.equal(environment.prefix, f.venv);
    assert.equal(environment.version, python.version);
    assert.equal(environment.metadataHash, selected.snapshot.metadataHash);
    assert.deepEqual(environment.packages, []);
    assert.deepEqual(environment.lockFiles, selected.snapshot.lockFiles);
    const { hash, ...identity } = environment;
    assert.equal(hash, createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
    const changedSelection = await adapter.invoke('research.inspectExperimentEnvironment', [{
      ...request, runtime: { ...runtime, expectedHash: 'f'.repeat(64) }
    }], 72);
    assert.equal(changedSelection.ok, false);
    const pathInjection = await adapter.invoke('research.inspectExperimentEnvironment', [{
      ...request, runtime: { ...runtime, selectedExecutable: f.executable }
    }], 72);
    assert.equal(pathInjection.ok, false);
    const compute = await adapter.invoke('research.startExperiment', [{
      projectId: f.project.id, runtime, engine: 'python', requestId: 'incomplete-contract', label: 'Python',
      sourcePath: 'analysis.py', inputPaths: [], parameters: {}, arguments: [], timeoutMs: 5000, network: 'disabled'
    }], 72);
    assert.equal(compute.ok, false);
    assert.deepEqual(f.repository.experiments.list(f.project.id, 100), []);
    assert.deepEqual(f.counts, {dispatches: 3 });
    await writeFile(join(f.packagePath, 'changed.py'), 'CHANGED = True\n');
    await assert.rejects(experiments.inspect(f.project.id, runtime), /research_python_environment_changed/u);
    assert.deepEqual(f.repository.pythonEnvironments.get(f.reference(selected)), selected);
    receipts.push({ scenario: 'environment-api-identity', environment });
  } finally { await experiments.shutdown(); await f.cleanup(); }
});

test('Python preparation rejects foreign or absent project admission before dispatch and forwards actual background priority', async () => {
  const f = await fixture({ scenario: 'environment-admission' });
  const dispatched = [];
  const resolver = {
    async acquireRuntime(input, jobDir, signal, admission, onProbe) {
      dispatched.push(admission);
      return f.service.acquireRuntime(input, jobDir, signal, admission, onProbe);
    }
  };
  const environments = new api.ResearchExperimentEnvironmentService({
    typescriptRuntime: async () => assert.fail('Python must not use TypeScript')
  }, resolver);
  try {
    const selected = await f.ready();
    const reference = f.reference(selected);
    const runtime = { kind: 'python', environmentId: reference.environmentId, expectedHash: reference.expectedHash };
    const signal = new AbortController().signal;
    await assert.rejects(environments.inspect(runtime, f.jobDir, signal,
      { projectId: null, priority: 'background' }, () => undefined), /research_python_environment_project_required/u);
    assert.equal(dispatched.length, 0);
    await assert.rejects(f.service.acquireRuntime(reference, f.jobDir, signal,
      { projectId: 'foreign', priority: 'user' }, () => undefined), /research_python_environment_admission_mismatch/u);
    assert.equal(f.counts.dispatches, 1);
    const probes = [], admission = { projectId: f.project.id, priority: 'background' };
    const prepared = await environments.inspect(runtime, f.jobDir, signal, admission, probe => probes.push(probe));
    assert.deepEqual(dispatched, [admission]);
    assert.equal(probes.length, 1); assert.equal(probes[0].exitCode, 0);
    assert.deepEqual(receipts.at(-1).admission, { ...admission, resourceClass: 'utility' });
    assert.deepEqual(probes[0].admission, receipts.at(-1).result.admission);
    assert.equal(prepared.python.metadataHash, selected.snapshot.metadataHash);
    api.assertPythonCodeReceipt(prepared.python.codeReceipt, prepared.snapshot.metadataHash);
    assert.equal(prepared.typescriptRuntime, null);
    assert.equal(prepared.readablePaths.includes(f.workspace), false);
    assert.deepEqual(Object.keys(prepared.environment).sort(), ['LANG', 'PATH', 'TMPDIR']);
    const foreignPath = join(f.path, 'foreign'); await mkdir(foreignPath);
    const foreign = f.repository.createProject({ title: 'Foreign', description: '', workspacePath: foreignPath });
    await assert.rejects(environments.inspect(runtime, f.jobDir, signal,
      { projectId: foreign.id, priority: 'user' }, () => undefined), /research_python_environment_project_mismatch/u);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await assert.rejects(environments.inspect(runtime, f.jobDir, signal, admission, () => undefined),
      /research_project_archived/u);
    assert.deepEqual(f.counts, {dispatches: 2 });
  } finally { await f.cleanup(); }
});

test('wire paths, actors, missing main authority, another project and another window cannot grant or replay preparation', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.prepare(f.request), /research_human_required/u);
    assert.throws(() => f.human(() => f.service.prepare(f.request), 'other-project'), /research_human_project_mismatch/u);
    await assert.rejects(f.prepare({ ...f.request, selectedExecutable: f.executable }));
    await assert.rejects(f.prepare({ ...f.request, actor: { kind: 'user', id: 'window:72' } }));
    assert.deepEqual(f.counts, {dispatches: 0});
    const selected = await f.ready();
    await assert.rejects(f.human(() => f.service.prepare(f.request), f.project.id, 73), /research_python_operation_request_conflict/u);
    const otherPath = join(f.path, 'other-project'); await mkdir(otherPath);
    const other = f.repository.createProject({ title: 'Other', description: '', workspacePath: otherPath });
    assert.throws(() => f.repository.pythonEnvironments.get({ ...f.reference(selected), projectId: other.id }), /research_python_environment_project_mismatch/u);
    assert.throws(() => f.repository.pythonEnvironments.get({ ...f.reference(selected), expectedHash: 'f'.repeat(64) }), /research_python_environment_hash_mismatch/u);
    assert.deepEqual(f.counts, {dispatches: 1 });
  } finally { await f.cleanup(); }
});

test('generated prepare/status/cancel APIs bind main sender and expose immutable receipts', async () => {
  const f = await fixture();
  try {
    const handlers = new Map();
    api.registerResearchPythonEnvironmentCapabilities({ pluginId: '@roc/plugin-research', capabilities: {
      register(_plugin, descriptor, handler) { handlers.set(descriptor.name, handler); }
    } }, f.repository.pythonEnvironments, f.service);
    const adapter = api.createPluginCapabilityAdapter({ invokeCapability(name, input) {
      assert.ok(handlers.has(name)); return handlers.get(name)(input);
    } });
    assert.equal((await adapter.invoke('research.preparePythonEnvironment', [f.request])).ok, false);
    assert.equal((await adapter.invoke('research.preparePythonEnvironment', [{ ...f.request, executable: f.executable }], 72)).ok, false);
    assert.deepEqual(f.counts, {dispatches: 0});
    const result = await adapter.invoke('research.preparePythonEnvironment', [f.request], 72);
    assert.equal(result.ok, true, JSON.stringify(result));
    const state = await waitPythonPreparation(f.service, f.project.id, result.data.id);
    const selected = state.environment;
    assert.deepEqual(selected.snapshot.actor, { kind: 'user', id: 'window:72' });
    const read = await adapter.invoke('research.getPythonEnvironment', [f.reference(selected)], 72);
    assert.equal(read.ok, true); assert.deepEqual(read.data, selected);
    const list = await adapter.invoke('research.listPythonEnvironments', [{ projectId: f.project.id }], 72);
    assert.equal(list.ok, true); assert.deepEqual(list.data, [selected]);
    const status = await adapter.invoke('research.getPythonEnvironmentStatus', [{projectId: f.project.id}], 72);
    assert.equal(status.ok, true); assert.deepEqual(status.data, state);
    const cancel = await adapter.invoke('research.cancelPythonEnvironmentPreparation', [{projectId: f.project.id, operationId: state.operation.id}], 72);
    assert.equal(cancel.ok, true); assert.deepEqual(cancel.data, state.operation);
    assert.equal((await adapter.invoke('research.cancelPythonEnvironmentPreparation', [{projectId: f.project.id, operationId: state.operation.id}])).ok, false);
    assert.equal((await adapter.invoke('research.preparePythonEnvironment', [f.request], 73)).ok, false);
  } finally { await f.cleanup(); }
});

test('archived projects refuse preparation without a receipt or Python dispatch', async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await assert.rejects(f.prepare(), /research_project_archived/u);
    assert.deepEqual(f.counts, {dispatches: 0}); assert.deepEqual(f.service.list({projectId: f.project.id}), []);
  } finally {await f.cleanup();}
});

test('changed installed code cannot be re-signed by prepare; historical replay never authorizes changed execution', async () => {
  const f = await fixture();
  try {
    const selected = await f.ready();
    await writeFile(join(f.packagePath, 'changed-native.so'), 'changed declared code bytes');
    await assert.rejects(f.service.acquireRuntime(f.reference(selected), f.jobDir, new AbortController().signal, f.admission, () => undefined),
      /research_python_environment_changed/u);
    assert.deepEqual(await f.ready(), selected);
    const changed = await f.prepare({...f.request, requestId: 'refuse-changed-code'});
    const refused = await waitPythonPreparation(f.service, f.project.id, changed.id);
    assert.equal(refused.operation.phase, 'failed'); assert.equal(refused.operation.errorCode, 'research_python_environment_changed');
    assert.equal(f.service.list({projectId: f.project.id}).length, 1);
    await rm(join(f.packagePath, 'changed-native.so'));
    const fresh = await f.ready({...f.request, requestId: 'restored-code'});
    assert.equal(fresh.snapshot.metadataHash, selected.snapshot.metadataHash);
    assert.notEqual(fresh.snapshotHash, selected.snapshotHash);
    assert.equal(f.repository.pythonEnvironments.list({ projectId: f.project.id }).length, 2);
    await writeFile(join(f.workspace, '.python-version'), '3.14.0\n');
    await assert.rejects(f.service.acquireRuntime(f.reference(fresh), f.jobDir, new AbortController().signal, f.admission, () => undefined),
      /research_python_runtime_version_mismatch/u);
    const invalid = await f.prepare({...f.request, requestId: 'invalid-preparation'});
    assert.equal((await waitPythonPreparation(f.service, f.project.id, invalid.id)).operation.phase, 'failed');
    assert.equal(f.repository.pythonEnvironments.list({ projectId: f.project.id }).length, 2);
  } finally { await f.cleanup(); }
});

test('project archive or workspace replacement while probe runs cannot persist or resolve a stale binding', async () => {
  for (const scenario of ['archive', 'workspace']) {
    const f = await fixture({ scenario, afterRun: (result, f) => {
      if (scenario === 'archive') f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
      else f.db.prepare('UPDATE research_projects SET workspace_path=? WHERE id=?').run(join(root, 'replaced-project'), f.project.id);
      return result;
    } });
    try {
      const operation = await f.prepare();
      const state = await waitPythonPreparation(f.service, f.project.id, operation.id);
      assert.equal(state.operation.phase, 'failed');
      assert.match(state.operation.errorCode, scenario === 'archive' ? /research_project_archived/u : /research_python_environment_workspace_changed/u);
      assert.equal(f.db.prepare('SELECT count(*) FROM research_python_environments').pluck().get(), 0);
    } finally { await f.cleanup(); }
  }
});

test('project release cancels the actual held Python probe and shutdown refuses further preparation', async () => {
  const f = await fixture();
  let entered, startupFailed;
  const started = new Promise((resolve, reject) => { entered = resolve; startupFailed = reject; });
  const service = createPythonFixtureService(api, f.repository, f.path, f.executable, {run: async request => {
    const actual = api.runResearchProcess({ ...request, args: [...api.pythonExperimentFlags, '-c',
      'import time;open("python-ready","w").write("running");time.sleep(60)'] });
    const ready = (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        request.signal.throwIfAborted();
        try {
          assert.equal(await readFile(join(request.cwd, 'python-ready'), 'utf8'), 'running');
          return;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('actual Python did not signal readiness');
    })();
    try {
      await Promise.race([ready, actual.then(() => { throw new Error('Python exited before cancellation readiness'); })]);
      entered();
      return await actual;
    } catch (error) {
      startupFailed(error);
      receipts.push({ scenario: 'cancel-held-preparation', error: error.code, usage: error.resourceUsage, admission: error.admission });
      throw error;
    }
  }});
  try {
    const pending = f.human(() => service.prepare(f.request));
    const operation = await pending;
    await started;
    await service.releaseProject(f.project.id);
    const state = await waitPythonPreparation(service, f.project.id, operation.id);
    assert.equal(state.operation.phase, 'cancelled');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_python_environments').pluck().get(), 0);
    assert.ok(receipts.at(-1).admission.holdMs > 0);
    await service.shutdown();
    await assert.rejects(f.human(() => service.prepare(f.request)), /research_python_environment_service_closed/u);
  } finally { await service.shutdown(); await f.cleanup(); }
});

test('damaged stored JSON, column identity or missing environment fails without another Python dispatch', async () => {
  const f = await fixture();
  try {
    const selected = await f.ready();
    const original = f.db.prepare('SELECT * FROM research_python_environments WHERE id=?').get(selected.snapshot.id);
    for (const mutate of [
      () => f.db.prepare('UPDATE research_python_environments SET snapshot_json=? WHERE id=?').run('{}', original.id),
      () => f.db.prepare('UPDATE research_python_environments SET snapshot_hash=? WHERE id=?').run('e'.repeat(64), original.id),
      () => f.db.prepare('UPDATE research_python_environments SET created_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', original.id)
    ]) {
      mutate();
      assert.throws(() => f.repository.pythonEnvironments.get(f.reference(selected)));
      assert.throws(() => f.repository.pythonEnvironments.list({ projectId: f.project.id }));
      assert.throws(() => f.service.status({projectId: f.project.id}));
      assert.deepEqual(f.counts, {dispatches: 1 });
      f.db.prepare('UPDATE research_python_environments SET snapshot_json=?,snapshot_hash=?,created_at=? WHERE id=?')
        .run(original.snapshot_json, original.snapshot_hash, original.created_at, original.id);
    }
    f.db.prepare('DELETE FROM research_python_environments WHERE id=?').run(original.id);
    await assert.rejects(f.service.acquireRuntime(f.reference(selected), f.jobDir, new AbortController().signal, f.admission, () => undefined), /research_python_environment_not_found/u);
    assert.equal(f.counts.dispatches, 1);
  } finally { await f.cleanup(); }
});

test('disk reopen preserves existing project bytes and exact immutable environment receipt without another probe', async () => {
  const f = await fixture();
  const dbPath = join(f.path, 'research.sqlite');
  let disk;
  try {
    const selected = await f.ready();
    disk = new Database(dbPath); disk.pragma('foreign_keys=ON');
    api.applyResearchDatabaseSchema(disk);
    const row = f.db.prepare('SELECT * FROM research_projects WHERE id=?').get(f.project.id), keys = Object.keys(row);
    disk.prepare(`INSERT INTO research_projects (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
    api.applyResearchDatabaseSchema(disk);
    assert.deepEqual(disk.prepare('SELECT * FROM research_projects').get(), row);
    assert.equal(disk.prepare('SELECT current_version FROM schema_metadata').pluck().get(), api.researchSchema.version);
    const reopenedRepository = new api.ResearchRepository(disk, f.tasks);
    assert.deepEqual(reopenedRepository.pythonEnvironments.save(selected.snapshot), selected);
    disk.close();
    disk = new Database(dbPath); disk.pragma('foreign_keys=ON'); api.applyResearchDatabaseSchema(disk);
    const repository = new api.ResearchRepository(disk, f.tasks);
    assert.deepEqual(repository.pythonEnvironments.get(f.reference(selected)), selected);
    assert.deepEqual(repository.pythonEnvironments.findRequest(f.request), selected);
    assert.deepEqual(disk.prepare('SELECT * FROM research_projects').get(), row);
    assert.deepEqual(f.counts, {dispatches: 1 });
    assert.equal(await readFile(join(f.workspace, '.python-version'), 'utf8'), `${python.version}\n`);
    assert.throws(() => repository.pythonEnvironments.save(selected.snapshot), /request_conflict/u);
  } finally { disk?.close(); await f.cleanup(); }
});
