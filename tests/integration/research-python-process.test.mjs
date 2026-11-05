import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, readFile, symlink, rm, stat, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadResearchTestApi } from '../unit/fixtures/research-test-kit.mjs';

const python = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
  'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":sys.version.split()[0]}))'], { encoding: 'utf8' }));
assert.match(python.version, /^3\.14\.\d+$/u);
let api, root;
const receipts = [];
before(async () => { api = await loadResearchTestApi(); root = await realpath(await mkdtemp('/private/tmp/roc-python-process-')); });
after(async () => {
  const output = join(process.cwd(), '.artifacts/research-optimization/pr08-a4b2');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'python-process.json'), JSON.stringify({
    python, actualIsolatedPython: true, userSelectionGranted: false, bootstrapHash: api.pythonExperimentBootstrapHash(), receipts
  }, null, 2));
  await rm(root, { recursive: true, force: true }); api.dispose();
});

async function fixture(code) {
  const path = await mkdtemp(join(root, 'case-'));
  const venv = join(path, 'venv'), workspace = join(path, 'workspace');
  const inputDir = join(path, 'input'), outputDir = join(path, 'output'), scratchDir = join(path, 'scratch');
  const packagePath = join(venv, 'lib/python3.14/site-packages'), jobDir = join(path, 'jobs');
  for (const dir of [workspace, inputDir, outputDir, scratchDir, packagePath, jobDir, join(venv, 'bin')]) await mkdir(dir, { recursive: true });
  const executable = join(venv, 'bin/python3'); await symlink(python.executable, executable);
  await writeFile(join(venv, 'pyvenv.cfg'), `home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion = ${python.version}\n`);
  const metadata = join(packagePath, 'Fixture_Pkg-1.0.0.dist-info'), packageCode = join(packagePath, 'fixture_pkg');
  await mkdir(metadata); await mkdir(packageCode);
  await writeFile(join(metadata, 'METADATA'), 'Metadata-Version: 2.4\nName: Fixture_Pkg\nVersion: 1.0.0\n');
  await writeFile(join(packageCode, '__init__.py'), 'VALUE = 42\n');
  await writeFile(join(packagePath, 'sitecustomize.py'), 'raise RuntimeError("UNTRUSTED_HOOK_EXECUTED")\n');
  await writeFile(join(workspace, 'roc-python.lock.json'), JSON.stringify({
    schemaVersion: 1, python: { implementation: 'cpython', version: python.version, platform: 'darwin', architecture: 'arm64' },
    distributions: [{ name: 'fixture-pkg', version: '1.0.0' }]
  }));
  const inspected = await api.inspectPythonExperimentEnvironment({
    workspace, selectedExecutable: executable, jobDir, signal: new AbortController().signal, run: api.runResearchProcess,
    admission: { projectId: 'python-process', priority: 'user' }, onProbe: receipt => receipts.push({ scenario: 'preflight', receipt })
  });
  await writeFile(join(inputDir, 'analysis.py'), code, { mode: 0o400 });
  await writeFile(join(inputDir, 'data.txt'), '3\n', { mode: 0o400 });
  await writeFile(join(workspace, 'private.txt'), 'synthetic private workspace value');
  const request = {
    source: { sourceVersion: 1, sourcePath: 'analysis.py', inputPaths: ['data.txt'], parameters: { scale: '2' }, seed: 73, arguments: ['declared-arg'] },
    python: inspected, inputDir, outputDir, scratchDir,
    policy: {
      timeoutMs: 5000, maxOutputBytes: 1024 * 1024,
      resourceLimits: { mode: 'monitored', cpuTimeMs: 15000, maxResidentBytes: 512 * 1024 ** 2 },
      writeLimits: [outputDir, scratchDir].map(path => ({ path, maxFileBytes: 4 * 1024 ** 2, maxTotalBytes: 8 * 1024 ** 2, maxFiles: 100, maxEntries: 200 }))
    },
    admission: { projectId: 'python-process', priority: 'user', resourceClass: 'compute' }, signal: new AbortController().signal
  };
  return { path, workspace, inputDir, outputDir, scratchDir, request,
    replaceSource: async content => {
      const source = join(inputDir, 'analysis.py');
      await chmod(source, 0o600); await writeFile(source, content); await chmod(source, 0o400);
    },
    execute: async (scenario, input = request, run = api.runResearchProcess) => api.runPythonExperimentProcess(input, async dispatch => {
      try {
        const result = await run(dispatch);
        receipts.push({ scenario, admission: dispatch.admission, result });
        return result;
      } catch (error) {
        receipts.push({ scenario, error: { code: error.code, stdout: error.stdout, stderr: error.stderr,
          resourceUsage: error.resourceUsage, admission: error.admission } });
        throw error;
      }
    })
  };
}

