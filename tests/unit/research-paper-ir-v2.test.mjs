import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, readFile, writeFile, rm, readdir, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let builder, repository, validator, tables, equations, visuals, quality, legacy, api;
before(async () => {
  [builder, repository, validator, tables, equations, visuals, quality, legacy] = await Promise.all([
    'paper-ir-builder', 'paper-ir-repository', 'paper-ir-validation', 'pdf-table-extractor', 'pdf-equation-extractor',
    'pdf-caption-linker', 'pdf-quality-assessor', 'paper-ir'].map(name => importTypeScriptModule(
      `src/main/plugins/research/${name}.ts`, {platform: 'node'})));
  api = await loadResearchTestApi();
});
after(() => api?.dispose());
const block = (id, kind, text, y = 10) => ({id, kind, text, label: kind, locator: `page 1 ${id}`,
  imagePath: null, locations: [{page: 1, bbox: [10, y, 300, y + 20], coordinateOrigin: 'TOPLEFT'}]});
const identity = {paperId: 'paper', documentId: 'document', parseId: 'parse:one', knowledgeDocumentId: 'document:parse:one',
  sourceHash: 'a'.repeat(64), parserFingerprint: 'b'.repeat(64)};
const formulaPages = [{regions: [{id: 'equation', formula: 'x = y \\tag{2}'}]}];
function source() {
  const blocks = [
    block('method', 'heading', '2 Method'),
    block('body', 'paragraph', 'We use original method [1]. Figure 1 and Eq. (2) describe it.', 40),
    block('algorithm', 'paragraph', 'Algorithm 1 Exact procedure\n1: Original input\n2: Return original output', 70),
    block('fig', 'figure', '', 110), block('caption', 'paragraph', 'Figure 1: Original caption.', 135),
    block('equation', 'formula', 'x = y \\tag{2}', 165),
    block('definition', 'paragraph', 'where $x$ denotes the original input.', 190),
    block('table', 'table', 'original cells', 220),
    block('refs', 'heading', 'References', 250),
    block('reference', 'paragraph', '[1] Original author. Original paper.', 280)
  ];
  blocks[7].table = tables.extractPaperTable(blocks[7], {id: 'table',
    rawHtml: '<table><tr><th>Metric</th><th>F1 (%)</th></tr><tr><td>Original</td><td>90</td></tr></table>'});
  const enriched = visuals.attachPaperVisuals(equations.attachPaperEquations(blocks, formulaPages));
  const report = quality.assessPdfQuality({pages: [{page: 1, coordinateFrame: {
    kind: 'image', page: 1, width: 400, height: 400, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT'}, regions: []}],
    blocks: enriched});
  return {sourceHash: identity.sourceHash, parserFingerprint: identity.parserFingerprint, blocks: enriched, quality: report};
}
test('parse-bound IR retains original objects, table cells, exact algorithms/citations and finite relations', () => {
  const content = source(), ir = builder.buildPaperIR({identity, content});
  assert.deepEqual(ir.blocks.map(b => b.text), content.blocks.map(b => b.text));
  assert.equal(ir.tables.length, 1); assert.equal(ir.tables[0].cells.length, 4);
  assert.equal(ir.tables[0].cells.at(-1).text, '90');
  assert.equal(ir.tables[0].cells[0].sourceLocator.locations[0].bbox, null);
  assert.equal(ir.figures.length, 1); assert.equal(ir.equations.length, 1);
  assert.equal(ir.algorithms.length, 1); assert.equal(ir.algorithms[0].steps.length, 3);
  assert.equal(ir.references.length, 1); assert.equal(ir.citations.length, 1);
  assert.equal(ir.citations[0].status, 'linked'); assert.deepEqual(ir.citations[0].targetIds, [ir.references[0].id]);
  assert.ok(ir.relations.some(r => r.type === 'caption_of' && r.status === 'linked'));
  assert.ok(ir.relations.some(r => r.type === 'references' && r.toId === ir.equations[0].id));
  assert.ok(ir.relations.every(r => r.type !== 'supports'));
  assert.deepEqual(legacy.paperBlocks(content.blocks, identity).map(b => b.content), content.blocks.map(b => b.text));
  const next = builder.buildPaperIR({identity: {...identity, parseId: 'parse:two'}, content});
  assert.ok(validator.paperIRObjects(ir).every(o => !validator.paperIRObjects(next).some(n => n.id === o.id)));
  assert.deepEqual(builder.buildPaperIR({identity, content}), ir);
});
test('ambiguous and missing numbered references remain candidates with exact marker spans', () => {
  const content = source();
  content.blocks.push(block('duplicate', 'paragraph', '[1] A second original reference.', 310));
  content.blocks[1].text = 'Original text [1, 99].';
  content.blocks = visuals.attachPaperVisuals(equations.attachPaperEquations(content.blocks, formulaPages));
  const ir = builder.buildPaperIR({identity, content}), citation = ir.citations[0];
  assert.equal(citation.status, 'candidate'); assert.equal(citation.targetIds.length, 2);
  assert.deepEqual(citation.unresolvedTargets, ['1', '99']);
  assert.equal(citation.text, '[1, 99]');
  const span = citation.sourceLocator.textSpan;
  assert.equal(content.blocks[1].text.slice(span.start, span.end), citation.text);
});
test('IR validation rejects mismatched source, section, cell, formula, relation and citation identities', () => {
  const content = source(), ir = builder.buildPaperIR({identity, content});
  for (const mutate of [
    v => {v.blocks[0].sourceLocator.parseHash = 'c'.repeat(64);},
    v => {v.sections[0].title = 'invented';},
    v => {v.tables[0].cells[0].text = 'invented';},
    v => {v.equations[0].data.rawLatex = 'invented';},
    v => {v.relations[0].toId = 'foreign';},
    v => {v.citations[0].text = '[99]';},
    v => {v.blocks[0].id = 'foreign';},
    v => {v.tables[0].cells[0].sourceLocator.locations[0].bbox = [1, 2, 3, 4];},
    v => {v.algorithms[0].steps[0].text = 'invented';},
    v => {v.citations[0].id = 'foreign'; v.citations[0].sourceLocator.objectId = 'foreign';},
    v => {v.algorithms[0].sourceLocator.locations[0].bbox = [1, 2, 3, 4];},
    v => {v.relations[0].type = 'defines';},
    v => {v.algorithms[0].steps.pop();}
  ]) {
    const bad = structuredClone(ir); mutate(bad);
    assert.throws(() => validator.validatePaperIR(bad));
  }
  assert.throws(() => builder.buildPaperIR({identity: {...identity, sourceHash: 'c'.repeat(64)}, content}), /source_invalid/);
  const withoutQuality = {...content}; delete withoutQuality.quality;
  assert.throws(() => builder.buildPaperIR({identity, content: withoutQuality}), /source_invalid/);
});
test('immutable artifacts survive repeat/concurrent publication and restart; corruption/symlinks/scope reject', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-ir-')));
  try {
    const store = new repository.PaperIRRepository(root), ir = builder.buildPaperIR({identity, content: source()});
    const [a, b] = await Promise.all([store.publish(ir), store.publish(ir)]);
    assert.deepEqual(a, b);
    const original = await readFile(join(root, a.path));
    const next = await store.publish(builder.buildPaperIR({identity: {...identity, parseId: 'parse:two'}, content: source()}));
    const restarted = new repository.PaperIRRepository(root);
    assert.deepEqual(await restarted.read(a, {paperId: 'paper', parseId: identity.parseId}), ir);
    assert.ok(!restarted.isCurrent(a, next)); assert.ok(restarted.isCurrent(next, next));
    assert.deepEqual(await readFile(join(root, a.path)), original);
    assert.equal(restarted.object(ir, ir.tables[0].cells[0].id).text, 'Metric');
    await assert.rejects(restarted.read(a, {paperId: 'foreign'}), /scope_invalid/);
    await writeFile(join(root, a.path), original.toString().replace('Original author', 'Invented author'));
    await assert.rejects(restarted.read(a), /artifact_changed/);
    await writeFile(join(root, a.path), original);
    const invalid = structuredClone(ir); invalid.relations[0].toId = 'absent';
    const before = await readdir(join(root, 'paper-ir'));
    await assert.rejects(store.publish(invalid));
    assert.deepEqual(await readdir(join(root, 'paper-ir')), before);
    const badRoot = join(root, 'symlink-root');
    await symlink(join(root, 'paper-ir'), badRoot);
    await assert.rejects(new repository.PaperIRRepository(root).read({...a, path: `symlink-root/${a.path.split('/').slice(1).join('/')}`}), /symlink/);
  } finally {await rm(root, {recursive: true, force: true});}
});
test('project publication retains an empty figure in IR and cache without inventing text or replacing valid rows on failure', async () => {
  const f = createResearchFixture(api, 'reading');
  try {
    f.repository.indexing.bindRoot(f.project.id, f.project.workspacePath);
    f.repository.indexing.reconcile(f.project.id, f.repository.indexing.beginScan(f.project.id),
      [{path: 'original.pdf', kind: 'pdf', size: 100, signature: 'fixture'}], false, null,
      new Map([['pdf', 'fixture-parser']]));
    const job = f.repository.indexing.beginJob(f.repository.indexing.nextJob().id);
    const paperId = `project-index:${job.fileId}`, content = source();
    const scoped = {...identity, paperId, documentId: paperId, knowledgeDocumentId: paperId};
    const ir = builder.buildPaperIR({identity: scoped, content});
    const chunks = legacy.paperBlocks(content.blocks, {paperId, parseId: scoped.parseId, sourceHash: scoped.sourceHash});
    const payload = {content: chunks.map(c => c.content).join('\n\n'), chunks,
      sourceHash: identity.sourceHash, parserFingerprint: identity.parserFingerprint,
      parserKey: job.input.parserKey, parserVersion: 'fixture-parser', parseArtifactId: identity.parseId,
      artifactPath: 'artifacts/fixture', paperIR: repository.paperIRArtifact(ir), paperIRVersion: ir.version};
    f.repository.indexing.publishText(job, payload, 'sources/original.pdf');
    const cached = f.repository.indexing.cached(job.fileId).payload;
    assert.equal(cached.chunks.find(c => c.semantic.blockId === 'fig').content, '');
    assert.equal(ir.figures.length, 1);
    assert.ok(f.repository.knowledge.knowledgeChunks(paperId).every(c => c.content.trim()));
    const before = f.db.prepare('SELECT * FROM research_knowledge_chunks ORDER BY id').all();
    const bad = structuredClone(payload); bad.paperIR.identity.parseHash = 'c'.repeat(64);
    bad.chunks[0].content = 'invented';
    assert.throws(() => f.repository.indexing.publishText(job, bad, 'sources/changed.pdf'));
    assert.deepEqual(f.db.prepare('SELECT * FROM research_knowledge_chunks ORDER BY id').all(), before);
    assert.deepEqual(f.repository.indexing.cached(job.fileId).payload, cached);
    f.repository.indexing.finishJob(job, null);
    assert.equal(f.db.pragma('integrity_check', {simple: true}), 'ok');
  } finally {await f.close();}
});
