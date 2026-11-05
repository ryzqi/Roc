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
before(async () => { api = await loadResearchTestApi(); root = await realpath(await mkdtemp('/private/tmp/roc-python-selection-')); });
after(async () => {
  const output = join(process.cwd(), '.artifacts/research-optimization/pr08-a4b1');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'python-selection.json'), JSON.stringify({
    python, actualIsolatedPython: true, nativePicker: 'fixture supplied path; no actual user product selection', receipts
  }, null, 2));
  await rm(root, { recursive: true, force: true }); api.dispose();
});

async function fixture(options = {}) {
  const path = await mkdtemp(join(root, 'case-')), workspace = join(path, 'workspace'), venv = join(path, 'venv'), jobDir = join(path, 'jobs');
  const packagePath = join(venv, 'lib/python3.14/site-packages');
  for (const dir of [workspace, packagePath, join(venv, 'bin'), jobDir]) await mkdir(dir, { recursive: true });
  const executable = join(venv, 'bin/python3');
  await symlink(python.executable, executable);
  await writeFile(join(venv, 'pyvenv.cfg'), `home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion = ${python.version}\n`);
  const lock = { schemaVersion: 1, python: { implementation: 'cpython', version: python.version, platform: 'darwin', architecture: 'arm64' }, distributions: [] };
  await writeFile(join(workspace, 'roc-python.lock.json'), JSON.stringify(lock));
  await writeFile(join(packagePath, 'sitecustomize.py'), 'raise RuntimeError("UNTRUSTED_HOOK_EXECUTED")\n');
  const f = createResearchFixture(api, 'experiment', workspace);
  const counts = { picks: 0, dispatches: 0 };
  const service = new api.ResearchPythonEnvironmentService(f.repository, async (owner, signal) => {
    counts.picks++; assert.equal(owner, 'window:72');
    return options.picker === undefined ? executable : options.picker(owner, signal);
  }, async request => {
    counts.dispatches++;
    const result = await api.runResearchProcess(request);
    receipts.push({ scenario: options.scenario ?? 'selection', admission: request.admission, result });
    return options.afterRun === undefined ? result : options.afterRun(result, f);
  });
  const request = { projectId: f.project.id, requestId: 'explicit-selection' };
  const human = (action, projectId = f.project.id, windowId = 72) => api.withResearchHumanContext({
    capability: 'research.pythonEnvironments.select', projectId, windowId
  }, action);
  return { ...f, path, workspace, venv, packagePath, jobDir, executable, lock, counts, service, request, human,
    admission: { projectId: f.project.id, priority: 'user' },
    select: input => human(() => service.select(input ?? request)),
    reference: selection => ({ projectId: f.project.id, selectionId: selection.snapshot.id, expectedHash: selection.snapshotHash }),
    async cleanup() { await service.shutdown(); f.close(); } };
}

test('main user selection binds actual isolated CPython identity and exact project; replay is readonly and resolve rechecks bytes', async () => {
  const f = await fixture();
  try {
    const selected = await f.select();
    assert.equal(selected.snapshot.selectedExecutable, f.executable);
    assert.equal(selected.snapshot.executable, python.executable);
    assert.equal(selected.snapshot.workspacePath, f.workspace);
    assert.deepEqual(selected.snapshot.actor, { kind: 'user', id: 'window:72' });
    assert.equal(selected.snapshot.version, python.version);
    assert.equal(f.counts.picks, 1); assert.equal(f.counts.dispatches, 1);
    const changes = f.db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(await f.select(), selected);
    assert.equal(f.counts.picks, 1); assert.equal(f.counts.dispatches, 1);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
    const observed = [];
    const resolved = await f.service.resolve(f.reference(selected), f.jobDir, new AbortController().signal, f.admission, receipt => observed.push(receipt));
    assert.equal(resolved.metadataHash, selected.snapshot.metadataHash);
    assert.equal(resolved.code.hash, selected.snapshot.codeHash);
    assert.equal(observed.length, 1); assert.equal(observed[0].outcome, 'returned'); assert.equal(observed[0].exitCode, 0);
    const actual = receipts.at(-1).result;
    assert.deepEqual(observed[0].usage, actual.resourceUsage); assert.deepEqual(observed[0].admission, actual.admission);
  } finally { await f.cleanup(); }
});

