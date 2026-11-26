import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {load} from 'sqlite-vec';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {scientificWikiCandidates} from './fixtures/scientific-wiki-fixture.mjs';

let api;
before(async () => {
  const [base, ...modules] = await Promise.all([loadResearchTestApi(),
    ...['ovis-document-parser', 'ovis-source-artifact', 'ovis-document-adapter', 'ovis-parsed-document',
      'scientific-library-index', 'scientific-retrieval-router', 'scientific-extraction-service'].map(name =>
      importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node',
        external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'}))]);
  api = Object.assign(base, ...modules);
});
after(() => api?.dispose());
const hash = value => createHash('sha256').update(value).digest('hex');
const model = {engine: 'ovisocr3-mlx', revision: '702a71f233a208be050b12779ee29fdd1eb2dab3', quantization: '8bit',
  groupSize: 64, visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: 'a'.repeat(64),
  inferenceSha256: 'b'.repeat(64), promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'};
const roles = ['problem', 'contribution', 'method', 'experimental_setup', 'results', 'limitations'];
const html = '<table><tr><th>Method</th><th>F1 (%)</th></tr><tr><td rowspan="2">Original baseline</td><td>90</td></tr><tr><td>91</td></tr></table>';
const latex = '$$x = y \\tag{7}$$';
function raw(page, revision) {
  return JSON.stringify(page === 1 ? [
    {category: 'paragraph_title', content: '2 Method', bbox: [50, 30, 900, 90]},
    {category: 'text', content: `Ovisuniquesentinel ${revision} method uses Dataset C. See Eq. (7).`, bbox: [50, 110, 900, 200]},
    {category: 'figure_title', content: 'Table 3: Dataset C results.', bbox: [50, 220, 900, 270]},
    {category: 'table', content: html, bbox: [50, 280, 900, 480]},
    {category: 'image', content: '<img src="untrusted-model-path.png">', bbox: [50, 510, 900, 760]},
    {category: 'figure_title', content: 'Figure 2: Original architecture.', bbox: [50, 780, 900, 840]}
  ] : [
    {category: 'display_formula', content: latex, bbox: [50, 60, 900, 180]},
    {category: 'text', content: 'where $x$ denotes the original input.', bbox: [50, 220, 900, 300]}
  ]);
}

/** Controlled OCR/embedding responses; real source capture, service, storage and indexes. No model quality claim. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-ovis-downstream-')));
  const f = createResearchFixture(api, 'reading', root);
  let embeddings, documents;
  const close = async () => {
    await documents?.shutdown();
    await f.repository.knowledgeJobs.shutdown();
    await embeddings?.shutdown();
    await f.close();
    await rm(root, {recursive: true, force: true});
  };
  try {
    load(f.db);
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let page = 1; page <= 2; page++) {
      pdf.addPage([400, 600]).drawText(`Original source page ${page}`, {x: 30, y: 550, size: 10, font});
    }
    const bytes = Buffer.from(await pdf.save()), input = join(root, 'input.pdf');
    await writeFile(input, bytes);
    const title = 'Controlled Ovis downstream fixture';
    const item = f.repository.library.import([{metadata: {id: 'ovis-fixture', source: 'local', externalId: 'ovis-fixture',
      doi: null, title, authors: ['Fixture'], abstract: null, publishedYear: 2026, citationCount: null,
      url: null, openAccessUrl: null, importedAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z'},
      bibliography: {citationKey: 'ovis2026', entryType: 'article', fields: {title}, preambles: [], csl: null,
        title, authors: ['Fixture'], doi: null, publishedYear: 2026, abstract: null, url: null}}
    ], f.project.id, {notify: false}).items[0];
    const config = {id: 'ovis-fixture', name: 'Fixture', enabled: true, baseUrl: 'https://fixture.invalid',
      model: 'fixture-1', dimensions: 3};
    f.repository.knowledge.saveEmbeddingConfig(config, 'fixture-secret');
    let provider = async texts => texts.map(() => [3, 4, 0]);
    embeddings = new api.ResearchEmbeddingService(f.repository.knowledge,
      {embed: async ({texts, signal}) => provider(texts, signal)},
      {secrets: {get: async () => 'fixture-key'}, logger: {info() {}, warn() {}, error() {}}});
    const library = new api.ScientificLibraryIndexService(f.repository, embeddings, root);
    let revision = 'first', workerHook = async () => {}, resultHook = async () => {};
    const leases = {acquired: 0, released: 0}, outputs = [];
    const models = {acquire: async signal => {
      signal.throwIfAborted(); leases.acquired++;
      return {installation: {identity: model}, release: () => {leases.released++;}};
    }};
    documents = new api.ResearchDocumentService(f.repository, {
      defaultParseOptions: () => ({tier: 'complete', device: 'auto', pageRange: ''}),
      parseDocument: async request => {
        outputs.push(request.outputDir);
        const result = await api.parseOvisDocument({...request, sourceKind: 'pdf', pages: null, timeoutMs: 60_000,
          admission: {...request.admission, resourceClass: 'parse'}}, models, {
          capture: capture => api.createOvisSourceArtifact(capture, async worker => {
            await workerHook(worker);
            return {process: {exitCode: 0}, pages: worker.pages.map(({binding}) => {
              const output = raw(binding.frame.page, revision);
              return api.adaptOvisPage(Buffer.from(output), {protocolVersion: 1, sourceHash: binding.sourceHash,
                inputImageSha256: binding.inputImageSha256, model, page: binding.frame.page,
                width: binding.frame.width, height: binding.frame.height, rawSha256: hash(output),
                generation: {finishReason: 'stop', generationTokens: 2, tokenIds: [17, 248046]}}, binding);
            })};
          }), write: api.writeOvisParsedDocument
        });
        await resultHook(request, result);
        return result;
      }
    }, root, null, null, library);
    const document = await documents.import({target: 'library-item', libraryItemId: item.id,
      projectId: f.project.id, sourcePath: input});
    const source = join(root, f.repository.documents.sourcePath(document.id));
    const router = new api.ScientificRetrievalRouter(f.repository, embeddings, {library: root, index: null},
      new api.ScholarlyRelationsRepository(f.db, f.repository), null, null);
    return {...f, root, bytes, source, document, documents, router, leases, outputs, close,
      parse: () => documents.parse(document.id, 'complete'),
      search: query => router.search({projectId: f.project.id, query, documentIds: [document.id],
        embeddingConfigId: null, limit: 20, candidateLimit: 100, rerank: 'none'}),
      revision: value => {revision = value;}, workerHook: value => {workerHook = value;},
      resultHook: value => {resultHook = value;}, provider: value => {provider = value;},
      changeEmbedding: () => f.repository.knowledge.saveEmbeddingConfig({...config, model: 'fixture-2'}, 'fixture-secret')};
  } catch (error) {await close(); throw error;}
}

function assertPageOnly(locator, f, parseId) {
  assert.equal(locator.documentId, f.document.id);
  assert.equal(locator.parseId, parseId);
  assert.equal(locator.sourceHash, hash(f.bytes));
  assert.ok(locator.locations.length > 0);
  for (const location of locator.locations) {
    assert.ok([1, 2].includes(location.page));
    assert.equal(location.bbox, null);
    assert.equal(location.coordinateOrigin, null);
  }
}
function activeState(f) {
  return {
    generic: f.db.prepare("SELECT * FROM research_knowledge_chunks WHERE document_id LIKE 'document:%' ORDER BY id").all(),
    vectors: f.db.prepare('SELECT * FROM research_knowledge_embeddings ORDER BY chunk_id,space_key').all(),
    generations: f.db.prepare("SELECT * FROM research_scientific_index_generations WHERE status='active' ORDER BY id").all(),
    scientificVectors: f.db.prepare(`SELECT e.* FROM research_scientific_embeddings e
      JOIN research_scientific_index_generations g ON g.id=e.generation_id WHERE g.status='active' ORDER BY e.chunk_id`).all()
  };
}
async function wikiPage(f) {
  await f.repository.paperCards.idle(); await f.repository.wiki.idle();
  const pages = (await f.repository.wiki.search(f.project.id)).pages;
  assert.equal(pages.length, 1);
  return f.repository.wiki.read(f.project.id, pages[0].id);
}

test('Ovis service publishes original objects and page-only sources into real FTS and sqlite-vec retrieval', async () => {
  const f = await fixture();
  try {
    const parsed = await f.parse(); assert.equal(parsed.status, 'ready');
    const parseId = parsed.currentParseId, {data} = f.repository.documents.parsed(parsed.id, parseId);
    const ir = await f.documents.paperIR(parsed.id, parseId);
    assert.deepEqual(data.content.modelIdentity, model);
    assert.equal(data.content.engine, 'ovisocr3-mlx'); assert.equal(data.content.quality.status, 'review');
    assert.equal(ir.tables.length, 1); assert.equal(ir.equations.length, 1); assert.equal(ir.figures.length, 1);
    assert.equal(ir.tables[0].data.rawHtml, html); assert.equal(ir.equations[0].data.rawLatex, latex);
    assert.deepEqual(ir.tables[0].cells.map(cell => cell.text), ['Method', 'F1 (%)', 'Original baseline', '90', '91']);
    for (const cell of ir.tables[0].cells) assertPageOnly(cell.sourceLocator, f, parseId);
    const result = await f.search('Ovisuniquesentinel Dataset C F1 table equation figure original input architecture');
    assert.ok(result.candidates.some(candidate => candidate.signals.some(signal => signal.method === 'fts')));
    assert.ok(result.candidates.some(candidate => candidate.signals.some(signal => signal.method === 'dense')));
    for (const kind of ['text', 'table', 'equation']) assert.ok(result.candidates.some(c => c.object.kind === kind), kind);
    assert.ok(result.candidates.every(candidate => candidate.object.kind !== 'figure'),
      'figures with only candidate captions have no attributable text for retrieval');
    assert.ok(result.candidates.some(candidate => candidate.content.includes('Figure 2: Original architecture.')),
      'the original caption remains independently searchable');
    for (const candidate of result.candidates) {
      if (candidate.sourceLocator) assertPageOnly(candidate.sourceLocator, f, parseId);
      for (const source of candidate.sources) assertPageOnly(source.locator, f, parseId);
      if (candidate.object.kind === 'table') for (const cell of candidate.object.cells) assertPageOnly(cell.sourceLocator, f, parseId);
    }
    const equation = result.candidates.find(c => c.object.kind === 'equation');
    assert.equal(equation.object.data.rawLatex, latex);
    assert.ok(equation.sourceLocator.locations.every(location => location.page === 2));
    const numbered = await f.search('Table 3 Figure 2');
    assert.ok(numbered.candidates.every(candidate => !['table', 'figure'].includes(candidate.object.kind)),
      'unverified candidate captions do not establish exact numbered-object identities');
    assert.ok(ir.figures[0].data.captions.length > 0);
    assert.ok(ir.figures[0].data.captions.every(caption => caption.status === 'candidate'));
    const chunks = f.repository.scientificIndex.chunks(f.repository.scientificIndex.active(null, parsed.id).id, null);
    for (const candidate of result.candidates.filter(value => value.chunkId !== null)) {
      assert.ok(chunks.find(chunk => chunk.id === candidate.chunkId)?.retrieval,
        `non-retrievable ${candidate.object.kind} ${candidate.chunkId}`);
    }
    await f.router.assertCurrent(result);
    const context = await f.router.readContext({search: result,
      candidateIds: result.candidates.filter(candidate => ['table', 'equation'].includes(candidate.object.kind)).map(candidate => candidate.id)});
    const table = context.evidence.find(evidence => evidence.object.kind === 'table');
    assert.ok(table.object.cells.some(cell => cell.text === '90'));
    const tableAsset = data.content.assets.find(asset => asset.id === ir.tables[0].data.assetId);
    assert.ok(tableAsset, 'table image is an actual captured raster crop');
    assert.equal(hash(await readFile(join(f.root, data.outputPath, data.files[tableAsset.id]))), tableAsset.sha256);
    assert.equal(context.evidence.find(evidence => evidence.object.kind === 'equation').object.data.rawLatex, latex);
    for (const evidence of context.evidence) {
      for (const hit of evidence.hits) for (const source of hit.sources) assertPageOnly(source.locator, f, parseId);
      for (const passage of evidence.passages) assertPageOnly(passage.sourceLocator, f, parseId);
    }
    assert.ok(activeState(f).vectors.length > 0); assert.ok(activeState(f).scientificVectors.length > 0);
    assert.equal(f.repository.knowledgeJobs.list(null).find(job => job.documentId === `document:${parseId}`).status, 'ready');
    assert.deepEqual(f.leases, {acquired: 1, released: 1});
    assert.deepEqual(await readFile(f.source), f.bytes);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.close();}
});

test('Ovis Paper Cards publish six Wiki sections citing current original blocks and preserve historical parse references', async () => {
  const f = await fixture();
  try {
    f.repository.paperCards.start(async (_title, blocks) => {
      const original = blocks.find(block => block.text.includes('Ovisuniquesentinel'));
      assert.ok(original);
      return {sections: roles.map(role => ({role, body: original.text, chunkIds: [original.source.chunkId]}))};
    }, {pollMs: 60_000});
    const first = await f.parse(); assert.equal(first.status, 'ready');
    const page = await wikiPage(f), original = page.current;
    assert.equal(page.paperJob.status, 'ready'); assert.equal(original.sections.length, 6);
    for (const section of original.sections) {
      assert.match(section.body, /Ovisuniquesentinel first/);
      assert.equal(section.paperSources.length, 1);
      assert.equal(section.paperSources[0].parseId, first.currentParseId);
      assert.equal(section.paperSources[0].sourceHash, hash(f.bytes));
    }
    const oldSearch = await f.search('Ovisuniquesentinel'), oldData = f.repository.documents.parsed(first.id, first.currentParseId).data;
    const oldGeneration = f.repository.scientificIndex.active(null, first.id).id;
    f.revision('second');
    const second = await f.parse(); assert.equal(second.status, 'ready');
    const updated = await wikiPage(f);
    assert.notEqual(second.currentParseId, first.currentParseId);
    assert.equal(updated.page.id, page.page.id);
    assert.ok(updated.current.sections.every(section => section.body.includes('Ovisuniquesentinel second') &&
      section.paperSources.every(source => source.parseId === second.currentParseId)));
    assert.deepEqual(f.repository.wiki.revision(f.project.id, page.page.id, page.page.revision), original);
    assert.deepEqual(f.repository.documents.parsed(first.id, first.currentParseId).data, oldData);
    assert.equal(f.repository.scientificIndex.get(oldGeneration).status, 'retired');
    await assert.rejects(f.router.assertCurrent(oldSearch), /source_changed/);
    const current = await f.search('Ovisuniquesentinel');
    assert.ok(current.hits.some(hit => hit.content.includes('second')));
    for (const hit of current.hits) if (hit.sourceLocator) assertPageOnly(hit.sourceLocator, f, second.currentParseId);
    assert.equal(f.repository.evidence.list(f.project.id).length, 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_claims').pluck().get(), 0);
  } finally {await f.close();}
});

test('Ovis downstream publication failure preserves both current indexes, source and historical IR', async () => {
  const f = await fixture();
  try {
    const first = await f.parse(); assert.equal(first.status, 'ready');
    const old = activeState(f), saved = await f.search('Ovisuniquesentinel');
    const originalIR = await f.documents.paperIR(first.id, first.currentParseId);
    f.changeEmbedding(); f.provider(async () => {throw new Error('embedding_provider_http_503');});
    const failed = await f.parse(); assert.equal(failed.status, 'failed');
    assert.equal(failed.currentParseId, first.currentParseId);
    assert.deepEqual(activeState(f), old);
    assert.deepEqual(await f.documents.paperIR(first.id, first.currentParseId), originalIR);
    // Retrieval with the prior configuration is no longer current, but no failed parse became searchable.
    assert.ok(f.db.prepare("SELECT count(*) FROM research_knowledge_keywords WHERE research_knowledge_keywords MATCH 'Ovisuniquesentinel'").pluck().get() > 0);
    assert.ok(saved.candidates.every(candidate => candidate.generationId === old.generations[0].id));
    assert.equal(f.repository.documents.runs(first.id)[0].status, 'failed');
    assert.deepEqual(f.leases, {acquired: 2, released: 2});
    assert.deepEqual(await readFile(f.source), f.bytes);
  } finally {await f.close();}
});

test('Ovis structured Paper Card and Wiki preserve original table evidence as unreviewed page-only knowledge', async () => {
  const f = await fixture();
  const extraction = new api.ScientificExtractionService(f.repository, {library: f.root, index: null}, async () => ({
    config: {extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'fixture/1',
      model: {provider: 'fixture', modelId: 'fixture', model: 'fixture', revision: '1'}, inputTokens: 16000, batchTokens: 8000},
    invoke: async () => {throw new Error('fixture_read_must_not_invoke_model');}
  }), () => 'fixture/1', {pollMs: 60_000});
  try {
    const first = await f.parse(); assert.equal(first.status, 'ready');
    const ir = await f.documents.paperIR(first.id, first.currentParseId);
    f.repository.paperCards.configureKnowledge((request, signal) => extraction.readPaperCard(request, signal));
    f.repository.wiki.configureKnowledge({
      state: (projectId, documentId) => extraction.wikiKnowledgeState(projectId, documentId),
      read: (projectId, ref, signal) => extraction.readPaperCard({projectId, ...ref}, signal)
    });
    const request = {projectId: f.project.id, documentId: first.id};
    const job = await extraction.enqueue(request);
    f.repository.scientificExtraction.claim(job.id, f.project.id);
    f.repository.scientificExtraction.publish(job.id, f.project.id, scientificWikiCandidates(ir), ir, () => job.snapshot);
    const card = await f.repository.paperCards.readKnowledge({...request, generationId: null});
    assert.equal(card.state, 'current'); assert.equal(card.version, 2);
    assert.deepEqual(card.objects, {tables: ir.tables, equations: ir.equations, figures: ir.figures, algorithms: ir.algorithms});
    const fact = card.knowledge.facts.find(value => value.factType === 'experimental_result');
    assert.equal(fact.value.raw, '90'); assert.equal(fact.value.normalized, '0.9');
    for (const value of card.knowledge.facts) {
      assert.equal(value.scientificApproval, 'unreviewed');
      for (const evidence of value.evidence) assertPageOnly(evidence.locator, f, first.currentParseId);
    }
    let page = await f.repository.wiki.createCurrent({projectId: f.project.id, title: 'Ovis source knowledge', kind: 'topic',
      evidenceIds: [], claimIds: [], paperKnowledgeSources: [{documentId: first.id, generationId: job.id}]});
    await f.repository.wiki.idle();
    page = await f.repository.wiki.readCurrent(f.project.id, page.page.id);
    assert.ok(page.current.sections.some(section => section.paperKnowledgeSources.some(source => source.generationId === job.id)));
    const historical = structuredClone(card.objects);
    f.revision('second'); assert.equal((await f.parse()).status, 'ready');
    const stale = await f.repository.paperCards.readKnowledge({...request, generationId: job.id});
    assert.equal(stale.state, 'stale'); assert.deepEqual(stale.objects, historical);
    assert.ok(stale.knowledge.facts.every(value => value.status === 'stale'));
    const wiki = await f.repository.wiki.readCurrent(f.project.id, page.page.id);
    assert.ok(wiki.current.sections.some(section => section.status === 'stale'));
  } finally {await extraction.shutdown(); await f.close();}
});

test('Ovis cancellation after raster capture releases the lease, removes only its job and permits retry', async () => {
  const f = await fixture();
  try {
    const first = await f.parse(); assert.equal(first.status, 'ready');
    const old = activeState(f);
    let enter;
    const entered = new Promise(resolve => {enter = resolve;});
    f.workerHook(async worker => {
      enter();
      await new Promise((resolve, reject) => worker.signal.addEventListener('abort', () => reject(worker.signal.reason), {once: true}));
    });
    const operation = f.parse(); await entered;
    const active = f.repository.documents.get(f.document.id);
    assert.ok(active.activeParseId); f.documents.cancel(active.id, active.activeParseId);
    const cancelled = await operation;
    assert.equal(cancelled.currentParseId, first.currentParseId);
    assert.equal(f.repository.documents.runs(first.id)[0].status, 'cancelled');
    assert.deepEqual(activeState(f), old);
    await assert.rejects(access(f.outputs.at(-1)), {code: 'ENOENT'});
    await access(f.outputs[0]); assert.deepEqual(f.leases, {acquired: 2, released: 2});
    f.workerHook(async () => {});
    assert.equal((await f.parse()).status, 'ready');
    assert.deepEqual(f.leases, {acquired: 3, released: 3});
  } finally {await f.close();}
});

test('changed Ovis raw capture cannot reach publication or replace an earlier ready parse', async () => {
  const f = await fixture();
  try {
    const first = await f.parse(); assert.equal(first.status, 'ready');
    const old = activeState(f);
    f.resultHook(async request => writeFile(join(request.outputDir, 'evidence/page-1.json'), '{}'));
    const failed = await f.parse(); assert.equal(failed.status, 'failed');
    assert.equal(failed.currentParseId, first.currentParseId);
    assert.equal(f.repository.documents.runs(first.id)[0].error, 'research_ovis_artifact_changed');
    assert.deepEqual(activeState(f), old);
    await assert.rejects(access(f.outputs.at(-1)), {code: 'ENOENT'});
    await access(f.outputs[0]);
    await f.router.assertCurrent(await f.search('Ovisuniquesentinel'));
  } finally {await f.close();}
});
