import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import * as esbuild from 'esbuild';

let directory, evaluate;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-acquisition-eval-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'fixture.mjs');
  await esbuild.build({entryPoints: ['src/main/plugins/research/literature-acquisition-evaluation.ts'],
    outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent'});
  evaluate = (await import(outfile)).evaluateLiteratureAcquisition;
});
after(() => rmSync(directory, {recursive: true, force: true}));
const startedAt = '2026-11-19T00:00:00.000Z';
const observedAt = '2026-11-19T00:01:00.000Z';
const receipt = {id: 'r1', generation: 'g1', sha256: 'a'.repeat(64), bytes: 1234,
  sourceUrl: 'https://arxiv.org/pdf/2403.02691', provider: 'arxiv', version: 'preprint',
  license: null, doi: null, arxivId: '2403.02691', relativePath: 'papers/a.pdf', acquiredAt: startedAt};
const sample = (paperId, overrides = {}) => ({paperId, topicId: 'agents', expectedOpenAccess: true,
  startedAt, observedAt, discovered: false, receipt: null, parsed: null, indexed: null, wiki: null,
  readyAt: null, recovery: null, failures: [], ...overrides});
const corpus = samples => ({schemaVersion: 1, corpusId: 'fixture', environment: 'engineering_fixture',
  expectedPaperIds: samples.map(value => value.paperId), samples});

test('all declared papers remain in rates; unmeasured stages are explicit and p95 is censored', () => {
  const data = corpus([
    sample('ready', {discovered: true, receipt, parsed: true, indexed: true, wiki: true,
      readyAt: '2026-11-19T00:00:10.000Z', recovery: {incident: 'restart', recovered: true}}),
    sample('download-only', {discovered: true, receipt, recovery: {incident: 'rate_limit', recovered: null}}),
    sample('failed', {expectedOpenAccess: false, parsed: false, indexed: false, wiki: false,
      failures: [{provider: 'arxiv', code: 'research_pdf_size_invalid'}]})
  ]);
  const report = evaluate(data);
  assert.deepEqual(report.allPapers.discovery, {numerator: 2, denominator: 3, rate: 2 / 3});
  assert.deepEqual(report.allPapers.verifiedPdf, report.allPapers.discovery);
  assert.deepEqual(report.allPapers.endToEndReady,
    {numerator: 1, denominator: 3, rate: 1 / 3, fullyObserved: 2, completeMeasurement: false});
  assert.deepEqual(report.allPapers.completionTime,
    {p95Ms: 10000, completed: 1, censored: 2, population: 'completed_only'});
  assert.deepEqual(report.allPapers.recovery, {numerator: 1, denominator: 2, rate: 0.5, unknown: 1});
  assert.equal(report.declaredOpenAccess.discovery.rate, 1);
  assert.equal(report.failures[0].paperId, 'failed');
  assert.match(report.evidenceHash, /^[a-f0-9]{64}$/u);
  const empty = evaluate(corpus([sample('unknown', {expectedOpenAccess: null})]));
  assert.equal(empty.declaredOpenAccess.discovery.rate, null);
  assert.equal(empty.allPapers.completionTime.p95Ms, null);
  assert.equal(empty.allPapers.recovery.rate, null);
});

test('cherry-picked denominators, duplicate samples and impossible stage/time evidence fail', () => {
  const data = corpus([sample('one'), sample('two')]);
  assert.throws(() => evaluate({...data, samples: data.samples.slice(0, 1)}), /denominator_changed/u);
  assert.throws(() => evaluate({...data, expectedPaperIds: ['one', 'one']}), /denominator_changed/u);
  assert.throws(() => evaluate({...data, samples: [data.samples[0], data.samples[0]]}), /denominator_changed/u);
  for (const invalid of [
    {receipt}, {indexed: true}, {wiki: true}, {parsed: true},
    {observedAt: '2026-11-18T23:59:59.000Z'}, {readyAt: observedAt},
    {discovered: true, receipt, parsed: true, indexed: true, wiki: true},
    {discovered: true, receipt, parsed: true, indexed: true, wiki: true, readyAt: '2026-11-19T00:02:00Z'}
  ]) assert.throws(() => evaluate(corpus([sample('bad', invalid)])), /evidence_inconsistent/u);
  const fractional = sample('fractional', {startedAt: '2026-11-19T00:00:00Z',
    observedAt: '2026-11-19T00:00:00.100Z'});
  assert.doesNotThrow(() => evaluate(corpus([fractional])));
});

test('offline acquisition CLI writes the computed evidence hash and refuses overwrite', () => {
  const input = join(directory, 'evidence.json'), output = join(directory, 'report.json');
  const data = corpus([sample('one')]);
  writeFileSync(input, JSON.stringify(data));
  const args = ['scripts/evaluate-literature-acquisition.mjs', input, output];
  execFileSync(process.execPath, args, {stdio: 'pipe'});
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), evaluate(data));
  assert.throws(() => execFileSync(process.execPath, args, {stdio: 'pipe'}), /EEXIST/u);
});
