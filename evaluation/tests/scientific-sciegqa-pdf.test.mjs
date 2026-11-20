import assert from 'node:assert/strict';
import test from 'node:test';
import {verifySciegqaPdfHeader} from '../adapters/scientific-public/sciegqa-pdf.mjs';

function fixture() {
  const cohort = {sourceLockHash: 'source', papers: Array.from({length: 45}, (_, i) => ({
    id: `dataset-${i}`, pdf: {path: `pdfs/${i}.pdf`, sha256: String(i), bytes: 20}}))};
  const source = {cohort, cohortHash: 'cohort', manifestHash: 'manifest'};
  const inputs = {sourceLockHash: 'source', cohortHash: 'cohort', manifestHash: 'manifest',
    pins: cohort.papers.map(p => p.pdf), codeHashes: {parser: 'parserhash'}, modelHashes: {model: 'modelhash'},
    modelManifest: 'complete', parserOptions: {tier: 'complete', device: 'cpu', pageRange: ''},
    compiledBundleHashes: [{name: 'parser.js', sha256: 'compiledhash'}]};
  const run = {...inputs, kind: 'scientific-sciegqa-full-pdf-parser-component-run',
    status: 'processed-unscored', cohortComplete: true, papers: 45, questions: 225, failedPapers: 1,
    rows: cohort.papers.map((p, i) => ({datasetPaperId: p.id, source: p.pdf.path, sourceHash: p.pdf.sha256,
      status: i === 0 ? 'failed' : 'parsed', elapsedMs: i, peakRssBytes: 1}))};
  return {source, inputs, run};
}

test('complete preselection retains failed attempts for independent receipt verification', () => {
  const {source, inputs, run} = fixture();
  assert.deepEqual(verifySciegqaPdfHeader(run, inputs, source), inputs.pins);
});

test('missing/reordered papers, changed source or code/model/options identities reject', () => {
  const {source, inputs, run} = fixture();
  for (const change of [r => r.rows.pop(), r => r.rows.reverse(),
    r => {r.rows[0].sourceHash = 'changed';}, r => {r.cohortHash = 'changed';},
    r => {r.questions = 224;}, r => {r.codeHashes.parser = 'changed';},
    r => {r.modelHashes.model = 'changed';}, r => {r.parserOptions.device = 'auto';},
    r => {r.cohortComplete = false;}]) {
    const changed = structuredClone(run); change(changed);
    assert.throws(() => verifySciegqaPdfHeader(changed, inputs, source), /run_unqualified/);
  }
});

test('fabricated success counts, incomplete pins and invalid measured resources reject', () => {
  const {source, inputs, run} = fixture();
  for (const change of [r => {r.failedPapers = 0;}, r => {r.rows[0].elapsedMs = NaN;},
    r => {r.rows[0].peakRssBytes = 0;}]) {
    const changed = structuredClone(run); change(changed);
    assert.throws(() => verifySciegqaPdfHeader(changed, inputs, source), /run_unqualified/);
  }
  const incomplete = structuredClone(inputs); incomplete.pins.pop();
  assert.throws(() => verifySciegqaPdfHeader(run, incomplete, source), /run_unqualified/);
});
