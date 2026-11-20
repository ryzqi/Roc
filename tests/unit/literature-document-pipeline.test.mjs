import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, LiteraturePdfAcquisition, PdfDownloadService, ScientificLibraryIndexService;
before(async () => {
  [api, {LiteraturePdfAcquisition}, {PdfDownloadService}, {ScientificLibraryIndexService}] = await Promise.all([
    loadResearchTestApi(), ...['literature-pdf-acquisition', 'pdf-download-service', 'scientific-library-index'].map(name =>
      importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node'}))
  ]);
});
after(() => api?.dispose());
const config = {id: 'acquisition', name: 'Fixture', baseUrl: 'https://fixture.invalid', model: 'fixture', dimensions: 3, enabled: true};
async function fixture({embedding = true, empty = false, mismatch = false} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-acquisition-pipeline-')));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const f = createResearchFixture(api, 'reading', workspace);
  const metadata = {id: 'arxiv:2601.01234', source: 'arxiv', externalId: '2601.01234', doi: mismatch ? '10.5555/right' : null,
    title: 'Acquisition Fulltext', authors: [], abstract: 'Abstract without the secret token', publishedYear: 2026,
    citationCount: null, url: null, openAccessUrl: null, importedAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z'};
  const item = f.repository.library.import([{metadata, bibliography: {citationKey: 'acquisition', entryType: 'article',
    fields: {title: metadata.title}, preambles: [], csl: null, title: metadata.title, authors: [], doi: metadata.doi,
    publishedYear: 2026, abstract: metadata.abstract, url: null}}], f.project.id, {notify: false}).items[0];
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([600, 800]);
  if (!empty) {
    page.drawText('Acquisition Fulltext', {x: 30, y: 760, size: 16, font});
    page.drawText('2 Method', {x: 30, y: 720, size: 14, font});
    page.drawText('Fulltextuniquesentinel proves actual original body retrieval.', {x: 30, y: 680, size: 11, font});
    page.drawText('The experiment preserves immutable sources and verifies publication.', {x: 30, y: 650, size: 11, font});
  }
  const bytes = Buffer.from(await pdf.save());
  let downloads = 0, parses = 0, provider = async texts => texts.map(() => [3, 4, 0]), afterParse = () => {};
  if (embedding) f.repository.knowledge.saveEmbeddingConfig(config, 'test-secret');
  const embeddings = new api.ResearchEmbeddingService(f.repository.knowledge,
    {embed: async ({texts}) => provider(texts)}, {secrets: {get: async () => 'test-key'}, logger: {info() {}, warn() {}, error() {}}});
  const scientific = new ScientificLibraryIndexService(f.repository, embeddings, root);
  const documents = new api.ResearchDocumentService(f.repository, {
    defaultParseOptions: () => ({tier: 'compact', device: 'cpu', pageRange: ''}),
    parseDocument: async input => {parses++; const result = await api.parseResearchDocument({...input, modelFiles: null, modelManifest: ''}); afterParse(); return result;}
  }, root, null, mismatch ? {identity: 'fixture-grobid', parse: async () =>
    '<TEI><teiHeader><fileDesc><titleStmt><title>Acquisition Fulltext</title></titleStmt><sourceDesc><biblStruct><idno type="DOI">10.5555/wrong</idno></biblStruct></sourceDesc></fileDesc></teiHeader><text><body/></text></TEI>'} : null, scientific);
  const downloader = new PdfDownloadService(root, {lookup: async () => [{address: '93.184.216.34', family: 4}],
    request: async () => {downloads++; return {status: 200, headers: {'content-length': String(bytes.length)},
      body: {async *[Symbol.asyncIterator]() {yield bytes;}}, cancel() {}};}});
  const pipeline = new LiteraturePdfAcquisition(f.repository, f.repository.library, downloader, () => {}, undefined,
    {resolver: {fetch: async () => Response.json({})}});
  await pipeline.initialize(); pipeline.configureDocumentPipeline(async () => documents);
  let job = {id: 'fixture-job', generation: 'fixture-generation', projectId: f.project.id, libraryItemId: item.id,
    title: metadata.title, stage: 'resolve', status: 'running', attempts: 0, nextRetryAt: null, documentId: null,
    source: null, receipt: null, errorCode: null, updatedAt: '2026-11-19T00:00:00Z'};
  const run = async (overrides = {}, requireCurrent = () => {}) => {
    job = {...job, ...overrides, status: 'running'};
    const outcome = await pipeline.process(job, new AbortController().signal, requireCurrent);
    const oldStage = job.stage;
    job = {...job, ...outcome, attempts: oldStage !== (outcome.stage ?? oldStage) ? 0 : job.attempts + (outcome.errorCode ? 1 : 0)};
    return outcome;
  };
  const acquire = async () => {await run(); return await run();};
  const startJobs = () => f.repository.knowledgeJobs.start((id, signal, requireCurrent) =>
    id.startsWith('document:') ? scientific.rebuild(id, signal, requireCurrent) : embeddings.embedDocument(id, null, signal));
  return {...f, root, workspace, bytes, item, documents, pipeline, run, acquire, startJobs, job: () => job,
    downloads: () => downloads, parses: () => parses, provider: value => {provider = value;}, afterParse: value => {afterParse = value;},
    close: async () => {await documents.shutdown(); await f.repository.knowledgeJobs.shutdown(); await embeddings.shutdown();
      await f.close(); await rm(root, {recursive: true, force: true});}};
}

test('automatic real PDF import and parse publish durable artifacts before both vector indexes become ready', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.acquire()).status, 'queued');
    const imported = await f.run(); assert.equal(imported.stage, 'parse');
    const parsed = await f.run(); assert.equal(parsed.stage, 'index');
    const document = f.repository.documents.get(imported.documentId), parseId = document.currentParseId;
    assert.equal(document.status, 'ready');
    assert.ok(await f.documents.paperIR(document.id, parseId));
    assert.equal((await f.run()).status, 'queued', 'queued vectors are not a readiness receipt');
    f.startJobs(); await f.repository.knowledgeJobs.idle();
    assert.deepEqual(await f.run(), {stage: 'wiki', status: 'queued', documentId: document.id});
    assert.ok(f.repository.knowledge.hasDocumentEmbeddings(`document:${parseId}`, config.id, 1));
    const generation = f.repository.scientificIndex.active(null, document.id); f.repository.scientificIndex.verify(generation.id);
    assert.ok(f.db.prepare("SELECT count(*) FROM research_knowledge_keywords WHERE research_knowledge_keywords MATCH 'Fulltextuniquesentinel'").pluck().get() > 0);
    assert.equal(f.downloads(), 1); assert.equal(f.parses(), 1);
    await f.run({stage: 'import'}); assert.equal((await f.run()).stage, 'wiki');
    assert.equal(f.parses(), 1, 'same source skips parsing');
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.close();}
});

