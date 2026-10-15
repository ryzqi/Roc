import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Tests for `literature/parse-blocks.ts` — the reader's projection of a parse.
 *
 * The two failure modes this guards are both silent: dropping a block kind (a
 * parse you cannot read looks identical to a failed parse) and inventing text for
 * an empty block. Note the shape used here is the **post-IPC** schema
 * (`imageAssetId`, not `imagePath`) — that difference is exactly what
 * `research-documents.ts` rewrites, and using the wrong one would let a test pass
 * while the runtime fails.
 */

let parseBlocks;

before(async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'roc-parse-blocks-'));
  const outfile = join(tempDir, 'parse-blocks.mjs');
  await esbuild.build({
    entryPoints: ['src/renderer-next/literature/parse-blocks.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    logLevel: 'silent'
  });
  parseBlocks = await import(outfile);
  rmSync(tempDir, { recursive: true, force: true });
});

function block(overrides) {
  return {
    id: 'b1',
    kind: 'paragraph',
    label: 'p',
    text: 'Some text',
    locator: 'section 1',
    imageAssetId: null,
    locations: [{ page: 1, bbox: [0, 0, 10, 10], coordinateOrigin: 'TOPLEFT' }],
    ...overrides
  };
}

function content(blocks) {
  return {
    sourceHash: 'a'.repeat(64),
    parserVersion: 'test',
    pageCount: 3,
    content: '# Markdown',
    blocks,
    assets: [],
    warnings: []
  };
}

test('every block kind survives the projection, in document order', () => {
  const parsed = parseBlocks.parseDocumentBlocks(
    content([
      block({ id: 'b-heading', kind: 'heading', text: 'Introduction' }),
      block({ id: 'b-paragraph' }),
      block({ id: 'b-table', kind: 'table', text: 'a | b\n1 | 2' }),
      block({ id: 'b-formula', kind: 'formula', text: 'E = mc^2' }),
      block({ id: 'b-figure', kind: 'figure', text: 'Figure 1', imageAssetId: 'asset-1' })
    ])
  );
  assert.deepEqual(
    parsed.map((entry) => entry.kind),
    ['heading', 'paragraph', 'table', 'formula', 'figure']
  );
  assert.deepEqual(
    parsed.map((entry) => entry.id),
    ['b-heading', 'b-paragraph', 'b-table', 'b-formula', 'b-figure']
  );
});

test('a block with no locations or no label is still rendered, and marked', () => {
  const parsed = parseBlocks.parseDocumentBlocks(
    content([block({ id: 'b-blank', text: '   ', locations: [], label: '  ' })])
  );
  assert.equal(parsed.length, 1, 'an empty block must not be dropped');
  assert.equal(parsed[0].isBlank, true);
  assert.equal(parsed[0].page, null);
  assert.equal(parsed[0].label, '（无标签 paragraph）');
});

test('the page comes from the first location, not the last', () => {
  const parsed = parseBlocks.parseDocumentBlocks(
    content([
      block({
        locations: [
          { page: 4, bbox: [0, 0, 1, 1], coordinateOrigin: 'TOPLEFT' },
          { page: 5, bbox: [0, 0, 1, 1], coordinateOrigin: 'TOPLEFT' }
        ]
      })
    ])
  );
  assert.equal(parsed[0].page, 4);
});

test('counts are computed from the rendered blocks', () => {
  const counts = parseBlocks.countParsedBlocks(
    content([
      block({ id: 'h', kind: 'heading', locations: [{ page: 1, bbox: [0, 0, 1, 1], coordinateOrigin: 'TOPLEFT' }] }),
      block({ id: 't', kind: 'table', locations: [{ page: 2, bbox: [0, 0, 1, 1], coordinateOrigin: 'TOPLEFT' }] }),
      block({ id: 't2', kind: 'table', locations: [{ page: 2, bbox: [0, 0, 1, 1], coordinateOrigin: 'TOPLEFT' }] }),
      block({ id: 'f', kind: 'formula', locations: [] })
    ])
  );
  assert.deepEqual(counts, {
    total: 4,
    headings: 1,
    paragraphs: 0,
    tables: 2,
    formulas: 1,
    figures: 0,
    pagesCovered: 2
  });
});

test('an empty parse is empty, not a placeholder', () => {
  const parsed = parseBlocks.parseDocumentBlocks(content([]));
  assert.deepEqual(parsed, []);
  assert.equal(parseBlocks.countParsedBlocks(content([])).total, 0);
});
