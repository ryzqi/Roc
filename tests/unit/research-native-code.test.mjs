import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, writeFile, symlink, unlink, stat, utimes, chmod, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api, root;
const exec = promisify(execFile);
before(async () => { api = await loadResearchTestApi(); root = await realpath(await mkdtemp('/private/tmp/roc-native-code-unit-')); });
after(async () => { await rm(root, { recursive: true, force: true }); api.dispose(); });
async function directory() { return mkdtemp(join(root, 'code-')); }
function identity(paths, signal = new AbortController().signal) { return api.nativeCodeIdentity(paths, signal); }

test('native code identity is deterministic across ordering, duplicate roots and file reads', async () => {
  const one = await directory(), two = await directory();
  await mkdir(join(one, 'nested'));
  await writeFile(join(one, 'native.dylib'), Buffer.alloc(2 * 1024 * 1024, 23));
  await writeFile(join(two, 'code.rdx'), 'frozen package code');
  const before = await identity([one, two, join(one, 'nested')]);
  assert.equal(await identity([two, one, one, join(one, 'nested')]), before);
});

test('native code identity detects changed bytes of unchanged-size files even when mtime is restored', async () => {
  const path = await directory(), file = join(path, 'native.dylib');
  await writeFile(file, 'native-1');
  const info = await stat(file), before = await identity([path]);
  await writeFile(file, 'native-2'); await utimes(file, info.atime, info.mtime);
  assert.equal((await stat(file)).size, info.size);
  assert.notEqual(await identity([path]), before);
});

test('native code identity binds permissions and full file/directory membership', async () => {
  const path = await directory(), file = join(path, 'native.dylib');
  await writeFile(file, 'native code'); await chmod(file, 0o600);
  const before = await identity([path]);
  await chmod(file, 0o700);
  assert.notEqual(await identity([path]), before);
  await chmod(file, 0o600); assert.equal(await identity([path]), before);
  await mkdir(join(path, 'extension'));
  const directoryAdded = await identity([path]); assert.notEqual(directoryAdded, before);
  await writeFile(join(path, 'extension/new-code'), 'additional package code');
  const fileAdded = await identity([path]); assert.notEqual(fileAdded, directoryAdded);
  await unlink(join(path, 'extension/new-code'));
  assert.equal(await identity([path]), directoryAdded);
});

test('native code links resolve only into declared roots and retargeting is part of identity', async () => {
  const library = await directory(), one = await directory(), two = await directory();
  for (const path of [one, two]) await writeFile(join(path, 'DESCRIPTION'), 'identical package description');
  const link = join(library, 'Package'); await symlink(one, link, 'dir');
  await assert.rejects(identity([library]), /native_code_outside_scope/);
  const before = await identity([library, one, two]);
  await unlink(link); await symlink(two, link, 'dir');
  assert.notEqual(await identity([library, one, two]), before);
  await symlink(join(two, 'DESCRIPTION'), join(two, 'metadata-alias'));
  assert.match(await identity([library, one, two]), /^[a-f0-9]{64}$/);
});

test('native code capture refuses oversized files and special entries before any blocking content read', async () => {
  const path = await directory(), file = join(path, 'large.dylib');
  const handle = await open(file, 'w');
  try { await handle.truncate(api.nativeCodeLimits.maxFileBytes + 1); } finally { await handle.close(); }
  await assert.rejects(identity([path]), /native_code_limit/);
  await unlink(file);
  await exec('/usr/bin/mkfifo', [join(path, 'pipe')]);
  await assert.rejects(identity([path]), /native_code_entry_invalid/);
});

test('cancelled native code capture returns the real abort reason', async () => {
  const controller = new AbortController(); controller.abort(new Error('controlled_native_hash_abort'));
  await assert.rejects(identity([await directory()], controller.signal), /controlled_native_hash_abort/);
});
