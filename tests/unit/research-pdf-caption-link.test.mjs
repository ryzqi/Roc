import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
let linker, schema, indexing, api;
before(async () => {
  [linker, schema, indexing, api] = await Promise.all([
    'src/main/plugins/research/pdf-caption-linker.ts', 'src/shared/schemas/research-paper-visual.ts',
    'src/main/plugins/research/index-files.ts'].map(entry => importTypeScriptModule(entry, {platform: 'node'})).concat(loadResearchTestApi()));
});
after(() => api?.dispose());
const block = (id, kind, text, bbox = [20, 20, 220, 100], page = 1, label = kind) => ({
  id, kind, text, label, imagePath: null, locator: `page ${page}`, locations: [{page, bbox, coordinateOrigin: 'TOPLEFT'}]
});
const figure = () => [block('fig', 'figure', ''), block('cap', 'paragraph', 'Figure 1: Original figure caption.', [20, 110, 220, 140]),
  block('ref', 'paragraph', 'See Fig. 1. Figure 10 is separate.', [20, 160, 220, 200])];

test('unique same-page caption and exact numbered reference preserve original text and source', () => {
  const original = figure(), result = linker.attachPaperVisuals(original), value = result[0].visual;
  assert.equal(value.kind, 'figure'); assert.equal(value.objectNumber, '1');
  assert.equal(value.captions[0].status, 'linked'); assert.equal(value.references.length, 1);
  assert.equal(value.references[0].evidence.text, 'Fig. 1');
  assert.equal(value.references[0].status, 'linked');
  assert.deepEqual(value.source, {...original[0].locations[0], locator: 'page 1'});
  assert.deepEqual(result.map(b => b.text), original.map(b => b.text));
  schema.assertPaperVisualEvidence(result);
  assert.deepEqual(indexing.indexDocumentBlocks(result, {paperId: 'p', parseId: 'parse', sourceHash: 'a'.repeat(64)})[0].semantic.visual, value);
  original[1].text = 'Figure 1.2: Original caption.';
  original[2].text = 'Fig. 1x2 differs from Fig. 1.2.';
  assert.equal(linker.attachPaperVisuals(original)[0].visual.references.length, 1);
});

test('two figure panels sharing a caption remain ambiguous; neighboring columns do not bind', () => {
  const input = [block('left', 'figure', '', [20, 20, 120, 100]),
    block('right', 'figure', '', [130, 20, 230, 100]),
    block('cap', 'paragraph', 'Fig. 1: Panels.', [20, 110, 230, 140])];
  const result = linker.attachPaperVisuals(input);
  assert.ok(result.slice(0, 2).every(b => b.visual.captions[0].status === 'candidate' && b.visual.objectNumber === null));
  const otherColumn = [block('f', 'figure', '', [20, 20, 120, 100]),
    block('c', 'paragraph', 'Fig. 1: Another column.', [200, 110, 300, 140])];
  assert.equal(linker.attachPaperVisuals(otherColumn)[0].visual.captions.length, 0);
});

test('cross-page captions, distant captions and intervening prose never become automatic links', () => {
  const cross = figure(); cross[1].locations[0].page = 2; cross[1].locator = 'page 2';
  const c = linker.attachPaperVisuals(cross)[0].visual;
  assert.equal(c.captions[0].crossPage, true); assert.equal(c.captions[0].status, 'candidate');
  assert.equal(c.references[0].status, 'candidate');
  const separated = figure(); separated.splice(1, 0, block('body', 'paragraph', 'Original prose.'));
  assert.equal(linker.attachPaperVisuals(separated)[0].visual.captions[0].status, 'candidate');
  const distant = figure(); distant[1].locations[0].bbox = [20, 800, 220, 840];
  assert.equal(linker.attachPaperVisuals(distant)[0].visual.captions.length, 0);
});