test('missing embedding blocks only indexing and configuration recovery does not repeat parsing', async () => {
  const f = await fixture({embedding: false});
  try {
    await f.acquire(); await f.run(); await f.run(); f.startJobs(); await f.repository.knowledgeJobs.idle();
    assert.equal((await f.run()).status, 'blocked');
    assert.equal(f.repository.documents.get(f.job().documentId).status, 'ready');
    f.repository.knowledge.saveEmbeddingConfig(config, 'test-secret'); f.repository.knowledgeJobs.configurationChanged();
    await f.repository.knowledgeJobs.idle(); assert.equal((await f.run()).stage, 'wiki');
    assert.equal(f.parses(), 1); assert.equal(f.downloads(), 1);
  } finally {await f.close();}
});

test('library-only processing uses app-owned storage and later project publication reuses the PDF and parse', async () => {
  const f = await fixture();
  try {
    await f.run({projectId: null}); const downloaded = await f.run();
    assert.equal(downloaded.stage, 'import'); assert.equal(downloaded.status, 'queued');
    await f.run(); await f.run(); f.startJobs(); await f.repository.knowledgeJobs.idle();
    assert.equal((await f.run()).stage, 'wiki');
    const documentId = f.job().documentId;
    const reused = await f.run({stage: 'resolve', projectId: f.project.id, documentId: null, receipt: null});
    assert.equal(reused.stage, 'import'); assert.equal(reused.documentId, documentId);
    await f.run(); assert.equal((await f.run()).stage, 'wiki');
    assert.equal(f.downloads(), 1); assert.equal(f.parses(), 1);
    assert.equal(f.repository.documents.list(f.item.id).length, 1);
  } finally {await f.close();}
});

test('selected manual PDF wins over an older ready document and publishes beside its preserved original', async () => {
  const f = await fixture();
  try {
    await f.acquire(); await f.run(); await f.run();
    const original = f.repository.documents.get(f.job().documentId), oldPath = f.job().receipt.relativePath;
    const pdf = await PDFDocument.load(f.bytes);
    pdf.getPage(0).drawText('A corrected replacement retains its own source version.', {x: 30, y: 600, size: 11});
    const replacementBytes = Buffer.from(await pdf.save());
    const replacement = await f.documents.importPrepared({target: 'library-item', libraryItemId: f.item.id,
      projectId: f.project.id, sourcePath: join(f.workspace, 'manual.pdf')}, replacementBytes,
      () => {}, new AbortController().signal);
    assert.equal(replacement.status, 'imported'); assert.equal(original.status, 'ready');
    const resolved = await f.run({stage: 'resolve', documentId: replacement.id});
    assert.equal(resolved.stage, 'import'); assert.equal(resolved.documentId, replacement.id);
    assert.equal(resolved.receipt.sha256, replacement.sourceHash);
    assert.notEqual(resolved.receipt.relativePath, oldPath);
    assert.deepEqual(await readFile(join(f.workspace, oldPath)), f.bytes);
    assert.deepEqual(await readFile(join(f.workspace, resolved.receipt.relativePath)), replacementBytes);
    assert.equal((await f.run()).stage, 'parse'); assert.equal((await f.run()).stage, 'index');
    assert.equal(f.parses(), 2); assert.equal(f.downloads(), 1);
    assert.equal(f.repository.documents.get(original.id).currentParseId, original.currentParseId);
    const replay = await f.run({stage: 'resolve'});
    assert.equal(replay.receipt.relativePath, resolved.receipt.relativePath);
    assert.equal(replay.documentId, replacement.id); assert.equal(f.downloads(), 1);
  } finally {await f.close();}
});

