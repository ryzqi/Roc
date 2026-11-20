import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import test from 'node:test';
import {verifyExpertPublicSources} from '../adapters/scientific-public/expert-sources.mjs';
import {hash, sha256} from '../lib/common.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'roc-scientific-expert-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'm3sciqa'));
  const bytes = Buffer.from('Original expert label bytes');
  const lock = {schemaVersion: 1, sources: [{id: 'm3sciqa', files: [{
    path: 'm3sciqa/data', url: 'https://huggingface.co/datasets/example/resolve/revision/data',
    bytes: bytes.length, sha256: sha256(bytes)
  }]}]};
  writeFileSync(join(root, 'm3sciqa/data'), bytes);
  return {root, bytes, lock};
}

test('supplementary source verification accepts exact locked bytes and relative roots', t => {
  const {root, lock} = fixture(t);
  const receipt = verifyExpertPublicSources(relative(process.cwd(), root), lock);
  assert.equal(receipt.root, root);
  assert.equal(receipt.sourceLockHash, hash(lock));
  assert.equal(receipt.scientificBaselineReady, false);
});
test('same-size source corruption is rejected', t => {
  const {root, bytes, lock} = fixture(t);
  writeFileSync(join(root, 'm3sciqa/data'), Buffer.alloc(bytes.length, 65));
  assert.throws(() => verifyExpertPublicSources(root, lock), /source_changed/);
});
test('missing source is rejected without a success-shaped receipt', t => {
  const {root, lock} = fixture(t);
  rmSync(join(root, 'm3sciqa/data'));
  assert.throws(() => verifyExpertPublicSources(root, lock), /source_changed/);
});
test('source files and directories cannot redirect through symlinks', t => {
  const {root, lock} = fixture(t);
  rmSync(join(root, 'm3sciqa/data'));
  symlinkSync('/etc/hosts', join(root, 'm3sciqa/data'));
  assert.throws(() => verifyExpertPublicSources(root, lock), /path_invalid/);
  rmSync(join(root, 'm3sciqa'), {recursive: true});
  symlinkSync(tmpdir(), join(root, 'm3sciqa'));
  assert.throws(() => verifyExpertPublicSources(root, lock), /path_invalid/);
});
test('duplicate pins, excessive bytes and unsafe source paths are rejected', t => {
  const {root, lock} = fixture(t);
  const pin = lock.sources[0].files[0];
  const changed = files => ({...lock, sources: [{...lock.sources[0], files}]});
  assert.throws(() => verifyExpertPublicSources(root, changed([pin, pin])), /lock_invalid/);
  assert.throws(() => verifyExpertPublicSources(root, changed([{...pin, bytes: 129 * 1024 * 1024}])), /lock_invalid/);
  assert.throws(() => verifyExpertPublicSources(root, changed([{...pin, path: '../data'}])));
});
