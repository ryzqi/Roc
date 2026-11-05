import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, mkdir, symlink, writeFile, readFile, rm, cp, stat, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadResearchTestApi } from '../unit/fixtures/research-test-kit.mjs';

const python = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
  'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":".".join(map(str,sys.version_info[:3]))}))'],
{ encoding: 'utf8' }));
assert.match(python.version, /^3\.14\.\d+$/u);
let api, root;
const receipts = [];
before(async () => {
  api = await loadResearchTestApi();
  root = await realpath(await mkdtemp('/private/tmp/roc-python-environment-'));
});
after(async () => {
  const output = join(process.cwd(), '.artifacts/research-optimization/pr08-a2');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'python-environment.json'), JSON.stringify({
    backend: 'macos-seatbelt', python, actualPythonTested: true, userSelectionGranted: false, receipts
  }, null, 2));
  await rm(root, { recursive: true, force: true });
  api.dispose();
});

async function fixture() {
  const path = await mkdtemp(join(root, 'case-'));
  const venv = join(path, 'venv'), workspace = join(path, 'project'), jobDir = join(path, 'jobs');
  for (const directory of [join(venv, 'bin'), join(venv, 'lib/python3.14/site-packages'), workspace, jobDir]) {
    await mkdir(directory, { recursive: true });
  }
  const selectedExecutable = join(venv, 'bin/python3');
  await symlink(python.executable, selectedExecutable);
  const config = join(venv, 'pyvenv.cfg');
  await writeFile(config, `home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion = ${python.version}\n`);
  const lock = { schemaVersion: 1, python: { implementation: 'cpython', version: python.version, platform: 'darwin', architecture: 'arm64' },
    distributions: [{ name: 'fixture-pkg', version: '1.0.0' }] };
  const packagePath = join(venv, 'lib/python3.14/site-packages');
  const metadata = join(packagePath, 'Fixture_Pkg-1.0.0.dist-info');
  const packageCode = join(packagePath, 'fixture_pkg');
  await mkdir(metadata); await mkdir(packageCode);
  await writeFile(join(metadata, 'METADATA'), 'Metadata-Version: 2.4\nName: Fixture_Pkg\nVersion: 1.0.0\n');
  await writeFile(join(packageCode, '__init__.py'), `raise RuntimeError("PACKAGE_CODE_WAS_IMPORTED")\n`);
  await writeFile(join(packagePath, 'sitecustomize.py'), `raise RuntimeError("STARTUP_HOOK_WAS_IMPORTED")\n`);
  await writeFile(join(workspace, 'roc-python.lock.json'), JSON.stringify(lock));
  await writeFile(join(workspace, 'undeclared.txt'), 'synthetic private project data');
  const input = {
    workspace, selectedExecutable, jobDir, signal: new AbortController().signal,
    admission: { projectId: 'python-environment-matrix', priority: 'user' },
    onProbe: receipt => receipts.push({ scenario: 'environment', probe: receipt }), run: api.runResearchProcess
  };
  return { path, venv, workspace, config, packagePath, packageCode, metadata, lock, input };
}
async function inspect(f, scenario, run = api.runResearchProcess) {
  return api.inspectPythonExperimentEnvironment({
    ...f.input, run: async request => {
      try {
        const result = await run(request);
        receipts.push({ scenario, actual: result });
        return result;
      } catch (error) {
        receipts.push({ scenario, actualError: { code: error.code, usage: error.resourceUsage, admission: error.admission } });
        throw error;
      }
    },
    onProbe: probe => receipts.push({ scenario, probe })
  });
}

