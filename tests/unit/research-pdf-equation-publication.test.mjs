import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let api, extractor, indexing;
before(async () => {
  [api, extractor, indexing] = await Promise.all([loadResearchTestApi(),
    importTypeScriptModule('src/main/plugins/research/pdf-equation-extractor.ts', {platform: 'node'}),
    importTypeScriptModule('src/main/plugins/research/index-files.ts', {platform: 'node'})]);
});
after(() => api?.dispose());

test('source-bound equation metadata survives actual SQLite publication, restart and search; corrupt locator rolls back', async () => {
  const f = createResearchFixture(api, 'reading');
  const block = (id, kind, text) => ({id, kind, text, label: kind, locator: 'page 1', imagePath: null,
    locations: [{page: 1, bbox: [20, 20, 200, 80], coordinateOrigin: 'TOPLEFT'}]});
  try {
    const blocks = extractor.attachPaperEquations([
      block('intro', 'paragraph', 'Equation 3 describes temperature.'),
      block('eq', 'formula', 'x=y \\tag{3}'),
      block('definition', 'paragraph', 'where x denotes temperature.')
    ], [{regions: [{id: 'eq', formula: ' x=y \\tag{3} '}]}]);
    const identity = {paperId: 'equation-source', parseId: 'equation-parse', sourceHash: 'a'.repeat(64)};
    const chunks = indexing.indexDocumentBlocks(blocks, identity);
    const request = {id: 'equation-source', projectId: f.project.id, sourceId: 'equation-source', sourceType: 'file',
      title: 'Original equation', content: blocks.map(b => b.text).join('\n\n'), chunks, embeddingPolicy: 'none'};
    f.repository.knowledge.upsertFromSource(request);
    const expected = chunks.find(c => c.semantic.equation).semantic.equation;
    const rows = f.db.prepare('SELECT chunk_id, metadata_json FROM research_knowledge_chunk_semantics').all();
    const row = rows.find(r => JSON.parse(r.metadata_json).equation);
    assert.deepEqual(JSON.parse(row.metadata_json).equation, expected);
    const restarted = new api.ResearchRepository(f.db, f.tasks);
    assert.deepEqual(restarted.knowledge.chunkSemantic(row.chunk_id).equation, expected);
    const hits = restarted.knowledge.searchKnowledge({request: {projectId: f.project.id, query: 'tag',
      limit: 10, embeddingConfigId: null}, vector: null}).hits;
    assert.ok(hits.some(hit => restarted.knowledge.chunkSemantic(hit.chunkId)?.equation?.rawLatex === expected.rawLatex));
    const before = f.db.prepare('SELECT * FROM research_knowledge_documents ORDER BY id').all();
    const changed = structuredClone(request);
    changed.chunks.find(c => c.semantic.equation).locator = 'page 999';
    assert.throws(() => restarted.knowledge.upsertFromSource(changed), /binding_invalid/);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_knowledge_documents ORDER BY id').all(), before);
    assert.deepEqual(restarted.knowledge.chunkSemantic(row.chunk_id).equation, expected);
    assert.equal(f.db.pragma('integrity_check', {simple: true}), 'ok');
  } finally {await f.close();}
});
