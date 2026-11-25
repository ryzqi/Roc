import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, realpath, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let api, files;
before(async () => {
  api = await loadResearchTestApi();
  files = await importTypeScriptModule('src/main/plugins/research/document-files.ts', {platform: 'node'});
});
after(() => api?.dispose());
const hash = value => createHash('sha256').update(value).digest('hex');
const raw = '<table class="source"><caption>Table 1 Scores</caption><thead><tr><th rowspan="2">Method</th><th>Time [ms]</th></tr><tr><th>CPU</th></tr></thead><tr><td>Ours</td><td>2.1</td></tr><tfoot><tr><td colspan="2">* measured</td></tr></tfoot></table>';
const source = `<h1>Source</h1><h2>Results</h2>${raw}<p>See Table 1.</p>`;
const tools = () => ({defaultParseOptions: () => ({tier: 'compact', device: 'cpu', pageRange: ''}),
  identity: async () => 'table-html-publication',
  parseDocument: input => api.parseResearchDocument({...input, modelFiles: null, modelManifest: ''})});
const entry = () => ({metadata: {id: 'table', source: 'local', externalId: 'table', doi: null, title: 'Table Source',
  authors: [], abstract: null, publishedYear: null, citationCount: null, url: null, openAccessUrl: null,
  importedAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z'},
  bibliography: {citationKey: 'table', entryType: 'article', fields: {title: 'Table Source'}, preambles: [], csl: null,
    title: 'Table Source', authors: [], doi: null, publishedYear: null, abstract: null, url: null}});
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) {assert.ok(Date.now() < deadline, 'publication did not settle'); await delay(10);}
}

test('production parser, artifact readback, library restart and SQLite chunks preserve table structure', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-table-library-'))), f = createResearchFixture(api, 'reading');
  const service = new api.ResearchDocumentService(f.repository, tools(), root);
  try {
    await writeFile(join(root, 'source.html'), source);
    const document = f.repository.documents.import({id: 'table-document', libraryItemId: null, projectId: f.project.id,
      filename: 'source.html', mediaType: 'text/html', sourcePath: 'source.html', sourceHash: hash(source),
      size: Buffer.byteLength(source), entry: entry()}, false).document;
    const parsed = await service.parse(document.id);
    assert.equal(parsed.status, 'ready', parsed.error ?? undefined);
    const data = f.repository.documents.parsed(document.id, parsed.currentParseId).data;
    const block = data.content.blocks.find(b => b.kind === 'table');
    assert.ok(data.content.blocks.every(b => b.locations.length === 1 && b.locations[0].page === 1 &&
      b.locations[0].bbox === null && b.locations[0].coordinateOrigin === null));
    assert.deepEqual(block.table.source, {locator: block.locator, page: 1, bbox: null, coordinateOrigin: null});
    assert.equal(block.table.rawHtml, raw); assert.equal(block.table.assetId, null);
    assert.equal(block.table.rows[0].cells[0].rowSpan, 2);
    assert.equal(block.table.rows[2].cells[1].text, '2.1');
    const jsonRows = f.db.prepare('SELECT metadata_json FROM research_knowledge_chunk_semantics').all();
    assert.ok(jsonRows.some(r => JSON.parse(r.metadata_json).table?.rows[2].cells[1].text === '2.1'));
    const restarted = new api.ResearchRepository(f.db, f.tasks);
    assert.deepEqual(restarted.documents.parsed(document.id, parsed.currentParseId).data.content.blocks, data.content.blocks);
    const artifactPath = join(root, data.outputPath, data.content.artifacts.structuredContent), original = await readFile(artifactPath);
    const captured = JSON.parse(original);
    const input = {...data.content, blocks: captured.blocks, assets: []};
    await files.collectDocumentContent(root, join(root, data.outputPath), input);
    // Alter both equal copies while keeping the original recognizer HTML: recomputation must still reject.
    const changed = structuredClone(captured); changed.blocks.find(b => b.kind === 'table').table.rows[2].cells[1].text = '999';
    await writeFile(artifactPath, JSON.stringify(changed));
    await assert.rejects(files.collectDocumentContent(root, join(root, data.outputPath), {...input, blocks: changed.blocks}), /table_artifact_mismatch/);
    const removed = structuredClone(captured);
    delete removed.blocks.find(b => b.kind === 'table').table;
    await writeFile(artifactPath, JSON.stringify(removed));
    await assert.rejects(files.collectDocumentContent(root, join(root, data.outputPath), {...input, blocks: removed.blocks}), /table_artifact_mismatch/);
    await writeFile(artifactPath, original);
    const row = f.db.prepare('SELECT data_json FROM research_document_parses WHERE id=?').get(parsed.currentParseId);
    const bad = JSON.parse(row.data_json); bad.content.blocks.find(b => b.kind === 'table').table.source.page = 999;
    f.db.prepare('UPDATE research_document_parses SET data_json=? WHERE id=?').run(JSON.stringify(bad), parsed.currentParseId);
    assert.throws(() => restarted.documents.parsed(document.id, parsed.currentParseId), /binding_invalid/);
    f.db.prepare('UPDATE research_document_parses SET data_json=? WHERE id=?').run(row.data_json, parsed.currentParseId);
    assert.deepEqual(await readFile(artifactPath), original);
    assert.equal(f.db.pragma('integrity_check', {simple: true}), 'ok');
  } finally {await service.shutdown(); await f.close(); await rm(root, {recursive: true, force: true});}
});

test('actual project index carries whole cells through cache, search and source-bound metadata', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-table-index-'))), workspace = join(root, 'workspace');
  await mkdir(workspace);
  const f = createResearchFixture(api, 'reading', workspace), logger = {info() {}, warn() {}};
  const embeddings = new api.ResearchEmbeddingService(f.repository.knowledge, {}, {logger});
  const service = new api.ResearchIndexService(f.repository, tools(), embeddings, join(root, 'storage'), logger);
  try {
    await writeFile(join(workspace, 'paper.html'), source);
    const {projectId, revision, ...settings} = f.repository.indexing.settings(f.project.id);
    service.configure({...settings, projectId, expectedRevision: revision, kinds: ['html'], include: ['**/*.html'], watch: false});
    await until(() => service.status(projectId).counts.ready === 1);
    const file = f.repository.indexing.listFiles(projectId, '', false, 10)[0], payload = f.repository.indexing.cached(file.id).payload;
    const chunk = payload.chunks.find(c => c.semantic?.table);
    assert.equal(chunk.semantic.table.rawHtml, raw);
    assert.equal(chunk.semantic.table.source.locator, chunk.locator);
    const result = f.repository.knowledge.searchKnowledge({request: {projectId, query: 'Ours', limit: 10, embeddingConfigId: null}, vector: null});
    assert.ok(result.hits.some(hit => f.repository.knowledge.chunkSemantic(hit.chunkId)?.table?.rawHtml === raw));
    const request = {id: 'bad-table', projectId, sourceId: file.id, sourceType: 'file', title: 'bad',
      content: chunk.content, chunks: [{...chunk, locator: 'foreign'}], embeddingPolicy: 'none'};
    const before = f.db.prepare('SELECT * FROM research_knowledge_documents ORDER BY id').all();
    assert.throws(() => f.repository.knowledge.upsertFromSource(request), /binding_invalid/);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_knowledge_documents ORDER BY id').all(), before,
      'failed transaction publishes no durable rows');
    assert.equal(f.db.pragma('integrity_check', {simple: true}), 'ok');
  } finally {await service.shutdown(); await f.close(); await rm(root, {recursive: true, force: true});}
});
