import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, ScientificLibraryIndexService;
before(async () => {
  [api, {ScientificLibraryIndexService}] = await Promise.all([
    loadResearchTestApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-library-index.ts', {platform: 'node'})
  ]);
});
after(() => api?.dispose());

const hash = value => createHash('sha256').update(value).digest('hex');
const config = {id: 'status', name: 'Fixture', baseUrl: 'https://fixture.invalid', model: 'model-one', dimensions: 3, enabled: true};
const entry = index => ({
  metadata: {id: `status-paper-${index}`, source: 'local', externalId: `status-fixture-${index}`, doi: null,
    title: `Status fixture ${index}`, authors: [], abstract: null, publishedYear: null, citationCount: null,
    url: null, openAccessUrl: null, importedAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z'},
  bibliography: {citationKey: `statusFixture${index}`, entryType: 'article', fields: {title: `Status fixture ${index}`},
    preambles: [], csl: null, title: `Status fixture ${index}`, authors: [], doi: null, publishedYear: null, abstract: null, url: null}
});

async function fixture(enabled = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-document-status-')));
  const f = createResearchFixture(api, 'reading', root);
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([600, 800]);
  page.drawText('2 Method', {x: 30, y: 740, size: 14, font});
  page.drawText('Batchstatussentinel preserves original source identity.', {x: 30, y: 700, size: 11, font});
  const bytes = Buffer.from(await pdf.save()), sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, bytes);
  const document = f.repository.documents.import({id: 'status-document', libraryItemId: null, entry: entry(0),
    projectId: f.project.id, filename: 'source.pdf', mediaType: 'application/pdf', sourcePath: 'source.pdf',
    sourceHash: hash(bytes), size: bytes.length}, false).document;
  if (enabled) f.repository.knowledge.saveEmbeddingConfig(config, 'fixture-secret');
  let calls = 0, parses = 0, provider = async texts => texts.map(() => [3, 4, 0]);
  const embeddings = new api.ResearchEmbeddingService(f.repository.knowledge,
    {embed: async ({texts, signal}) => {calls++; return await provider(texts, signal);}},
    {secrets: {get: async () => 'fixture-key'}, logger: {info() {}, warn() {}, error() {}}});
  const scientific = new ScientificLibraryIndexService(f.repository, embeddings, root);
  const service = new api.ResearchDocumentService(f.repository, {
    defaultParseOptions: () => ({tier: 'compact', device: 'cpu', pageRange: ''}),
    parseDocument: async input => {parses++; return await api.parseResearchDocument({...input, modelFiles: null, modelManifest: ''});}
  }, root, null, null, scientific);
  const handlers = new Map();
  api.registerResearchDocumentCapabilities({pluginId: 'research', capabilities: {
    register(_pluginId, capability, handler) {handlers.set(capability.name, {capability, handler});}
  }}, f.repository.documents, service);
  const statusMany = async (libraryItemIds = [document.libraryItemId], projectId = f.project.id) => {
    const {capability, handler} = handlers.get('research.document.statusMany');
    return await handler(capability.inputSchema.parse({projectId, libraryItemIds}));
  };
  return {...f, root, bytes, sourcePath, document, service, scientific,
    statusMany, status: async () => (await statusMany()).items[0].documents[0],
    parse: () => service.parse(document.id, null),
    calls: () => calls, parses: () => parses, provider: value => {provider = value;},
    startJobs: () => f.repository.knowledgeJobs.start((id, signal, requireCurrent) =>
      id.startsWith('document:') ? scientific.rebuild(id, signal, requireCurrent) : embeddings.embedDocument(id, null, signal)),
    close: async () => {
      await service.shutdown(); await f.repository.knowledgeJobs.shutdown(); await embeddings.shutdown();
      await f.close(); await rm(root, {recursive: true, force: true});
    }
  };
}

test('batch capability distinguishes an imported real PDF from actual parse and both verified vector indexes without writes', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.status(), {id: f.document.id, status: 'imported', currentParseId: null,
      indexStatus: 'unavailable', error: null});
    const parsed = await f.parse(); assert.equal(parsed.status, 'ready');
    const calls = f.calls(), parses = f.parses(), changes = f.db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(await f.status(), {id: f.document.id, status: 'ready', currentParseId: parsed.currentParseId,
      indexStatus: 'ready', error: null});
    assert.equal(f.calls(), calls); assert.equal(f.parses(), parses);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
    assert.deepEqual(await readFile(f.sourcePath), f.bytes);
  } finally {await f.close();}
});

test('text-only parsing stays unavailable while a configuration rebuild reports queued, running and finally real ready', async () => {
  const f = await fixture(false);
  let release;
  try {
    const parsed = await f.parse(); assert.equal(parsed.status, 'ready');
    assert.equal((await f.status()).indexStatus, 'unavailable');
    f.repository.knowledge.saveEmbeddingConfig(config, 'fixture-secret');
    f.repository.knowledgeJobs.configurationChanged();
    assert.equal((await f.status()).indexStatus, 'queued');
    let enter;
    const entered = new Promise(resolve => {enter = resolve;});
    const pending = new Promise(resolve => {release = resolve;});
    f.provider(async texts => {enter(); await pending; return texts.map(() => [3, 4, 0]);});
    f.startJobs(); await entered;
    assert.equal((await f.status()).indexStatus, 'running');
    release(); await f.repository.knowledgeJobs.idle();
    assert.equal((await f.status()).indexStatus, 'ready');
    assert.equal(f.parses(), 1, 'status/configuration rebuild must not repeat parsing');
    assert.equal(f.repository.documents.get(f.document.id).currentParseId, parsed.currentParseId);
  } finally {release?.(); await f.close();}
});