test('actual CPython venv probe verifies exact lock, ignores site hooks and never imports installed package code', async () => {
  const f = await fixture();
  const first = await inspect(f, 'unchanged-first');
  const second = await inspect(f, 'unchanged-second');
  assert.equal(first.report.executable, f.input.selectedExecutable);
  assert.equal(first.report.prefix, f.venv);
  assert.equal(first.report.siteLoaded, false);
  assert.deepEqual(first.report.distributions, f.lock.distributions);
  assert.equal(first.metadataHash, second.metadataHash);
  assert.equal(first.code.hash, second.code.hash);
  assert.ok(first.code.entries.some(entry => entry.path.endsWith('fixture_pkg/__init__.py')));
  assert.ok(first.code.entries.some(entry => entry.path === 'python3' && entry.type === 'symlink'));
  const observed = receipts.find(item => item.scenario === 'unchanged-first' && item.probe).probe;
  assert.equal(observed.outcome, 'returned'); assert.equal(observed.exitCode, 0);
  const actual = receipts.find(item => item.scenario === 'unchanged-first' && item.actual).actual;
  assert.deepEqual(observed.usage, actual.resourceUsage); assert.deepEqual(observed.admission, actual.admission);
  assert.ok(observed.admission.holdMs > 0);
});

test('actual Python probe policy denies undeclared data, runtime writes, network and inherited credentials', async () => {
  const f = await fixture();
  process.env.ROC_SYNTHETIC_PARENT_SECRET = 'synthetic-test-only-value';
  try {
    await inspect(f, 'boundary-environment', async request => {
      const script = `import os,json,socket,errno
observed = {}
try:
    open(${JSON.stringify(join(f.workspace, 'undeclared.txt'))}, "rb").read()
    observed["privateDenied"] = False
except OSError as error:
    observed["privateDenied"] = error.errno == errno.EPERM
try:
    open(${JSON.stringify(f.config)}, "w").write("changed")
    observed["runtimeWriteDenied"] = False
except OSError as error:
    observed["runtimeWriteDenied"] = error.errno == errno.EPERM
try:
    connection = socket.socket()
    connection.connect(("127.0.0.1", 9))
    observed["networkDenied"] = False
except OSError as error:
    observed["networkDenied"] = error.errno == errno.EPERM
observed["credentialAbsent"] = "ROC_SYNTHETIC_PARENT_SECRET" not in os.environ
with open("declared-output.json", "w", encoding="utf-8") as output:
    json.dump(observed, output)
print(json.dumps(observed))
`;
      const boundary = await api.runResearchProcess({ ...request, args: [...api.pythonExperimentFlags, '-c', script] });
      receipts.push({ scenario: 'actual-python-boundaries', result: boundary });
      assert.equal(boundary.exitCode, 0, boundary.stderr);
      assert.deepEqual(JSON.parse(boundary.stdout), {
        privateDenied: true, runtimeWriteDenied: true, networkDenied: true, credentialAbsent: true
      });
      assert.deepEqual(JSON.parse(await readFile(join(request.cwd, 'declared-output.json'), 'utf8')), JSON.parse(boundary.stdout));
      return api.runResearchProcess(request);
    });
  } finally { delete process.env.ROC_SYNTHETIC_PARENT_SECRET; }
});

test('lock version and complete distribution set must exactly match actual installed metadata', async () => {
  for (const [change, error] of [
    [lock => { lock.python.version = '3.14.0'; }, /research_python_runtime_version_mismatch/u],
    [lock => { lock.distributions[0].version = '1.0.1'; }, /research_python_installed_distributions_mismatch/u],
    [lock => { lock.distributions = []; }, /research_python_installed_distributions_mismatch/u],
    [lock => { lock.distributions.push({ name: 'missing-package', version: '1.0.0' }); }, /research_python_installed_distributions_mismatch/u]
  ]) {
    const f = await fixture(); change(f.lock);
    await writeFile(join(f.workspace, 'roc-python.lock.json'), JSON.stringify(f.lock));
    await assert.rejects(inspect(f, 'lock-mismatch'), error);
  }
});

