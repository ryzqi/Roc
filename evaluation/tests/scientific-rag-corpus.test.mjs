import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { hash, sha256 } from '../lib/common.mjs';
import {
  checkScientificRagCorpus, scientificPaperQuotas, scientificQueryQuotas, scientificReviewContentHash
} from '../lib/scientific-rag-corpus.mjs';

// All PDFs, gold and review names below are fabricated test inputs, confined
// to disposable temp directories. They are never scientific quality evidence.
let fixtureRoot;
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const review = value => ({
  ...value, review: {
    status: 'reviewed',
    annotations: ['test-reviewer-a', 'test-reviewer-b'].map(reviewer => ({
      reviewer, reviewedAt: '2026-11-16T00:00:00.000Z',
      contentHash: scientificReviewContentHash(value), judgmentHash: hash('test-agree')
    })), arbitration: null
  }
});
function isolated(t) {
  const root = mkdtempSync(join(tmpdir(), 'roc-scientific-corpus-test-'));
  cpSync(fixtureRoot, root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function changeAnnotation(root, index, mutate) {
  const manifest = read(join(root, 'manifest.json')), paper = manifest.papers[index];
  const path = join(root, paper.annotationPath), annotation = read(path);
  mutate(annotation);
  write(path, annotation);
  paper.annotationHash = sha256(readFileSync(path));
  write(join(root, 'manifest.json'), manifest);
}
function changeQueries(root, mutate) {
  const manifest = read(join(root, 'manifest.json')), path = join(root, manifest.queriesPath);
  const queries = read(path);
  mutate(queries);
  write(path, queries);
  manifest.queriesHash = sha256(readFileSync(path));
  write(join(root, 'manifest.json'), manifest);
}
const hasIssue = (report, code) => report.issues.some(issue => issue.code === code);
const check = root => checkScientificRagCorpus(join(root, 'manifest.json'));

before(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'roc-scientific-corpus-fixture-'));
  for (const dir of ['papers', 'annotations', 'queries']) mkdirSync(join(fixtureRoot, dir));
  const manifest = {
    schemaVersion: 1, id: 'test-only-synthetic-corpus',
    provenance: { kind: 'human_reviewed', producer: 'test-producer',
      sourceRevision: 'test-only-revision', license: 'test-only' },
    papers: [], queriesPath: 'queries/queries.json', queriesHash: null
  };
  const annotations = [];
  for (const [category, count] of Object.entries(scientificPaperQuotas)) {
    for (let i = 0; i < count; i++) {
      const paperId = `paper-${manifest.papers.length}`, pdf = await PDFDocument.create();
      pdf.setTitle(`Synthetic test ${paperId}`);
      pdf.addPage([600, 800]).drawText(`Synthetic test ${paperId}`);
      const pdfBytes = await pdf.save(), sourceHash = sha256(pdfBytes);
      const annotation = review({
        schemaVersion: 1, annotationVersion: 'scientific-gold-v1', paperId, sourceHash, parseRef: null,
        coordinateSystem: 'TOPLEFT_NORMALIZED',
        pages: [{ page: 1, transcript: `Synthetic test ${paperId}` }],
        blocks: ['text', 'table', 'figure', 'equation'].map((kind, index) => ({
          blockId: `${paperId}-${kind}`, page: 1, kind, bbox: [0, index / 4, 1, (index + 1) / 4],
          text: ` Evidence ${paperId} ${kind} `, readingOrder: index
        })),
        expectedSections: [{ id: `${paperId}-section`, title: 'Test', blockIds: [`${paperId}-text`] }],
        expectedTables: [{ id: `${paperId}-table-object`, blockId: `${paperId}-table`,
          html: '<table><tr><td>test</td></tr></table>',
          cells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: 'test' }] }],
        expectedFigures: [{ id: `${paperId}-figure-object`, blockId: `${paperId}-figure`, caption: 'Test' }],
        expectedEquations: [{ id: `${paperId}-equation-object`, blockId: `${paperId}-equation`,
          latex: 'x=1', normalizedLatex: 'x=1', normalizationVersion: 'test-v1' }],
        expectedCitations: []
      });
      const paper = { paperId, sourceHash, category, sourceUri: `https://fixture.invalid/${paperId}`,
        license: 'test-only', pdfPath: `papers/${paperId}.pdf`,
        annotationPath: `annotations/${paperId}.json`, annotationHash: '' };
      writeFileSync(join(fixtureRoot, paper.pdfPath), pdfBytes);
      write(join(fixtureRoot, paper.annotationPath), annotation);
      paper.annotationHash = sha256(readFileSync(join(fixtureRoot, paper.annotationPath)));
      manifest.papers.push(paper); annotations.push(annotation);
    }
  }
  const queries = [];
  for (const [category, count] of Object.entries(scientificQueryQuotas)) {
    for (let i = 0; i < count; i++) {
      const answerable = category !== 'unanswerable';
      const targets = category === 'cross-paper' ? annotations.slice(0, 2) : [annotations[i % annotations.length]];
      const kind = category === 'table-results' ? 'table' : category === 'figure' ? 'figure' : 'text';
      const blocks = targets.map(target => target.blocks.find(block => block.kind === kind));
      queries.push(review({
        id: `query-${queries.length}`, category, query: `Synthetic ${category} question ${i}`,
        targetPaperIds: targets.map(target => target.paperId),
        targetBlockIds: blocks.map(block => block.blockId),
        targetTableIds: category === 'table-results' ? targets.map(target => target.expectedTables[0].id) : [],
        targetFigureIds: category === 'figure' ? targets.map(target => target.expectedFigures[0].id) : [],
        targetEquationIds: [],
        expectedEvidenceSpans: answerable ? targets.map((target, index) => ({
          id: `gold-${index}`, paperId: target.paperId, sourceHash: target.sourceHash,
          blockId: blocks[index].blockId, page: 1, start: 0, end: blocks[index].text.length,
          quote: blocks[index].text, relevance: 3
        })) : [],
        expectedAnswer: answerable ? 'Synthetic test answer' : null,
        answerable, unanswerableReason: answerable ? null : 'Synthetic evidence is insufficient.'
      }));
    }
  }
  write(join(fixtureRoot, manifest.queriesPath), queries);
  manifest.queriesHash = sha256(readFileSync(join(fixtureRoot, manifest.queriesPath)));
  write(join(fixtureRoot, 'manifest.json'), manifest);
});
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

