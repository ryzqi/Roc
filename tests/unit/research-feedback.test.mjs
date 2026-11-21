import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import * as yazl from 'yazl';
import {PDFDocument, PDFHexString, PDFName, StandardFonts} from 'pdf-lib';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi, unknownExperiment, withResearchTestWorker} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = value => createHash('sha256').update(value).digest('hex');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function docx(files) {
  const zip = new yazl.ZipFile(), chunks = [];
  const end = new Promise((resolve, reject) => {
    zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('error', reject); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, text] of Object.entries(files)) zip.addBuffer(Buffer.from(text), name);
  zip.end();
  return end;
}
const wordFeedback = () => docx({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="comments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>',
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Mean: 42 ms.</w:t></w:r><w:commentRangeEnd w:id="1"/>
  <w:commentRangeStart w:id="2"/><w:r><w:t>repeated</w:t></w:r><w:commentRangeEnd w:id="2"/>
  <w:ins w:id="11" w:author="Collaborator" w:date="2026-11-22T01:00:00Z"><w:r><w:t>More observations.</w:t></w:r></w:ins>
  <w:del w:id="12" w:author="Collaborator"><w:r><w:delText>42</w:delText></w:r></w:del></w:p></w:body></w:document>`,
  'word/comments.xml': `<w:comments xmlns:w="${W}"><w:comment w:id="1" w:author="Anonymous reviewer" w:date="2026-11-22T01:00:00Z"><w:p><w:r><w:t>Please report the sample size.</w:t></w:r></w:p></w:comment>
  <w:comment w:id="2" w:author="Second reviewer"><w:p><w:r><w:t>Clarify repeated wording.</w:t></w:r></w:p></w:comment>
  <w:comment w:id="3"><w:p><w:r><w:t>This unanchored comment remains unmatched.</w:t></w:r></w:p></w:comment></w:comments>`
});

async function scene() {
  const root = await mkdtemp(join(tmpdir(), 'roc-feedback-'));
  const f = createResearchFixture(api, 'writing', root);
  f.repository.knowledge.upsertFromSource({id: 'feedback-original', projectId: f.project.id, sourceType: 'file', sourceId: 'results.csv',
    title: 'Engineering observations', content: 'Mean 42 ms.', chunks: [{content: 'Mean 42 ms.', locator: 'block:0'}], embeddingPolicy: 'none'});
  const source = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'feedback-original:chunk:0'});
  const completed = withResearchTestWorker(api, f.repository, f.run.id, f.project.id, id => f.repository.runs.complete(id, f.project.id, {
    title: 'Existing paper', markdown: 'Existing record', verdict: 'ready', sections: [{title: 'Results', claimIndexes: [0, 1]}],
    claims: ['Mean: 42 ms.', 'repeated repeated'].map(content => ({content, subjectType: 'paragraph', status: 'supported',
      experiment: {...unknownExperiment}, evidenceIds: [source.id]}))
  }));
  f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'writing', action: 'complete'});
  const scope = {projectId: f.project.id, artifactId: completed.outputArtifactIds[0]};
  const version = () => f.repository.inspectArtifact({...scope, expectedVersion: null}).snapshot.version;
  const human = (capability, action) => api.withResearchHumanContext({capability, projectId: f.project.id, windowId: 52}, action);
  const service = f.repository.feedback;
  const request = path => ({...scope, expectedArtifactVersion: version(), requestId: `import:${path}`, path, expectedFileHash: null});
  const close = async () => {try {await f.close();} finally {await rm(root, {recursive: true, force: true});}};
  return {...f, root, source, scope, service, version, human, request, close};
}

test('real Word comments and tracked changes preserve authors, original IDs/ranges and exact/ambiguous/unmatched locations across restart', async () => {
  const f = await scene();
  let disk, restored;
  try {
    const bytes = await wordFeedback();
    await writeFile(join(f.root, 'review.docx'), bytes);
    const request = f.request('review.docx');
    await assert.rejects(f.service.import(request), /research_human_required/u);
    const initial = await f.human('research.feedback.import', () => f.service.import(request));
    assert.equal(initial.snapshot.source.sha256, hash(bytes));
    assert.equal(initial.snapshot.actor.id, 'window:52');
    assert.equal(initial.snapshot.items.length, 5);
    const comment = initial.snapshot.items.find(item => item.id === 'comment:1');
    assert.equal(comment.originalId, '1');
    assert.equal(comment.author, 'Anonymous reviewer');
    assert.equal(comment.text, 'Please report the sample size.');
    assert.equal(comment.quote, 'Mean: 42 ms.');
    assert.equal(comment.sourceStart, 0);
    assert.equal(comment.sourceEnd, 12);
    assert.equal(comment.mapping.status, 'exact');
    assert.equal(initial.snapshot.items.find(item => item.id === 'comment:2').mapping.status, 'ambiguous');
    assert.equal(initial.snapshot.items.find(item => item.id === 'comment:3').mapping.status, 'unmatched');
    assert.equal(initial.snapshot.items.find(item => item.kind === 'insertion').text, 'More observations.');
    assert.equal(initial.snapshot.items.find(item => item.kind === 'deletion').text, '42');
    assert.equal(initial.currentArtifact, true); assert.equal(initial.sourceCurrent, true);
    assert.deepEqual(await f.human('research.feedback.import', () => f.service.import(request)), initial);
    assert.equal(f.repository.evidence.listClaims(f.scope)[0].content, 'Mean: 42 ms.');
    const path = join(f.root, 'restart.sqlite'); await f.db.backup(path); disk = new Database(path); api.applyResearchDatabaseSchema(disk);
    restored = new api.ResearchRepository(disk, f.tasks);
    assert.deepEqual(await restored.feedback.get({projectId: f.project.id, feedbackId: initial.snapshot.id}), initial);
  } finally {
    if (restored !== undefined) await Promise.all([restored.knowledgeJobs.shutdown(), restored.paperCards.shutdown(), restored.wiki.shutdown()]);
    disk?.close(); await f.close();
  }
});

test('explicit merge creates open original response comments, stales earlier review and rejects modified originals or late source drift', async () => {
  const f = await scene();
  try {
    await writeFile(join(f.root, 'review.docx'), await wordFeedback());
    const row = {commentId: 'existing', reviewer: 'Original reviewer', comment: 'Retain the original measurement.',
      status: 'open', response: '', locations: [], evidenceIds: []};
    const prior = f.human('research.responseMatrix.save', () => f.repository.responseMatrix.save({...f.scope, requestId: 'original-matrix',
      expectedArtifactVersion: f.version(), parent: null, rationale: 'Recorded original scientific question.', rows: [row]}));
    const saved = await f.human('research.feedback.import', () => f.service.import(f.request('review.docx')));
    const request = {projectId: f.project.id, feedbackId: saved.snapshot.id, expectedHash: saved.snapshotHash,
      expectedArtifactVersion: f.version(), requestId: 'merge-selected', itemIds: ['comment:1']};
    await assert.rejects(f.service.merge(request), /research_human_required/u);
    const merged = await f.human('research.feedback.merge', () => f.service.merge(request));
    assert.deepEqual(await f.human('research.feedback.merge', () => f.service.merge(request)), merged);
    assert.notEqual(merged.artifactVersion, request.expectedArtifactVersion);
    const inspect = () => f.repository.responseMatrix.inspect({...f.scope, expectedHash: null});
    assert.equal(inspect().report.reviewCurrent, false);
    assert.ok(inspect().report.openCommentIds.includes(merged.commentIds[0]));
    const opinion = inspect().report.externalComments[0];
    assert.equal(opinion.comment, 'Please report the sample size.');
    assert.equal(opinion.reviewer, 'Anonymous reviewer');
    const next = {...f.scope, requestId: 'new-response-version', expectedArtifactVersion: f.version(),
      parent: {reviewId: prior.snapshot.id, reviewHash: prior.snapshotHash}, rationale: 'Added one original collaborator comment.',
      rows: [row, {commentId: opinion.commentId, reviewer: opinion.reviewer, comment: opinion.comment, status: 'open',
        response: '', locations: [], evidenceIds: []}]};
    assert.throws(() => f.human('research.responseMatrix.save', () => f.repository.responseMatrix.save({...next, rows: [row]})), /external_comment_changed/u);
    assert.throws(() => f.human('research.responseMatrix.save', () => f.repository.responseMatrix.save({...next,
      rows: [row, {...next.rows[1], comment: 'Modified reviewer opinion'}]})), /external_comment_changed/u);
    const matrix = f.human('research.responseMatrix.save', () => f.repository.responseMatrix.save(next));
    assert.equal(matrix.snapshot.request.rows[1].status, 'open');
    assert.equal(inspect().report.reviewCurrent, true);
    assert.equal((await f.service.get({projectId: f.project.id, feedbackId: saved.snapshot.id})).currentArtifact, true);
    await writeFile(join(f.root, 'review.docx'), Buffer.from('changed original file'));
    assert.equal((await f.service.get({projectId: f.project.id, feedbackId: saved.snapshot.id})).sourceCurrent, false);
    await assert.rejects(f.human('research.feedback.merge', () => f.service.merge({...request, requestId: 'late-merge',
      expectedArtifactVersion: f.version(), itemIds: ['comment:3']})), /source_changed/u);
    assert.deepEqual(f.repository.feedback.mergedComments(f.project.id, f.scope.artifactId), [opinion]);
  } finally {await f.close();}
});

test('actual PDF highlight retains native page coordinates and only maps whole uniquely quoted text', async () => {
  const f = await scene();
  try {
    const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica), page = document.addPage([612, 792]);
    const text = 'Mean: 42 ms.'; page.drawText(text, {x: 50, y: 700, size: 12, font});
    const width = font.widthOfTextAtSize(text, 12);
    const annotation = document.context.obj({Type: PDFName.of('Annot'), Subtype: PDFName.of('Highlight'),
      Rect: [49, 695, 51 + width, 714], QuadPoints: [49, 714, 51 + width, 714, 49, 695, 51 + width, 695],
      Contents: PDFHexString.fromText('Explain this measured value.'), T: PDFHexString.fromText('PDF collaborator'), NM: PDFHexString.fromText('highlight-1')});
    page.node.addAnnot(document.context.register(annotation));
    const note = document.context.obj({Type: PDFName.of('Annot'), Subtype: PDFName.of('Text'), Rect: [20, 20, 35, 35],
      Contents: PDFHexString.fromText('Unanchored page note.'), T: PDFHexString.fromText('PDF collaborator')});
    page.node.addAnnot(document.context.register(note));
    const bytes = await document.save(); await writeFile(join(f.root, 'review.pdf'), bytes);
    const imported = await f.human('research.feedback.import', () => f.service.import(f.request('review.pdf')));
    const highlight = imported.snapshot.items.find(item => item.text === 'Explain this measured value.');
    assert.equal(highlight.page, 1);
    for (const [index, value] of [49, 695, 51 + width, 714].entries()) assert.ok(Math.abs(highlight.rect[index] - value) < 0.00001);
    assert.equal(highlight.author, 'PDF collaborator'); assert.equal(highlight.quadPoints.length, 8);
    assert.equal(highlight.quote, text); assert.equal(highlight.mapping.status, 'exact');
    assert.equal(imported.snapshot.items.find(item => item.text === 'Unanchored page note.').mapping.status, 'unmatched');
    assert.equal(hash(await readFile(join(f.root, 'review.pdf'))), imported.snapshot.source.sha256);
  } finally {await f.close();}
});

test('explicit manuscript revision lineage keeps original merged comments open without reusing old locations or unrelated paper opinions', async () => {
  const f = await scene();
  try {
    const projectId = f.project.id, artifactId = f.scope.artifactId;
    await writeFile(join(f.root, 'review.docx'), await wordFeedback());
    const imported = await f.human('research.feedback.import', () => f.service.import(f.request('review.docx')));
    await f.human('research.feedback.merge', () => f.service.merge({projectId, feedbackId: imported.snapshot.id,
      expectedHash: imported.snapshotHash, expectedArtifactVersion: f.version(), requestId: 'lineage-merge', itemIds: ['comment:1']}));
    const original = f.service.mergedComments(projectId, artifactId)[0];
    assert.notEqual(original.location, null);
    await f.human('research.manuscriptSync.attach', () => f.repository.manuscriptSync.attach({...f.scope,
      expectedArtifactVersion: f.version(), mode: 'checkout', texPath: 'paper.tex', bibPath: 'paper.bib'}));
    for (const relation of f.repository.evidence.relations.forArtifact(artifactId, projectId)) {
      f.repository.evidence.relations.review({projectId, relationId: relation.id, expectedVersion: relation.version,
        expectedClaimVersion: relation.claimVersion, expectedSourceDigest: relation.sourceDigest, decision: 'confirm', note: 'Synthetic source review.'},
      {kind: 'user', id: 'fixture-reviewer'});
    }
    f.repository.transitionWorkflow({projectId, expectedStage: 'writing', action: 'approve',
      expectedArtifactVersions: [{artifactId, version: f.version()}]});
    f.db.prepare("UPDATE research_projects SET current_stage='revision' WHERE id=?").run(projectId);
    f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='revision'").run(projectId);
    f.db.prepare("UPDATE research_review_cycles SET status='revision_required' WHERE project_id=?").run(projectId);
    await writeFile(join(f.root, 'paper.tex'), (await readFile(join(f.root, 'paper.tex'), 'utf8')).replace('42 ms.', '43 ms.'));
    const preview = await f.repository.manuscriptSync.inspect(f.scope);
    const result = await f.human('research.manuscriptSync.apply', () => f.repository.manuscriptSync.apply({...f.scope,
      expectedPreviewHash: preview.previewHash, requestId: 'revision-from-comments',
      changes: preview.changes.map(change => ({id: change.id, evidenceIds: change.evidenceIds}))}));
    assert.notEqual(result.artifactId, artifactId);
    const inherited = f.service.mergedComments(projectId, result.artifactId);
    assert.deepEqual(inherited, [{...original, location: null}]);
    const matrix = f.repository.responseMatrix.inspect({projectId, artifactId: result.artifactId, expectedHash: null});
    assert.ok(matrix.report.openCommentIds.includes(original.commentId));
    assert.equal(matrix.report.review, null);
    assert.equal(f.repository.getArtifact(result.artifactId).status, 'draft');
    const unrelated = f.repository.createArtifact({projectId, stage: 'revision', kind: 'manuscript', title: 'Unrelated paper', path: null});
    assert.deepEqual(f.service.mergedComments(projectId, unrelated.id), []);
    assert.deepEqual(f.service.mergedComments(projectId, artifactId), [original]);
  } finally {await f.close();}
});

test('office XML entities, untrusted ZIP paths, stale manuscript and mismatched source bytes fail closed without imports', async () => {
  const f = await scene();
  try {
    await writeFile(join(f.root, 'malformed.docx'), await docx({'word/document.xml': '<!DOCTYPE x [<!ENTITY outside SYSTEM "file:///etc/passwd">]><w:document/>'}));
    await assert.rejects(f.human('research.feedback.import', () => f.service.import(f.request('malformed.docx'))), /docx_invalid/u);
    const hostile = await docx({'word/document.xml': `<w:document xmlns:w="${W}"/>`, 'safe/outer.xml': '<example/>'});
    const allowed = Buffer.from('safe/outer.xml'), escaped = Buffer.from('../outside.xml');
    assert.equal(allowed.length, escaped.length);
    for (let offset = hostile.indexOf(allowed); offset !== -1; offset = hostile.indexOf(allowed, offset + escaped.length)) escaped.copy(hostile, offset);
    await writeFile(join(f.root, 'hostile.docx'), hostile);
    await assert.rejects(f.human('research.feedback.import', () => f.service.import(f.request('hostile.docx'))), /path|entry|relative|invalid/u);
    await writeFile(join(f.root, 'review.docx'), await wordFeedback());
    await assert.rejects(f.human('research.feedback.import', () => f.service.import({...f.request('review.docx'), expectedFileHash: 'f'.repeat(64)})), /source_changed/u);
    await assert.rejects(f.human('research.feedback.import', () => f.service.import({...f.request('review.docx'), expectedArtifactVersion: 'f'.repeat(64)})), /artifact_changed/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_feedback_imports').pluck().get(), 0);
  } finally {await f.close();}
});
