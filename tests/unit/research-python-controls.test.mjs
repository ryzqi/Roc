import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, mkdir, cp, symlink, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { discoverPythonEnvironmentControls } = await importTypeScriptModule(
  'src/main/plugins/research/experiment-python-controls.ts', { platform: 'node' });
const python = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
  'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"prefix":sys.base_prefix,"version":sys.version.split()[0]}))'],
{ encoding: 'utf8' }));
assert.match(python.version, /^3\.14\.\d+$/u, 'This runtime contract requires an actual installed CPython 3.14.');
const signal = () => new AbortController().signal;

async function fixture() {
  const root = await realpath(await mkdtemp('/private/tmp/roc-python-controls-'));
  const environment = join(root, 'venv');
  await mkdir(join(environment, 'bin'), { recursive: true });
  await mkdir(join(environment, 'lib/python3.14/site-packages'), { recursive: true });
  await symlink(python.executable, join(environment, 'bin/python3'));
  const config = `home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion = ${python.version}\n`;
  await writeFile(join(environment, 'pyvenv.cfg'), config);
  return { root, environment, executable: join(environment, 'bin/python3'), config,
    async dispose() { await rm(root, { recursive: true, force: true }); } };
}

test('real standalone and symlinked standard venv expose explicit canonical code paths without launching in discovery', async () => {
  const standalone = await discoverPythonEnvironmentControls(python.executable, signal());
  assert.equal(standalone.executable, python.executable);
  assert.equal(standalone.prefix, python.prefix); assert.equal(standalone.basePrefix, python.prefix);
  assert.deepEqual(standalone.controls, []);
  assert.deepEqual(standalone.codeRoots, [join(python.prefix, 'bin'), join(python.prefix, 'lib')]);
  const f = await fixture();
  try {
    const selected = await discoverPythonEnvironmentControls(f.executable, signal());
    assert.equal(selected.selectedExecutable, f.executable); assert.equal(selected.executable, python.executable);
    assert.equal(selected.prefix, f.environment); assert.equal(selected.basePrefix, python.prefix);
    assert.equal(selected.packagePath, join(f.environment, 'lib/python3.14/site-packages'));
    assert.deepEqual(selected.controls, [{ path: join(f.environment, 'pyvenv.cfg'),
      sha256: createHash('sha256').update(f.config).digest('hex') }]);
    const actual = JSON.parse(execFileSync(f.executable, ['-I', '-S', '-c',
      'import sys,json;print(json.dumps({"prefix":sys.prefix,"basePrefix":sys.base_prefix,"paths":sys.path,"siteLoaded":"site" in sys.modules}))'],
    { encoding: 'utf8' }));
    assert.equal(actual.prefix, selected.prefix); assert.equal(actual.basePrefix, selected.basePrefix);
    assert.deepEqual(actual.paths, selected.modulePaths); assert.equal(actual.siteLoaded, false);
  } finally { await f.dispose(); }
});

test('actual ._pth starts site hooks despite -I -S, and host preflight refuses before interpreter dispatch', async () => {
  const f = await fixture();
  try {
    const runtime = join(f.root, 'runtime');
    await mkdir(join(runtime, 'bin'), { recursive: true });
    const executable = join(runtime, 'bin', basename(python.executable));
    await cp(python.executable, executable);
    await symlink(join(python.prefix, 'lib'), join(runtime, 'lib'), 'dir');
    const hooks = join(f.root, 'hooks'); await mkdir(hooks);
    await writeFile(join(hooks, 'sitecustomize.py'), 'print("REAL_STARTUP_HOOK_EXECUTED")\n');
    await writeFile(`${executable}._pth`, [
      join(python.prefix, 'lib/python3.14'), join(python.prefix, 'lib/python3.14/lib-dynload'), hooks, 'import site', ''
    ].join('\n'));
    const actual = execFileSync(executable, ['-I', '-S', '-c', 'import sys;print("SITE_LOADED", "site" in sys.modules)'],
      { encoding: 'utf8' });
    assert.match(actual, /REAL_STARTUP_HOOK_EXECUTED/u);
    assert.match(actual, /SITE_LOADED True/u);
    await assert.rejects(discoverPythonEnvironmentControls(executable, signal()), /research_python_path_override_unsupported/u);
    await writeFile(join(f.environment, 'lib/libpython3.14._pth'), 'import site\n');
    await assert.rejects(discoverPythonEnvironmentControls(f.executable, signal()), /research_python_path_override_unsupported/u);
  } finally { await f.dispose(); }
});

test('venv controls refuse system packages, duplicate keys, missing home, wrong home and unsupported version', async () => {
  const f = await fixture();
  try {
    for (const [config, error] of [
      [f.config.replace('false', 'true'), /research_python_system_packages_unsupported/u],
      [f.config + 'home = /private/tmp\n', /research_python_venv_config_invalid/u],
      [f.config.split('\n').slice(1).join('\n'), /research_python_venv_home_mismatch/u],
      [f.config.replace(dirname(python.executable), f.root), /research_python_venv_home_mismatch/u],
      [f.config.replace(`version = ${python.version}`, 'version = 3.13.1'), /research_python_venv_version_unsupported/u],
      [f.config + 'unknown-option = yes\n', /research_python_venv_config_invalid/u]
    ]) {
      await writeFile(join(f.environment, 'pyvenv.cfg'), config);
      await assert.rejects(discoverPythonEnvironmentControls(f.executable, signal()), error);
    }
    await writeFile(join(f.environment, 'pyvenv.cfg'), f.config);
    await writeFile(join(f.environment, 'bin/pyvenv.cfg'), f.config);
    await assert.rejects(discoverPythonEnvironmentControls(f.executable, signal()), /research_python_venv_layout_unsupported/u);
  } finally { await f.dispose(); }
});

test('unsupported interpreter layout and executable bytes fail, and cancellation keeps its real reason', async () => {
  const f = await fixture();
  try {
    await assert.rejects(discoverPythonEnvironmentControls('python3', signal()), /research_python_interpreter_path_invalid/u);
    const runtime = join(f.root, 'invalid-runtime');
    await mkdir(join(runtime, 'bin'), { recursive: true }); await mkdir(join(runtime, 'lib'));
    const binary = join(runtime, 'bin/python3.14');
    await writeFile(binary, '#!/bin/sh\nprintf fake-python\n');
    await assert.rejects(discoverPythonEnvironmentControls(binary, signal()), /research_python_interpreter_binary_unsupported/u);
    const controller = new AbortController(), reason = new Error('actual-selection-cancelled');
    controller.abort(reason);
    await assert.rejects(discoverPythonEnvironmentControls(f.executable, controller.signal), error => error === reason);
  } finally { await f.dispose(); }
});