test('actual bootstrap preserves __main__, argv, declared package imports, encoding and fixed seed across independent runs', async () => {
  const f = await fixture(`# coding: latin-1
import sys, os, json, random
import roc_experiment as roc
import fixture_pkg
assert __name__ == "__main__"
assert sys.modules["__main__"].__dict__ is globals()
assert sys.argv == [__file__, "declared-arg"]
assert roc.source_version == 1 and roc.seed == 73
assert roc.input_paths == ("data.txt",)
assert "site" not in sys.modules
assert os.environ.get("ROC_SYNTHETIC_SECRET") is None
assert fixture_pkg.VALUE == 42
assert "é" == "\\xe9"
with open(os.path.join(roc.input_dir, "data.txt")) as data:
    value = int(data.read()) * int(roc.parameters["scale"])
try:
    roc.parameters["scale"] = "wrong"
    raise AssertionError("parameters mutable")
except TypeError:
    pass
with open(os.path.join(roc.output_dir, "result.json"), "w") as output:
    json.dump({"value": value, "random": random.random()}, output, sort_keys=True)
with open(os.path.join(roc.scratch_dir, "temporary.txt"), "w") as temporary:
    temporary.write("declared scratch")
print("ACTUAL_USER_SOURCE")
`);
  // compile(bytes) must honor the source's actual encoding declaration.
  await f.replaceSource(Buffer.from(await readFile(join(f.inputDir, 'analysis.py'), 'utf8'), 'latin1'));
  const saved = process.env.ROC_SYNTHETIC_SECRET; process.env.ROC_SYNTHETIC_SECRET = 'synthetic-host-secret';
  try {
    const first = await f.execute('repeat-first'), resultBytes = await readFile(join(f.outputDir, 'result.json'));
    assert.equal(first.result.exitCode, 0);
    assert.match(first.result.stdout, /\nACTUAL_USER_SOURCE\n$/u);
    assert.equal(first.result.stderr, '');
    assert.equal(first.startup.report.executable, f.request.python.controls.selectedExecutable);
    assert.deepEqual(first.startup.modulePaths, [...f.request.python.controls.modulePaths, f.request.python.controls.packagePath]);
    assert.equal(first.startup.sourcePath, join(f.inputDir, 'analysis.py'));
    assert.equal(first.startup.report.siteLoaded, false);
    const second = await f.execute('repeat-second');
    assert.equal(second.result.exitCode, 0); assert.deepEqual(second.startup, first.startup);
    assert.deepEqual(await readFile(join(f.outputDir, 'result.json')), resultBytes);
    assert.equal(JSON.parse(resultBytes).value, 6);
    assert.equal((await stat(join(f.inputDir, 'data.txt'))).mode & 0o777, 0o400);
  } finally {
    if (saved === undefined) delete process.env.ROC_SYNTHETIC_SECRET; else process.env.ROC_SYNTHETIC_SECRET = saved;
  }
});

