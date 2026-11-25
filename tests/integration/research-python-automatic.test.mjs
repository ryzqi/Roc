import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, realpath, writeFile, readFile, symlink, rm, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {loadResearchTestApi, createResearchFixture} from '../unit/fixtures/research-test-kit.mjs';
import {writePythonProjectFiles, createPythonFixtureService, waitPythonPreparation} from '../unit/fixtures/python-environment.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());

test('list/status are pure on an empty project; automatic preparation reports failure and permits an explicit retry', async () => {
  const root = await realpath(await mkdtemp('/private/tmp/roc-python-automatic-failure-'));
  const f = createResearchFixture(api, 'experiment', root);
  let preparations = 0;
  const service = new api.ResearchPythonEnvironmentService(f.repository, join(root, 'managed-python'), {prepare: async () => {
    preparations++; throw new Error('research_python_runtime_download_failed');
  }});
  try {
    const request = {projectId: f.project.id}, before = await readdir(root);
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(service.list(request), []);
      assert.deepEqual(service.status(request), {operation: null, environment: null});
    }
    assert.equal(preparations, 0); assert.deepEqual(await readdir(root), before);
    const operation = await service.prepareAutomatic(f.project.id);
    const state = await waitPythonPreparation(service, f.project.id, operation.id);
    assert.equal(state.operation.phase, 'failed');
    assert.equal(state.operation.errorCode, 'research_python_runtime_download_failed');
    assert.deepEqual(state.operation.actor, {kind: 'system', id: 'roc-python-environment'});
    assert.equal(state.environment, null); assert.equal(preparations, 1);
    assert.deepEqual(service.list(request), []); assert.deepEqual(service.status(request), state);
    assert.equal(preparations, 1);
    const next = await service.prepareAutomatic(f.project.id);
    assert.notEqual(next.id, operation.id);
    await waitPythonPreparation(service, f.project.id, next.id); assert.equal(preparations, 2);
  } finally {await service.shutdown(); f.close(); await rm(root, {recursive: true, force: true});}
});

test('automatic preparation records a system receipt; subsequent reads never probe or repair changed project files', async () => {
  const root = await realpath(await mkdtemp('/private/tmp/roc-python-automatic-'));
  const workspace = join(root, 'workspace'), venv = join(workspace, '.venv');
  const python = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
    'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":sys.version.split()[0]}))'], {encoding: 'utf8'}));
  for (const path of [join(venv, 'bin'), join(venv, 'lib/python3.14/site-packages')]) await mkdir(path, {recursive: true});
  const executable = join(venv, 'bin/python3'); await symlink(python.executable, executable);
  await writeFile(join(venv, 'pyvenv.cfg'), `home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion_info = ${python.version}\nimplementation = CPython\nuv = 0.13.9\n`);
  await writePythonProjectFiles(workspace, python.version);
  const f = createResearchFixture(api, 'experiment', workspace);
  let probes = 0;
  const service = createPythonFixtureService(api, f.repository, root, executable, {run: async request => {
    probes++; return api.runResearchProcess(request);
  }});
  try {
    const request = {projectId: f.project.id};
    assert.deepEqual(service.list(request), []); assert.equal(probes, 0);
    const operation = await service.prepareAutomatic(f.project.id);
    const state = await waitPythonPreparation(service, f.project.id, operation.id);
    assert.equal(state.operation.phase, 'ready', state.operation.errorCode); assert.equal(probes, 1);
    assert.deepEqual(state.environment.snapshot.actor, {kind: 'system', id: 'roc-python-environment'});
    assert.equal(state.environment.snapshot.selectedExecutable, executable);
    assert.deepEqual(state.environment.snapshot.lockFiles.map(file => file.path).sort(), ['.python-version', 'pyproject.toml', 'uv.lock']);
    const first = service.list(request), lock = await readFile(join(workspace, 'uv.lock'), 'utf8');
    await writeFile(join(venv, 'lib/python3.14/site-packages/project_helper.py'), 'VALUE = 1\n');
    for (let i = 0; i < 3; i++) {assert.deepEqual(service.list(request), first); assert.deepEqual(service.status(request), state);}
    assert.equal(probes, 1); assert.equal(await readFile(join(workspace, 'uv.lock'), 'utf8'), lock);
    await writeFile(join(workspace, 'uv.lock'), '{}');
    assert.deepEqual(service.list(request), first); assert.equal(probes, 1);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.deepEqual(service.status(request), state); await assert.rejects(service.prepareAutomatic(f.project.id), /research_project_archived/u);
  } finally {await service.shutdown(); f.close(); await rm(root, {recursive: true, force: true});}
});
