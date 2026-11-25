import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, realpath, readFile, readdir, rm, writeFile, copyFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/main/plugins/research/python-runtime-store.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { ResearchPythonRuntimeStore } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
let root, store, runtime;
before(async () => {
  root = await realpath(await mkdtemp('/private/tmp/roc-python-store-'));
  let download;
  if (process.env.ROC_TEST_PYTHON_ARCHIVES) {
    const { createHash } = await import('node:crypto');
    download = async (url, hash, target, { expectedSize, signal }) => {
      signal.throwIfAborted();
      const source = join(process.env.ROC_TEST_PYTHON_ARCHIVES, url.includes('/uv/') ? 'uv.tar.gz' : 'python.tar.gz');
      const bytes = await readFile(source);
      assert.equal(bytes.length, expectedSize);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
      await copyFile(source, target);
      return target;
    };
  }
  store = new ResearchPythonRuntimeStore(join(root, 'managed'), undefined, download);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('pinned uv installs exact private Python and reuses a fully verified receipt without downloads', async () => {
  runtime = await store.prepare('3.14.10', 'runtime-store-test', new AbortController().signal);
  assert.equal(runtime.version, '3.14.10');
  assert.match(runtime.pythonKey, /3\.14\.10/);
  assert.equal(await realpath(runtime.executable), runtime.executable);
  assert.deepEqual(await readdir(runtime.jobs), []);
  const offline = new ResearchPythonRuntimeStore(runtime.root, undefined, async () => { throw new Error('unexpected_download'); });
  assert.deepEqual(await offline.prepare('3.14.10', 'runtime-store-test', new AbortController().signal), runtime);
});

test('changed installed library refuses reuse; restoring exact bytes restores the same identity', async () => {
  const path = join(runtime.prefix, 'lib/python3.14/os.py'), original = await readFile(path);
  try {
    await writeFile(path, Buffer.concat([original, Buffer.from('\n# drift\n')]));
    await assert.rejects(store.prepare('3.14.10', 'runtime-store-test', new AbortController().signal), /integrity_failed/);
  } finally { await writeFile(path, original); }
  assert.deepEqual(await store.prepare('3.14.10', 'runtime-store-test', new AbortController().signal), runtime);
});

test('unsupported versions, pre-cancelled jobs and linked runtime roots never prepare', async () => {
  await assert.rejects(store.prepare('3.14.9', 'runtime-store-test', new AbortController().signal), /version_unavailable/);
  const controller = new AbortController(); controller.abort(new Error('cancelled-test'));
  await assert.rejects(store.prepare('3.14.10', 'runtime-store-test', controller.signal), /cancelled-test/);
  await symlink(runtime.root, join(root, 'alias'));
  await assert.rejects(new ResearchPythonRuntimeStore(join(root, 'alias')).prepare('3.14.10', 'runtime-store-test', new AbortController().signal), /directory_invalid/);
});
