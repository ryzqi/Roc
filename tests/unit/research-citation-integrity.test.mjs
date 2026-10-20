import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * A dangling citation key compiles successfully, so it has to be caught before the compile.
 *
 * Measured, not assumed: compiling `\cite{does-not-exist}` with the bundled Tectonic exits 0, and
 * the string `export-builder.ts` refuses on (`errors were issued by BibTeX, but were ignored`) only
 * appears when the `.bib` file itself is missing. With a present-but-incomplete bibliography, BibTeX
 * writes `Warning--I didn't find a database entry for "does-not-exist"` to the `.blg` and LaTeX logs
 * `Citation 'does-not-exist' on page 1 undefined` — the PDF ships with a broken reference.
 *
 * So the properties pinned here are about not crying wolf as much as about catching the real thing:
 * a commented-out example, a `verbatim` listing that teaches `\cite`, and `\nocite{*}` are all
 * legitimate LaTeX that must not be read as a missing key.
 */

const { latexCitationKeys, unknownCitationKeys, unknownCitationKeysIn } = await importTypeScriptModule(
  'src/main/plugins/research/citation-integrity.ts'
);

test('the common citation forms are recognised', () => {
  assert.deepEqual(latexCitationKeys('See \\cite{zhang2023}.'), ['zhang2023']);
  // Multi-key, spaced, and the optional pre/post notes natbib allows.
  assert.deepEqual(latexCitationKeys('\\cite{a, b ,c}'), ['a', 'b', 'c']);
  assert.deepEqual(latexCitationKeys('\\citep[see][p. 3]{lee2020}'), ['lee2020']);
  assert.deepEqual(latexCitationKeys('\\citet*{alpha}'), ['alpha']);
});

test('any cite-family macro counts, including biblatex spellings', () => {
  // The macro name always contains `cite`, so the rule does not enumerate variants: a template
  // written for a different package still gets checked rather than silently skipped.
  const keys = latexCitationKeys('\\autocite{x}\\parencite{y}\\textcite{z}\\Citeauthor{q}\\nocite{w}');
  assert.deepEqual(keys, ['x', 'y', 'z', 'q', 'w']);
});

test('\\nocite{*} means "everything", not a key literally named *', () => {
  assert.deepEqual(latexCitationKeys('\\nocite{*}'), []);
  assert.deepEqual(latexCitationKeys('\\nocite{*}\n\\cite{real}'), ['real']);
});

test('a commented-out citation is not a citation', () => {
  assert.deepEqual(latexCitationKeys('\\cite{kept}\n% \\cite{commented}\n'), ['kept']);
});

test('a listing that teaches \\cite is not reported as a dangling key', () => {
  // A template documenting its own bibliography slots is the realistic case here.
  const source = [
    '\\begin{verbatim}',
    '\\cite{example-key}',
    '\\end{verbatim}',
    '\\begin{lstlisting}',
    '\\cite{another-example}',
    '\\end{lstlisting}',
    '\\cite{real}'
  ].join('\n');
  assert.deepEqual(latexCitationKeys(source), ['real']);
});

test('repeats collapse, and the order is the order they appear in', () => {
  assert.deepEqual(latexCitationKeys('\\cite{b}\\cite{a}\\cite{b}'), ['b', 'a']);
});

test('real-world key shapes survive intact', () => {
  // Keys are identifiers: `Smith2020a` and `smith2020a` are different keys, and
  // `China-National-Standard.2015` is one key, not three.
  assert.deepEqual(latexCitationKeys('\\cite{Smith2020a,smith2020a,China-National-Standard.2015}'),
    ['Smith2020a', 'smith2020a', 'China-National-Standard.2015']);
});

test('only keys absent from the snapshot are reported, in source order', () => {
  const keys = ['b', 'a', 'b', 'zzz'];
  assert.deepEqual(unknownCitationKeys(keys, ['a', 'x']), ['b', 'zzz']);
  assert.deepEqual(unknownCitationKeys(keys, ['a', 'b', 'zzz']), []);
});

test('the difference is taken over all the compiled sources at once', () => {
  // Reporting per file would make the user fix one key, re-export, and discover the next.
  const sources = ['\\cite{a}', '\\cite{missing-one}', '\\cite{missing-two, present}'];
  assert.deepEqual(unknownCitationKeysIn(sources, ['a', 'present']), ['missing-one', 'missing-two']);
});
