import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, readFile, symlink, rm, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadResearchTestApi, createResearchFixture } from '../unit/fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

test('missing and unsupported Python report an actionable error without opening a picker or writing a lock', async () => {
  const root = await realpath(await mkdtemp('/private/tmp/roc-python-unavailable-'));
  await mkdir(join(root, 'bin'));
  const oldPython = join(root, 'bin/python3.12');
  await writeFile(oldPython, '', { mode: 0o755 });
  const f = createResearchFixture(api, 'experiment', root);
  try {
    for (const candidates of [[], [oldPython]]) {
      const service = new api.ResearchPythonEnvironmentService(f.repository, undefined,
        async () => assert.fail('unsupported interpreter must not execute'), async () => candidates);
      try {
        await assert.rejects(service.list({ projectId: f.project.id }), error => {
          assert.equal(error.code, 'research_python_runtime_unavailable');
          assert.match(error.message, /CPython 3\.14/u);
          assert.match(error.userAction, /安装 CPython 3\.14/u);
          return true;
        });
        await assert.rejects(access(join(root, 'roc-python.lock.json')), { code: 'ENOENT' });
      } finally { await service.shutdown(); }
    }
  } finally { f.close(); await rm(root, { recursive: true, force: true }); }
});

test('first project use automatically probes Python, initializes its lock and reuses a system receipt', async () => {
  const root = await realpath(await mkdtemp('/private/tmp/roc-python-automatic-'));
  const workspace = join(root, 'workspace'), venv = join(workspace, '.venv');
  const python = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
    'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":sys.version.split()[0]}))'], { encoding: 'utf8' }));
  for (const path of [join(venv, 'bin'), join(venv, 'lib/python3.14/site-packages')]) await mkdir(path, { recursive: true });
  await symlink(python.executable, join(venv, 'bin/python3'));
  await writeFile(join(venv, 'pyvenv.cfg'), `home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion = ${python.version}\n`);
  const f = createResearchFixture(api, 'experiment', workspace);
  let probes = 0;
  const service = new api.ResearchPythonEnvironmentService(f.repository, undefined, async request => {
    probes++; return api.runResearchProcess(request);
  });
  try {
    const request = { projectId: f.project.id };
    const [first, concurrent] = await Promise.all([service.list(request), service.list(request)]);
    assert.deepEqual(first, concurrent); assert.equal(probes, 1);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].snapshot.actor, { kind: 'system', id: 'roc-python-environment' });
    assert.equal(first[0].snapshot.selectedExecutable, join(venv, 'bin/python3'));
    const lockPath = join(workspace, 'roc-python.lock.json');
    const lockBytes = await readFile(lockPath, 'utf8');
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.python.version, python.version); assert.deepEqual(lock.distributions, []);
    assert.deepEqual(await service.list(request), first); assert.equal(probes, 2);
    assert.equal(await readFile(lockPath, 'utf8'), lockBytes);
    await writeFile(join(venv, 'lib/python3.14/site-packages/project_helper.py'), 'VALUE = 1\n');
    const updated = await service.list(request);
    assert.equal(updated.length, 2);
    assert.notEqual(updated[1].snapshot.metadataHash, first[0].snapshot.metadataHash);
    await writeFile(lockPath, '{}');
    await assert.rejects(service.list(request), error => error.code === 'research_python_lock_invalid');
    assert.equal(await readFile(lockPath, 'utf8'), '{}');
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.deepEqual(await service.list(request), updated);
  } finally {
    await service.shutdown(); f.close(); await rm(root, { recursive: true, force: true });
  }
});
