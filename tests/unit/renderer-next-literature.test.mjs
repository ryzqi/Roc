import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Unit tests for the P5 literature pure layer (`literature/format.ts`).
 *
 * These are not decoration: every helper here sits between free-form user input
 * (a pasted DOI, a pasted arXiv URL, a title with accents) and a **strict** IPC
 * schema. A wrong answer does not look wrong — it becomes a backend validation
 * error the user cannot interpret, or a silently malformed citation key.
 *
 * The citation-key cases double as the documentation of
 * `researchCitationKeySchema` (`/^[^\s,{}\\%#"]+$/u`): the derived key must be
 * acceptable to the backend *before* it is submitted.
 */

let format;

before(async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'roc-literature-'));
  const outfile = join(tempDir, 'format.mjs');
  await esbuild.build({
    entryPoints: ['src/renderer-next/literature/format.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    logLevel: 'silent'
  });
  format = await import(outfile);
  rmSync(tempDir, { recursive: true, force: true });
});

test('isCitationKeyValid mirrors the backend pattern', () => {
  assert.equal(format.isCitationKeyValid('smith2024attention'), true);
  assert.equal(format.isCitationKeyValid('a'), true);
  for (const bad of ['', 'a b', 'a,b', 'a{b', 'a}b', 'a\\b', 'a%b', 'a#b', 'a"b']) {
    assert.equal(format.isCitationKeyValid(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.equal(format.isCitationKeyValid('x'.repeat(501)), false);
});

test('deriveCitationKey produces a schema-valid key from the import form', () => {
  const key = format.deriveCitationKey({ title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], year: 2017 });
  assert.equal(key, 'vaswani2017attention');
  assert.equal(format.isCitationKeyValid(key), true);
});

test('deriveCitationKey strips diacritics instead of dropping the surname', () => {
  assert.equal(format.deriveCitationKey({ title: 'Über die Mechanik', authors: ['Karl Müller'], year: 1905 }), 'muller1905uber');
});

test('deriveCitationKey returns null when nothing usable can be built', () => {
  // "Of" is shorter than the 3-character minimum, and there is no author/year.
  assert.equal(format.deriveCitationKey({ title: 'Of', authors: [], year: null }), null);
  assert.equal(format.deriveCitationKey({ title: '', authors: [], year: null }), null);
});

test('normalizeDoi strips the wrappers users actually paste', () => {
  assert.equal(format.normalizeDoi('10.1038/nature12373'), '10.1038/nature12373');
  assert.equal(format.normalizeDoi('  https://doi.org/10.1038/nature12373  '), '10.1038/nature12373');
  assert.equal(format.normalizeDoi('http://dx.doi.org/10.1000/xyz'), '10.1000/xyz');
  assert.equal(format.normalizeDoi('doi: 10.1000/xyz'), '10.1000/xyz');
  assert.equal(format.normalizeDoi('DOI:10.1000/xyz'), '10.1000/xyz');
});

test('normalizeDoi refuses non-DOIs rather than sending them to the backend', () => {
  assert.equal(format.normalizeDoi(''), null);
  assert.equal(format.normalizeDoi('not-a-doi'), null);
  // A DOI-shaped path on another host is not a DOI.
  assert.equal(format.normalizeDoi('https://example.com/10.1000/xyz'), null);
  // Real DOIs have a 4–9 digit registrant; `10.1/x` is not one (this is the
  // difference between “looks like a DOI” and “is a DOI”).
  assert.equal(format.normalizeDoi('10.1/abc'), null);
});

test('arxivQueryFromInput accepts ids, prefixes, and URLs', () => {
  assert.equal(format.arxivQueryFromInput('2301.12345'), '2301.12345');
  assert.equal(format.arxivQueryFromInput('  arXiv:2301.12345  '), '2301.12345');
  assert.equal(format.arxivQueryFromInput('2301.12345v2'), '2301.12345');
  assert.equal(format.arxivQueryFromInput('https://arxiv.org/abs/2301.12345'), '2301.12345');
  assert.equal(format.arxivQueryFromInput('https://arxiv.org/pdf/2301.12345v1.pdf'), '2301.12345');
  assert.equal(format.arxivQueryFromInput('math.GT/0309136'), 'math.GT/0309136');
});

test('arxivQueryFromInput returns null for a free-text query', () => {
  // A title search must go through the search box, not the arXiv-id path, or the
  // UI would claim "this is an arXiv id" for something that is not.
  assert.equal(format.arxivQueryFromInput('attention is all you need'), null);
  assert.equal(format.arxivQueryFromInput(''), null);
});

test('readVenue reads the free-form bibliography fields in importer order', () => {
  assert.equal(format.readVenue({ fields: { journal: 'Nature' } }), 'Nature');
  assert.equal(format.readVenue({ fields: { booktitle: 'NeurIPS' } }), 'NeurIPS');
  assert.equal(format.readVenue({ fields: { 'container-title': 'JMLR' } }), 'JMLR');
  // journal wins over booktitle when both are present (BibTeX @article + @inproceedings leftovers).
  assert.equal(format.readVenue({ fields: { booktitle: 'NeurIPS', journal: 'Nature' } }), 'Nature');
  assert.equal(format.readVenue({ fields: {} }), null);
  assert.equal(format.readVenue({ fields: { journal: '   ' } }), null);
});

test('formatAuthorList degrades honestly', () => {
  assert.equal(format.formatAuthorList([]), '作者未知');
  assert.equal(format.formatAuthorList(['  ', '']), '作者未知');
  assert.equal(format.formatAuthorList(['A. One']), 'A. One');
  assert.equal(format.formatAuthorList(['A. One', 'B. Two']), 'A. One · B. Two');
  assert.equal(format.formatAuthorList(['A. One', 'B. Two', 'C. Three', 'D. Four']), 'A. One · B. Two 等 4 人');
});

test('null metadata is rendered as absent, not as a guess', () => {
  assert.equal(format.formatYear(null), '—');
  assert.equal(format.formatYear(2024), '2024');
  assert.equal(format.formatCitationCount(null), '引用数未知');
  assert.equal(format.formatCitationCount(0), '被引 0');
  assert.equal(format.formatDoi(null), null);
  assert.equal(format.formatDoi('   '), null);
  assert.equal(format.formatDoi('10.1038/nature12373'), '10.1038/nature12373');
});

test('libraryItemTitle prefers metadata and never shows an empty row', () => {
  assert.equal(format.libraryItemTitle({ metadata: { title: ' A ' }, bibliography: { title: 'B' } }), 'A');
  assert.equal(format.libraryItemTitle({ metadata: { title: '  ' }, bibliography: { title: ' B ' } }), 'B');
  assert.equal(format.libraryItemTitle({ metadata: { title: '' }, bibliography: { title: '' } }), '（无题名）');
});