test('existing environment API rechecks the selected Python and preserves exact identity without enabling computation', async () => {
  const f = await fixture({ scenario: 'environment-api' });
  const environments = new api.ResearchExperimentEnvironmentService({
    nativeRuntime: async () => assert.fail('Python preview must not resolve native tools'),
    typescriptRuntime: async () => assert.fail('Python preview must not resolve TypeScript')
  }, f.service);
  const experiments = new api.ResearchExperimentService(f.repository, environments, f.path,
    { error: (...args) => assert.fail(JSON.stringify(args)) },
    async () => assert.fail('environment preview must not dispatch a computation'));
  try {
    const selected = await f.select();
    const runtime = { kind: 'python', selectionId: selected.snapshot.id, expectedHash: selected.snapshotHash };
    const handlers = new Map();
    api.registerResearchExperimentCapabilities({ pluginId: '@roc/plugin-research', capabilities: {
      register(_plugin, descriptor, handler) { handlers.set(descriptor.name, handler); }
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
    assert.deepEqual(environment.lockFiles, [selected.snapshot.lockFile]);
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
      projectId: f.project.id, runtime, engine: 'python', requestId: 'not-enabled', label: 'Python',
      sourcePath: 'analysis.py', inputPaths: [], parameters: {}, arguments: [], timeoutMs: 5000, network: 'disabled'
    }], 72);
    assert.equal(compute.ok, false);
    assert.deepEqual(f.repository.experiments.list(f.project.id, 100), []);
    assert.deepEqual(f.counts, { picks: 1, dispatches: 3 });
    await writeFile(join(f.packagePath, 'changed.py'), 'CHANGED = True\n');
    await assert.rejects(experiments.inspect(f.project.id, runtime), /research_python_selection_environment_changed/u);
    assert.deepEqual(f.repository.pythonEnvironments.get(f.reference(selected)), selected);
    receipts.push({ scenario: 'environment-api-identity', environment });
  } finally { await experiments.shutdown(); await f.cleanup(); }
});

test('Python preparation rejects foreign or absent project admission before dispatch and forwards actual background priority', async () => {
  const f = await fixture({ scenario: 'environment-admission' });
  const dispatched = [];
  const resolver = {
    async resolve(input, jobDir, signal, admission, onProbe) {
      dispatched.push(admission);
      return f.service.resolve(input, jobDir, signal, admission, onProbe);
    }
  };
  const environments = new api.ResearchExperimentEnvironmentService({
    nativeRuntime: async () => assert.fail('Python must not use native tools'),
    typescriptRuntime: async () => assert.fail('Python must not use TypeScript')
  }, resolver);
  try {
    const selected = await f.select();
    const reference = f.reference(selected);
    const runtime = { kind: 'python', selectionId: reference.selectionId, expectedHash: reference.expectedHash };
    const signal = new AbortController().signal;
    await assert.rejects(environments.inspect(f.workspace, runtime, f.jobDir, signal,
      { projectId: null, priority: 'background' }, () => undefined), /research_python_selection_project_required/u);
    assert.equal(dispatched.length, 0);
    await assert.rejects(f.service.resolve(reference, f.jobDir, signal,
      { projectId: 'foreign', priority: 'user' }, () => undefined), /research_python_selection_admission_mismatch/u);
    assert.equal(f.counts.dispatches, 1);
    const probes = [], admission = { projectId: f.project.id, priority: 'background' };
    const prepared = await environments.inspect(f.workspace, runtime, f.jobDir, signal, admission, probe => probes.push(probe));
    assert.deepEqual(dispatched, [admission]);
    assert.equal(probes.length, 1); assert.equal(probes[0].exitCode, 0);
    assert.deepEqual(receipts.at(-1).admission, { ...admission, resourceClass: 'utility' });
    assert.deepEqual(probes[0].admission, receipts.at(-1).result.admission);
    assert.equal(prepared.python.metadataHash, selected.snapshot.metadataHash);
    api.assertPythonCodeReceipt(prepared.python.codeReceipt, prepared.snapshot.metadataHash);
    assert.equal(prepared.nativeCode, null); assert.equal(prepared.typescriptRuntime, null);
    assert.equal(prepared.readablePaths.includes(f.workspace), false);
    assert.deepEqual(Object.keys(prepared.environment).sort(), ['LANG', 'PATH', 'TMPDIR']);
    const foreignPath = join(f.path, 'foreign'); await mkdir(foreignPath);
    const foreign = f.repository.createProject({ title: 'Foreign', description: '', workspacePath: foreignPath });
    await assert.rejects(environments.inspect(foreignPath, runtime, f.jobDir, signal,
      { projectId: foreign.id, priority: 'user' }, () => undefined), /research_python_selection_project_mismatch/u);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await assert.rejects(environments.inspect(f.workspace, runtime, f.jobDir, signal, admission, () => undefined),
      /research_project_archived/u);
    assert.deepEqual(f.counts, { picks: 1, dispatches: 2 });
  } finally { await f.cleanup(); }
});