test('complete declared records meet exact quotas deterministically but never constitute a measured baseline', async t => {
  const root = isolated(t), report = await check(root);
  assert.equal(report.corpusReady, true, JSON.stringify(report.issues));
  assert.equal(report.verifiedPapers, 45);
  assert.equal(report.verifiedQueries, 200);
  assert.equal(report.scientificBaselineReady, false);
  assert.deepEqual(report, await check(root));
});

test('committed empty corpus is blocked with all category deficits and no invented scores', async () => {
  const path = resolve('evaluation/corpora/scientific-rag/manifest.json');
  const report = await checkScientificRagCorpus(path);
  assert.equal(report.corpusReady, false);
  assert.equal(report.verifiedPapers, 0);
  assert.equal(report.verifiedQueries, 0);
  assert.equal(report.issues.filter(issue => issue.code.includes('quota_missing')).length, 14);
  assert.ok(hasIssue(report, 'human_reviewed_provenance_missing'));
  assert.deepEqual(report, await checkScientificRagCorpus(path));
});

test('engineering fixture provenance cannot qualify even with complete asserted review records', async t => {
  const root = isolated(t), manifest = read(join(root, 'manifest.json'));
  manifest.provenance.kind = 'engineering_fixture';
  write(join(root, 'manifest.json'), manifest);
  assert.ok(hasIssue(await check(root), 'human_reviewed_provenance_missing'));
});

test('duplicate PDF bytes and duplicate paper IDs cannot meet quotas', async t => {
  for (const field of ['sourceHash', 'paperId']) {
    const root = isolated(t), manifest = read(join(root, 'manifest.json'));
    manifest.papers[1][field] = manifest.papers[0][field];
    write(join(root, 'manifest.json'), manifest);
    const report = await check(root);
    assert.equal(report.corpusReady, false);
    assert.equal(report.verifiedPapers, 44);
    assert.ok(hasIssue(report, field === 'sourceHash' ? 'duplicate_pdf_source' : 'duplicate_paper'));
  }
});