test('invalid lock contracts and host path overrides refuse before any interpreter dispatch', async () => {
  for (const [scenario, prepare] of [
    ['unknown-lock-contract', async f => { f.lock.schemaVersion = 2; }],
    ['duplicate-lock', async f => { f.lock.distributions.push(f.lock.distributions[0]); }],
    ['unnormalized-lock-name', async f => { f.lock.distributions[0].name = 'Fixture_Pkg'; }],
    ['unexpected-lock-field', async f => { f.lock.install = true; }],
    ['startup-override', async f => { await writeFile(join(f.venv, 'bin/python3._pth'), 'import site\n'); }],
    ['external-code-link', async f => { await symlink(f.workspace, join(f.packageCode, 'external'), 'dir'); }]
  ]) {
    const f = await fixture(); await prepare(f);
    await writeFile(join(f.workspace, 'roc-python.lock.json'), JSON.stringify(f.lock));
    let dispatches = 0;
    await assert.rejects(inspect(f, scenario, async request => {
      dispatches++; return api.runResearchProcess(request);
    }));
    assert.equal(dispatches, 0);
    assert.equal(receipts.some(item => item.scenario === scenario && item.probe), false);
  }
  for (const scenario of ['missing-lock', 'malformed-lock', 'linked-lock']) {
    const f = await fixture(), path = join(f.workspace, 'roc-python.lock.json');
    await rm(path);
    if (scenario === 'malformed-lock') await writeFile(path, '{broken');
    if (scenario === 'linked-lock') {
      const external = join(f.path, 'external-lock.json');
      await writeFile(external, JSON.stringify(f.lock)); await symlink(external, path);
    }
    let dispatches = 0;
    await assert.rejects(inspect(f, scenario, async request => { dispatches++; return api.runResearchProcess(request); }));
    assert.equal(dispatches, 0);
  }
});

test('unsupported direct/editable dependency and startup-path semantics fail with actual probe logs and resource receipts', async () => {
  for (const [filename, content] of [
    ['direct_url.json', '{"url":"file:///private/tmp/editable-source","dir_info":{"editable":true}}'],
    ['direct_url.json', '{"url":"https://example.invalid/package.whl","archive_info":{}}'],
    ['startup.pth', 'import sitecustomize\n'],
    ['old.egg-link', '/private/tmp/external-package\n']
  ]) {
    const f = await fixture();
    await writeFile(join(filename === 'direct_url.json' ? f.metadata : f.packagePath, filename), content);
    await assert.rejects(inspect(f, filename), error => {
      assert.equal(error.code, 'research_python_environment_probe_failed');
      assert.match(error.stderr, /research_python_(direct_dependency|package_layout)_unsupported/u);
      const actual = receipts.filter(item => item.scenario === filename && item.actual).at(-1).actual;
      assert.deepEqual(error.resourceUsage, actual.resourceUsage); assert.deepEqual(error.admission, actual.admission);
      assert.ok(error.admission.holdMs > 0);
      return true;
    });
    const receipt = receipts.filter(item => item.scenario === filename && item.probe).at(-1).probe;
    assert.equal(receipt.outcome, 'returned'); assert.equal(receipt.exitCode, 1);
  }
});

test('duplicate installed identities and malformed metadata are rejected rather than choosing one distribution', async () => {
  const f = await fixture();
  const duplicate = join(f.packagePath, 'fixture.pkg-1.0.0.dist-info');
  await mkdir(duplicate);
  await writeFile(join(duplicate, 'METADATA'), 'Metadata-Version: 2.4\nName: fixture.pkg\nVersion: 1.0.0\n');
  await assert.rejects(inspect(f, 'duplicate-installed'), /research_python_environment_report_invalid/u);
  await rm(duplicate, { recursive: true });
  await writeFile(join(f.metadata, 'METADATA'), 'Metadata-Version: 2.4\nName: Fixture_Pkg\nName: forged\nVersion: 1.0.0\n');
  await assert.rejects(inspect(f, 'malformed-installed'), error =>
    error.code === 'research_python_environment_probe_failed' && /research_python_distribution_metadata_invalid/u.test(error.stderr));
});

