import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { ensureTexBundleZip, verifyTexBundleZip } = await importTypeScriptModule('scripts/research/tex-bundle-cache.ts', {
  platform: 'node',
  external: ['yauzl'],
  tempDir: join(process.cwd(), '.runtime/tmp')
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture(t, classContents = 'initial class\n') {
  const root = await mkdtemp(join(tmpdir(), 'roc-tex-bundle-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = join(root, 'source');
  await mkdir(contents);
  await writeFile(join(contents, 'tectonic-format-latex.tex'), '\\input article.cls\n');
  await writeFile(join(contents, 'article.cls'), classContents);
  await writeFile(join(contents, 'extra.sty'), 'optional package\n');
  const source = join(root, 'source.tar');
  execFileSync('tar', ['-cf', source, '-C', contents, 'tectonic-format-latex.tex', 'article.cls', 'extra.sty'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }
  });
  return { source, destination: join(root, 'tex-bundle.zip') };
}

test('TeX ZIP verifies selected uncompressed content and reuses a valid cache', async (t) => {
  const { source, destination } = await fixture(t);
  const files = ['article.cls', 'tectonic-format-latex.tex'];
  await ensureTexBundleZip(source, destination, files);
  await verifyTexBundleZip(destination, files, source);
  const first = await readFile(destination);
  await ensureTexBundleZip(source, destination, files);
  assert.equal(sha256(await readFile(destination)), sha256(first));
  await assert.rejects(verifyTexBundleZip(destination, [...files, 'extra.sty'], source), /research_tex_bundle_cache_invalid/u);
});

test('damaged TeX ZIP cache is rebuilt from the verified source', async (t) => {
  const { source, destination } = await fixture(t);
  const files = ['article.cls', 'tectonic-format-latex.tex'];
  await ensureTexBundleZip(source, destination, files);
  const original = await readFile(destination);
  const damaged = Buffer.from(original);
  damaged[60] ^= 0xff;
  await writeFile(destination, damaged);
  await assert.rejects(verifyTexBundleZip(destination, files, source), /research_tex_bundle_cache_invalid/u);
  await ensureTexBundleZip(source, destination, files);
  assert.equal(sha256(await readFile(destination)), sha256(original));
});

test('changing selected TeX files invalidates and regenerates the cache', async (t) => {
  const { source, destination } = await fixture(t);
  const files = ['article.cls', 'tectonic-format-latex.tex'];
  await ensureTexBundleZip(source, destination, files);
  const initialDigest = sha256(await readFile(destination));
  await ensureTexBundleZip(source, destination, [...files, 'extra.sty']);
  await verifyTexBundleZip(destination, [...files, 'extra.sty'], source);
  assert.notEqual(sha256(await readFile(destination)), initialDigest);
});

test('a self-consistent TeX ZIP from a different source is rebuilt even when selected names match', async (t) => {
  const original = await fixture(t);
  const replacement = await fixture(t, 'changed class\n');
  const files = ['article.cls', 'tectonic-format-latex.tex'];
  await ensureTexBundleZip(original.source, original.destination, files);
  const oldDigest = sha256(await readFile(original.destination));
  await assert.rejects(verifyTexBundleZip(original.destination, files, replacement.source), /research_tex_bundle_cache_invalid/u);
  await ensureTexBundleZip(replacement.source, replacement.destination, files);
  const expectedDigest = sha256(await readFile(replacement.destination));
  assert.notEqual(expectedDigest, oldDigest);
  await ensureTexBundleZip(replacement.source, original.destination, files);
  assert.equal(sha256(await readFile(original.destination)), expectedDigest);
});

test('a valid TeX ZIP cannot replace a missing source archive and remains intact on failure', async (t) => {
  const { source, destination } = await fixture(t);
  const files = ['article.cls', 'tectonic-format-latex.tex'];
  await ensureTexBundleZip(source, destination, files);
  const original = await readFile(destination);
  await rm(source);
  await assert.rejects(ensureTexBundleZip(source, destination, files), { code: 'ENOENT' });
  assert.deepEqual(await readFile(destination), original);
});

for (const headers of ['local', 'central', 'both']) {
  test(`TeX ZIP rejects and rebuilds CRC-only corruption in ${headers} headers`, async (t) => {
    const { source, destination } = await fixture(t);
    const files = ['article.cls', 'tectonic-format-latex.tex'];
    await ensureTexBundleZip(source, destination, files);
    const original = await readFile(destination);
    const damaged = Buffer.from(original);
    const end = damaged.length - 22;
    assert.equal(damaged.readUInt32LE(end), 0x06054b50);
    const central = damaged.readUInt32LE(end + 16);
    assert.equal(damaged.readUInt32LE(central), 0x02014b50);
    const local = damaged.readUInt32LE(central + 42);
    assert.equal(damaged.readUInt32LE(local), 0x04034b50);
    if (headers !== 'central') damaged[local + 14] ^= 1;
    if (headers !== 'local') damaged[central + 16] ^= 1;
    await writeFile(destination, damaged);
    await assert.rejects(verifyTexBundleZip(destination, files, source), /research_tex_bundle_cache_invalid/u);
    await ensureTexBundleZip(source, destination, files);
    assert.equal(sha256(await readFile(destination)), sha256(original));
  });
}
