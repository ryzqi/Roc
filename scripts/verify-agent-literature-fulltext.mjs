import assert from 'node:assert/strict';
import {access, copyFile, cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';

// Component acceptance, not a simulated Agent success message. The default
// runner requires Electron; --native explicitly runs the narrower Node boundary.
// Every writable path is a fresh temporary directory. No smoke git seed, user
// profile, real provider, model, OCR download or production DB is used.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const fulltextMarkers = ['quartzfalconproof731', 'cobaltbadgerproof419'];
export const fulltextToolNames = {
  plan: 'research_search_literature_plan',
  search: 'research_search_literature', read: 'research_read_literature_search', add: 'research_add_literature',
  get: 'research_get_literature_import', cancel: 'research_cancel_literature_import',
  progress: 'research_get_literature_processing', retry: 'research_retry_literature_processing', cancelProcessing: 'research_cancel_literature_processing'
};
const runtimeImports = `
import {createHash} from 'node:crypto';
import {readFile, mkdir, readdir} from 'node:fs/promises';
import {createServer, request as httpRequest} from 'node:http';
import {join} from 'node:path';
import net from 'node:net';
import Database from 'better-sqlite3';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {applyAgentDatabaseSchema, applyResearchDatabaseSchema} from './src/main/infrastructure/database-schemas';
import {CapabilityRegistry} from './src/main/kernel/capability-registry';
import {withLiteratureContext} from './src/main/services/literature-context';
import {createLiteratureTools, createLiteratureProcessingTools} from './src/main/plugins/agent/literature-tools';
import {ResearchRepository} from './src/main/plugins/research/repository';
import {ResearchTaskRepository} from './src/main/plugins/research/research-task-repository';
import {ResearchDocumentService} from './src/main/plugins/research/document-service';
import {parseResearchDocument} from './src/main/plugins/research/document-parser';
import {modelPackManifest} from './src/main/plugins/research/model-catalog';
import {normalizeResearchBibliography} from './src/main/plugins/research/bibliography';
import {ResearchLibraryService} from './src/main/plugins/research/library-service';
import {LiteratureSearchService} from './src/main/plugins/research/literature-service';
import {LiteratureImportService} from './src/main/plugins/research/literature-import-service';
import {LiteratureAcquisitionService} from './src/main/plugins/research/literature-acquisition-service';
import {LiteratureAcquisitionRepository} from './src/main/plugins/research/literature-acquisition-repository';
import {LiteraturePdfAcquisition} from './src/main/plugins/research/literature-pdf-acquisition';
import {PdfDownloadService} from './src/main/plugins/research/pdf-download-service';
import {createLiteratureProviderGovernor} from './src/main/plugins/research/literature-provider-governor';
import {literatureImportCapabilities, registerLiteratureImportCapabilities} from './src/main/plugins/research/literature-import-capabilities';
import {literatureAcquisitionCapabilities, registerLiteratureAcquisitionCapabilities} from './src/main/plugins/research/literature-acquisition-capabilities';
import {ResearchEmbeddingService} from './src/main/plugins/research/embedding-service';
import {OpenAICompatibleEmbeddingClient} from './src/main/plugins/research/embedding-client';
import {ScientificLibraryIndexService} from './src/main/plugins/research/scientific-library-index';
import {loadResearchVectorExtension} from './src/main/plugins/research/research-vector-extension';
import {ResearchLiteratureAcquisitionWiki} from './src/main/plugins/research/literature-acquisition-wiki';
import {LiteratureWikiAcquisition, reconcileAcquisitionReadiness} from './src/main/plugins/research/literature-wiki-acquisition';
import {RadarService} from './src/main/plugins/research/radar-service';
import {ReadingRepository} from './src/main/plugins/research/reading-repository';
import {ReadingDiscoveryService} from './src/main/plugins/research/reading-discovery';
`;

// Serialized into an isolated bundle so Electron and Node exercise identical
// source services. Only provider transports and model generation are fixtures.
async function createRuntimeFixture(root, options = {}) {
  const markers = ['quartzfalconproof731', 'cobaltbadgerproof419'];
  const counters = {downloads: 0, parses: 0, embeddingRequests: 0, cards: 0};
  const providerUrls = [], embeddedTexts = [], unexpectedRequests = [], stages = [], toolCalls = [], pdfRequests = [];
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const workspace = join(root, 'workspace');
  await mkdir(workspace, {recursive: true});
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  let fixturePort = null;
  globalThis.fetch = async input => {unexpectedRequests.push(String(input)); throw new Error('fixture_network_denied');};
  net.Socket.prototype.connect = function (...args) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (fixturePort !== null && input?.host === '127.0.0.1' && Number(input.port) === fixturePort) {
      return originalConnect.apply(this, args);
    }
    unexpectedRequests.push('node_socket_connection'); throw new Error('fixture_network_denied');
  };
  const cleanup = [() => {globalThis.fetch = originalFetch; net.Socket.prototype.connect = originalConnect;}];
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    const errors = [];
    for (const dispose of cleanup.reverse()) {try {await dispose();} catch (error) {errors.push(error);}}
    if (errors.length) throw new AggregateError(errors, 'fixture_cleanup_failed');
  };
  try {
  let embeddingAvailable = options.embeddingAvailable !== false;
  const pdfs = [];
  for (const marker of markers) {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([612, 792]);
    page.drawText('Synthetic acquisition study', {x: 32, y: 754, font, size: 15});
    page.drawText('2 Methods', {x: 32, y: 725, font, size: 13});
    const lines = [
      `The original body contains ${marker} as a reproducible evidence token.`,
      'This synthetic experiment studies secure agents using a fixed controlled protocol.',
      'Every participant follows the same schedule under the stated laboratory conditions.',
      'The evidence remains in the original document and never in metadata abstracts.',
      'Researchers preserve source bytes before deriving document structure and search indexes.',
      'The measurement uses independent observations with transparent limits and careful reporting.',
      'A durable receipt records content identity while background processing can be resumed.',
      'The protocol evaluates retrieval of original passages rather than generated summaries.',
      'No real paper, private workspace, external service or production credential is involved.',
      'Results apply only to this controlled synthetic fixture and establish engineering coverage.'
    ];
    lines.forEach((text, index) => page.drawText(text, {x: 32, y: 697 - index * 21, font, size: 9}));
    pdfs.push(Buffer.from(await pdf.save({useObjectStreams: false})));
  }
  const pdfServer = createServer((request, response) => {
    const match = /^\/paper-([12])\.pdf$/u.exec(request.url ?? '');
    if (request.method !== 'GET' || !match) {
      unexpectedRequests.push(`http:${request.method}:${request.url}`);
      response.writeHead(404); response.end(); return;
    }
    const bytes = pdfs[Number(match[1]) - 1];
    counters.downloads++; pdfRequests.push(request.url);
    response.writeHead(200, {'content-type': 'application/pdf', 'content-length': String(bytes.length)});
    for (let i = 0; i < bytes.length; i += 113) response.write(bytes.subarray(i, i + 113));
    response.end();
  });
  cleanup.push(async () => {
    pdfServer.closeAllConnections();
    await new Promise((resolve, reject) => pdfServer.close(error => error ? reject(error) : resolve()));
    fixturePort = null;
  });
  await new Promise((resolve, reject) => {
    const failed = error => reject(error);
    pdfServer.once('error', failed);
    pdfServer.listen(0, '127.0.0.1', () => {pdfServer.off('error', failed); resolve();});
  });
  fixturePort = pdfServer.address().port;
  const papers = [0, 1, 2, 3].map(index => ({id: `https://openalex.org/W${101 + index}`,
    doi: `https://doi.org/10.5555/roc-fulltext-${index + 1}`, title: `Synthetic secure agents study ${index + 1}`,
    publication_year: index === 3 ? 2021 : 2026, authorships: [{author: {display_name: 'Synthetic Author'}}], cited_by_count: 0,
    abstract_inverted_index: {Synthetic: [0], metadata: [1], contains: [2], no: [3], body: [4], evidence: [5]},
    primary_location: {landing_page_url: `https://landing.fixture.invalid/study-${index + 1}`, license: 'cc-by', version: 'publishedVersion'},
    open_access: {is_oa: index < 2, oa_url: index < 2 ? `https://pdf-${index + 1}.fixture.invalid/download` : null},
    best_oa_location: index < 2 ? {pdf_url: `https://pdf-${index + 1}.fixture.invalid/download`, license: 'cc-by', version: 'publishedVersion'} : null,
    locations: [{landing_page_url: `https://landing.fixture.invalid/study-${index + 1}`}]
  }));
  const providerFetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input)); providerUrls.push(url.href);
    if (url.origin === 'https://api.openalex.org') {
      if (url.pathname === '/works') return Response.json({meta: {count: papers.length}, results: papers});
      const paper = papers.find(item => url.pathname.endsWith(new URL(item.id).pathname) || decodeURIComponent(url.pathname).endsWith(item.doi.slice(16)));
      if (paper) return Response.json(paper);
    }
    if (url.origin === 'https://api.semanticscholar.org') return Response.json({});
    if (url.origin === 'https://www.ebi.ac.uk') return Response.json({resultList: {result: []}});
    unexpectedRequests.push(url.href); throw new Error('fixture_provider_route_denied');
  };
  const db = new Database(join(root, 'research.sqlite')); cleanup.push(() => db.close());
  const agentDb = new Database(join(root, 'agent.sqlite')); cleanup.push(() => agentDb.close());
  db.pragma('foreign_keys=ON'); agentDb.pragma('foreign_keys=ON');
  applyResearchDatabaseSchema(db, () => new Date().toISOString()); applyAgentDatabaseSchema(agentDb);
  loadResearchVectorExtension(db);
  const repo = new ResearchRepository(db, new ResearchTaskRepository(agentDb));
  const previous = db.prepare('SELECT id FROM research_projects LIMIT 1').get();
  const project = previous ? repo.getProject(previous.id) : repo.createProject({title: 'Synthetic fulltext acceptance', description: 'Disposable P5 fixture', workspacePath: workspace});
  const logger = {info() {}, warn() {}, error() {}};
  const embeddings = new ResearchEmbeddingService(repo.knowledge, new OpenAICompatibleEmbeddingClient(async (url, init) => {
    if (url !== 'https://embedding.fixture.invalid/v1/embeddings') throw new Error('fixture_embedding_route_denied');
    init.signal?.throwIfAborted();
    if (!embeddingAvailable) return Response.json({error: 'controlled outage'}, {status: 503});
    const {input} = JSON.parse(init.body); counters.embeddingRequests++; embeddedTexts.push(...input);
    return Response.json({data: input.map((text, index) => ({index,
      embedding: text.includes(markers[0]) ? [1, 0, 0, 0.1] : text.includes(markers[1]) ? [0, 1, 0, 0.1] : [0, 0, 1, 0.1]}))});
  }), {secrets: {get: async () => 'fixture-only', set: async () => {}, clear() {}}, logger});
  cleanup.push(() => embeddings.shutdown());
  if (options.configureEmbedding !== false && !embeddings.selectedIdentity(null)) await embeddings.saveConfig({id: 'fixture-embedding', name: 'Synthetic embedding',
    baseUrl: 'https://embedding.fixture.invalid/v1', model: 'fixture-4', dimensions: 4, apiKey: 'fixture-only', enabled: true});
  const scientific = new ScientificLibraryIndexService(repo, embeddings, root);
  const normalizeBibliography = async input => (await normalizeResearchBibliography(input)).entries;
  const documents = new ResearchDocumentService(repo, {normalizeBibliography,
    defaultParseOptions: () => ({tier: 'compact', device: 'cpu', pageRange: ''}),
    parseDocument: async input => {counters.parses++; return await parseResearchDocument({...input, modelFiles: null, modelManifest: modelPackManifest('compact')});}
  }, root, null, null, scientific);
  cleanup.push(() => documents.shutdown());
  const governor = createLiteratureProviderGovernor(), search = new LiteratureSearchService(providerFetch, governor);
  cleanup.push(() => search.shutdown());
  const library = new ResearchLibraryService(repo.library, {normalizeBibliography}, root, providerFetch);
  cleanup.push(() => library.shutdown());
  const acquisitionRepository = new LiteratureAcquisitionRepository(db);
  const acquisition = new LiteratureAcquisitionService(acquisitionRepository);
  const reading = new ReadingRepository(db, repo);
  const radar = new RadarService(reading, embeddings, library, acquisition);
  const discovery = new ReadingDiscoveryService(reading, radar, async () =>
    '<meta name="citation_title" content="Synthetic acquisition study"><meta name="citation_pdf_url" content="https://pdf-1.fixture.invalid/download">');
  cleanup.push(() => radar.shutdown(), () => discovery.shutdown());
  const downloader = new PdfDownloadService(root, {lookup: async host => {
    if (!/^pdf-[12]\.fixture\.invalid$/u.test(host)) throw new Error('fixture_dns_route_denied');
    return [{address: '93.184.216.34', family: 4}];
  }, request: async (url, address, signal) => {
    signal.throwIfAborted();
    const match = /^https:\/\/pdf-([12])\.fixture\.invalid\/download$/u.exec(url.href);
    if (!match || address.address !== '93.184.216.34') throw new Error('fixture_pdf_route_denied');
    // Redirect only the injected transport to a real loopback HTTP fixture.
    // Production URL/DNS restrictions remain intact, including SSRF rejection.
    return await new Promise((resolve, reject) => {
      const request = httpRequest({hostname: '127.0.0.1', port: fixturePort, path: `/paper-${match[1]}.pdf`,
        method: 'GET', agent: false, signal}, response => resolve({status: response.statusCode ?? 0,
          headers: response.headers, body: response, cancel: () => response.destroy()}));
      request.once('error', reject); request.end();
    });
  }});
  const pipeline = new LiteraturePdfAcquisition(repo, repo.library, downloader, () => {}, governor, {resolver: {fetch: providerFetch}});
  await pipeline.initialize(); pipeline.configureDocumentPipeline(async () => documents);
  const wiki = new ResearchLiteratureAcquisitionWiki(repo.wiki, repo.paperCards);
  pipeline.configureWikiPipeline(new LiteratureWikiAcquisition(wiki, acquisitionRepository).process);
  acquisitionRepository.resumeBlockedWiki();
  const imports = new LiteratureImportService(db, repo.library, search, library, async () => {}, undefined, acquisition);
  cleanup.push(() => imports.shutdown());
  const registry = new CapabilityRegistry(), context = {pluginId: 'fulltext-fixture', capabilities: registry};
  for (const descriptor of [...literatureImportCapabilities, ...literatureAcquisitionCapabilities]) registry.declare(context.pluginId, descriptor);
  registerLiteratureImportCapabilities(context, imports); registerLiteratureAcquisitionCapabilities(context, acquisition);
  const allowed = new Set([...literatureImportCapabilities, ...literatureAcquisitionCapabilities].map(item => item.name));
  const scope = {owner: 'thread:synthetic-fulltext', projectId: project.id};
  const tools = new Map([...createLiteratureTools(registry, scope, {
    search: 'research_search_literature', read: 'research_read_literature_search', add: 'research_add_literature',
    get: 'research_get_literature_import', cancel: 'research_cancel_literature_import'
  }), ...createLiteratureProcessingTools(registry, scope)].map(item => [item.name, item]));
  cleanup.push(async () => {await repo.knowledgeJobs.shutdown(); await repo.paperCards.shutdown(); await repo.wiki.shutdown();});
  repo.wiki.configureSearch(embeddings); repo.wiki.start();
  repo.paperCards.start(async (_title, blocks, signal) => {
    signal.throwIfAborted(); counters.cards++;
    const block = blocks.find(item => markers.some(marker => item.text.includes(marker))) ?? blocks[0];
    if (!block) throw new Error('fixture_original_blocks_missing');
    return {sections: ['problem', 'contribution', 'method', 'experimental_setup', 'results', 'limitations']
      .map(role => ({role, body: block.text.slice(0, 900), chunkIds: [block.source.chunkId]}))};
  }, {pollMs: 50});
  repo.knowledgeJobs.start((id, signal, current) => id.startsWith('document:') ? scientific.rebuild(id, signal, current) : embeddings.embedDocument(id, null, signal));
  const unsubscribe = repo.knowledgeJobs.subscribeChanges(() => acquisition.wake());
  const unsubscribeSources = repo.subscribeKnowledgeSources(() => acquisition.wake());
  cleanup.push(unsubscribe, unsubscribeSources, () => acquisition.shutdown());
  acquisition.start(async (...args) => {const result = await pipeline.process(...args); stages.push({stage: args[0].stage, status: result.status, nextStage: result.stage, error: result.errorCode}); return result;},
    () => reconcileAcquisitionReadiness(acquisitionRepository, repo, wiki));
  const inspect = async () => {
    const items = db.prepare('SELECT id FROM research_library ORDER BY id').all().map(row => repo.library.get(row.id));
    const docs = [];
    for (const item of items) for (const document of repo.documents.list(item.id)) {
      const parsed = document.currentParseId ? documents.parsed(document.id, document.currentParseId) : null;
      const ir = document.currentParseId ? await documents.paperIR(document.id, document.currentParseId) : null;
      const generation = repo.scientificIndex.active(null, document.id);
      if (generation) repo.scientificIndex.verify(generation.id);
      const identity = embeddings.selectedIdentity(null);
      docs.push({document, parsed, ir, generationId: generation?.id ?? null,
        allLeafVectors: !!identity && !!document.currentParseId && repo.knowledge.hasDocumentEmbeddings(`document:${document.currentParseId}`, identity.configId, identity.revision),
        wiki: wiki.readSource(project.id, document.id)});
    }
    const files = [];
    const walk = async path => {for (const entry of await readdir(path, {withFileTypes: true})) {
      const child = join(path, entry.name); if (entry.isDirectory()) await walk(child);
      else {const bytes = await readFile(child); files.push({path: child.slice(workspace.length + 1), bytes: bytes.length, sha256: hash(bytes), pdf: bytes.subarray(0, 5).toString() === '%PDF-'});}
    }};
    await walk(workspace);
    return {projectId: project.id, runtime: {pid: process.pid, electron: process.versions.electron ?? null, node: process.versions.node, modules: process.versions.modules, arch: process.arch},
      items, documents: docs, jobs: withLiteratureContext(scope, () => acquisition.list({offset: 0, limit: 50})).jobs,
      files, counters: {...counters}, pdfRequests: [...pdfRequests], providerUrls: [...providerUrls], embeddedTexts: [...embeddedTexts], unexpectedRequests: [...unexpectedRequests], stages: [...stages], toolCalls: [...toolCalls], toolNames: [...tools.keys()],
      foreignKeys: db.pragma('foreign_key_check'), integrity: db.pragma('integrity_check'), expectedPdfHashes: pdfs.map(hash)};
  };
  return {close, async invoke(name, input = {}) {
    if (closed) throw new Error('fixture_closed');
    if (tools.has(name)) {toolCalls.push(name); return await tools.get(name).invoke(input);}
    if (allowed.has(name)) return await withLiteratureContext(scope, () => registry.invoke(name, input));
    if (name === 'fixture.inspect') return await inspect();
    if (name === 'fixture.importCoolPapers') {
      const article = await discovery.capturePage(project.id, 'https://papers.cool/venue/fixture');
      return await radar.importArticle(project.id, article.id);
    }
    if (name === 'fixture.searchBody') return await embeddings.search({query: input.marker, projectId: project.id, limit: 10, embeddingConfigId: null});
    if (name === 'fixture.wikiBatch') {
      const ids = db.prepare("SELECT id FROM research_documents WHERE current_parse_id IS NOT NULL").all().map(row => row.id);
      await repo.paperCards.idle(); await repo.wiki.idle();
      const result = wiki.readBatch(project.id, input.batchId);
      if (!result?.pageId) throw new Error('fixture_automatic_wiki_batch_missing');
      return {result,
        page: repo.wiki.read(project.id, result.pageId), sources: ids.map(documentId => repo.wiki.acquisitionSource(project.id, documentId))};
    }
    if (name === 'fixture.enableEmbedding') {
      embeddingAvailable = true;
      await embeddings.saveConfig({id: 'fixture-embedding', name: 'Synthetic embedding', baseUrl: 'https://embedding.fixture.invalid/v1', model: 'fixture-4', dimensions: 4, apiKey: 'fixture-only', enabled: true});
      repo.knowledgeJobs.configurationChanged(); acquisition.resumeDocumentPipeline(); return true;
    }
    throw new Error('fixture_ipc_method_denied');
  }};
  } catch (error) {
    try {await close();} catch (cleanupError) {throw new AggregateError([error, cleanupError], 'fixture_setup_failed');}
    throw error;
  }
}