test('full native package bytes affect environment identity even with restored timestamps and unchanged lock metadata', async () => {
  const f = await fixture();
  const native = join(f.packageCode, 'actual-native.so');
  const actualNative = execFileSync(python.executable, ['-I', '-S', '-c', 'import _dbm;print(_dbm.__file__)'], { encoding: 'utf8' }).trim();
  await cp(actualNative, native);
  const first = await inspect(f, 'native-before');
  const before = await stat(native), bytes = await readFile(native);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(native, bytes); await utimes(native, before.atime, before.mtime);
  const second = await inspect(f, 'native-after');
  assert.deepEqual(first.report.distributions, second.report.distributions);
  assert.deepEqual(first.lockFile, second.lockFile);
  assert.notEqual(first.code.hash, second.code.hash);
  assert.notEqual(first.metadataHash, second.metadataHash);
});

test('post-dispatch lock, control and package-code drift each reject the actual otherwise successful probe', async () => {
  for (const [scenario, mutate, error] of [
    ['lock-drift', async f => writeFile(join(f.workspace, 'roc-python.lock.json'), JSON.stringify({ ...f.lock, schemaVersion: 2 })),
      /research_python_lock_changed/u],
    ['control-drift', async f => writeFile(f.config, (await readFile(f.config, 'utf8')) + 'prompt = changed\n'),
      /research_python_environment_controls_changed/u],
    ['code-drift', async f => writeFile(join(f.packageCode, '__init__.py'), 'raise RuntimeError("changed code")\n'),
      /research_python_native_code_changed/u]
  ]) {
    const f = await fixture();
    await assert.rejects(inspect(f, scenario, async request => {
      const result = await api.runResearchProcess(request);
      assert.equal(result.exitCode, 0); await mutate(f);
      return result;
    }), error);
    assert.equal(receipts.find(item => item.scenario === scenario && item.probe).probe.exitCode, 0);
  }
});

test('cancelled actual probe preserves rejected usage and admission, without inventing successful environment data', async () => {
  const f = await fixture(), controller = new AbortController();
  f.input.signal = controller.signal;
  await assert.rejects(inspect(f, 'actual-cancel', async request => {
    const promise = api.runResearchProcess({ ...request, args: [...api.pythonExperimentFlags, '-c', 'import time;time.sleep(60)'] });
    setTimeout(() => controller.abort(new Error('actual-python-probe-cancel')), 100);
    return promise;
  }), /research_process_cancelled/u);
  const receipt = receipts.find(item => item.scenario === 'actual-cancel' && item.probe).probe;
  assert.equal(receipt.outcome, 'rejected'); assert.equal(receipt.exitCode, null);
  assert.equal(receipt.error, 'research_process_cancelled');
  assert.ok(receipt.admission.holdMs > 0);
  const actual = receipts.find(item => item.scenario === 'actual-cancel' && item.actualError).actualError;
  assert.deepEqual(receipt.usage, actual.usage); assert.deepEqual(receipt.admission, actual.admission);
});

test('actual malformed report fails with original stdout and measured resource usage retained', async () => {
  const f = await fixture();
  await assert.rejects(inspect(f, 'malformed-report', async request => {
    const args = [...request.args], script = args.indexOf('-c') + 1;
    args[script] = 'print("UNTRUSTED_REPORT_NOISE")\n' + args[script];
    return api.runResearchProcess({ ...request, args });
  }), error => {
    assert.equal(error.code, 'research_python_environment_report_invalid');
    assert.match(error.stdout, /^UNTRUSTED_REPORT_NOISE\n/u);
    const actual = receipts.find(item => item.scenario === 'malformed-report' && item.actual).actual;
    assert.deepEqual(error.resourceUsage, actual.resourceUsage);
    assert.deepEqual(error.admission, actual.admission);
    return true;
  });
});
