import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let api;
before(async () => {api = await importTypeScriptModule('src/main/plugins/research/ovis-model-store.ts', {platform: 'node'});});
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const parent = await mkdtemp('/private/tmp/roc-ovis-store-test-'), root = join(parent, 'installed'), pythonBase = join(parent, 'python');
  await mkdir(root); await mkdir(pythonBase);
  for (const area of ['model-8bit', 'runtime', 'spec', 'tools']) await mkdir(join(root, area));
  const executable = join(pythonBase, 'python'), sharedLibrary = join(pythonBase, 'libpython.dylib'), inferenceScript = join(parent, 'infer.py');
  await writeFile(executable, 'python'); await writeFile(sharedLibrary, 'library'); await writeFile(inferenceScript, '# inference');
  await symlink(executable, join(root, 'runtime/python'));
  await writeFile(join(root, 'model-8bit/weights'), 'weights');
  const revision = '702a71f233a208be050b12779ee29fdd1eb2dab3';
  await writeFile(join(root, 'spec/prequantized.lock.json'), JSON.stringify({model: {revision}}));
  const files = {};
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), info = await lstat(path), mode = info.mode & 0o7777, key = relative(root, path);
      if (info.isSymbolicLink()) files[key] = {type: 'symlink', mode, target: await readlink(path)};
      else if (info.isDirectory()) {files[key] = {type: 'directory', mode}; await visit(path);}
      else files[key] = {type: 'file', mode, size: info.size, sha256: hash(await readFile(path))};
    }
  }
  await visit(root);
  const receipt = {schemaVersion: 2, status: 'installed', files,
    python: {basePrefix: pythonBase, executable, executableSha256: hash('python'), sharedLibrary, sharedLibrarySha256: hash('library'),
      pythonVersion: '3.14.10', implementation: 'cpython', machine: 'arm64', freeThreaded: false},
    dependencies: {mlx: '0.32.5', 'mlx-vlm': '0.8.1'}, model: {repository: 'fwgpiyawudk/OvisOCR3-mlx-8bit', revision, quantization: {bits: 8, group_size: 64, mode: 'affine'},
      visionDtype: 'bfloat16', visionTensors: 153, quantizedLanguageModules: 187}};
  const receiptBytes = Buffer.from(JSON.stringify(receipt)); await writeFile(join(root, 'receipt.json'), receiptBytes);
  const identity = {engine: 'ovisocr3-mlx', revision, quantization: '8bit', groupSize: 64, visionPrecision: 'bfloat16', device: 'metal',
    installationReceiptSha256: hash(receiptBytes), inferenceSha256: hash('# inference'),
    promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'};
  return {parent, root, receipt, input: {root, pythonBase, inferenceScript, identity},
    cleanup: () => rm(parent, {recursive: true, force: true})};
}

test('integrity inspection verifies all recorded bytes and never implies quality qualification', async () => {
  const f = await fixture();
  try {
    const result = await api.inspectOvisInstallation(f.input, new AbortController().signal);
    assert.equal(result.entries, Object.keys(f.receipt.files).length);
    assert.equal(result.bytes, Object.values(f.receipt.files).reduce((n,e) => n + (e.size ?? 0), 0));
    assert.equal(result.qualityQualified, false); assert.deepEqual(result.installation, f.input);
  } finally {await f.cleanup();}
});

test('changed, omitted, extra and symlinked installed bytes are rejected without repair', async () => {
  for (const mode of ['weights', 'extra', 'missing', 'link', 'receipt', 'python', 'library', 'inference']) {
    const f = await fixture();
    try {
      if (mode === 'weights') await writeFile(join(f.root, 'model-8bit/weights'), 'changed');
      if (mode === 'extra') await writeFile(join(f.root, 'runtime/extra.py'), 'pass');
      if (mode === 'missing') await rm(join(f.root, 'model-8bit/weights'));
      if (mode === 'link') {await rm(join(f.root, 'runtime/python')); await symlink(f.input.inferenceScript, join(f.root, 'runtime/python'));}
      if (mode === 'receipt') await writeFile(join(f.root, 'receipt.json'), '{}');
      if (mode === 'python') await writeFile(f.receipt.python.executable, 'changed');
      if (mode === 'library') await writeFile(f.receipt.python.sharedLibrary, 'changed');
      if (mode === 'inference') await writeFile(f.input.inferenceScript, 'changed');
      await assert.rejects(api.inspectOvisInstallation(f.input, new AbortController().signal), /research_ovis_/u, mode);
    } finally {await f.cleanup();}
  }
});

test('status reads only the pinned receipt and directories; loading still rejects changed model bytes', async () => {
  const f = await fixture();
  try {
    const signal = new AbortController().signal;
    const status = await api.readOvisInstallationStatus(f.input, signal);
    assert.deepEqual(status.identity, f.input.identity);
    assert.equal(status.bytes, Object.values(f.receipt.files).reduce((n, e) => n + (e.size ?? 0), 0));
    // Model contents are deliberately outside the lightweight status contract.
    await writeFile(join(f.root, 'model-8bit/weights'), 'changed');
    assert.deepEqual(await api.readOvisInstallationStatus(f.input, signal), status);
    await assert.rejects(api.inspectOvisInstallation(f.input, signal), /research_ovis_/u);
    await writeFile(join(f.root, 'receipt.json'), '{}');
    await assert.rejects(api.readOvisInstallationStatus(f.input, signal), /research_ovis_/u);
  } finally {await f.cleanup();}
});

test('acquisition reserves before inspection, releases once and unwinds failures/cancellation', async () => {
  const f = await fixture();
  try {
    const store = new api.OvisModelStore(f.input), signal = new AbortController().signal;
    const pending = store.acquire(signal); assert.equal(store.busy, true);
    const a = await pending, b = await store.acquire(signal);
    a.release(); a.release(); assert.equal(store.busy, true);
    b.release(); assert.equal(store.busy, false);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(store.acquire(controller.signal)); assert.equal(store.busy, false);
    await writeFile(join(f.root, 'runtime/extra.py'), 'pass');
    await assert.rejects(store.acquire(signal)); assert.equal(store.busy, false);
  } finally {await f.cleanup();}
});

test('malformed inventories and external runtime roots fail even with a caller-pinned receipt', async () => {
  for (const mode of ['traversal', 'external', 'revision']) {
    const f = await fixture();
    try {
      if (mode === 'traversal') f.receipt.files['../outside'] = {type: 'file', mode: 420, size: 0, sha256: hash('')};
      if (mode === 'external') f.receipt.python.executable = f.input.inferenceScript;
      if (mode === 'revision') {
        const path = join(f.root, 'spec/prequantized.lock.json'), bytes = Buffer.from(JSON.stringify({model: {revision: 'bad'}}));
        await writeFile(path, bytes); f.receipt.files['spec/prequantized.lock.json'] = {...f.receipt.files['spec/prequantized.lock.json'], size: bytes.length, sha256: hash(bytes)};
      }
      const bytes = Buffer.from(JSON.stringify(f.receipt)); await writeFile(join(f.root, 'receipt.json'), bytes);
      f.input.identity.installationReceiptSha256 = hash(bytes);
      await assert.rejects(api.inspectOvisInstallation(f.input, new AbortController().signal), /research_ovis_/u);
    } finally {await f.cleanup();}
  }
});