test('ready outbox cannot hide missing generic vectors, corrupt scientific vectors/FTS or mismatched source ownership', async () => {
  for (const damage of [
    (f, parseId) => f.db.prepare(`DELETE FROM research_knowledge_embeddings WHERE chunk_id IN
      (SELECT id FROM research_knowledge_chunks WHERE document_id=?)`).run(`document:${parseId}`),
    f => f.db.prepare("UPDATE research_scientific_embeddings SET embedding=zeroblob(length(embedding))").run(),
    f => f.db.prepare('DELETE FROM research_scientific_fts').run(),
    (f, parseId) => f.db.prepare('UPDATE research_knowledge_documents SET source_id=? WHERE id=?')
      .run('foreign-paper', `document:${parseId}`),
    f => f.db.prepare("UPDATE research_documents SET source_hash=? WHERE id=?").run('f'.repeat(64), f.document.id),
    (f, parseId) => {
      const row = f.db.prepare('SELECT data_json FROM research_document_parses WHERE id=?').get(parseId);
      const data = JSON.parse(row.data_json); data.content.content += 'changed stored parse';
      f.db.prepare('UPDATE research_document_parses SET data_json=? WHERE id=?').run(JSON.stringify(data), parseId);
    }
  ]) {
    const f = await fixture();
    try {
      const parsed = await f.parse();
      assert.equal((await f.status()).indexStatus, 'ready');
      damage(f, parsed.currentParseId);
      assert.equal(f.repository.knowledgeJobs.get(`document:${parsed.currentParseId}`).status, 'ready');
      const result = await f.status();
      assert.equal(result.status, 'ready', 'the stored parse state remains a separate observation');
      assert.equal(result.indexStatus, 'failed');
      assert.match(result.error, /索引/u);
      assert.deepEqual(await readFile(f.sourcePath), f.bytes);
    } finally {await f.close();}
  }
});

test('changed selected embedding revision and archived source never retain a ready index claim', async () => {
  const f = await fixture();
  try {
    await f.parse(); assert.equal((await f.status()).indexStatus, 'ready');
    f.repository.knowledge.saveEmbeddingConfig({...config, model: 'model-two'}, 'fixture-secret');
    assert.equal((await f.status()).indexStatus, 'unavailable');
    const item = f.repository.library.get(f.document.libraryItemId);
    f.repository.library.archive(item.id, item.revision, true);
    assert.equal((await f.status()).indexStatus, 'unavailable');
    assert.equal((await f.status()).status, 'ready');
  } finally {await f.close();}
});

test('batch reads preserve complete document and request order while rejecting unknown, foreign, duplicate or oversized IDs', async () => {
  const f = await fixture();
  try {
    await f.parse();
    const empty = f.repository.library.import([entry(1)], f.project.id, {notify: false}).items[0];
    const second = f.repository.documents.import({id: 'status-document-second', libraryItemId: f.document.libraryItemId,
      entry: null, projectId: f.project.id, filename: 'second.pdf', mediaType: 'application/pdf', sourcePath: 'second.pdf',
      sourceHash: 'b'.repeat(64), size: 100}, false).document;
    const ids = [empty.id, f.document.libraryItemId], result = await f.statusMany(ids);
    assert.deepEqual(result.items.map(item => item.libraryItemId), ids);
    assert.deepEqual(result.items[0].documents, []);
    assert.deepEqual(result.items[1].documents.map(document => document.id), [f.document.id, second.id]);
    assert.deepEqual(result.items[1].documents.map(document => document.indexStatus), ['ready', 'unavailable']);
    await assert.rejects(f.statusMany(['missing']), /research_library_item_not_found/u);
    const other = f.repository.createProject({title: 'Other', description: '', workspacePath: join(f.root, 'other')});
    await assert.rejects(f.statusMany(ids, other.id), /research_document_project_mismatch/u);
    assert.equal((await f.statusMany(ids, null)).items.length, 2);
    await assert.rejects(f.statusMany([]));
    await assert.rejects(f.statusMany([empty.id, empty.id]), /research_document_status_duplicate_item/u);
    await assert.rejects(f.statusMany(Array.from({length: 1001}, (_, i) => `overflow-${i}`)));
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.close();}
});

test('one capability reads 1000 actual library documents with a bounded number of database statements', async () => {
  const f = await fixture();
  try {
    const ids = [f.document.libraryItemId];
    f.db.transaction(() => {
      for (let i = 1; i < 1000; i++) {
        const document = f.repository.documents.import({id: `status-document-${i}`, libraryItemId: null, entry: entry(i),
          projectId: f.project.id, filename: `${i}.pdf`, mediaType: 'application/pdf', sourcePath: `${i}.pdf`,
          sourceHash: hash(String(i)), size: 100}, false).document;
        ids.push(document.libraryItemId);
      }
    })();
    const prepare = f.db.prepare, changes = prepare.call(f.db, 'SELECT total_changes()').pluck().get();
    let statements = 0;
    f.db.prepare = function(...args) {statements++; return prepare.apply(this, args);};
    let result;
    try {result = await f.statusMany(ids);}
    finally {f.db.prepare = prepare;}
    assert.equal(result.items.length, 1000);
    assert.ok(result.items.every(item => item.documents.length === 1 && item.documents[0].indexStatus === 'unavailable'));
    assert.ok(statements <= 12, `expected batch SQL instead of per-item reads, observed ${statements} statements`);
    assert.equal(prepare.call(f.db, 'SELECT total_changes()').pluck().get(), changes);
    assert.equal(f.calls(), 0); assert.equal(f.parses(), 0);
  } finally {await f.close();}
});
