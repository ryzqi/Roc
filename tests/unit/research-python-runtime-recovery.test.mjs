import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { ResearchPythonRuntimeStore } = await importTypeScriptModule('src/main/plugins/research/python-runtime-store.ts', { platform: 'node' });
const signal = () => new AbortController().signal;

test('an ordinary download failure removes only its own attempt and retries without adopting unknown or live roots', async () => {
  const root = await realpath(await mkdtemp('/private/tmp/roc-runtime-store-unit-'));
  try {
    const unknown = join(root, 'attempts', 'unknown-user-directory');
    const liveId = randomUUID(), live = join(root, 'attempts', liveId);
    await mkdir(unknown, { recursive: true }); await mkdir(live);
    await writeFile(join(unknown, 'user.txt'), 'preserve');
    await writeFile(join(live, 'owner.json'), JSON.stringify({ pid: process.pid, attemptId: liveId }));
    await mkdir(join(root, '.runtime-preparing'));
    await mkdir(join(root, 'python')); await writeFile(join(root, 'python', 'unknown.txt'), 'untouched');
    const downloads = [], failure = new Error('fixture-network-failure');
    const store = new ResearchPythonRuntimeStore(root, () => { assert.fail('unexpected process'); }, async (_url, _hash, target) => {
      downloads.push(target); throw failure;
    });
    for (let retry = 0; retry < 2; retry++) {
      await assert.rejects(store.prepare('3.14.10', 'retry', signal()), error => error === failure);
      assert.deepEqual((await readdir(join(root, 'attempts'))).sort(), ['unknown-user-directory', liveId].sort());
    }
    assert.equal(downloads.length, 2); assert.notEqual(downloads[0], downloads[1]);
    assert.equal(await readFile(join(unknown, 'user.txt'), 'utf8'), 'preserve');
    assert.equal(await readFile(join(root, 'python', 'unknown.txt'), 'utf8'), 'untouched');
    assert.equal(JSON.parse(await readFile(join(live, 'owner.json'), 'utf8')).pid, process.pid);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication rejects legacy receipts and escaping, noncanonical or symlinked attempt targets', async () => {
  const root = await realpath(await mkdtemp('/private/tmp/roc-runtime-pointer-unit-'));
  try {
    const store = new ResearchPythonRuntimeStore(root, () => { assert.fail('unexpected process'); }, () => { assert.fail('unexpected download'); });
    const pointer = join(root, 'python-3.14.10.json');
    await writeFile(pointer, '{"schemaVersion":1}');
    await assert.rejects(store.prepare('3.14.10', 'legacy', signal()), /research_python_runtime_receipt_invalid/);
    await rm(pointer);
    for (const target of ['../../user.json', '/tmp/user.json', 'attempts/not-a-uuid/python-3.14.10.json']) {
      await symlink(target, pointer);
      await assert.rejects(store.prepare('3.14.10', 'escape', signal()), /research_python_runtime_receipt_invalid/);
      await rm(pointer);
    }
    const id = randomUUID(), outside = join(root, 'user');
    await mkdir(outside); await writeFile(join(outside, 'user.txt'), 'preserve');
    await mkdir(join(root, 'attempts')); await symlink(outside, join(root, 'attempts', id));
    await symlink(`attempts/${id}/python-3.14.10.json`, pointer);
    await assert.rejects(store.prepare('3.14.10', 'linked', signal()), /research_python_runtime_directory_invalid/);
    assert.equal(await readFile(join(outside, 'user.txt'), 'utf8'), 'preserve');
  } finally { await rm(root, { recursive: true, force: true }); }
});
