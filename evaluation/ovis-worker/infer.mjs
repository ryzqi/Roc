/** Qualify real 8-bit inference under the production supervisor. No parser adoption. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const [installationArgument, outputArgument] = process.argv.slice(2);
assert.ok(installationArgument && outputArgument, 'usage: node evaluation/ovis-worker/infer.mjs INSTALLATION NEW_OUTPUT_DIRECTORY');
const exec = promisify(execFile), root = await realpath(process.cwd());
const installation = await realpath(resolve(installationArgument)), output = resolve(outputArgument);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256 = async path => {
  const value = createHash('sha256');
  for await (const bytes of createReadStream(path)) value.update(bytes);
  return value.digest('hex');
};
const pin = JSON.parse(await readFile('evaluation/ovis-pytorch-reference/parity.json', 'utf8'));
const paired = JSON.parse(await readFile('evaluation/ovis-evaluator/paired-inference.json', 'utf8'));
const receiptBytes = await readFile(join(installation, 'receipt.json'));
assert.equal(hash(receiptBytes), pin.installationReceiptSha256);
const receipt = JSON.parse(receiptBytes), script = join(root, paired.inferenceScriptPath);
assert.equal(await sha256(script), paired.inferenceScriptSha256);
const python = join(installation, 'runtime/bin/python'), base = await realpath(receipt.python.basePrefix);
assert.equal(await realpath(python), await realpath(receipt.python.executable));
assert.equal(await sha256(receipt.python.executable), receipt.python.executableSha256);
assert.equal(await sha256(receipt.python.sharedLibrary), receipt.python.sharedLibrarySha256);
// Two identical inputs in one process prove model reuse and deterministic replay.
const chosen = pin.pages.find(page => page.id === 'science-charts-captions');
assert.ok(chosen);
const image = await realpath(join(root, chosen.image));
assert.equal(await sha256(image), chosen.sha256);
const pages = ['first', 'reused'].map(id => ({ id, image, sha256: chosen.sha256 }));
const { runResearchProcess, ResearchProcessError } = await importTypeScriptModule('src/main/plugins/research/process-runner.ts', { platform: 'node' });
const { captureNativeCode } = await importTypeScriptModule('src/main/plugins/research/experiment-native-code.ts', { platform: 'node' });
const controller = new AbortController(), cancel = () => controller.abort(new Error('qualification_cancelled'));
process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
const codeRoots = [base, join(installation, 'runtime')];
const before = await captureNativeCode(codeRoots, controller.signal);
await mkdir(output); // Never overwrite prior evidence.
const job = await realpath(await mkdtemp('/private/tmp/roc-ovis-full-worker-'));
const cacheParent = (await exec('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'])).stdout.trim();
const metalCache = await realpath(await mkdtemp(join(cacheParent, 'roc-ovis-metal-')));
let safeToClean = true;
const report = { schemaVersion: 1, status: 'running', automaticAdoption: false, performanceQualification: false,
  hostLoad: 'mixed-host-load', installationReceiptSha256: hash(receiptBytes), runtimeCodeHash: before.hash,
  scriptSha256: await sha256(fileURLToPath(import.meta.url)), inferenceScriptSha256: await sha256(script),
  processRunnerSha256: await sha256(join(root, 'src/main/plugins/research/process-runner.ts')),
  metalCache, cachePolicy: 'private Darwin cache suffix; scoped compiler extensions; monitored byte/file limits',
  limits: { rssBytes: 6 * 1024 ** 3, mlxGuidelineBytes: 4 * 1024 ** 3, mlxHardLimit: false },
  scenarios: [] };
const errorDetails = error => ({ message: error.message, code: error.code, stdout: error.stdout,
  stderr: error.stderr, resourceUsage: error.resourceUsage, admission: error.admission });

async function pressure() {
  const { stdout } = await exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']);
  assert.equal(stdout.trim(), '1', 'macOS memory pressure must remain normal');
}

async function scenario(name, { cancelOnTokens = false, lowMemory = false } = {}) {
  await pressure();
  controller.signal.throwIfAborted();
  const scratch = join(job, name); await mkdir(scratch);
  const manifest = join(scratch, 'pages.json'), marker = join(scratch, 'worker.json'), resultPath = join(scratch, 'output');
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, pages }));
  const local = new AbortController(), relay = () => local.abort(controller.signal.reason);
  controller.signal.addEventListener('abort', relay, { once: true });
  const site = join(installation, 'runtime/lib/python3.14/site-packages');
  const bootstrap = `import ctypes, json, os, runpy, sys\nfrom pathlib import Path\n` +
    `Path(${JSON.stringify(marker)}).write_text(json.dumps({"pid": os.getpid()}))\n` +
    `lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib')\nlib._set_user_dir_suffix.argtypes=[ctypes.c_char_p]\n` +
    `lib._set_user_dir_suffix.restype=ctypes.c_int\nassert lib._set_user_dir_suffix(${JSON.stringify(basename(metalCache))}.encode()) == 1\n` +
    `sys.path.insert(0, ${JSON.stringify(site)})\nimport mlx.core as mx\n` +
    `assert mx.metal.is_available()\nmx.set_default_device(mx.gpu)\n` +
    `mx.set_memory_limit(${report.limits.mlxGuidelineBytes})\nmx.set_cache_limit(64 * 1024**2)\n` +
    `sys.argv = ${JSON.stringify([script, '--installation', installation, '--variant', '8bit', '--pages', manifest,
      '--output', resultPath, '--offline-worker'])}\nrunpy.run_path(${JSON.stringify(script)}, run_name="__main__")\n`;
  const request = { command: python, args: ['-I', '-S', '-B', '-X', 'utf8', '-c', bootstrap],
    cwd: scratch, readablePaths: [...codeRoots, join(installation, 'receipt.json'), join(installation, 'spec'),
      join(installation, 'model-8bit'), join(installation, 'source/prompts/document_structured.txt'),
      join(installation, 'source/generation_config.json'), script, image, '/usr/lib', '/System/Library'],
    writablePaths: [scratch, metalCache], environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: scratch, TMPDIR: scratch,
      HF_HOME: scratch, XDG_CACHE_HOME: scratch, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
      TOKENIZERS_PARALLELISM: 'false', DO_NOT_TRACK: '1' },
    timeoutMs: 600_000, terminationGraceMs: 2000,
    resourceLimits: { mode: 'monitored', cpuTimeMs: 600_000, maxResidentBytes: lowMemory ? 128 * 1024 ** 2 : report.limits.rssBytes },
    admission: { projectId: `ovis-worker-${name}`, priority: 'user', resourceClass: 'parse' },
    allowGpuAcceleration: true, metalCompilerCachePath: metalCache, networkAccess: 'none', signal: local.signal,
    writeLimits: [{ path: scratch, maxFileBytes: 32 * 1024 ** 2, maxTotalBytes: 128 * 1024 ** 2, maxFiles: 200, maxEntries: 400 },
      { path: metalCache, maxFileBytes: 64 * 1024 ** 2, maxTotalBytes: 128 * 1024 ** 2, maxFiles: 500, maxEntries: 1000 }] };
  let finished = false, cancelledDuringTokens = false, monitorError;
  const monitor = (async () => {
    try {
      while (!finished) {
        await pressure();
        if (cancelOnTokens && !cancelledDuringTokens) {
          const size = (await stat(join(resultPath, 'first.raw.txt')).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          }))?.size ?? 0;
          if (size >= 256) { cancelledDuringTokens = true; local.abort(new Error('cancel_during_generation')); }
        }
        if (!finished) await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch (error) { monitorError = error; local.abort(error); }
  })();
  const row = { name, expected: cancelOnTokens ? 'research_process_cancelled' : lowMemory ? 'research_process_memory_limit' : 'completed',
    request: { ...request, signal: undefined } };
  report.scenarios.push(row);
  try {
    try { row.result = await runResearchProcess(request); }
    catch (error) {
      row.error = errorDetails(error);
      if (error instanceof ResearchProcessError && ['research_process_kill_failed', 'research_process_supervision_failed',
        'research_process_completion_failed'].includes(error.code)) safeToClean = false;
    }
  } finally {
    finished = true; await monitor;
    controller.signal.removeEventListener('abort', relay);
    row.cancelledDuringTokens = cancelledDuringTokens;
    await cp(scratch, join(output, name), { recursive: true, errorOnExist: true, force: false });
  }
  if (monitorError) throw monitorError;
  controller.signal.throwIfAborted();
  const { pid } = JSON.parse(await readFile(marker, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'worker must have exited');
  row.workerExited = true;
  if (row.expected === 'completed') {
    assert.equal(row.error, undefined, JSON.stringify(row.error));
    assert.equal(row.result.exitCode, 0, row.result.stderr);
    const inference = JSON.parse(await readFile(join(resultPath, 'report.json'), 'utf8'));
    assert.equal(inference.status, 'completed');
    assert.deepEqual(inference.pages.map(page => page.id), ['first', 'reused']);
    assert.ok(inference.pages.every(page => page.valid && page.termination.eosObserved));
    assert.equal(inference.pages[0].rawSha256, inference.pages[1].rawSha256);
    row.modelLoadSeconds = inference.loadSeconds;
    row.pageSeconds = inference.pages.map(page => page.seconds);
    row.sameProcessModelReuse = true;
  } else {
    assert.equal(row.error?.code, row.expected, JSON.stringify(row));
    if (cancelOnTokens) assert.ok(cancelledDuringTokens, 'cancellation must occur after generated bytes');
  }
  row.passed = true;
  console.log(JSON.stringify({ name, passed: true }));
}

try {
  await scenario('complete-and-reuse');
  await scenario('cancel-generation', { cancelOnTokens: true });
  await scenario('memory-boundary', { lowMemory: true });
  await scenario('restart-after-failures');
  assert.equal((await captureNativeCode(codeRoots, controller.signal)).hash, before.hash);
  assert.equal(await sha256(script), paired.inferenceScriptSha256);
  assert.equal(await sha256(join(installation, 'receipt.json')), pin.installationReceiptSha256);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = errorDetails(error); process.exitCode = 1;
} finally {
  if (safeToClean) {
    await rm(job, { recursive: true, force: true });
    await rm(metalCache, { recursive: true, force: true });
  } else { report.preservedJob = job; report.preservedMetalCache = metalCache; }
  process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, output, error: report.error?.message }));
}
