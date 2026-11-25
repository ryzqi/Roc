/** Actual frozen source -> 8-bit Worker -> document service -> both indexes -> cited context/Wiki. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, copyFile, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {extname, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {load} from 'sqlite-vec';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from '../../tests/unit/fixtures/research-test-kit.mjs';

const {values} = parseArgs({options: {installation: {type: 'string'}, 'source-relative': {type: 'string'},
  output: {type: 'string'}, 'project-index': {type: 'boolean', default: false}}, strict: true});
if (!values.installation || !values['source-relative'] || !values.output) {
  throw new Error('--installation, --source-relative (frozen corpus PDF/image) and --output are required');
}
const hash = value => createHash('sha256').update(value).digest('hex');
const lock = JSON.parse(await readFile('evaluation/corpora/ovis-ocr/sources.lock.json', 'utf8'));
const source = lock.files.find(file => file.path === values['source-relative']);
assert.ok(source, 'Source must belong to the frozen corpus');
const extension = extname(source.path).toLowerCase(), sourceKind = extension === '.pdf' ? 'pdf' : 'image';
assert.ok(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(extension));
const config = JSON.parse(await readFile('evaluation/ovis-evaluator/paired-inference.json', 'utf8'));
const installation = await realpath(values.installation), receiptBytes = await readFile(join(installation, 'receipt.json'));
assert.equal(hash(receiptBytes), config.installationReceiptSha256);
const receipt = JSON.parse(receiptBytes), inferenceScript = resolve(config.inferenceScriptPath);
assert.equal(hash(await readFile(inferenceScript)), config.inferenceScriptSha256);
const identity = {engine: 'ovisocr3-mlx', revision: config.modelRevision, quantization: '8bit', groupSize: 64,
  visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: config.installationReceiptSha256,
  inferenceSha256: config.inferenceScriptSha256, promptSha256: config.settings.promptSha256};
const moduleNames = ['ovis-document-parser', 'ovis-source-artifact', 'ovis-model-store', 'ovis-worker',
  'process-runner', 'ovis-parsed-document', 'scientific-library-index', 'scientific-retrieval-router'];
const modules = await Promise.all(moduleNames.map(name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
  {platform: 'node', external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'})));
const helpers = Object.assign({}, ...modules), output = resolve(values.output), controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
await mkdir(output);
const summary = {status: 'running', automaticAdoption: false, performanceQualification: false, hostLoad: 'mixed-host-load',
  scope: 'Live 8-bit OCR through unregistered document service, SQLite/FTS/sqlite-vec, context and six-section Wiki',
  fixtures: ['in-memory repository', 'embedding vectors', 'deterministic excerpt card generator'],
  source, identity, modules: {}};
const store = new helpers.OvisModelStore({root: installation, pythonBase: receipt.python.basePrefix, inferenceScript, identity});
let api, fixture, embeddings, documents, indexer, processRequest, parserError;
try {
  for (const name of [...moduleNames, 'document-service', 'document-files', 'document-repository', 'paper-card-service',
    'scientific-context-assembler', 'scientific-chunks', 'scientific-text-serializer', 'index-service']) {
    summary.modules[name] = hash(await readFile(`src/main/plugins/research/${name}.ts`));
  }
  summary.harnessSha256 = hash(await readFile(new URL(import.meta.url)));
  const original = resolve(lock.localSourceRoot, source.path), input = join(output, `input${extension}`);
  assert.equal(hash(await readFile(original)), source.sha256);
  await copyFile(original, input);
  api = await loadResearchTestApi(); fixture = createResearchFixture(api, 'reading', output); load(fixture.db);
  const title = 'Actual Ovis downstream verification', now = new Date().toISOString();
  const item = fixture.repository.library.import([{metadata: {id: 'ovis-verification', source: 'local',
    externalId: 'ovis-verification', doi: null, title, authors: [], abstract: null, publishedYear: null,
    citationCount: null, url: null, openAccessUrl: null, importedAt: now, updatedAt: now},
    bibliography: {citationKey: 'ovisVerification', entryType: 'article', fields: {title}, preambles: [], csl: null,
      title, authors: [], doi: null, publishedYear: null, abstract: null, url: null}}
  ], fixture.project.id, {notify: false}).items[0];
  fixture.repository.knowledge.saveEmbeddingConfig({id: 'fixture', name: 'Fixture', enabled: true,
    baseUrl: 'https://fixture.invalid', model: 'fixture', dimensions: 3}, 'fixture-secret');
  embeddings = new api.ResearchEmbeddingService(fixture.repository.knowledge,
    {embed: async ({texts}) => texts.map(() => [3, 4, 0])},
    {secrets: {get: async () => 'fixture-key'}, logger: {info() {}, warn() {}, error() {}}});
  const parseTools = {
    identity: async () => JSON.stringify(identity),
    defaultParseOptions: () => ({tier: 'complete', device: 'auto', pageRange: ''}),
    parseDocument: async request => {
      try {
        return await helpers.parseOvisDocument({...request, sourceKind, pages: null, timeoutMs: 600000,
          admission: {...request.admission, resourceClass: 'parse'},
          signal: AbortSignal.any([controller.signal, request.signal])}, store, {
          capture: capture => helpers.createOvisSourceArtifact(capture, worker => helpers.runOvisDocumentPages(worker,
            async input => {processRequest = input; return await helpers.runResearchProcess(input);})),
          write: helpers.writeOvisParsedDocument
        });
      } catch (error) {parserError = error; throw error;}
    }
  };
  documents = new api.ResearchDocumentService(fixture.repository, parseTools, output, null, null,
    new helpers.ScientificLibraryIndexService(fixture.repository, embeddings, output));
  const roles = ['problem', 'contribution', 'method', 'experimental_setup', 'results', 'limitations'];
  fixture.repository.paperCards.start(async (_title, blocks) => {
    const block = blocks.find(value => value.text.trim().length > 20); assert.ok(block);
    return {sections: roles.map(role => ({role, body: block.text.trim().slice(0, 1800), chunkIds: [block.source.chunkId]}))};
  }, {pollMs: 60000});
  const document = await documents.import({target: 'library-item', libraryItemId: item.id,
    projectId: fixture.project.id, sourcePath: input});
  const parsed = await documents.parse(document.id, 'complete');
  if (parsed.status !== 'ready') throw parserError ?? new Error(fixture.repository.documents.runs(document.id)[0].error);
  const parseId = parsed.currentParseId, {data} = fixture.repository.documents.parsed(document.id, parseId);
  const ir = await documents.paperIR(document.id, parseId);
  assert.deepEqual(data.content.modelIdentity, identity); assert.equal(data.content.quality.status, 'review');
  const generation = fixture.repository.scientificIndex.active(null, document.id);
  fixture.repository.scientificIndex.verify(generation.id);
  assert.ok(fixture.repository.knowledge.hasDocumentEmbeddings(`document:${parseId}`, 'fixture', 1));
  const router = new helpers.ScientificRetrievalRouter(fixture.repository, embeddings, {library: output, index: null},
    new api.ScholarlyRelationsRepository(fixture.db, fixture.repository), null, null);
  // Original words exercise lexical search; fixed vectors exercise native vector storage, not semantic model quality.
  const prose = ir.blocks.find(block => block.kind === 'paragraph' && block.text.length > 40)?.text;
  assert.ok(prose);
  const terms = [...new Set(prose.match(/[A-Za-z]{4,}/gu) ?? [])].slice(0, 7); assert.ok(terms.length);
  const search = await router.search({projectId: fixture.project.id, documentIds: [document.id],
    query: terms.join(' '), embeddingConfigId: null, candidateLimit: 100, limit: 20, rerank: 'none'});
  assert.ok(search.candidates.some(candidate => candidate.signals.some(signal => signal.method === 'fts')));
  assert.ok(search.candidates.some(candidate => candidate.signals.some(signal => signal.method === 'dense')));
  await router.assertCurrent(search);
  const context = await router.readContext({search, candidateIds: search.hits.filter(hit => hit.chunkId !== null).map(hit => hit.id)});
  assert.ok(context.evidence.length);
  let locators = 0;
  const check = locator => {
    locators++; assert.equal(locator.documentId, document.id); assert.equal(locator.parseId, parseId);
    assert.equal(locator.sourceHash, source.sha256); assert.ok(locator.locations.length);
    for (const location of locator.locations) {
      assert.ok(location.page >= 1 && location.page <= data.content.pageCount);
      assert.equal(location.bbox, null); assert.equal(location.coordinateOrigin, null);
    }
  };
  for (const candidate of search.candidates) {
    if (candidate.sourceLocator) check(candidate.sourceLocator);
    for (const source of candidate.sources) check(source.locator);
    if (candidate.object.kind === 'table') for (const cell of candidate.object.cells) check(cell.sourceLocator);
  }
  for (const evidence of context.evidence) {
    for (const hit of evidence.hits) for (const source of hit.sources) check(source.locator);
    for (const passage of evidence.passages) check(passage.sourceLocator);
  }
  await fixture.repository.paperCards.idle(); await fixture.repository.wiki.idle();
  const pages = (await fixture.repository.wiki.search(fixture.project.id)).pages; assert.equal(pages.length, 1);
  const wiki = fixture.repository.wiki.read(fixture.project.id, pages[0].id);
  assert.equal(wiki.paperJob.status, 'ready'); assert.equal(wiki.current.sections.length, 6);
  for (const section of wiki.current.sections) {
    assert.ok(section.paperSources.length);
    assert.ok(section.paperSources.every(source => source.parseId === parseId && source.sourceHash === document.sourceHash));
  }
  assert.deepEqual(fixture.db.pragma('foreign_key_check'), []);
  assert.equal(hash(await readFile(join(output, fixture.repository.documents.sourcePath(document.id)))), source.sha256);
  for (const path of processRequest.writablePaths) await assert.rejects(access(path), {code: 'ENOENT'});
  assert.equal(store.busy, false);
  for (const [name, value] of Object.entries({stored: data, ir, search, context, wiki})) {
    await writeFile(join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
  }
  const capture = JSON.parse(await readFile(join(output, data.outputPath, 'manifest.json')));
  Object.assign(summary, {status: 'passed', documentId: document.id, parseId, generationId: generation.id,
    blocks: ir.blocks.length, equations: ir.equations.length, tables: ir.tables.length,
    cells: ir.tables.reduce((n, table) => n + table.cells.length, 0), figures: ir.figures.length,
    candidates: search.candidates.length, contextObjects: context.evidence.length, checkedPageOnlyLocators: locators,
    wikiSections: wiki.current.sections.length, sourceUnchanged: true, process: capture.process,
    modelLeaseReleased: true, ownedWorkerDirectoriesRemoved: true, outputPath: data.outputPath});
  if (values['project-index']) {
    summary.status = 'running-project';
    const workspace = join(output, 'project-workspace'), storage = join(output, 'project-index');
    await mkdir(workspace); await copyFile(input, join(workspace, `source${extension}`));
    const project = fixture.repository.createProject({title: 'Actual Ovis project index', description: '', workspacePath: workspace});
    const {projectId, revision, ...settings} = fixture.repository.indexing.settings(project.id);
    fixture.repository.indexing.saveSettings(projectId, revision, {...settings, kinds: [sourceKind], watch: false});
    indexer = new api.ResearchIndexService(fixture.repository, parseTools, embeddings, storage, {info() {}, warn() {}, error() {}});
    fixture.repository.indexing.requestScan(project.id, true);
    await indexer.scan(project.id, controller.signal);
    const queued = fixture.repository.indexing.nextJob(); assert.ok(queued); assert.equal(queued.projectId, project.id);
    const job = fixture.repository.indexing.beginJob(queued.id); await indexer.process(job, controller.signal);
    const completed = fixture.repository.indexing.job(job.id);
    assert.equal(completed.status, 'ready', completed.error);
    const payload = fixture.repository.indexing.cached(job.fileId).payload;
    const projectIR = await indexer.paperIR(project.id, job.fileId, controller.signal);
    const projectRouter = new helpers.ScientificRetrievalRouter(fixture.repository, embeddings, {library: output, index: storage},
      new api.ScholarlyRelationsRepository(fixture.db, fixture.repository));
    const projectSearch = await projectRouter.search({projectId: project.id, documentIds: [], query: terms.join(' '),
      embeddingConfigId: null, candidateLimit: 100, limit: 20, rerank: 'none'});
    assert.ok(projectSearch.candidates.some(c => c.signals.some(s => s.method === 'fts')));
    assert.ok(projectSearch.candidates.some(c => c.signals.some(s => s.method === 'dense')));
    await projectRouter.assertCurrent(projectSearch);
    const projectContext = await projectRouter.readContext({search: projectSearch,
      candidateIds: projectSearch.hits.filter(hit => hit.chunkId !== null).map(hit => hit.id)});
    assert.ok(projectContext.evidence.length);
    for (const candidate of projectSearch.candidates) if (candidate.sourceLocator) {
      assert.equal(candidate.sourceLocator.sourceHash, source.sha256);
      assert.equal(candidate.sourceLocator.parseId, payload.parseArtifactId);
      assert.ok(candidate.sourceLocator.locations.every(location => location.bbox === null && location.coordinateOrigin === null));
    }
    const projectGeneration = fixture.repository.scientificIndex.active(project.id, `project-index:${job.fileId}`);
    assert.ok(projectGeneration); fixture.repository.scientificIndex.verify(projectGeneration.id);
    assert.ok(fixture.repository.knowledge.hasDocumentEmbeddings(`project-index:${job.fileId}`, 'fixture', 1));
    assert.equal(hash(await readFile(join(workspace, `source${extension}`))), source.sha256);
    for (const path of processRequest.writablePaths) await assert.rejects(access(path), {code: 'ENOENT'});
    assert.equal(store.busy, false);
    const projectCapture = JSON.parse(await readFile(join(storage, payload.artifactPath, 'manifest.json')));
    for (const [name, value] of Object.entries({payload, ir: projectIR, search: projectSearch, context: projectContext})) {
      await writeFile(join(output, `project-${name}.json`), JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
    }
    summary.projectIndex = {status: 'passed', projectId, fileId: job.fileId, parseId: payload.parseArtifactId,
      generationId: projectGeneration.id, blocks: projectIR.blocks.length, equations: projectIR.equations.length,
      tables: projectIR.tables.length, figures: projectIR.figures.length, candidates: projectSearch.candidates.length,
      contextObjects: projectContext.evidence.length, sourceUnchanged: true, process: projectCapture.process,
      modelLeaseReleased: true, ownedWorkerDirectoriesRemoved: true};
    summary.status = 'passed';
  }
  assert.deepEqual(fixture.db.pragma('foreign_key_check'), []);
  await writeFile(join(output, 'research.sqlite'), fixture.db.serialize(), {flag: 'wx'});
} catch (error) {
  Object.assign(summary, {status: 'failed', error: {message: error.message, code: error.code,
    stdout: error.stdout, stderr: error.stderr}, ownedWorkerDirectories: processRequest?.writablePaths ?? []});
  process.exitCode = 1;
} finally {
  await indexer?.shutdown(); await documents?.shutdown(); await fixture?.repository.knowledgeJobs.shutdown();
  await embeddings?.shutdown(); await fixture?.close(); api?.dispose();
  summary.modelStoreBusy = store.busy;
  await writeFile(join(output, 'report.json'), JSON.stringify(summary, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(summary));
}
