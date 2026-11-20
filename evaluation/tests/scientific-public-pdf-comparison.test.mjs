import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hash} from '../lib/common.mjs';
import {comparePublicPdfReports} from '../adapters/scientific-public/pdf-comparison.mjs';

function attempt(failed = false) {
  const rows = Array.from({length: 45}, (_, i) => ({paperId: `paper-${i}`, status: failed && i === 44 ? 'failed' : 'parsed',
    sourceVerified: true, geometryVerified: !(failed && i === 44), resultHash: `output-${i}`}));
  const inputs = {sourceLockHash: 'lock', codeHashes: {parser: 'code'}, modelHashes: {model: 'weights'},
    modelManifest: 'model', parserOptions: {tier: 'complete'}, pins: ['fixed'],
    compiledBundleHashes: [{name: 'parser', sha256: 'bundle'}]};
  const run = {...inputs, kind: 'scientific-public-full-pdf-parser-component-run', cohortComplete: true,
    nodeVersion: 'fixed-node', papers: 45, rows};
  const verified = {kind: 'scientific-public-full-pdf-provenance-component-baseline',
    status: 'verified-provenance-unscored-quality', sourceLockHash: 'lock', parserCodeHashes: inputs.codeHashes,
    modelHashes: inputs.modelHashes, modelManifest: inputs.modelManifest, verifierCodeHashes: {verifier: 'fixed'},
    root: 'synthetic-contract-only', papers: 45, rows, runHash: hash(run), deterministicOutputHash: hash(rows),
    parsedPapers: failed ? 44 : 45, failedPapers: failed ? 1 : 0, verifiedPages: failed ? 44 : 45,
    performance: {paperP50Ms: 1}};
  return {run, inputs, verified};
}
test('cancellation changing to success preserves denominator and cannot establish complete repeatability', () => {
  const report = comparePublicPdfReports([attempt(true), attempt()]);
  assert.equal(report.papers, 45); assert.equal(report.commonParsedPapers, 44);
  assert.equal(report.commonParsedOutputsEqual, true);
  assert.equal(report.completeSuccessfulCohortRepeatable, false);
  assert.equal(report.changed[0].paperId, 'paper-44');
  assert.equal(report.scientificBaselineReady, false);
});
test('equal successful cohorts compare only deterministic outputs; performance differences remain measurements', () => {
  const second = attempt(); second.verified.performance.paperP50Ms = 9;
  const report = comparePublicPdfReports([attempt(), second]);
  assert.equal(report.completeSuccessfulCohortRepeatable, true);
  assert.equal(report.scientificBaselineReady, false);
  assert.equal(report.attempts[1].performance.paperP50Ms, 9);
});
test('changed output among common successful papers is reported despite otherwise identical identities', () => {
  const second = attempt(); second.verified.rows[2].resultHash = 'changed'; second.verified.deterministicOutputHash = hash(second.verified.rows);
  second.verified.runHash = hash(second.run);
  const report = comparePublicPdfReports([attempt(), second]);
  assert.equal(report.commonParsedOutputsEqual, false); assert.equal(report.completeSuccessfulCohortRepeatable, false);
  assert.deepEqual(report.changed.map(row => row.paperId), ['paper-2']);
});
test('tampered report bindings, duplicate papers and changed execution identities are rejected', () => {
  for (const mutate of [
    a => {a.verified.runHash = 'changed';},
    a => {a.verified.rows[1].paperId = a.verified.rows[0].paperId; a.verified.runHash = hash(a.run); a.verified.deterministicOutputHash = hash(a.verified.rows);},
    a => {a.inputs.compiledBundleHashes = [];},
    a => {a.run.nodeVersion = 'other'; a.verified.runHash = hash(a.run);},
    a => {a.inputs.pins = ['other'];},
    a => {a.verified.verifierCodeHashes = {verifier: 'other'};}
  ]) {
    const second = attempt(); mutate(second);
    assert.throws(() => comparePublicPdfReports([attempt(), second]), /scientific_pdf_comparison_/);
  }
});