export async function prepareFulltextFixture(options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-fulltext-acceptance-')));
  try {
    await writeFile(join(root, '.synthetic-fulltext-fixture'), 'Disposable fixture; no real Roc state.\n', {flag: 'wx'});
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    const runtimePath = join(root, 'runtime.mjs');
    await build({stdin: {contents: `${runtimeImports}\nexport const createFixture = ${createRuntimeFixture.toString()};`, resolveDir: repositoryRoot, sourcefile: 'p5-fulltext-fixture.ts'},
      outfile: runtimePath, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: {'.md': 'text', '.c': 'text'}, logLevel: 'silent'});
    let runtime;
    const load = async () => {runtime = await (await import(pathToFileURL(runtimePath).href)).createFixture(root, options);};
    return {root, runtimePath, options, async start() {await load(); return this;},
      invoke: (name, input) => runtime.invoke(name, input),
      async restart() {await runtime.close(); await load();},
      async close() {try {await runtime?.close();} finally {await rm(root, {recursive: true, force: true});}}};
  } catch (error) {await rm(root, {recursive: true, force: true}); throw error;}
}

async function until(action, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {value = await action(); if (predicate(value)) return value; await delay(40);} while (Date.now() < deadline);
  throw new Error(`fulltext_acceptance_timeout:${label}:${JSON.stringify(value)}`);
}

