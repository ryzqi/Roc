import assert from 'node:assert/strict';
import test from 'node:test';
import {selectSciegqaCohort} from '../adapters/scientific-public/sciegqa-cohort.mjs';
import {createSciegqaReviewMaterials, renderSciegqaReviewDocuments,
  verifySciegqaReviewMaterials} from '../adapters/scientific-public/sciegqa-review.mjs';

function fixture() {
  const papers = [], labels = [], alignment = [], correspondencePapers = new Map();
  for (let i = 0; i < 45; i++) {
    const docName = `2301.${String(i).padStart(5, '0')}`, id = `sciegqa:cs:${docName}`;
    const image = {path: `images/cs/${docName}/1.png`, sha256: `image-${i}`, page: 1};
    papers.push({id, docName, domain: 'cs', pdf: i === 44 ? null
      : {path: `pdfs/cs/${docName}.pdf`, sha256: `pdf-${i}`}, images: [image]});
    correspondencePapers.set(id, {path: `paper-${i}.json`, artifactHash: `observed-${i}`});
    for (let q = 0; q < 5; q++) {
      const publishedRow = labels.length, questionId = `sciegqa:test:${publishedRow}`;
      const region = {id: `${questionId}:region:0`, page: 1, kind: 'image',
        normalizedBbox: [0, 0, 1, 1], pixelBbox: [0, 0, 100, 100],
        coordinateSystem: 'TOPLEFT_NORMALIZED', pageImage: image};
      labels.push({id: questionId, paperId: id, publishedRow,
        original: {query: q === 0 ? '``` <script>alert(1)</script>\n[false](https://example.org)'
          : `Original question ${q}?`, answer: `Published answer ${q}`, category: 'cs',
        doc_name: docName, evidence_page: [1], bbox: [[[0, 0, 100, 100]]],
        rel_bbox: [[[0, 0, 1000, 1000]]], subimg_type: [['image']]},
        evidence: [region], status: 'published-image-regions-verified',
        issues: [], originalPdfAlignment: 'pending'});
      alignment.push({id: questionId, paperId: id, publishedRow,
        evidence: [{publishedRegionId: region.id, observationId: `${questionId}:observation`,
          status: i === 44 ? 'source-region-unavailable' : 'visual-correspondence-candidate'}],
        status: i === 44 ? 'unqualified-source-correspondence'
          : 'all-published-regions-visual-candidates', humanLocatorReview: false});
    }
  }
  const manifest = {papers, tasks: labels.length, sourceRevision: 'published-revision',
    sourceLockHash: 'locked-release', labelsHash: 'serialized-label-file-hash',
    annotationProvenance: {kind: 'published-human-benchmark', localHumanReview: false}, license: null};
  return {manifest, labels, cohort: selectSciegqaCohort(manifest, labels),
    correspondence: {alignment}, correspondencePapers,
    sourcePins: [{path: 'original/labels.json', sha256: manifest.labelsHash}]};
}

test('retains all original sources, answers, fields and unqualified rows with null human decisions', () => {
  const inputs = fixture(), {materials, worklist} = createSciegqaReviewMaterials(inputs);
  const counts = verifySciegqaReviewMaterials(materials, worklist, inputs);
  assert.equal(counts.papers, 45); assert.equal(counts.questions, 225);
  assert.equal(counts.candidateQuestions, 220); assert.equal(counts.unqualifiedQuestions, 5);
  assert.equal(counts.regionReferences, 225);
  assert.equal(materials.papers[44].publishedPaper.pdf, null);
  assert.equal(materials.papers[44].questions[4].publishedLabel.original.answer, 'Published answer 4');
  assert.equal(worklist.queries[224].answerable, null);
  assert.equal(worklist.queries[224].expectedAnswer, null);
  assert.ok(worklist.papers.every(p => p.review === null && p.fullStructureAnnotation === null
    && p.paperLayoutCategory === null));
  assert.ok(worklist.queries.every(q => q.review === null && q.expectedEvidenceSpans === null));
});

test('rejects altered published answers/coordinates, source statuses, missing or reordered records', () => {
  const inputs = fixture(), packet = createSciegqaReviewMaterials(inputs);
  for (const mutate of [
    p => {p.materials.papers[0].questions[0].publishedLabel.original.answer = 'Model answer';},
    p => {p.materials.papers[0].questions[0].publishedLabel.evidence[0].normalizedBbox[0] = 0.1;},
    p => {p.materials.papers[44].questions[0].sourceCorrespondence.status = 'all-published-regions-visual-candidates';},
    p => {p.materials.papers[0].questions.pop();}, p => {p.materials.papers.pop();},
    p => {p.materials.papers.reverse();},
    p => {p.materials.papers[0].questions.reverse();},
    p => {p.materials.papers[0].correspondenceArtifact.artifactHash = 'changed';},
    p => {p.materials.papers[0].questions[0].retrievalResult = {rank: 1};},
  ]) {
    const changed = structuredClone(packet); mutate(changed);
    assert.throws(() => verifySciegqaReviewMaterials(changed.materials, changed.worklist, inputs),
      /scientific_sciegqa_review_materials_changed/);
  }
});

test('rejects fabricated human review, plan categories, gold spans, or negative labels in the blank packet', () => {
  const inputs = fixture(), packet = createSciegqaReviewMaterials(inputs);
  for (const mutate of [
    p => {p.worklist.papers[0].review = {status: 'reviewed', reviewer: 'invented'};},
    p => {p.worklist.papers[0].paperLayoutCategory = 'two-column';},
    p => {p.worklist.queries[0].expectedEvidenceSpans = [{quote: 'production text'}];},
    p => {p.worklist.queries[224].answerable = false;},
    p => {p.materials.scientificBaselineReady = true;},
    p => {p.worklist.humanReviewed = true;},
  ]) {
    const changed = structuredClone(packet); mutate(changed);
    assert.throws(() => verifySciegqaReviewMaterials(changed.materials, changed.worklist, inputs),
      /scientific_sciegqa_review_materials_changed/);
  }
});

test('static documents preserve raw text safely inside fences and link existing assets without copying them', () => {
  const {materials} = createSciegqaReviewMaterials(fixture());
  const documents = renderSciegqaReviewDocuments(materials,
    '/repo/evaluation/local/review-materials/test', '/repo/evaluation/local/corpora/source',
    '/repo/.artifacts/correspondence');
  assert.equal(documents.size, 46);
  assert.match(documents.get('index.md'), /\| 45 \| .* \| 5 \| 0 \/ 5 \|/);
  const first = documents.get('papers/paper-001.md');
  assert.ok(first.includes('````text\n``` <script>alert(1)</script>\n[false](https://example.org)\n````'));
  assert.ok(first.includes('[原始 PDF](<../../../corpora/source/pdfs/cs/2301.00000.pdf>)'));
  assert.ok(first.includes('[原始 PNG](<../../../corpora/source/images/cs/2301.00000/1.png>)'));
  assert.match(documents.get('papers/paper-045.md'), /来源未提供/);
});
