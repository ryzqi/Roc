import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { ResearchPythonRuntimeStore } = await importTypeScriptModule('src/main/plugins/research/python-runtime-store.ts', { platform: 'node' });
const { downloadVerified } = await importTypeScriptModule('scripts/research/download-asset.ts', { platform: 'node' });
const pin = JSON.parse(await readFile('resources/research-runtime/python-tools.lock.json', 'utf8'));
const exec = promisify(execFile), evidence = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const signal = () => new AbortController().signal;
let root, archives, hostModule;

async function download(url, hash, target, options) {
  options.signal.throwIfAborted();
  const source = join(archives, url.includes('/uv/') ? 'uv.tar.gz' : 'python.tar.gz'), bytes = await readFile(source);
  assert.equal(bytes.length, options.expectedSize);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
  await copyFile(source, target); return target;
}
before(async () => {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  root = await realpath(await mkdtemp('/private/tmp/roc-runtime-recovery-'));
  archives = process.env.ROC_TEST_PYTHON_ARCHIVES ?? join(root, 'archives');
  if (!process.env.ROC_TEST_PYTHON_ARCHIVES) {
    await mkdir(archives);
    const python = Object.values(pin.python.downloads)[0];
    await downloadVerified(pin.uv.url, pin.uv.sha256, join(archives, 'uv.tar.gz'), { expectedSize: pin.uv.size });
    await downloadVerified(python.url, python.sha256, join(archives, 'python.tar.gz'), { expectedSize: pin.python.size });
  }
  hostModule = join(root, 'host.mjs');
  await build({ stdin: { contents: `
    import {copyFile,readFile,writeFile} from 'node:fs/promises';
    import {setTimeout as delay} from 'node:timers/promises';
    import {createHash} from 'node:crypto';
    import {join} from 'node:path';
    import {ResearchPythonRuntimeStore} from './src/main/plugins/research/python-runtime-store.ts';
    import {runPythonInstallerProcess} from './src/main/plugins/research/python-installer-process.ts';
    const [root,archives,mode,output] = process.argv.slice(2);
    const download = async (url,hash,target,options) => {
      options.signal.throwIfAborted();
      const source = join(archives,url.includes('/uv/')?'uv.tar.gz':'python.tar.gz'),bytes=await readFile(source);
      if(bytes.length!==options.expectedSize||createHash('sha256').update(bytes).digest('hex')!==hash) throw new Error('fixture_hash_mismatch');
      await copyFile(source,target); return target;
    };
    const run = async request => {
      if(mode==='concurrent'&&request.command===request.pythonExecutable) {
        await writeFile(output+'.probe',request.command);
        while(await readFile(output+'.release','utf8').catch(()=>null)!=='release') await delay(10);
      }
      if(mode==='kill-probe'&&request.command===request.pythonExecutable) {
        await writeFile(output+'.probe',request.command);
        const args=[...request.args];args[args.length-1]+=';import time;time.sleep(30)';
        return runPythonInstallerProcess({...request,args});
      }
      return runPythonInstallerProcess(request);
    };
    const value=await new ResearchPythonRuntimeStore(root,run,download).prepare('3.14.10','runtime-recovery',new AbortController().signal);
    await writeFile(output,JSON.stringify(value));
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: hostModule, logLevel: 'silent' });
});
after(async () => {
  await mkdir('.artifacts/research-toolchain-p2', { recursive: true });
  await writeFile('.artifacts/research-toolchain-p2/runtime-recovery.json', `${JSON.stringify(evidence, null, 2)}\n`);
  if (root) await rm(root, { recursive: true, force: true });
});
function host(path, mode, output) {
  const child = spawn(process.execPath, [hostModule, path, archives, mode, output], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, done: new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stderr }))) };
}
async function observeProbe(output, child) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const executable = await readFile(output + '.probe', 'utf8').catch(() => null);
    if (executable) {
      const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command=']);
      const rows = stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean);
      const probe = rows.find(row => row[4].startsWith(executable + ' -I -S -B -X utf8 -c ') && row[4].includes('time.sleep(30)'));
      if (probe) return { executable, pid: Number(probe[1]), guardPid: Number(probe[2]), group: Number(probe[3]) };
    }
    assert.equal(child.exitCode, null, 'host exited before the live probe');
    await delay(20);
  }
  assert.fail('live managed Python probe was not observed');
}
async function gone(pids) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (pids.every(pid => !alive(pid))) return;
    await delay(20);
  }
  assert.fail(`processes survived host death: ${pids.filter(alive)}`);
}

test('host SIGKILL leaves an unreceipted attempt; retry installs fresh and never adopts or deletes it', async () => {
  const managed = join(root, 'killed'), output = join(root, 'killed.json');
  const running = host(managed, 'kill-probe', output);
  let observed;
  try {
    observed = await observeProbe(output, running.child);
    assert.equal(observed.pid, observed.group);
    process.kill(observed.pid, 'SIGSTOP');
    running.child.kill('SIGKILL');
    const exit = await running.done;
    assert.equal(exit.signal, 'SIGKILL');
    await gone([observed.pid, observed.guardPid]);
    const originalBinary = await readFile(observed.executable);
    const oldAttempt = observed.executable.split('/python/')[0];
    const owner = JSON.parse(await readFile(join(oldAttempt, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, running.child.pid);
    const store = new ResearchPythonRuntimeStore(managed, undefined, download);
    const retry = await store.prepare(pin.python.version, 'retry', signal());
    assert.notEqual(retry.executable, observed.executable);
    assert.deepEqual(await readFile(observed.executable), originalBinary);
    assert.deepEqual(JSON.parse(await readFile(join(oldAttempt, 'owner.json'), 'utf8')), owner);
    assert.equal((await lstat(join(managed, `python-${pin.python.version}.json`))).isSymbolicLink(), true);
    const reused = await new ResearchPythonRuntimeStore(managed, () => { assert.fail('reuse dispatched a process'); },
      () => { assert.fail('reuse downloaded a runtime'); }).prepare(pin.python.version, 'reuse', signal());
    assert.deepEqual(reused, retry);
    assert.deepEqual(await readdir(retry.jobs), []);
    evidence.push({ scenario: 'actual-host-kill-and-fresh-retry', observed, exit, retry, descendantsAbsent: true, abandonedPrefixPreserved: true });
  } finally {
    if (alive(running.child.pid)) running.child.kill('SIGKILL');
    if (observed && alive(observed.pid)) process.kill(observed.pid, 'SIGKILL');
    await running.done;
  }
});

test('two independent hosts publish one runtime and clean only their own losing attempt', async () => {
  const managed = join(root, 'concurrent');
  const outputs = [join(root, 'concurrent-a.json'), join(root, 'concurrent-b.json')];
  const hosts = outputs.map(output => host(managed, 'concurrent', output));
  try {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const ready = await Promise.all(outputs.map(output => readFile(output + '.probe', 'utf8').catch(() => null)));
      if (ready.every(Boolean)) break;
      for (const host of hosts) assert.equal(host.child.exitCode, null, 'host exited before publication barrier');
      await delay(20);
    }
    for (const output of outputs) assert.ok(await readFile(output + '.probe', 'utf8'));
    assert.equal((await readdir(join(managed, 'attempts'))).length, 2);
    for (const output of outputs) await writeFile(output + '.release', 'release');
    const exits = await Promise.all(hosts.map(host => host.done));
    for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
    const values = await Promise.all(outputs.map(async output => JSON.parse(await readFile(output, 'utf8'))));
    assert.deepEqual(values[0], values[1]);
    const attempts = await readdir(join(managed, 'attempts'));
    assert.equal(attempts.length, 1);
    assert.deepEqual(await readdir(values[0].jobs), []);
    evidence.push({ scenario: 'independent-host-publication-race', sameRuntime: true, attemptCount: attempts.length });
  } finally {
    for (const host of hosts) if (alive(host.child.pid)) host.child.kill('SIGKILL');
    await Promise.all(hosts.map(host => host.done));
  }
});

test('unproven process cleanup preserves its owned attempt and job without publishing it', async () => {
  for (const code of ['research_process_kill_failed', 'research_process_supervision_failed', 'research_process_completion_failed']) {
    const managed = join(root, code), failure = Object.assign(new Error(code), { code });
    const store = new ResearchPythonRuntimeStore(managed, async () => { throw failure; }, download);
    await assert.rejects(store.prepare(pin.python.version, 'unproven-cleanup', signal()), error => error === failure);
    const attempts = await readdir(join(managed, 'attempts'));
    assert.equal(attempts.length, 1);
    const attempt = join(managed, 'attempts', attempts[0]);
    assert.equal(JSON.parse(await readFile(join(attempt, 'owner.json'), 'utf8')).pid, process.pid);
    assert.equal((await readdir(join(attempt, 'jobs'))).length, 1);
    await assert.rejects(lstat(join(managed, `python-${pin.python.version}.json`)), { code: 'ENOENT' });
    evidence.push({ scenario: 'unproven-process-cleanup', code, preserved: true, published: false });
  }
});
