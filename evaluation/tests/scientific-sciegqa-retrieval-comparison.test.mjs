import assert from 'node:assert/strict';
import test from 'node:test';
import {compareSciegqaRetrievalObservations} from '../adapters/scientific-public/sciegqa-retrieval-comparison.mjs';

function attempt() {
  return {report: {root: 'fixture', sourceLockHash: 'source', cohortHash: 'cohort', parsedPapers: 44, failedPapers: 1},
    inputs: {pdfVerificationHash: 'pdf', sourceIdentities: [{id: 'source'}], correspondenceManifestHash: 'manifest',
      correspondenceInventoryHash: 'inventory', contract: {version: 1}, config: {mode: 'bm25'},
      codeHashes: {runtime: 'code'}, compiledBundleHashes: [{sha256: 'bundle'}], nodeVersion: 'node'},
    verified: {indexHash: 'index', reportHash: 'report', deterministicScoreHash: 'scores', queries: 225},
    rows: [{id: 'qualified', metrics: {recall: 0}}, {id: 'unqualified', metrics: null},
      {id: 'failed', retrievalStatus: 'failed', metrics: {recall: 0}}]};
}

test('same fixed inputs compare all retained rows including null scores and failed searches', () => {
  const first = attempt(), second = structuredClone(first); second.report.root = 'second-fixture';
  second.verified.performance = {totalMs: 999};
  const report = compareSciegqaRetrievalObservations(first, second);
  assert.equal(report.status, 'fixed-input-observations-repeatable');
  assert.equal(report.fixedInputObservationsRepeatable, true);
  assert.equal(report.scientificBaselineReady, false); assert.deepEqual(report.changedQuestionIds, []);
});

test('changed execution identities cannot establish fixed-input repeatability', () => {
  const first = attempt();
  for (const change of [a => {a.report.cohortHash = 'other';}, a => {a.inputs.codeHashes.runtime = 'other';},
    a => {a.inputs.compiledBundleHashes[0].sha256 = 'other';}, a => {a.inputs.nodeVersion = 'other';},
    a => {a.inputs.pdfVerificationHash = 'other';}, a => {a.inputs.correspondenceInventoryHash = 'other';}]) {
    const second = structuredClone(first); change(second);
    const result = compareSciegqaRetrievalObservations(first, second);
    assert.equal(result.status, 'different-execution-inputs'); assert.equal(result.fixedInputObservationsRepeatable, false);
  }
});

test('dropped failures, changed null scores and changed index remain nonrepeatable', () => {
  const first = attempt();
  for (const change of [a => {a.rows.pop();}, a => {a.rows[1].metrics = {recall: 1};},
    a => {a.rows[2].retrievalStatus = 'verified';}, a => {a.verified.indexHash = 'other';}]) {
    const second = structuredClone(first); change(second);
    assert.equal(compareSciegqaRetrievalObservations(first, second).status, 'observation-outputs-changed');
  }
  const duplicated = attempt(); duplicated.rows.push(duplicated.rows[0]);
  assert.throws(() => compareSciegqaRetrievalObservations(first, duplicated), /duplicate_question/);
});