export async function exerciseFulltextAcceptance(invoke) {
  const checks = [], pass = name => checks.push(name);
  const plan = await invoke(fulltextToolNames.plan, {query: 'Synthetic secure agents', sources: ['openalex'],
    limit: 4, maxPages: 1, recentYears: 2, asOf: '2026-11-19'});
  assert.equal(plan.time.dateFrom, '2024-11-19'); assert.equal(plan.time.dateTo, '2026-11-19');
  assert.deepEqual((await invoke('fixture.inspect')).providerUrls, [], 'planning must not access providers');
  const search = await invoke(fulltextToolNames.search, plan.queries[0]);
  assert.equal(search.candidates.length, 3, JSON.stringify(search.sources));
  let snapshot = await invoke('fixture.inspect');
  assert.equal(snapshot.items.length, 0); assert.equal(snapshot.jobs.length, 0); assert.equal(snapshot.documents.length, 0);
  const pool = await invoke('research.literature.getPool', {executionId: search.executionId});
  assert.equal(pool.request.dateFrom, '2024-11-19'); assert.equal(pool.request.dateTo, '2026-11-19');
  const providerRequest = snapshot.providerUrls.map(value => new URL(value)).find(url => url.pathname === '/works');
  assert.equal(providerRequest?.searchParams.get('filter'), 'from_publication_date:2024-11-19,to_publication_date:2026-11-19');
  assert(pool.records.some(item => item.record.publishedYear === 2021), 'raw provider pool must include the excluded control');
  assert(search.candidates.every(item => item.record.publishedYear >= 2024 && item.record.publishedYear <= 2026), 'out-of-range candidate escaped year filtering');
  pass('Agent rolling-date plan reaches provider filters and local year fallback without importing papers');
  const entry = candidate => ({kind: 'candidate', searchId: search.searchId, candidateId: candidate.candidateId});
  const waitImport = async result => until(() => invoke(fulltextToolNames.get, {operationId: result.operationId}), item => !['queued', 'running'].includes(item.status), 'metadata import');
  const first = await waitImport(await invoke(fulltextToolNames.add, {requestId: 'p5-metadata-only', ingestionPolicy: 'metadata_only', entries: [entry(search.candidates[0])]}));
  assert.equal(first.status, 'completed');
  assert.equal(first.statusScope, 'metadata_import');
  snapshot = await invoke('fixture.inspect');
  assert.equal(snapshot.items.length, 1); assert.equal(snapshot.jobs.length, 0); assert.equal(snapshot.documents.length, 0); assert.equal(snapshot.counters.downloads, 0);
  pass('metadata_only creates no acquisition job or PDF');
  // Omit ingestionPolicy to exercise the real Agent tool's fulltext_auto default.
  const request = {requestId: 'p5-fulltext-batch', topicTitle: 'Synthetic secure agents', entries: search.candidates.map(entry)};
  const imported = await waitImport(await invoke(fulltextToolNames.add, request));
  assert.equal(imported.status, 'completed'); assert.equal(imported.counts.created, 2); assert.equal(imported.counts.alreadyPresent, 1);
  assert.equal(imported.statusScope, 'metadata_import'); assert.equal(imported.metadataImported, 3);
  assert.equal(imported.processingQueued, 3);
  const progress = await until(() => invoke(fulltextToolNames.progress, {operationId: imported.acquisitionBatchId, limit: 50}), state => state.total === 3 && state.jobs.length === 3 && state.jobs.every(job =>
    ['unavailable', 'ready', 'blocked', 'failed'].includes(job.status)), 'automatic acquisition via processing tool');
  assert.equal(progress.nextOffset, null);
  snapshot = await invoke('fixture.inspect');
  assert.deepEqual(snapshot.jobs.map(job => job.id).sort(), progress.jobs.map(job => job.id).sort());
  assert.equal(snapshot.items.length, 3); assert.equal(snapshot.documents.length, 2, JSON.stringify(snapshot.jobs));
  const unavailable = snapshot.jobs.filter(job => job.status === 'unavailable');
  assert.equal(unavailable.length, 1); assert.equal(unavailable[0].documentId, null); assert.equal(unavailable[0].receipt, null);
  assert.equal(snapshot.counters.downloads, 2); assert.equal(snapshot.counters.parses, 2);
  assert.deepEqual([...snapshot.pdfRequests].sort(), ['/paper-1.pdf', '/paper-2.pdf']);
  for (const job of snapshot.jobs.filter(job => job.documentId)) {
    assert.equal(job.status, 'ready', JSON.stringify(job));
    const file = snapshot.files.find(file => file.path === job.receipt?.relativePath);
    assert(file?.pdf); assert.match(file.path, /^papers\//u); assert.equal(file.sha256, job.receipt.sha256); assert.equal(file.bytes, job.receipt.bytes);
    assert(snapshot.expectedPdfHashes.includes(file.sha256), 'published bytes differ from supplied PDF fixture');
  }
  pass('real downloader streams two local HTTP PDFs into hash-bound files and closed access stays unavailable');
  for (const marker of fulltextMarkers) {
    assert(!JSON.stringify(snapshot.items.map(item => item.metadata)).includes(marker));
    const parsed = snapshot.documents.find(item => JSON.stringify(item.parsed?.content).includes(marker));
    assert(parsed, `native parser did not retain ${marker}`); assert.equal(parsed.document.status, 'ready');
    assert(parsed.ir); assert(parsed.generationId); assert.equal(parsed.allLeafVectors, true);
    assert(snapshot.embeddedTexts.some(text => text.includes(marker)), 'provider must receive original body');
    const hits = await invoke('fixture.searchBody', {marker});
    assert(hits.hits.some(hit => hit.content.includes(marker) && hit.keywordRank !== null && hit.vectorRank !== null), JSON.stringify(hits));
  }
  pass('native PDF parser, Paper IR, complete vectors and hybrid retrieval contain body-only evidence');
  const batch = await invoke('fixture.wikiBatch', {batchId: imported.operationId});
  assert.equal(batch.result.coverage.readySources, 2); assert.equal(batch.result.coverage.covered, 2);
  assert.equal(batch.result.coverage.missing, 1); assert.equal(batch.result.coverage.complete, false);
  const sections = batch.page.current?.sections ?? [];
  assert.equal(batch.sources.length, 2);
  assert(batch.sources.every(source => source.receipt.ready && source.snapshot?.sections.length === 6));
  for (const marker of fulltextMarkers) {
    const original = batch.sources.flatMap(source => source.snapshot?.originals ?? []).find(item => item.text.includes(marker));
    assert(original, `source Wiki lost original body evidence ${marker}`);
    assert(sections.some(section => section.body.includes(marker) && section.paperSources?.some(source => source.chunkId === original.source.chunkId)),
      `topic Wiki lost the original citation for ${marker}`);
  }
  pass('automatic acquisition publishes cited Paper Card, source Wiki and partial batch coverage');
  const repeated = await waitImport(await invoke(fulltextToolNames.add, request));
  assert.equal(repeated.operationId, imported.operationId);
  const after = await invoke('fixture.inspect');
  assert.equal(after.items.length, 3); assert.equal(after.jobs.length, 3); assert.equal(after.counters.downloads, 2); assert.equal(after.counters.parses, 2);
  assert.deepEqual(after.foreignKeys, []); assert(after.integrity.every(row => row.integrity_check === 'ok'));
  assert.deepEqual(after.unexpectedRequests, []);
  for (const name of [fulltextToolNames.plan, fulltextToolNames.search, fulltextToolNames.add, fulltextToolNames.get, fulltextToolNames.progress]) assert(after.toolCalls.includes(name), `actual Agent tool was not exercised: ${name}`);
  for (const name of Object.values(fulltextToolNames)) assert(after.toolNames.includes(name), `Agent tool was not mounted: ${name}`);
  pass('idempotent import retains SQLite integrity without unexpected provider traffic');
  const automaticWiki = after.jobs.filter(job => job.documentId).every(job => job.status === 'ready');
  return {status: automaticWiki ? 'Verified passing' : 'Changed, unverified', checks, automaticWiki,
    operationId: imported.operationId, toolCalls: [...new Set(after.toolCalls)], pdfTransport: 'loopback-http-fixture', snapshot: after, limitations: [
      ...(!automaticWiki ? ['Automatic acquisition wiki stage is not connected; Wiki APIs/workers verified separately.'] : []),
      'Fixture bootstrap uses production capabilities/services, not production ResearchPlugin startup, Agent reasoning, reader or UI.',
      'Parser implementation runs natively in main; production parser Worker launcher is outside this boundary.',
      'PDF bytes stream over local HTTP through an injected transport; production HTTPS/TLS and public DNS need separate network coverage.',
      'Rolling-date planning and outgoing OpenAlex date filters are verified; the controlled provider returns an out-of-range control for local year fallback, not live day-level filtering.',
      'Synthetic native-text PDFs do not exercise OCR, live OA providers or scientific synthesis quality.'
    ]};
}

export async function discoverFulltextElectron(env = process.env) {
  const require = createRequire(import.meta.url), candidates = [];
  let packageVersion = null;
  for (const name of ['ROC_FULLTEXT_ELECTRON_PATH', 'ELECTRON_EXECUTABLE_PATH']) if (env[name]) candidates.push(resolve(env[name]));
  try {
    const packagePath = require.resolve('electron/package.json'), directory = dirname(packagePath);
    packageVersion = JSON.parse(await readFile(packagePath, 'utf8')).version;
    try {candidates.push(join(directory, 'dist', (await readFile(join(directory, 'path.txt'), 'utf8')).trim()));} catch {}
    candidates.push(join(directory, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
  } catch {}
  const packagedAppPath = join(repositoryRoot, 'release', 'mac-arm64', 'Roc.app');
  const packagedExecutable = join(packagedAppPath, 'Contents', 'MacOS', 'Roc');
  if (process.platform === 'darwin' && process.arch === 'arm64') candidates.push(packagedExecutable);
  for (const candidate of [...new Set(candidates)]) {
    try {await access(candidate, constants.X_OK); return {available: true, executablePath: candidate, packageVersion, candidates,
      packagedAppPath: candidate === packagedExecutable ? packagedAppPath : null};} catch {}
  }
  return {available: false, executablePath: null, packageVersion, candidates};
}

export async function isolatedElectronExecutable(electron, root, entry, copyFrameworks = false) {
  if (!electron.packagedAppPath) return electron.executablePath;
  // Reuse only the runtime from the existing package. Never launch Roc's
  // app.asar: this disposable bundle contains our own fixture entry exclusively.
  const contents = join(root, 'FulltextFixture.app', 'Contents');
  const app = join(contents, 'Resources', 'app');
  await mkdir(join(contents, 'MacOS'), {recursive: true});
  await mkdir(app, {recursive: true});
  const executable = join(contents, 'MacOS', 'Roc');
  await copyFile(electron.executablePath, executable);
  const frameworks = join(electron.packagedAppPath, 'Contents', 'Frameworks');
  if (copyFrameworks) await cp(frameworks, join(contents, 'Frameworks'), {recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE});
  else await symlink(frameworks, join(contents, 'Frameworks'), 'dir');
  const plist = (await readFile(join(electron.packagedAppPath, 'Contents', 'Info.plist'), 'utf8'))
    .replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/u, '$1local.roc.fulltext.fixture$2')
    .replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/u, '$1FulltextFixture$2');
  await writeFile(join(contents, 'Info.plist'), plist, {flag: 'wx'});
  await writeFile(join(app, 'package.json'), JSON.stringify({name: 'roc-fulltext-fixture', version: '0.0.0', main: 'main.cjs'}), {flag: 'wx'});
  await writeFile(join(app, 'main.cjs'), `require(${JSON.stringify(entry)});\n`, {flag: 'wx'});
  return executable;
}

export async function signIsolatedElectron(executable, root) {
  const bundle = resolve(dirname(executable), '../..');
  const checkLinks = async path => {
    assert((await realpath(path)).startsWith(`${root}/`), `diagnostic_copy_escapes_root:${path}`);
    for (const item of await readdir(path, {withFileTypes: true})) {
      const child = join(path, item.name);
      if (item.isSymbolicLink()) assert((await realpath(child)).startsWith(`${root}/`), `diagnostic_symlink_escapes_root:${child}`);
      else if (item.isDirectory()) await checkLinks(child);
    }
  };
  await checkLinks(bundle);
  const result = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], {encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024});
  assert.equal(result.status, 0, `temporary_fixture_codesign_failed:${result.error?.message ?? result.stderr}`);
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024});
  assert.equal(verified.status, 0, `temporary_fixture_signature_invalid:${verified.error?.message ?? verified.stderr}`);
  return {exitCode: result.status, stderr: result.stderr, verified: true};
}

