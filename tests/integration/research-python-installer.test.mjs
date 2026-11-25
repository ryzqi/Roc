import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const exec = promisify(execFile);
const { runPythonInstallerProcess: run } = await importTypeScriptModule('src/main/plugins/research/python-installer-process.ts', { platform: 'node' });
const { runResearchProcess } = await importTypeScriptModule('src/main/plugins/research/process-runner.ts', { platform: 'node' });
const { downloadVerified } = await importTypeScriptModule('scripts/research/download-asset.ts', { platform: 'node' });
const { extractToolArchive } = await importTypeScriptModule('scripts/research/archive-utils.ts', { platform: 'node' });
const pin = JSON.parse(await readFile('resources/research-runtime/python-tools.lock.json', 'utf8'));
const receipts = [];
let root, managed, cache, job, scratch, uv, python, environment, hostModule, archive;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function gone(pids) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (pids.every(pid => !alive(pid))) return;
    await delay(20);
  }
  assert.fail(`processes survived: ${pids.filter(alive)}`);
}
const base = () => ({ command: uv, cwd: job, readablePaths: [job, managed], writablePaths: [cache, scratch], environment,
  projectId: 'installer-integration', network: 'none', managedPythonRoot: managed, timeoutMs: 30_000 });
const common = () => ['--python', pin.python.key, '--no-build', '--no-config', '--no-python-downloads'];
const syncFlags = ['--locked', '--no-install-project', '--no-install-workspace', '--no-default-groups', '--link-mode', 'copy'];

before(async () => {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  root = await realpath(await mkdtemp('/private/tmp/roc-installer-integration-'));
  managed = join(root, 'python'); cache = join(root, 'cache'); job = join(root, 'jobs', 'test'); scratch = join(job, 'scratch');
  const uvRoot = join(root, 'tools', `uv-${pin.uv.version}`); uv = join(uvRoot, 'uv'); archive = join(job, 'python.tar.gz');
  for (const path of [managed, cache, scratch, uvRoot]) await mkdir(path, { recursive: true });
  if (process.env.ROC_TEST_PYTHON_UV) await copyFile(process.env.ROC_TEST_PYTHON_UV, uv);
  else {
    const uvArchive = join(job, 'uv.tar.gz'), extracted = join(job, 'uv-extracted');
    await downloadVerified(pin.uv.url, pin.uv.sha256, uvArchive, { expectedSize: pin.uv.size });
    await extractToolArchive(uvArchive, extracted); await copyFile(join(extracted, pin.uv.member), uv);
  }
  if (process.env.ROC_TEST_PYTHON_ARCHIVE) await copyFile(process.env.ROC_TEST_PYTHON_ARCHIVE, archive);
  else {
    const spec = Object.values(pin.python.downloads)[0];
    await downloadVerified(spec.url, spec.sha256, archive, { expectedSize: pin.python.size });
  }
  environment = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: scratch, UV_CACHE_DIR: cache,
    UV_PYTHON_INSTALL_DIR: managed, UV_PYTHON_INSTALL_BIN: '0' };
  const source = join(job, 'downloads.json');
  await writeFile(source, JSON.stringify(Object.fromEntries(Object.entries(pin.python.downloads).map(([key, value]) => [key, { ...value, url: pathToFileURL(archive).href }]))));
  const version = await run({ ...base(), args: ['--version'] });
  assert.equal(version.exitCode, 0); assert.match(version.stdout, /^uv 0\.13\.9 /);
  const installed = await run({ ...base(), args: ['python', 'install', pin.python.key, '--python-downloads-json-url', pathToFileURL(source).href,
    '--install-dir', managed, '--no-bin', '--no-config', '--offline'], writablePaths: [managed, cache, scratch] });
  assert.equal(installed.exitCode, 0, installed.stderr);
  python = join(managed, pin.python.key, pin.python.executable.path);
  receipts.push({ scenario: 'pinned-runtime-offline-install', version, installed });
  hostModule = join(job, 'host.mjs');
  await build({ stdin: { contents: `import {runPythonInstallerProcess} from './src/main/plugins/research/python-installer-process.ts';
    await runPythonInstallerProcess(JSON.parse(process.argv[2]));`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: hostModule, logLevel: 'silent' });
});
after(async () => {
  const output = join(process.cwd(), '.artifacts/research-toolchain-p2');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'installer-boundary.json'), `${JSON.stringify({ actualUv: pin.uv.version, actualPython: pin.python.version,
    registryDomainPolicy: 'fixed CLI index and validated dependencies; Seatbelt does not filter domains', receipts }, null, 2)}\n`);
  if (root) await rm(root, { recursive: true, force: true });
});