test('tables prefer captions above, body mentions are not captions, and repeated numbers yield candidate references', () => {
  const input = [block('cap', 'paragraph', 'Table 2: Scores.', [20, 0, 220, 15]),
    block('table', 'table', 'original cells'), block('ref', 'paragraph', 'Table 2 shows results.')];
  const value = linker.attachPaperVisuals(input)[1].visual;
  assert.equal(value.captions[0].status, 'linked'); assert.equal(value.references.length, 1);
  const repeated = [...figure(), block('other', 'figure', '', [20, 20, 220, 100], 3),
    block('other-caption', 'paragraph', 'Figure 1: Reused number.', [20, 110, 220, 140], 3)];
  assert.ok(linker.attachPaperVisuals(repeated).filter(b => b.visual).every(b => b.visual.references.every(r => r.status === 'candidate')));
});

test('unnumbered labelled captions and BOTTOMLEFT geometry remain conservative; source/evidence corruption rejects', () => {
  const input = figure(); input[1].text = 'Original unnumbered caption'; input[1].label = 'figure_caption';
  assert.equal(linker.attachPaperVisuals(input)[0].visual.captions[0].status, 'candidate');
  input[0].locations[0].coordinateOrigin = 'BOTTOMLEFT';
  assert.equal(linker.attachPaperVisuals(input)[0].visual.captions.length, 0);
  const original = linker.attachPaperVisuals(figure());
  for (const mutate of [v => v.source.page = 2, v => v.assetId = 'foreign', v => v.id = 'wrong',
    v => v.captions[0].crossPage = true]) {
    const changed = structuredClone(original[0]); mutate(changed.visual);
    assert.throws(() => schema.assertPaperVisualBlock(changed));
  }
  const changed = structuredClone(original); changed[1].text = 'changed source';
  assert.throws(() => schema.assertPaperVisualEvidence(changed), /evidence_invalid/);
});

test('actual SQLite publication/restart/search retain visual metadata; wrong locator cannot replace the index', async () => {
  const f = createResearchFixture(api, 'reading');
  try {
    const chunks = indexing.indexDocumentBlocks(linker.attachPaperVisuals(figure()),
      {paperId: 'visual', parseId: 'parse', sourceHash: 'a'.repeat(64)});
    const request = {id: 'visual', projectId: f.project.id, sourceId: 'visual', sourceType: 'file',
      title: 'Figure source', content: figure().map(b => b.text).join('\n\n'), chunks, embeddingPolicy: 'none'};
    f.repository.knowledge.upsertFromSource(request);
    const row = f.db.prepare('SELECT chunk_id,metadata_json FROM research_knowledge_chunk_semantics').all()
      .find(r => JSON.parse(r.metadata_json).visual);
    const restarted = new api.ResearchRepository(f.db, f.tasks);
    assert.deepEqual(restarted.knowledge.chunkSemantic(row.chunk_id).visual, chunks[0].semantic.visual);
    assert.equal(f.db.prepare('SELECT chunk_id FROM research_knowledge_chunk_structure WHERE chunk_id=?').get(row.chunk_id), undefined);
    assert.ok(restarted.knowledge.knowledgeChunks(request.id).every(c => c.content.trim()),
      'An empty object has no fabricated text span or embedding input');
    const populated = structuredClone(request); populated.chunks[0].content = 'Original diagram text.';
    restarted.knowledge.upsertFromSource(populated);
    const hits = restarted.knowledge.searchKnowledge({request: {projectId: f.project.id, query: 'diagram',
      limit: 10, embeddingConfigId: null}, vector: null}).hits;
    assert.ok(hits.some(hit => restarted.knowledge.chunkSemantic(hit.chunkId)?.visual?.blockId === 'fig'));
    const bad = structuredClone(populated); bad.chunks[0].locator = 'page 99';
    assert.throws(() => restarted.knowledge.upsertFromSource(bad), /binding_invalid/);
    assert.deepEqual(restarted.knowledge.chunkSemantic(row.chunk_id).visual, chunks[0].semantic.visual);
    assert.equal(f.db.pragma('integrity_check', {simple: true}), 'ok');
  } finally {await f.close();}
});
