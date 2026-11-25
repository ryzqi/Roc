/** Exercise the production process supervisor and deny-default sandbox with MLX.
 * This is a P3 runtime qualification probe, not a parser or model quality gate.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const [installationArgument, outputArgument] = process.argv.slice(2);
assert.ok(installationArgument && outputArgument, 'usage: node evaluation/ovis-worker/probe.mjs INSTALLATION OUTPUT_JSON');
const installation = await realpath(resolve(installationArgument)), output = resolve(outputArgument);
const receiptBytes = await readFile(join(installation, 'receipt.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256 = async path => {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
};
const pin = JSON.parse(await readFile('evaluation/ovis-pytorch-reference/parity.json', 'utf8'));
assert.equal(hash(receiptBytes), pin.installationReceiptSha256, 'frozen installation receipt');
const receipt = JSON.parse(receiptBytes);
const python = join(installation, 'runtime/bin/python');
assert.equal(await realpath(python), await realpath(receipt.python.executable));
assert.equal(await sha256(receipt.python.executable), receipt.python.executableSha256);
assert.equal(await sha256(receipt.python.sharedLibrary), receipt.python.sharedLibrarySha256);

async function verifyRuntime() {
  const expected = Object.entries(receipt.files).filter(([name]) => name === 'runtime' || name.startsWith('runtime/'));
  const actual = [];
  async function walk(path) {
    actual.push(path.slice(installation.length + 1).split(sep).join('/'));
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink()) for (const name of (await readdir(path)).sort()) await walk(join(path, name));
  }
  await walk(join(installation, 'runtime'));
  assert.deepEqual(actual.sort(), expected.map(([name]) => name).sort(), 'runtime file set');
  for (const [name, entry] of expected) {
    assert.ok(!isAbsolute(name) && !name.split('/').includes('..'));
    const path = join(installation, name), info = await lstat(path);
    assert.equal(info.mode & 0o7777, entry.mode, name);
    if (entry.type === 'directory') assert.ok(info.isDirectory() && !info.isSymbolicLink(), name);
    else if (entry.type === 'symlink') {
      assert.ok(info.isSymbolicLink(), name);
      assert.equal(await readlink(path), entry.target, name);
      const target = await realpath(path);
      assert.ok(target.startsWith(`${installation}/runtime/`) || target === await realpath(receipt.python.executable), name);
    } else {
      assert.ok(info.isFile() && info.nlink === 1, name);
      assert.equal(info.size, entry.size, name);
      assert.equal(await sha256(path), entry.sha256, name);
    }
  }
}

const { runResearchProcess } = await importTypeScriptModule('src/main/plugins/research/process-runner.ts', { platform: 'node' });
const { captureNativeCode } = await importTypeScriptModule('src/main/plugins/research/experiment-native-code.ts', { platform: 'node' });
await verifyRuntime();
const controller = new AbortController();
const cancel = () => controller.abort(new Error('probe_cancelled'));
process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
const base = await realpath(receipt.python.basePrefix);
const codeBefore = await captureNativeCode([base, join(installation, 'runtime')], controller.signal);
const job = await realpath(await mkdtemp('/private/tmp/roc-ovis-sandbox-'));
const denied = await realpath(await mkdtemp('/private/tmp/roc-ovis-denied-'));
await writeFile(join(denied, 'input.txt'), 'private fixture');
const listener = createServer(socket => socket.destroy());
let connections = 0;
listener.on('connection', () => { connections += 1; });
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
const port = listener.address().port;
const site = join(installation, 'runtime/lib/python3.14/site-packages');
const report = { schemaVersion: 1, status: 'running', installationReceiptSha256: hash(receiptBytes),
  runtimeCodeHash: codeBefore.hash, scriptSha256: await sha256(new URL(import.meta.url)), observations: [] };
const bootstrap = `import sys\nsys.path.insert(0, ${JSON.stringify(site)})\n`;
const boundaries = `
import ctypes, errno, json, os, socket, subprocess
from pathlib import Path
denied = Path(${JSON.stringify(denied)})
def refuses(name, operation):
    try:
        operation()
    except OSError as error:
        if error.errno not in (errno.EPERM, errno.EACCES):
            raise
        return {"name": name, "errno": error.errno}
    raise RuntimeError("sandbox_allowed_" + name)
checks = [
    refuses("outside_read", lambda: (denied / "input.txt").read_bytes()),
    refuses("outside_write", lambda: (denied / "output.txt").write_bytes(b"bad")),
    refuses("network", lambda: socket.create_connection(("127.0.0.1", ${port}), timeout=1)),
    refuses("unapproved_exec", lambda: subprocess.run(["/bin/sh", "-c", "exit 99"], check=True)),
    refuses("setsid", os.setsid),
    refuses("setpgid", lambda: os.setpgid(0, 0)),
]
Path("allowed.txt").write_text("allowed job write")
print(json.dumps({"checks": checks}), flush=True)
`;
const metal = `
import json
import mlx.core as mx
assert mx.metal.is_available(), "metal_unavailable"
mx.set_default_device(mx.gpu)
mx.set_memory_limit(256 * 1024**2)
mx.set_cache_limit(16 * 1024**2)
value = mx.arange(1024, dtype=mx.float32)
result = mx.sum(value * value)
mx.eval(result)
mx.synchronize()
assert result.item() == 357389824.0, result.item()
print(json.dumps({"value": result.item(), "device": mx.device_info(), "peakMlxMemoryBytes": mx.get_peak_memory(),
                  "memoryGuidelineBytes": mx.get_memory_limit(), "memoryIsHardLimit": False}), flush=True)
`;
async function execute(name, source, gpu) {
  const scratch = join(job, name); await mkdir(scratch);
  const result = await runResearchProcess({ command: python, args: ['-I', '-S', '-B', '-X', 'utf8', '-c', bootstrap + source],
    cwd: scratch, readablePaths: [base, join(installation, 'runtime'), '/usr/lib', '/System/Library'],
    writablePaths: [scratch], environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: scratch, TMPDIR: scratch,
      HF_HOME: scratch, XDG_CACHE_HOME: scratch, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
      TOKENIZERS_PARALLELISM: 'false', DO_NOT_TRACK: '1' },
    timeoutMs: 30_000, resourceLimits: { mode: 'monitored', cpuTimeMs: 30_000, maxResidentBytes: 1024 ** 3 },
    admission: { projectId: 'ovis-p3-sandbox', priority: 'user', resourceClass: 'parse' },
    allowGpuAcceleration: gpu, networkAccess: 'none', signal: controller.signal,
    writeLimits: [{ path: scratch, maxFileBytes: 32 * 1024 ** 2, maxTotalBytes: 64 * 1024 ** 2, maxFiles: 100, maxEntries: 200 }] });
  report.observations.push({ name, gpu, ...result });
  return result;
}
try {
  const boundary = await execute('boundaries', boundaries, true);
  assert.equal(boundary.exitCode, 0, boundary.stderr);
  assert.equal(JSON.parse(boundary.stdout).checks.length, 6);
  assert.equal(connections, 0);
  const negative = await execute('ordinary-no-metal', metal, false);
  assert.notEqual(negative.exitCode, 0, 'ordinary Python must not access Metal');
  const positive = await execute('worker-metal', metal, true);
  assert.equal(positive.exitCode, 0, positive.stderr);
  assert.equal(JSON.parse(positive.stdout).value, 357389824);
  await verifyRuntime();
  assert.equal((await captureNativeCode([base, join(installation, 'runtime')], controller.signal)).hash, codeBefore.hash);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, code: error.code, stdout: error.stdout, stderr: error.stderr };
  process.exitCode = 1;
} finally {
  await new Promise(resolve => listener.close(resolve));
  await rm(job, { recursive: true, force: true });
  await rm(denied, { recursive: true, force: true });
  process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, output, error: report.error?.message }));
}