test('wire paths, actors, missing main authority, another project and another window cannot grant or replay selection', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.select(f.request), /research_human_required/u);
    await assert.rejects(f.human(() => f.service.select(f.request), 'other-project'), /research_human_project_mismatch/u);
    await assert.rejects(f.select({ ...f.request, selectedExecutable: f.executable }));
    await assert.rejects(f.select({ ...f.request, actor: { kind: 'user', id: 'window:72' } }));
    assert.deepEqual(f.counts, { picks: 0, dispatches: 0 });
    const selected = await f.select();
    await assert.rejects(f.human(() => f.service.select(f.request), f.project.id, 73), /research_python_selection_request_conflict/u);
    const otherPath = join(f.path, 'other-project'); await mkdir(otherPath);
    const other = f.repository.createProject({ title: 'Other', description: '', workspacePath: otherPath });
    assert.throws(() => f.repository.pythonEnvironments.get({ ...f.reference(selected), projectId: other.id }), /research_python_selection_project_mismatch/u);
    assert.throws(() => f.repository.pythonEnvironments.get({ ...f.reference(selected), expectedHash: 'f'.repeat(64) }), /research_python_selection_hash_mismatch/u);
    assert.deepEqual(f.counts, { picks: 1, dispatches: 1 });
  } finally { await f.cleanup(); }
});

test('generated selection API establishes actual main sender across native picker and probe awaits', async () => {
  const f = await fixture();
  try {
    const handlers = new Map();
    api.registerResearchPythonEnvironmentCapabilities({ pluginId: '@roc/plugin-research', capabilities: {
      register(_plugin, descriptor, handler) { handlers.set(descriptor.name, handler); }
    } }, f.repository.pythonEnvironments, f.service);
    const adapter = api.createPluginCapabilityAdapter({ invokeCapability(name, input) {
      assert.ok(handlers.has(name)); return handlers.get(name)(input);
    } });
    assert.equal((await adapter.invoke('research.selectPythonEnvironment', [f.request])).ok, false);
    assert.equal((await adapter.invoke('research.selectPythonEnvironment', [{ ...f.request, executable: f.executable }], 72)).ok, false);
    assert.deepEqual(f.counts, { picks: 0, dispatches: 0 });
    const result = await adapter.invoke('research.selectPythonEnvironment', [f.request], 72);
    assert.equal(result.ok, true, JSON.stringify(result));
    const selected = result.data;
    assert.deepEqual(selected.snapshot.actor, { kind: 'user', id: 'window:72' });
    const read = await adapter.invoke('research.getPythonEnvironmentSelection', [f.reference(selected)], 72);
    assert.equal(read.ok, true); assert.deepEqual(read.data, selected);
    const list = await adapter.invoke('research.listPythonEnvironmentSelections', [{ projectId: f.project.id }], 72);
    assert.equal(list.ok, true); assert.deepEqual(list.data, [selected]);
    assert.equal((await adapter.invoke('research.selectPythonEnvironment', [f.request], 73)).ok, false);
  } finally { await f.cleanup(); }
});

test('cancelled panel and archived project do not dispatch Python or store a selection', async () => {
  const f = await fixture({ picker: async () => null });
  try {
    assert.equal(await f.select(), null); assert.equal(f.counts.dispatches, 0);
    assert.deepEqual(f.repository.pythonEnvironments.list({ projectId: f.project.id }), []);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await assert.rejects(f.select(), /research_project_archived/u);
    assert.deepEqual(f.counts, { picks: 1, dispatches: 0 });
  } finally { await f.cleanup(); }
});

test('environment changes require a fresh explicit selection; historical replay never authorizes changed execution', async () => {
  const f = await fixture();
  try {
    const selected = await f.select();
    await writeFile(join(f.packagePath, 'changed-native.so'), 'changed declared code bytes');
    await assert.rejects(f.service.resolve(f.reference(selected), f.jobDir, new AbortController().signal, f.admission, () => undefined),
      /research_python_selection_environment_changed/u);
    assert.deepEqual(await f.select(), selected);
    const fresh = await f.select({ ...f.request, requestId: 'explicit-new-selection' });
    assert.notEqual(fresh.snapshot.metadataHash, selected.snapshot.metadataHash);
    assert.notEqual(fresh.snapshotHash, selected.snapshotHash); assert.equal(f.counts.picks, 2);
    assert.equal(f.repository.pythonEnvironments.list({ projectId: f.project.id }).length, 2);
    f.lock.python.version = '3.14.0';
    await writeFile(join(f.workspace, 'roc-python.lock.json'), JSON.stringify(f.lock));
    await assert.rejects(f.service.resolve(f.reference(fresh), f.jobDir, new AbortController().signal, f.admission, () => undefined),
      /research_python_runtime_version_mismatch/u);
    await assert.rejects(f.select({ ...f.request, requestId: 'invalid-selection' }), /research_python_runtime_version_mismatch/u);
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
      await assert.rejects(f.select(), scenario === 'archive' ? /research_project_archived/u : /research_python_selection_workspace_changed/u);
      assert.equal(f.db.prepare('SELECT count(*) FROM research_python_environment_selections').pluck().get(), 0);
    } finally { await f.cleanup(); }
  }
});