async function workspace(name) {
  const path = join(root, name); await mkdir(join(path, '.venv'), { recursive: true }); return path;
}
const venvRequest = path => ({ ...base(), cwd: path, args: ['venv', '--no-project', '--no-config', '--no-python-downloads', '--python', pin.python.key, join(path, '.venv')],
  pythonExecutable: python, readablePaths: [managed, path], writablePaths: [join(path, '.venv'), cache, scratch] });

async function watchUvProbe(onProbe, stop) {
  while (!stop.value) {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command=']);
    const rows = stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean);
    const child = rows.find(row => row[4].startsWith(`${python} -I -B -c `));
    if (child) {
      const parent = rows.find(row => row[1] === child[2] && row[4].startsWith(`${uv} venv `));
      if (parent) {
        const observation = { uvPid: Number(parent[1]), uvGroup: Number(parent[3]), pythonPid: Number(child[1]), pythonGroup: Number(child[3]),
          isolatedProbe: child[4].includes(' -I -B -c '), siteDisabled: child[4].includes(' -S ') };
        assert.equal(observation.pythonGroup, observation.uvGroup);
        assert.equal(observation.uvPid, observation.uvGroup);
        await onProbe(observation); return observation;
      }
    }
    await delay(2);
  }
  throw new Error('uv_probe_not_observed');
}
async function clearInterpreterCache() {
  // This root belongs entirely to this test; force a genuine interpreter query.
  await rm(cache, { recursive: true, force: true }); await mkdir(cache);
}

test('actual uv venv uses exact managed key, executes a same-group Python probe and installs only registry wheels', async () => {
  const path = await workspace('project');
  const stop = { value: false }, observation = watchUvProbe(() => {}, stop);
  const venv = await run(venvRequest(path)); stop.value = true;
  const subprocess = await observation;
  assert.equal(venv.exitCode, 0, venv.stderr);
  const cfg = await readFile(join(path, '.venv', 'pyvenv.cfg'), 'utf8');
  await assert.rejects(run(venvRequest(path)), /venv_not_empty/);
  assert.equal(await readFile(join(path, '.venv', 'pyvenv.cfg'), 'utf8'), cfg);
  assert.match(cfg, /version_info = 3\.14\.10/); assert.ok(cfg.includes(join(managed, pin.python.key, 'bin')));
  const staging = join(job, 'project'); await mkdir(staging);
  await writeFile(join(staging, 'pyproject.toml'), '[project]\nname = "installer-boundary"\nversion = "0.0.0"\nrequires-python = ">=3.14,<3.15"\ndependencies = ["packaging==25.0"]\n');
  await writeFile(join(staging, '.python-version'), `${pin.python.version}\n`);
  const lock = await run({ ...base(), cwd: staging, args: ['lock', ...common(), '--project', staging], pythonExecutable: python,
    readablePaths: [managed, staging], writablePaths: [staging, cache, scratch], network: 'registry', timeoutMs: 120_000 });
  assert.equal(lock.exitCode, 0, lock.stderr);
  for (const file of ['pyproject.toml', '.python-version', 'uv.lock']) await copyFile(join(staging, file), join(path, file));
  const syncRequest = { ...base(), cwd: path, args: ['sync', ...common(), '--project', path, ...syncFlags], pythonExecutable: python,
    readablePaths: [managed, path], writablePaths: [join(path, '.venv'), cache, scratch], network: 'registry', timeoutMs: 120_000 };
  const sync = await run(syncRequest); assert.equal(sync.exitCode, 0, sync.stderr);
  const unchanged = await readFile(join(path, 'uv.lock'), 'utf8');
  const offline = await run({ ...syncRequest, network: 'none', args: [...syncRequest.args, '--offline', '--check'] });
  assert.equal(offline.exitCode, 0, offline.stderr); assert.equal(await readFile(join(path, 'uv.lock'), 'utf8'), unchanged);
  const output = await run({ ...base(), command: python, pythonExecutable: python, args: ['-I', '-S', '-B', '-X', 'utf8', '-c',
    'import sys;sys.path.insert(0,sys.argv[1]);import packaging;print(packaging.__version__)', join(path, '.venv/lib/python3.14/site-packages')], readablePaths: [managed, path, job], writablePaths: [scratch] });
  assert.equal(output.exitCode, 0, output.stderr); assert.equal(output.stdout.trim(), '25.0');
  receipts.push({ scenario: 'venv-registry-wheel-offline-reuse', subprocess, venv, lock, sync, offline, output });
});

