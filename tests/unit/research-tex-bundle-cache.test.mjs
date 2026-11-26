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

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'roc-tex-bundle-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = join(root, 'source');
  await mkdir(contents);
  await writeFile(join(contents, 'tectonic-format-latex.tex'), '\\input article.cls\n');
  await writeFile(join(contents, 'article.cls'), 'initial class\n');
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
  await verifyTexBundleZip(destination, files);
  const first = await readFile(destination);
  await ensureTexBundleZip(source, destination, files);
  assert.equal(sha256(await readFile(destination)), sha256(first));
  await assert.rejects(verifyTexBundleZip(destination, [...files, 'extra.sty']), /research_tex_bundle_cache_invalid/u);
});

test('damaged TeX ZIP cache is rebuilt from the verified source', async (t) => {
  const { source, destination } = await fixture(t);
  const files = ['article.cls', 'tectonic-format-latex.tex'];
  await ensureTexBundleZip(source, destination, files);
  const original = await readFile(destination);
  const damaged = Buffer.from(original);
  damaged[60] ^= 0xff;
  await writeFile(destination, damaged);
  await assert.rejects(verifyTexBundleZip(destination, files), /research_tex_bundle_cache_invalid/u);
  await ensureTexBundleZip(source, destination, files);
  assert.equal(sha256(await readFile(destination)), sha256(original));
});

test('changing selected TeX files invalidates and regenerates the cache', async (t) => {
  const { source, destination } = await fixture(t);
  const files = ['article.cls', 'tectonic-format-latex.tex'];
  await ensureTexBundleZip(source, destination, files);
  const initialDigest = sha256(await readFile(destination));
  await ensureTexBundleZip(source, destination, [...files, 'extra.sty']);
  await verifyTexBundleZip(destination, [...files, 'extra.sty']);
  assert.notEqual(sha256(await readFile(destination)), initialDigest);
});
