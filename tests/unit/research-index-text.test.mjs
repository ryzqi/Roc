import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/**
 * Preserve the local indexer's line/UTF-16 locators and parser-block source metadata. A generic
 * splitter change also needs retrieval-quality evidence, beyond matching these chunk contracts.
 */
async function loadIndexFiles() {
  const dir = mkdtempSync(realpathSync(join(tmpdir())) + '/roc-index-text-');
  const outfile = join(dir, 'index-files.mjs');
  await build({
    entryPoints: ['src/main/plugins/research/index-files.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external'
  });
  return { dir, files: await import(outfile) };
}

test('indexText keeps short text grouped by source lines', async () => {
  const { dir, files } = await loadIndexFiles();
  try {
    const result = files.indexText(Buffer.from('title\n\nbody text', 'utf8'));

    assert.equal(result.parserVersion, 'roc-text-1');
    assert.equal(result.content, 'title\n\nbody text');
    assert.deepEqual(result.chunks, [{ content: 'title\n\nbody text', locator: 'lines 1-3' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('indexText splits an oversized line without breaking UTF-16 surrogate pairs', async () => {
  const { dir, files } = await loadIndexFiles();
  try {
    const text = `${'界'.repeat(1999)}😀tail`;
    const result = files.indexText(Buffer.from(text, 'utf8'));

    assert.equal(result.chunks.length, 2);
    assert.equal(result.chunks.map((chunk) => chunk.content).join(''), text);
    assert.deepEqual(result.chunks.map((chunk) => chunk.locator), [
      'line 1; UTF-16 1-1999',
      `line 1; UTF-16 2000-${text.length}`
    ]);
    for (const chunk of result.chunks) {
      assert.ok(chunk.content.length <= 2000);
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(chunk.content, 'utf8'));
      assert.equal(decoded, chunk.content);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('indexLocatedText preserves parser locators while splitting long extracted blocks', async () => {
  const { dir, files } = await loadIndexFiles();
  try {
    const text = 'x'.repeat(2001);
    const chunks = files.indexLocatedText(text, 'PDF page 7, paragraph 2');

    assert.equal(chunks.map((chunk) => chunk.content).join(''), text);
    assert.deepEqual(chunks.map((chunk) => chunk.locator), [
      'PDF page 7, paragraph 2; extracted line 1; UTF-16 1-2000',
      'PDF page 7, paragraph 2; extracted line 1; UTF-16 2001-2001'
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('indexText rejects malformed UTF-8 rather than indexing replacement characters', async () => {
  const { dir, files } = await loadIndexFiles();
  try {
    assert.throws(() => files.indexText(Buffer.from([0xff])), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