test('project release cancels actual held Python probe and shutdown refuses further native selection', async () => {
  const f = await fixture();
  let entered, startupFailed;
  const started = new Promise((resolve, reject) => { entered = resolve; startupFailed = reject; });
  const service = new api.ResearchPythonEnvironmentService(f.repository, async () => f.executable, async request => {
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
      receipts.push({ scenario: 'cancel-held-selection', error: error.code, usage: error.resourceUsage, admission: error.admission });
      throw error;
    }
  });
  try {
    const pending = f.human(() => service.select(f.request));
    const rejected = assert.rejects(pending, /research_process_cancelled/u);
    await started;
    await service.releaseProject(f.project.id);
    await rejected;
    assert.equal(f.db.prepare('SELECT count(*) FROM research_python_environment_selections').pluck().get(), 0);
    assert.ok(receipts.at(-1).admission.holdMs > 0);
    await service.shutdown();
    await assert.rejects(f.human(() => service.select(f.request)), /research_python_selection_service_closed/u);
  } finally { await service.shutdown(); await f.cleanup(); }
});

test('damaged stored JSON, column identity or missing selection fails without opening another panel', async () => {
  const f = await fixture();
  try {
    const selected = await f.select();
    const original = f.db.prepare('SELECT * FROM research_python_environment_selections WHERE id=?').get(selected.snapshot.id);
    for (const mutate of [
      () => f.db.prepare('UPDATE research_python_environment_selections SET snapshot_json=? WHERE id=?').run('{}', original.id),
      () => f.db.prepare('UPDATE research_python_environment_selections SET snapshot_hash=? WHERE id=?').run('e'.repeat(64), original.id),
      () => f.db.prepare('UPDATE research_python_environment_selections SET created_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', original.id)
    ]) {
      mutate();
      assert.throws(() => f.repository.pythonEnvironments.get(f.reference(selected)));
      assert.throws(() => f.repository.pythonEnvironments.list({ projectId: f.project.id }));
      await assert.rejects(f.select());
      assert.deepEqual(f.counts, { picks: 1, dispatches: 1 });
      f.db.prepare('UPDATE research_python_environment_selections SET snapshot_json=?,snapshot_hash=?,created_at=? WHERE id=?')
        .run(original.snapshot_json, original.snapshot_hash, original.created_at, original.id);
    }
    f.db.prepare('DELETE FROM research_python_environment_selections WHERE id=?').run(original.id);
    await assert.rejects(f.service.resolve(f.reference(selected), f.jobDir, new AbortController().signal, f.admission, () => undefined), /research_python_selection_not_found/u);
    assert.equal(f.counts.dispatches, 1);
  } finally { await f.cleanup(); }
});

test('DB41 upgrade and disk reopen preserve existing project bytes and exact immutable selection without another probe', async () => {
  const f = await fixture();
  const dbPath = join(f.path, 'research.sqlite');
  let disk;
  try {
    const selected = await f.select();
    disk = new Database(dbPath); disk.pragma('foreign_keys=ON');
    api.applyDatabaseMigrations(disk, { dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(m => m.version <= 41) });
    const row = f.db.prepare('SELECT * FROM research_projects WHERE id=?').get(f.project.id), keys = Object.keys(row);
    disk.prepare(`INSERT INTO research_projects (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
    api.applyResearchDatabaseSchema(disk);
    assert.deepEqual(disk.prepare('SELECT * FROM research_projects').get(), row);
    assert.equal(disk.prepare('SELECT current_version FROM schema_metadata').pluck().get(), 42);
    const reopenedRepository = new api.ResearchRepository(disk, f.tasks);
    assert.deepEqual(reopenedRepository.pythonEnvironments.save(selected.snapshot), selected);
    disk.close();
    disk = new Database(dbPath); disk.pragma('foreign_keys=ON'); api.applyResearchDatabaseSchema(disk);
    const repository = new api.ResearchRepository(disk, f.tasks);
    assert.deepEqual(repository.pythonEnvironments.get(f.reference(selected)), selected);
    assert.deepEqual(repository.pythonEnvironments.findRequest(f.request), selected);
    assert.deepEqual(disk.prepare('SELECT * FROM research_projects').get(), row);
    assert.deepEqual(f.counts, { picks: 1, dispatches: 1 });
    assert.equal((await readFile(join(f.workspace, 'roc-python.lock.json'), 'utf8')), JSON.stringify(f.lock));
  } finally { disk?.close(); await f.cleanup(); }
});