test('missing sources, changed PDF bytes, changed annotations and unlocked questions are refused', async t => {
  const mutations = [
    [root => rmSync(join(root, 'papers/paper-0.pdf')), 'file_missing'],
    [root => writeFileSync(join(root, 'papers/paper-0.pdf'), 'changed bytes'), 'pdf_source_changed'],
    [root => writeFileSync(join(root, 'annotations/paper-0.json'), '{}'), 'annotation_file_changed'],
    [root => writeFileSync(join(root, 'queries/queries.json'), '[]'), 'queries_file_changed_or_unlocked']
  ];
  for (const [mutate, code] of mutations) {
    const root = isolated(t); mutate(root);
    assert.ok(hasIssue(await check(root), code), code);
  }
});

test('rehashing a changed annotation cannot reuse the old human review', async t => {
  const root = isolated(t);
  changeAnnotation(root, 0, annotation => { annotation.pages[0].transcript = 'Changed human gold'; });
  assert.ok(hasIssue(await check(root), 'review_content_changed'));
});

test('independent reviewers and disagreement arbitration bind the actual content', async t => {
  const root = isolated(t);
  changeAnnotation(root, 0, annotation => { annotation.review.annotations[0].reviewer = 'test-producer'; });
  assert.ok(hasIssue(await check(root), 'independent_reviews_required'));
  const disagree = isolated(t);
  changeAnnotation(disagree, 0, annotation => { annotation.review.annotations[0].judgmentHash = hash('different'); });
  assert.ok(hasIssue(await check(disagree), 'review_arbitration_required'));
  changeAnnotation(disagree, 0, annotation => {
    annotation.review.arbitration = { reviewer: 'test-reviewer-c', reviewedAt: '2026-11-16T00:00:00.000Z',
      contentHash: scientificReviewContentHash(annotation), resolution: 'Test-only resolution' };
  });
  assert.equal((await check(disagree)).corpusReady, true);
});

test('invalid pages, bounds, object references and merged-cell overlap are rejected', async t => {
  const mutations = [
    [a => { a.pages[0].page = 2; }, 'annotation_pages_incomplete'],
    [a => { a.blocks[0].bbox[2] = 2; }, 'annotation_locator_invalid'],
    [a => { a.expectedFigures[0].blockId = 'absent'; }, 'object_block_missing_or_wrong_kind'],
    [a => { a.expectedTables[0].cells.push({ ...a.expectedTables[0].cells[0] }); }, 'table_cells_overlap']
  ];
  for (const [mutate, code] of mutations) {
    const root = isolated(t);
    changeAnnotation(root, 0, annotation => { mutate(annotation); Object.assign(annotation, review(annotation)); });
    assert.ok(hasIssue(await check(root), code), code);
  }
});

test('gold spans require exact source, page, block and UTF-16 text including whitespace', async t => {
  const mutations = [
    q => { q.expectedEvidenceSpans[0].quote = 'Wrong quote'; },
    q => { q.expectedEvidenceSpans[0].sourceHash = hash('wrong'); },
    q => { q.expectedEvidenceSpans[0].page = 2; },
    q => { q.expectedEvidenceSpans[0].end++; }
  ];
  for (const mutate of mutations) {
    const root = isolated(t);
    changeQueries(root, queries => { mutate(queries[0]); queries[0] = review(queries[0]); });
    assert.ok(hasIssue(await check(root), 'query_evidence_source_or_span_changed'));
  }
});

test('unanswerable questions need a rationale and cannot carry positive gold or an answer', async t => {
  const root = isolated(t);
  changeQueries(root, queries => {
    const query = queries.find(query => !query.answerable);
    query.expectedAnswer = 'Invented answer';
    Object.assign(query, review(query));
  });
  assert.ok(hasIssue(await check(root), 'query_answerability_gold_mismatch'));
});