test('failed embeddings have bounded retries while a manual index retry preserves the parse', async () => {
  const f = await fixture();
  try {
    f.provider(async () => {throw new Error('embedding_provider_http_503');});
    await f.acquire(); await f.run(); await f.run(); f.startJobs(); await f.repository.knowledgeJobs.idle();
    const parseId = f.repository.documents.get(f.job().documentId).currentParseId;
    assert.equal((await f.run()).status, 'queued'); await f.repository.knowledgeJobs.idle();
    assert.equal((await f.run()).status, 'failed');
    f.provider(async texts => texts.map(() => [3, 4, 0]));
    assert.equal((await f.run({attempts: 0})).status, 'queued'); await f.repository.knowledgeJobs.idle();
    assert.equal((await f.run()).stage, 'wiki'); assert.equal(f.parses(), 1);
    assert.equal(f.repository.documents.get(f.job().documentId).currentParseId, parseId);
  } finally {await f.close();}
});

test('changed workspace receipts and stale import transactions cannot publish a managed document', async () => {
  for (const change of ['receipt', 'generation']) {
    const f = await fixture();
    try {
      await f.acquire();
      if (change === 'receipt') await writeFile(join(f.workspace, f.job().receipt.relativePath), 'changed');
      let calls = 0;
      const result = await f.run({}, () => {if (change === 'generation' && ++calls >= 3) throw new Error('literature_acquisition_changed');});
      assert.equal(result.status, 'blocked');
      assert.equal(f.repository.documents.list(f.item.id).length, 0);
    } finally {await f.close();}
  }
});

test('empty PDFs and generation changes during parsing cannot enter the knowledge index', async () => {
  for (const change of ['empty', 'generation']) {
    const f = await fixture({empty: change === 'empty'});
    try {
      await f.acquire(); await f.run();
      let stale = false; f.afterParse(() => {stale = true;});
      const result = await f.run({}, () => {if (change === 'generation' && stale) throw new Error('literature_acquisition_changed');});
      assert.equal(result.status, change === 'generation' ? 'blocked' : 'failed', `${change}: ${result.errorCode}`);
      assert.equal(f.repository.documents.get(f.job().documentId).currentParseId, null);
      assert.equal(f.db.prepare("SELECT count(*) FROM research_knowledge_documents WHERE id LIKE 'document:%'").pluck().get(), 0);
    } finally {await f.close();}
  }
});

test('a scholarly DOI conflicting with the target paper fails before any knowledge publication', async () => {
  const f = await fixture({mismatch: true});
  try {
    await f.acquire(); await f.run();
    const result = await f.run(); assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'research_document_source_mismatch');
    assert.equal(f.repository.documents.get(f.job().documentId).currentParseId, null);
    assert.equal(f.db.prepare("SELECT count(*) FROM research_knowledge_documents WHERE id LIKE 'document:%'").pluck().get(), 0);
  } finally {await f.close();}
});

test('a ready job with missing vectors or corrupt immutable IR fails verified readiness', async () => {
  for (const change of ['vectors', 'IR', 'source', 'workspace']) {
    const f = await fixture();
    try {
      await f.acquire(); await f.run(); await f.run(); f.startJobs(); await f.repository.knowledgeJobs.idle();
      const document = f.repository.documents.get(f.job().documentId);
      if (change === 'vectors') f.db.prepare('DELETE FROM research_knowledge_embeddings').run();
      if (change === 'IR') {
        const {data} = f.repository.documents.parsed(document.id, document.currentParseId);
        await writeFile(join(f.root, data.paperIR.path), 'corrupt');
      }
      if (change === 'source') await writeFile(join(f.root, f.repository.documents.sourcePath(document.id)), 'corrupt');
      if (change === 'workspace') await writeFile(join(f.workspace, f.job().receipt.relativePath), 'corrupt');
      assert.equal((await f.run()).status, 'failed');
    } finally {await f.close();}
  }
});