for (const scenario of ['cancelled', 'timeout', 'host-death']) {
  test(`actual uv interpreter descendant is reaped after ${scenario}`, async () => {
    await clearInterpreterCache();
    const path = await workspace(scenario), request = venvRequest(path), stop = { value: false };
    const controller = new AbortController();
    let host, observed;
    const observation = watchUvProbe(async found => {
      observed = found;
      // Freeze both real processes at the inspection boundary so the test cannot
      // accidentally pass after uv already completed without a live descendant.
      process.kill(found.pythonPid, 'SIGSTOP'); process.kill(found.uvPid, 'SIGSTOP');
      if (scenario === 'cancelled') controller.abort();
      if (scenario === 'host-death') process.kill(host.pid, 'SIGKILL');
    }, stop);
    try {
      if (scenario === 'host-death') {
        host = spawn(process.execPath, [hostModule, JSON.stringify(request)], { stdio: 'ignore' });
        const completion = new Promise(resolve => host.once('close', resolve));
        await observation; await completion;
      } else {
        await assert.rejects(run({ ...request, signal: controller.signal, timeoutMs: scenario === 'timeout' ? 2000 : 30_000 }),
          error => error.code === `research_process_${scenario}`);
        await observation;
      }
      await gone([observed.uvPid, observed.pythonPid]);
      receipts.push({ scenario, ...observed, descendantsAbsent: true });
    } finally {
      stop.value = true;
      await observation.catch(() => {});
      if (observed) for (const pid of [observed.uvPid, observed.pythonPid]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      if (host && alive(host.pid)) host.kill('SIGKILL');
    }
  });
}

test('direct Python probe blocks external executables, process-group escapes, network and inherited credentials', async () => {
  const script = `import os,socket,subprocess,json\nresult={}\nfor name,fn in [('setsid',os.setsid),('shell',lambda:subprocess.run(['/bin/sh','-c','exit 0'],check=True)),('network',lambda:socket.create_connection(('1.1.1.1',443),1))]:\n try: fn();result[name]=False\n except OSError: result[name]=True\nresult['credential']='OPENAI_API_KEY' in os.environ\nprint(json.dumps(result))`;
  const probe = await run({ ...base(), command: python, pythonExecutable: python, args: ['-I', '-S', '-B', '-X', 'utf8', '-c', script], writablePaths: [scratch] });
  assert.equal(probe.exitCode, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), { setsid: true, shell: true, network: true, credential: false });
  await assert.rejects(run({ ...base(), args: ['--version'], environment: { ...environment, PYTHONPATH: '/untrusted' } }), /environment_invalid/);
  const ordinary = await runResearchProcess({ command: python, args: ['-I', '-S', '-B', '-X', 'utf8', '-c', script], cwd: job,
    readablePaths: [managed, job, '/usr/lib', '/System/Library'], writablePaths: [scratch], environment: { PATH: '/usr/bin:/bin' },
    timeoutMs: 10_000, resourceLimits: { mode: 'monitored', cpuTimeMs: 5000, maxResidentBytes: 256 * 1024 ** 2 },
    admission: { projectId: 'installer-integration', priority: 'user', resourceClass: 'utility' }, allowGpuAcceleration: false, networkAccess: 'none',
    writeLimits: [{ path: scratch, maxFileBytes: 1024 ** 2, maxTotalBytes: 4 * 1024 ** 2, maxFiles: 100, maxEntries: 200 }] });
  assert.equal(ordinary.exitCode, 0, ordinary.stderr); assert.deepEqual(JSON.parse(ordinary.stdout), JSON.parse(probe.stdout));
  receipts.push({ scenario: 'probe-and-ordinary-denials', probe, ordinary });
});
