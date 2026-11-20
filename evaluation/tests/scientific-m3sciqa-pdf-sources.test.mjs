import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {validateM3PdfCohort, validateM3PdfInputs} from '../adapters/scientific-public/m3sciqa-pdf-sources.mjs';
import {readJson} from '../lib/common.mjs';

const lockUrl = new URL('../corpora/scientific-rag/m3sciqa-pdf-sources.lock.json', import.meta.url);
const fixture = () => {
  const lock = readJson(lockUrl);
  return {lock, counts: new Map(lock.cohort.map(row => [row.paperId, row.publishedQuestions]))};
};

test('preselected PDF cohort retains failure and all published questions', () => {
  const {lock, counts} = fixture();
  validateM3PdfCohort(counts, lock);
  assert.equal(lock.cohort.length, 45);
  assert.equal(lock.publishedQuestions, 308);
  assert.equal(lock.sources[0].files.length, 44);
  assert.deepEqual(lock.cohort.find(row => row.status === 'failed'),
    {paperId: '2202.03052', publishedQuestions: 6, status: 'failed', failure: 'not a bounded PDF'});
});
test('selection order and PDF/question omissions are rejected', () => {
  const {lock, counts} = fixture();
  const changed = structuredClone(lock);
  changed.cohort.reverse();
  assert.throws(() => validateM3PdfCohort(counts, changed), /cohort_changed/);
  const missing = structuredClone(lock);
  missing.cohort.pop();
  assert.throws(() => validateM3PdfCohort(counts, missing), /cohort_changed/);
  const extraCounts = new Map(counts);
  extraCounts.set('2401.00001', 100);
  assert.throws(() => validateM3PdfCohort(extraCounts, lock), /cohort_changed/);
});
test('failed downloads cannot acquire a fabricated successful source pin', () => {
  const {lock, counts} = fixture();
  const failure = lock.cohort.find(row => row.status === 'failed');
  failure.status = 'downloaded';
  assert.throws(() => validateM3PdfCohort(counts, lock), /cohort_changed/);
});
test('duplicate, untrusted, unbounded and falsely licensed PDF pins are rejected', () => {
  const {lock, counts} = fixture();
  const duplicate = structuredClone(lock);
  duplicate.sources[0].files[1] = duplicate.sources[0].files[0];
  assert.throws(() => validateM3PdfCohort(counts, duplicate), /cohort_changed/);
  for (const override of [{url: 'https://example.com/other.pdf'}, {bytes: 33 * 1024 * 1024},
    {license: 'CC-BY-4.0'}, {revisionCorrespondence: 'human-verified'}]) {
    const changed = structuredClone(lock);
    Object.assign(changed.sources[0].files[0], override);
    assert.throws(() => validateM3PdfCohort(counts, changed), /pin_invalid/);
  }
});
test('altered published labels fail before source acquisition', t => {
  const root = mkdtempSync(join(tmpdir(), 'roc-m3-pdf-labels-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  writeFileSync(join(root, 'labels.json'), '[]');
  assert.throws(() => validateM3PdfInputs(root), /labels_changed/);
});