test('actual sandbox denies undeclared project input, frozen input writes, sibling files and network without executing startup hooks', async () => {
  const f = await fixture(`import os, socket, errno
import roc_experiment as roc
denied = 0
for path, mode in [
    (${JSON.stringify('__PRIVATE_PATH__')}, "r"),
    (os.path.join(roc.input_dir, "data.txt"), "w"),
    (os.path.join(os.path.dirname(roc.output_dir), "escaped.txt"), "w")
]:
    try:
        open(path, mode)
        raise AssertionError("boundary allowed: " + path)
    except PermissionError:
        denied += 1
try:
    with socket.socket() as connection:
        connection.connect(("127.0.0.1", 9))
    raise AssertionError("network allowed")
except PermissionError:
    denied += 1
print("BOUNDARY_DENIED=" + str(denied))
`);
  const source = (await readFile(join(f.inputDir, 'analysis.py'), 'utf8')).replace('__PRIVATE_PATH__', join(f.workspace, 'private.txt'));
  await f.replaceSource(source);
  const result = await f.execute('boundaries');
  assert.equal(result.result.exitCode, 0, result.result.stderr);
  assert.match(result.result.stdout, /BOUNDARY_DENIED=4/u);
  assert.equal(result.result.stdout.includes('UNTRUSTED_HOOK_EXECUTED'), false);
  assert.equal(await readFile(join(f.inputDir, 'data.txt'), 'utf8'), '3\n');
  await assert.rejects(readFile(join(f.path, 'escaped.txt')), { code: 'ENOENT' });
});

test('original user exception and nonzero exit keep actual startup proof and logs', async () => {
  const f = await fixture('print("BEFORE_EXIT", flush=True)\nraise SystemExit(7)\n');
  const nonzero = await f.execute('exit-seven');
  assert.equal(nonzero.result.exitCode, 7);
  assert.match(nonzero.result.stdout, /BEFORE_EXIT/u);
  assert.equal(nonzero.startup.seed, 73);
  await f.replaceSource('raise RuntimeError("ORIGINAL_USER_EXCEPTION")\n');
  const exception = await f.execute('user-exception');
  assert.equal(exception.result.exitCode, 1);
  assert.match(exception.result.stderr, /ORIGINAL_USER_EXCEPTION/u);
  assert.match(exception.result.stderr, /analysis\.py/u);
});

test('actual output overflow and computation timeout retain measurements and exact errors', async () => {
  const f = await fixture('import sys\nwhile True:\n    sys.stdout.write("flood" * 4096)\n    sys.stdout.flush()\n');
  await assert.rejects(f.execute('log-overflow', {
    ...f.request, policy: { ...f.request.policy, maxOutputBytes: 4096 }
  }), error => {
    assert.equal(error.code, 'research_process_output_limit');
    assert.ok(Buffer.byteLength(error.stdout) <= 4096);
    assert.ok(error.resourceUsage !== null); assert.ok(error.admission !== null); return true;
  });
  await f.replaceSource('import time\ntime.sleep(30)\n');
  await assert.rejects(f.execute('timeout', {
    ...f.request, policy: { ...f.request.policy, timeoutMs: 1000 }
  }), error => { assert.equal(error.code, 'research_process_timeout'); assert.ok(error.admission !== null); return true; });
});

test('actual CPU, memory and output-file monitors stop Python and retain resource receipts', async () => {
  const f = await fixture('while True:\n    pass\n');
  await assert.rejects(f.execute('cpu-limit', { ...f.request, policy: { ...f.request.policy,
    resourceLimits: { ...f.request.policy.resourceLimits, cpuTimeMs: 100 }
  } }), error => { assert.equal(error.code, 'research_process_cpu_limit'); assert.ok(error.resourceUsage.samples > 0); return true; });
  await f.replaceSource('import time\nallocation = bytearray(128 * 1024 ** 2)\ntime.sleep(30)\n');
  await assert.rejects(f.execute('memory-limit', { ...f.request, policy: { ...f.request.policy,
    resourceLimits: { ...f.request.policy.resourceLimits, maxResidentBytes: 32 * 1024 ** 2 }
  } }), error => { assert.equal(error.code, 'research_process_memory_limit'); assert.ok(error.resourceUsage.samples > 0); return true; });
  await f.replaceSource(`import os, time
import roc_experiment as roc
with open(os.path.join(roc.output_dir, "too-large.bin"), "wb") as output:
    output.write(b"x" * 8 * 1024 ** 2)
time.sleep(30)
`);
  await assert.rejects(f.execute('output-file-limit'), error => {
    assert.equal(error.code, 'research_process_write_limit'); assert.ok(error.admission !== null); return true;
  });
});