test('cross-paper gold must cover two sources and table questions require a real table target', async t => {
  const root = isolated(t);
  changeQueries(root, queries => {
    const query = queries.find(query => query.category === 'cross-paper');
    query.expectedEvidenceSpans.pop(); Object.assign(query, review(query));
  });
  assert.ok(hasIssue(await check(root), 'cross_paper_evidence_missing'));
  const tables = isolated(t);
  changeQueries(tables, queries => {
    const query = queries.find(query => query.category === 'table-results');
    query.targetTableIds = []; Object.assign(query, review(query));
  });
  assert.ok(hasIssue(await check(tables), 'query_table_targets_missing'));
});

test('duplicate questions with new IDs and duplicate evidence do not count twice', async t => {
  const root = isolated(t);
  changeQueries(root, queries => {
    const duplicate = structuredClone(queries[0]);
    duplicate.id = 'different-id'; queries.push(review(duplicate));
    queries[1].expectedEvidenceSpans.push({ ...queries[1].expectedEvidenceSpans[0], id: 'different-gold-id' });
    queries[1] = review(queries[1]);
  });
  const report = await check(root);
  assert.equal(report.verifiedQueries, 199);
  assert.ok(hasIssue(report, 'duplicate_question'));
  assert.ok(hasIssue(report, 'duplicate_evidence_span'));
});

test('relative and symlink escapes cannot read files outside the corpus', async t => {
  for (const link of [false, true]) {
    const root = isolated(t), manifest = read(join(root, 'manifest.json'));
    if (link) {
      symlinkSync(join(fixtureRoot, 'papers/paper-0.pdf'), join(root, 'outside.pdf'));
      manifest.papers[0].pdfPath = 'outside.pdf';
    } else manifest.papers[0].pdfPath = '../outside.pdf';
    write(join(root, 'manifest.json'), manifest);
    const report = await check(root);
    assert.equal(report.corpusReady, false);
    assert.ok(hasIssue(report, 'corpus_path_outside_root'));
    assert.ok(!JSON.stringify(report).includes(fixtureRoot));
  }
});

test('invalid PDF with a matching hash and unknown schema fields still fail qualification', async t => {
  const root = isolated(t), manifest = read(join(root, 'manifest.json'));
  const bytes = Buffer.from('This is not a PDF.');
  writeFileSync(join(root, manifest.papers[0].pdfPath), bytes);
  manifest.papers[0].sourceHash = sha256(bytes);
  write(join(root, 'manifest.json'), manifest);
  assert.ok(hasIssue(await check(root), 'pdf_invalid'));
  manifest.extra = 'unknown field';
  write(join(root, 'manifest.json'), manifest);
  assert.ok(hasIssue(await check(root), 'schema_invalid'));
});

test('table or figure target cannot qualify with unrelated text evidence', async t => {
  const root = isolated(t);
  changeQueries(root, queries => {
    const query = queries.find(query => query.category === 'table-results');
    const blockId = query.targetBlockIds[0].replace('-table', '-text');
    const annotation = read(join(root, `annotations/${query.targetPaperIds[0]}.json`));
    const block = annotation.blocks.find(block => block.blockId === blockId);
    query.targetBlockIds = [blockId];
    Object.assign(query.expectedEvidenceSpans[0], { blockId, end: block.text.length, quote: block.text });
    Object.assign(query, review(query));
  });
  assert.ok(hasIssue(await check(root), 'query_object_evidence_missing'));
});

test('CLI returns exit 2 for missing data, writes only a new readiness file and refuses overwrite', t => {
  const root = isolated(t), output = join(root, 'readiness.json');
  const script = resolve('scripts/check-scientific-rag-corpus.mjs');
  const args = [script, '--corpus', resolve('evaluation/corpora/scientific-rag/manifest.json'), '--output', output];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 2, first.stderr);
  const before = readFileSync(output);
  assert.equal(read(output).status, 'blocked');
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(second.status, 0);
  assert.deepEqual(readFileSync(output), before);
  const missing = spawnSync(process.execPath, [script, '--corpus', join(root, 'missing.json')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.ok(hasIssue(JSON.parse(missing.stdout), 'file_missing'));
});
