import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as esbuild from 'esbuild';

let directory;
let api;
let fixture;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-bibliography-codec-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'fixture.mjs');
  await esbuild.build({ stdin: { contents: `
    export { readBibtex, writeBibliography } from './src/main/plugins/research/bibliography';
  `, resolveDir: process.cwd() }, outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
    packages: 'external', logLevel: 'silent' });
  api = await import(outfile);
  const corpus = readFileSync(join(process.cwd(), 'tests/fixtures/architecture-repair/bibliography-semantics.bib'), 'utf8');
  fixture = corpus
    .replace('Smith, John Paul, Jr.', 'Smith, Jr., John Paul')
    .replace('Jane Doe, Jr.', 'Doe, Jr., Jane');
});

after(() => rmSync(directory, { recursive: true, force: true }));

test('BibTeX codec preserves field semantics and derives complete names and titles', () => {
  const entries = api.readBibtex(fixture);
  assert.equal(entries.length, 4);

  const byKey = new Map(entries.map((entry) => [entry.citationKey, entry]));
  const proceedings = byKey.get('roc-workshop-2025');
  const paper = byKey.get('unicode-names-2025');
  const extensions = byKey.get('biblatex-extensions-2024');
  const article = byKey.get('postfix-and-particles');

  assert.deepEqual(proceedings.preambles, ['Proceedings of the Roc Data Workshop']);
  assert.equal(proceedings.fields.publishernote, 'retain this unknown field');
  assert.equal(proceedings.fields.venue, '上海');
  assert.deepEqual(paper.authors, [
    'María-José García',
    '明 李',
    'World Health Organization',
    'Ana de la Cruz',
    'Ludwig van Beethoven',
    'John Paul Smith Jr.'
  ]);
  assert.equal(paper.title.normalize('NFC'), 'Évidence from Nested Studies and LaTeX-Only Titles');
  assert.equal(paper.fields.booktitle, 'Journal of Reproducible Systems Annual Meeting');
  assert.equal(paper.fields.crossref, 'roc-workshop-2025');
  assert.equal(paper.fields.publisher, undefined);
  assert.equal(paper.fields.customresearchfield, 'must survive parse and export');
  const customCommand = String.raw`customresearchfield = {must survive parse and export \rocCustomToken}`;
  const withCustomCommand = fixture.replace('customresearchfield = {must survive parse and export}', customCommand);
  assert.equal(api.readBibtex(withCustomCommand)[1].fields.customresearchfield, String.raw`must survive parse and export \rocCustomToken`);
  assert.equal(paper.fields.title, String.raw`{\'{E}}vidence from {Nested {Studies}} and {\textbf{LaTeX-Only}} Titles`);
  assert.equal(extensions.fields.annotation, 'BibLaTeX-only fields remain available to callers');
  assert.equal(extensions.fields.note, String.raw`braces: {one {two}}; escaped: \{literal\}`);
  assert.deepEqual(article.authors, ['Ludwig van Beethoven', 'Ana de la Cruz', 'Jane Doe Jr.']);
});

test('BibTeX export reparses without losing keys, preambles, or unknown fields', () => {
  const entries = api.readBibtex(fixture);
  const restored = api.readBibtex(api.writeBibliography(entries, 'biblatex'));
  assert.deepEqual(restored.map((entry) => entry.citationKey), entries.map((entry) => entry.citationKey));
  assert.deepEqual(restored[0].preambles, entries[0].preambles);
  assert.equal(restored[0].fields.publishernote, 'retain this unknown field');
  assert.equal(restored[1].fields.customresearchfield, 'must survive parse and export');
  assert.equal(restored[1].fields.crossref, 'roc-workshop-2025');
  assert.equal(restored[2].fields.eprinttype, 'arxiv');
  assert.equal(restored[2].fields.note, entries[2].fields.note);
});

test('BibTeX export preserves quoted and repeated preamble directives', () => {
  const preamble = 'Proceedings of the "Roc" Data Workshop';
  const source = String.raw`@preamble{{Proceedings of the "Roc" Data Workshop}}
@preamble{{Proceedings of the "Roc" Data Workshop}}
@misc{preamble-roundtrip, title={Preamble round trip}}`;
  const entries = api.readBibtex(source);
  assert.deepEqual(entries[0].preambles, [preamble, preamble]);
  const restored = api.readBibtex(api.writeBibliography(entries, 'biblatex'));
  assert.deepEqual(restored[0].preambles, [preamble, preamble]);
});

test('BibTeX codec rejects malformed input, duplicate fields, and over-limit libraries', () => {
  assert.throws(() => api.readBibtex('@article{x, title={unfinished}'), /research_bibliography_parse_failed/u);
  assert.throws(() => api.readBibtex('@article{x, title={First}, TITLE={Second}}'), /research_bibliography_fields_invalid/u);
  const tooMany = Array.from({ length: 5001 }, (_, index) => `@misc{k${index}, title={Entry ${index}}}`).join('\n');
  assert.throws(() => api.readBibtex(tooMany), /research_bibliography_entry_count_invalid/u);
});