test('actual cancellation cleans TERM-ignoring Python parent, child and grandchild', async () => {
  const f = await fixture(`import os, signal, time, json
import roc_experiment as roc
signal.signal(signal.SIGTERM, signal.SIG_IGN)
parent = os.getpid()
child = os.fork()
if child == 0:
    grandchild = os.fork()
    if grandchild == 0:
        with open(os.path.join(roc.output_dir, "pids.json"), "w") as file:
            json.dump([parent, os.getppid(), os.getpid()], file)
    while True:
        time.sleep(0.01)
while True:
    time.sleep(0.01)
`);
  const controller = new AbortController();
  const execution = f.execute('cancel-tree', { ...f.request, signal: controller.signal,
    policy: { ...f.request.policy, timeoutMs: 15000 } });
  const rejected = assert.rejects(execution, error => { assert.equal(error.code, 'research_process_cancelled'); return true; });
  const deadline = Date.now() + 10000; let pids;
  while (Date.now() < deadline) {
    try { pids = JSON.parse(await readFile(join(f.outputDir, 'pids.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  try {
    assert.equal(pids?.length, 3);
    for (const pid of pids) process.kill(pid, 0);
    controller.abort(); await rejected;
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    receipts.push({ scenario: 'cancel-tree-pids', pids, allAbsent: true });
  } finally {
    controller.abort(); await rejected;
  }
});

test('changed startup report and missing first record are rejected with original actual process receipts', async () => {
  const f = await fixture('print("ACTUAL_COMPUTE", flush=True)\n');
  for (const scenario of ['report-changed', 'record-missing']) {
    let actual;
    await assert.rejects(f.execute(scenario, f.request, async request => {
      actual = await api.runResearchProcess(request);
      assert.equal(actual.exitCode, 0);
      if (scenario === 'record-missing') return { ...actual, stdout: 'ACTUAL_COMPUTE\n' };
      const newline = actual.stdout.indexOf('\n');
      const report = JSON.parse(actual.stdout.slice(0, newline));
      report.report.flags.noSite = 0;
      return { ...actual, stdout: JSON.stringify(report) + actual.stdout.slice(newline) };
    }), error => {
      assert.equal(error.code, 'research_python_startup_report_invalid');
      assert.deepEqual(error.resourceUsage, actual.resourceUsage); assert.deepEqual(error.admission, actual.admission);
      assert.match(error.stdout, /ACTUAL_COMPUTE/u); return true;
    });
  }
});

test('tampered code receipts, seed and oversized runner requests fail before dispatch', async () => {
  const f = await fixture('raise RuntimeError("MUST_NOT_RUN")\n');
  let dispatches = 0;
  const run = async () => { dispatches++; assert.fail('invalid input must not dispatch'); };
  for (const seed of [-1, 0x1_0000_0000, 1.5]) {
    await assert.rejects(f.execute('invalid-seed', { ...f.request, source: { ...f.request.source, seed } }, run));
  }
  const python = structuredClone(f.request.python);
  python.codeReceipt.metadataIdentity.controls.executableHash = 'f'.repeat(64);
  await assert.rejects(f.execute('tampered-code', { ...f.request, python }, run), /research_experiment_python_code_report_changed/u);
  await assert.rejects(f.execute('request-limit', { ...f.request, source: {
    ...f.request.source, parameters: { tooLarge: 'x'.repeat(4 * 1024 ** 2) }
  } }, run), /research_experiment_request_limit/u);
  assert.equal(dispatches, 0);
});
