import assert from 'node:assert/strict';
import test from 'node:test';
import {selectSciegqaCohort, verifySciegqaCohort} from '../adapters/scientific-public/sciegqa-cohort.mjs';

function fixture() {
  const papers = [], labels = [];
  for (const domain of ['cs', 'econ', 'eess', 'math', 'physics', 'q-bio', 'q-fin', 'stat']) {
    for (let rank = 0; rank < 10; rank++) {
      const id = `${domain}:${rank}`, docName = `2301.${String(rank).padStart(5, '0')}`;
      papers.push({id, domain, docName, pdf: rank === 0 ? null : {path: `${id}.pdf`}});
      for (let row = 0; row < 8; row++) labels.push({id: `${id}:${row}`, paperId: id,
        publishedRow: labels.length, status: row % 2 ? 'unqualified' : 'qualified',
        evidence: [{id: `${id}:${row}:region`}]});
    }
  }
  return {manifest: {tasks: labels.length, papers, sourceLockHash: 'locked-source',
    sourceRevision: 'locked-revision', labelsHash: 'locked-labels', license: null,
    annotationProvenance: {kind: 'published-human-benchmark'}}, labels};
}

test('45 papers and225 original questions follow round-robin without availability filtering', () => {
  const {manifest, labels} = fixture(), cohort = selectSciegqaCohort(manifest, labels);
  assert.equal(cohort.papers.length, 45); assert.equal(cohort.questionCount, 225);
  assert.deepEqual(cohort.papers.slice(0, 8).map(p => p.domain),
    ['cs', 'econ', 'eess', 'math', 'physics', 'q-bio', 'q-fin', 'stat']);
  assert.equal(cohort.papers[0].pdf, null);
  assert.deepEqual(cohort.papers[0].questions.map(q => q.id),
    ['cs:0:0', 'cs:0:1', 'cs:0:2', 'cs:0:3', 'cs:0:4']);
  assert.ok(cohort.papers.every(p => p.paperLayoutCategory === null
    && p.questions.every(q => q.queryCategory === null)));
  assert.equal(cohort.scientificBaselineReady, false);
});

test('source order and correspondence statuses never change preselection', () => {
  const {manifest, labels} = fixture(), cohort = selectSciegqaCohort(manifest, labels);
  manifest.papers.reverse(); labels.reverse();
  for (const q of labels) q.status = 'arbitrary-failure';
  assert.deepEqual(selectSciegqaCohort(manifest, labels), cohort);
});

test('omitted, reordered or reclassified cohort inputs fail independent reconstruction', () => {
  const {manifest, labels} = fixture(), cohort = selectSciegqaCohort(manifest, labels);
  verifySciegqaCohort(cohort, manifest, labels);
  for (const change of [c => c.papers.pop(), c => c.papers.reverse(),
    c => {c.papers[0].questions.pop();}, c => {c.papers[0].paperLayoutCategory = 'two-column';}]) {
    const changed = structuredClone(cohort); change(changed);
    assert.throws(() => verifySciegqaCohort(changed, manifest, labels), /cohort_changed/);
  }
  assert.throws(() => selectSciegqaCohort({...manifest, papers: manifest.papers.slice(0, 44)}, labels),
    /insufficient_papers/);
  const incomplete = labels.filter(q => q.paperId !== manifest.papers[0].id);
  assert.throws(() => selectSciegqaCohort({...manifest, tasks: incomplete.length}, incomplete),
    /insufficient_questions/);
});