// Opt-in, disposable startup probes. Relaxed Chromium switches are diagnostic
// controls only; the actual acceptance path below retains its sandbox settings.
export async function diagnoseFulltextElectron({probes = ['baseline', 'no-sandbox', 'disable-gpu', 'no-sandbox-disable-gpu', 'copied-signed']} = {}) {
  const variants = [['baseline', []], ['no-sandbox', ['--no-sandbox']], ['disable-gpu', ['--disable-gpu']],
    ['no-sandbox-disable-gpu', ['--no-sandbox', '--disable-gpu']]];
  // An empty selection checks the discarded linked bundle's signature without
  // launching any GUI process; normal diagnosis has at most five launches.
  assert(probes.length <= 5 && probes.every(name => [...variants.map(item => item[0]), 'copied-signed'].includes(name)), 'invalid Electron diagnostic probes');
  const electron = await discoverFulltextElectron();
  assert(electron.available, 'fulltext_electron_binary_missing');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-fulltext-electron-diagnostic-')));
  const reports = [];
  try {
    const entry = join(root, 'probe.cjs');
    await writeFile(entry, `const {app,BrowserWindow,crashReporter}=require('electron');
const root=process.env.ROC_DATA_ROOT,path=require('node:path'),fs=require('node:fs');
fs.mkdirSync(path.join(root,'crashes'),{recursive:true});
app.setPath('userData',path.join(root,'profile'));app.setPath('crashDumps',path.join(root,'crashes'));
app.commandLine.appendSwitch('disable-background-networking');app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');
console.error('[P5-PROBE] main-entered '+JSON.stringify({pid:process.pid,electron:process.versions.electron}));
crashReporter.start({submitURL:'https://crash.fixture.invalid',uploadToServer:false,ignoreSystemCrashHandler:true});
app.whenReady().then(async()=>{console.error('[P5-PROBE] app-ready');
const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
await window.loadURL('data:text/html,disposable');console.error('[P5-PROBE] window-ready');app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
setTimeout(()=>{console.error('[P5-PROBE] timeout');app.exit(72)},6000).unref();\n`, {flag: 'wx'});
    const env = {...process.env, ELECTRON_ENABLE_LOGGING: '1'};
    delete env.ELECTRON_RUN_AS_NODE;
    const execute = (executable, args, extra = {}) => {
      const result = spawnSync(executable, args, {env: {...env, ...extra}, encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024});
      return {pid: result.pid, exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
        stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
    };
    const linked = await isolatedElectronExecutable(electron, join(root, 'linked'), entry);
    if (electron.packagedAppPath) reports.push({name: 'linked-bundle-signature',
      ...execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', resolve(dirname(linked), '../..')])});
    for (const [name, flags] of variants.filter(([name]) => probes.includes(name))) {
      const profileRoot = join(root, name); await mkdir(profileRoot);
      reports.push({name, flags, ...execute(linked, [entry, ...flags, '--enable-logging=stderr'], {ROC_DATA_ROOT: profileRoot})});
    }
    if (electron.packagedAppPath && probes.includes('copied-signed')) {
      const copied = await isolatedElectronExecutable(electron, join(root, 'copied'), entry, true);
      // Frameworks are real copies here: signing cannot follow a link back into
      // the original packaged application. No original bundle is modified.
      const signature = await signIsolatedElectron(copied, root);
      reports.push({name: 'temporary-bundle-signature', ...signature});
      if (signature.exitCode === 0) {
        const profileRoot = join(root, 'copied-signed'); await mkdir(profileRoot);
        reports.push({name: 'copied-signed', flags: [], ...execute(copied, [entry, '--enable-logging=stderr'], {ROC_DATA_ROOT: profileRoot})});
      }
    }
    const crashArtifacts = [];
    const inspect = async path => {
      for (const item of await readdir(path, {withFileTypes: true})) {
        if (item.name === 'Frameworks' || item.isSymbolicLink()) continue;
        const child = join(path, item.name);
        if (item.isDirectory()) await inspect(child);
        else if (/\.(?:dmp|log|ips)$/u.test(item.name)) crashArtifacts.push(child.slice(root.length + 1));
      }
    };
    await inspect(root);
    let crashAnalysis = null;
    const dump = crashArtifacts.find(path => path.endsWith('.dmp'));
    if (dump && process.platform === 'darwin') crashAnalysis = execute('/usr/bin/lldb', ['--batch', '-c', join(root, dump), '-o', 'thread backtrace -c 18']);
    return {electron, reports, crashArtifacts, crashAnalysis, temporaryFilesRemoved: true};
  } finally {await rm(root, {recursive: true, force: true});}
}

async function electronMain(root, runtimePath, options) {
  const {app, BrowserWindow, ipcMain, session} = require('electron');
  app.setPath('userData', require('node:path').join(root, 'electron-profile'));
  app.setPath('crashDumps', require('node:path').join(root, 'crash-dumps'));
  app.commandLine.appendSwitch('disable-background-networking');
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (_details, callback) => callback({cancel: true}));
  const fixture = await (await import(require('node:url').pathToFileURL(runtimePath).href)).createFixture(root, options);
  const preload = require('node:path').join(root, 'preload.cjs');
  ipcMain.handle('p5:invoke', async (event, name, input) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('fixture_ipc_sender_denied');
    return await fixture.invoke(name, input);
  });
  const window = new BrowserWindow({show: false, webPreferences: {preload, contextIsolation: true, nodeIntegration: false, sandbox: true}});
  await window.loadURL('data:text/html,<html><body>Disposable fulltext acceptance</body></html>');
  globalThis.__p5Close = async () => {await fixture.close();};
}

export async function runFulltextAcceptance({native = false} = {}) {
  const electron = await discoverFulltextElectron();
  if (!native && !electron.available) throw new Error(`fulltext_electron_binary_missing:${JSON.stringify(electron)}`);
  const fixture = await prepareFulltextFixture();
  let app;
  try {
    let invoke, launchElectron;
    if (native) {await fixture.start(); invoke = fixture.invoke;}
    else {
      await writeFile(join(fixture.root, 'preload.cjs'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('p5',{invoke:(name,input)=>ipcRenderer.invoke('p5:invoke',name,input)});\n", {flag: 'wx'});
      const entry = join(fixture.root, 'electron-main.cjs');
      await writeFile(entry, `(${electronMain.toString()})(${JSON.stringify(fixture.root)},${JSON.stringify(fixture.runtimePath)},{}).catch(error=>{console.error(error);require('electron').app.exit(1)});`, {flag: 'wx'});
      const {_electron} = await import('@playwright/test');
      const env = {...process.env, ROC_DATA_ROOT: fixture.root, ROC_SMOKE: '1'};
      delete env.ELECTRON_RUN_AS_NODE;
      const executablePath = await isolatedElectronExecutable(electron, fixture.root, entry, true);
      if (electron.packagedAppPath) await signIsolatedElectron(executablePath, fixture.root);
      launchElectron = async () => {
        app = await _electron.launch({executablePath, args: [entry, `--user-data-dir=${join(fixture.root, 'electron-profile')}`], env, timeout: 20_000});
        const page = await app.firstWindow({timeout: 20_000});
        await page.waitForFunction(() => !!window.p5, null, {timeout: 20_000});
        invoke = (name, input) => page.evaluate(({name, input}) => window.p5.invoke(name, input), {name, input});
      };
      await launchElectron();
    }
    const report = await exerciseFulltextAcceptance(invoke);
    const before = report.snapshot;
    if (native) await fixture.restart();
    else {
      // Close all workers before inspecting durability through a fresh process.
      await app.evaluate(async () => {await globalThis.__p5Close();});
      await app.close(); app = null;
      await launchElectron();
    }
    const after = await invoke('fixture.inspect');
    if (!native) {
      assert(after.runtime.electron, 'fixture was not running in Electron');
      assert.notEqual(after.runtime.pid, before.runtime.pid, 'Electron restart must use a fresh main process');
    }
    assert.deepEqual(after.documents.map(item => item.document.currentParseId).sort(), before.documents.map(item => item.document.currentParseId).sort());
    assert.deepEqual(after.jobs.map(item => item.id).sort(), before.jobs.map(item => item.id).sort());
    assert.equal(after.items.length, 3); assert.equal(after.counters.downloads, 0); assert.equal(after.counters.parses, 0);
    for (const marker of fulltextMarkers) assert((await invoke('fixture.searchBody', {marker})).hits.some(hit => hit.content.includes(marker)));
    assert.deepEqual(after.unexpectedRequests, []);
    report.checks.push('fresh service instances retain jobs, parse identities and retrieval without downloading again');
    delete report.snapshot;
    if (native && process.versions.electron) report.limitations.push('ELECTRON_RUN_AS_NODE proves the packaged runtime and native modules, not Electron app readiness, GUI or IPC.');
    return {...report, transport: native ? (process.versions.electron ? 'electron-node' : 'node-direct') : 'electron-ipc', electron: native ? null : electron,
      runtime: after.runtime, restart: {beforePid: before.runtime.pid, afterPid: after.runtime.pid, separateProcess: before.runtime.pid !== after.runtime.pid}};
  } finally {
    if (app) {await app.evaluate(async () => {await globalThis.__p5Close?.();}).catch(() => {}); await app.close();}
    await fixture.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert(process.argv.slice(2).every(arg => ['--native', '--diagnose-electron'].includes(arg)) && process.argv.slice(2).length <= 1,
      'Usage: node scripts/verify-agent-literature-fulltext.mjs [--native | --diagnose-electron]');
    const diagnostic = process.argv.includes('--diagnose-electron');
    const report = diagnostic ? await diagnoseFulltextElectron() : await runFulltextAcceptance({native: process.argv.includes('--native')});
    console.log(JSON.stringify(report, null, 2));
    if (!diagnostic && !report.automaticWiki) process.exitCode = 1;
  } catch (error) {console.error(JSON.stringify({status: String(error).includes('fulltext_electron_binary_missing') ? 'Blocked, not run' : 'Changed, unverified', error: String(error)}, null, 2)); process.exitCode = 1;}
}
