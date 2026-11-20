import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import electronExecutable from 'electron';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createResearchFixture, loadResearchWorkerTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, paperIrVersion;
before(async () => {
  api = await loadResearchWorkerTestApi();
  ({paperIrVersion} = await importTypeScriptModule('src/main/plugins/research/paper-ir.ts', {platform: 'node'}));
});
after(() => api?.dispose());
const hash = text => createHash('sha256').update(text).digest('hex');
function observation() {
  const events = [];
  const observer = new api.ResearchProcessingObserver({info: (_message, event) => events.push(event),
    warn: (_message, event) => events.push(event)});
  return {events, observer};
}
function checkSpans(events) {
  const opened = new Map();
  for (const event of events) {
    api.processingStageEventSchema.parse(event);
    if (event.state === 'started') {
      assert.ok(!opened.has(event.spanId));
      assert.equal(event.resources.cpuUserMicros, 0);
      opened.set(event.spanId, event);
    } else {
      assert.ok(opened.has(event.spanId), `missing start: ${event.stage}`);
      assert.equal(opened.get(event.spanId).stage, event.stage);
      assert.ok(event.durationMs >= 0);
      opened.delete(event.spanId);
    }
  }
  assert.equal(opened.size, 0);
}
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) {assert.ok(Date.now() < deadline, 'processing did not settle'); await delay(10);}
}
const htmlTools = () => ({
  defaultParseOptions: () => ({tier: 'compact', device: 'cpu', pageRange: ''}),
  identity: async () => 'html-production-parser',
  parseDocument: input => api.parseResearchDocument({...input, modelFiles: null, modelManifest: ''})
});

test('trace retains identities, measured failures, process resources and bounded model aggregates', async () => {
  const {observer, events} = observation();
  const trace = observer.trace({trace_id: 'contract', paper_id: 'paper', source_hash: 'a'.repeat(64)});
  trace.page = 3;
  for (let i = 0; i < 40; i++) await trace.modelRun('formula_recognition', async () => 1);
  await assert.rejects(trace.modelRun('ocr_inference', async () => {throw new Error('embedding_provider_http_503');}));
  await trace.modelRun('ocr_inference', async () => 1);
  trace.flushModels();
  trace.page = null;
  await assert.rejects(trace.run('embedding', async () => {throw new Error('secret source payload');}));
  checkSpans(events);
  assert.equal(events.length, 6);
  const formula = events.find(e => e.stage === 'formula_recognition' && e.state === 'ready');
  assert.equal(formula.inputCount, 40); assert.equal(formula.outputCount, 40);
  assert.equal(formula.page, 3); assert.ok(formula.activeDurationMs >= 0);
  const ocr = events.find(e => e.stage === 'ocr_inference' && e.state === 'failed');
  assert.equal(ocr.inputCount, 2); assert.equal(ocr.outputCount, 1);
  assert.equal(ocr.failureCode, 'embedding_provider_http_503');
  assert.equal(events.at(-1).failureCode, 'research_processing_failed');
  assert.ok(!JSON.stringify(events).includes('secret source payload'));
  assert.throws(() => trace.bind({source_hash: 'bad'}));
});

test('caught undefined and cancellation remain failures, including swallowed model errors', async () => {
  const {observer, events} = observation();
  const trace = observer.trace({trace_id: 'failure-boundaries'});
  await assert.rejects(trace.run('document_parse', async () => {throw undefined;}));
  assert.throws(() => trace.sync('paper_ir_build', () => {throw undefined;}));
  await assert.rejects(trace.modelRun('ocr_inference', async () => {throw undefined;}));
  trace.flushModels();
  const aborted = new DOMException('Original private cancellation', 'AbortError');
  await assert.rejects(trace.run('embedding', async () => {throw aborted;}), error => error === aborted);
  checkSpans(events);
  assert.equal(events.filter(event => event.state === 'failed').length, 4);
  assert.equal(events.at(-1).failureCode, 'research_process_cancelled');
  assert.ok(!JSON.stringify(events).includes('Original private cancellation'));
});

test('library parsing publishes original IR and chunks with exact library/document/parse identities; cancellation preserves them', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-processing-library-')));
  const f = createResearchFixture(api, 'reading');
  const {observer, events} = observation();
  f.repository.processing.emit = event => observer.emit(event);
  const tools = htmlTools();
  const service = new api.ResearchDocumentService(f.repository, tools, root);
  try {
    const text = '<html><h1>Results</h1><p>Library original evidence.</p></html>';
    await writeFile(join(root, 'source.html'), text);
    const document = f.repository.documents.import({id: 'physical-document', libraryItemId: null, projectId: f.project.id,
      filename: 'source.html', mediaType: 'text/html', sourcePath: 'source.html', sourceHash: hash(text),
      size: Buffer.byteLength(text), entry: {
        metadata: {id: 'literature', source: 'local', externalId: 'trace-library', doi: null, title: 'Trace library',
          authors: [], abstract: null, publishedYear: null, citationCount: null, url: null, openAccessUrl: null,
          importedAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z'},
        bibliography: {citationKey: 'traceLibrary', entryType: 'article', fields: {title: 'Trace library'}, preambles: [],
          csl: null, title: 'Trace library', authors: [], doi: null, publishedYear: null, abstract: null, url: null}
      }}, false).document;
    const parsed = await service.parse(document.id);
    assert.equal(parsed.status, 'ready', parsed.error ?? undefined);
    const context = f.repository.knowledge.processingContext(`document:${parsed.currentParseId}`);
    assert.equal(context.document_id, document.id); assert.equal(context.paper_id, document.libraryItemId);
    assert.equal(context.parse_id, parsed.currentParseId); assert.equal(context.source_hash, hash(text));
    assert.equal(context.parser_fingerprint, service.parsed(document.id, parsed.currentParseId).content.parserFingerprint);
    for (const stage of ['source_read', 'native_text_extract', 'paper_ir_build', 'chunk_generation', 'index_publish']) {
      const event = events.find(event => event.stage === stage && event.state === 'ready');
      assert.ok(event, stage);
      assert.equal(event.context.paper_id, document.libraryItemId);
      assert.equal(event.context.parse_id, parsed.currentParseId);
    }
    assert.equal(events.find(event => event.stage === 'paper_ir_build').context.paper_ir_version, paperIrVersion);
    tools.parseDocument = async input => new Promise((_resolve, reject) => input.signal.addEventListener('abort',
      () => reject(input.signal.reason), {once: true}));
    const cancelled = service.parse(document.id);
    const active = f.repository.documents.get(document.id);
    await until(() => events.some(event => event.stage === 'document_parse' && event.state === 'started'
      && event.context.parse_id === active.activeParseId));
    service.cancel(document.id, active.activeParseId);
    assert.equal((await cancelled).status, 'cancelled');
    assert.equal(f.repository.documents.get(document.id).currentParseId, parsed.currentParseId);
    assert.ok(events.some(event => event.stage === 'document_processing' && event.failureCode === 'research_process_cancelled'));
    checkSpans(events);
  } finally {await service.shutdown(); await f.close(); await rm(root, {recursive: true, force: true});}
});

test('project HTML index retains actual artifact/fingerprint/generation and publishes searchable original chunks', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-processing-index-')));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const f = createResearchFixture(api, 'reading', workspace);
  const {observer, events} = observation();
  f.repository.processing.emit = event => observer.emit(event);
  const logger = {info() {}, warn() {}};
  let providerCalls = 0;
  const embeddings = new api.ResearchEmbeddingService(f.repository.knowledge, {embed: async () => {
    providerCalls++; assert.fail('unconfigured indexing must not invoke an embedding provider');
  }}, {logger});
  const index = new api.ResearchIndexService(f.repository, htmlTools(), embeddings, join(root, 'storage'), logger);
  try {
    const text = '<html><h1>Results</h1><p>Indexed original evidence.</p></html>';
    await writeFile(join(workspace, 'paper.html'), text);
    const {projectId, revision, ...settings} = f.repository.indexing.settings(f.project.id);
    index.configure({...settings, projectId, expectedRevision: revision, kinds: ['html'], include: ['**/*.html'], watch: false});
    await until(() => index.status(projectId).counts.ready === 1);
    const file = f.repository.indexing.listFiles(projectId, '', false, 10)[0];
    const payload = f.repository.indexing.cached(file.id).payload;
    const event = events.find(event => event.stage === 'index_job' && event.state === 'ready');
    const knowledgeId = event.context.document_id;
    assert.equal(event.context.project_id, projectId);
    assert.equal(event.context.paper_id, knowledgeId);
    assert.equal(event.context.source_hash, hash(text));
    assert.equal(event.context.parse_id, payload.parseArtifactId);
    assert.equal(event.context.parser_fingerprint, payload.parserFingerprint);
    assert.equal(event.context.index_generation, String(f.repository.indexing.listJobs(projectId, 10)[0].generation));
    assert.equal(f.repository.knowledge.processingContext(knowledgeId).parser_fingerprint, payload.parserFingerprint);
    assert.ok(f.repository.knowledge.knowledgeChunks(knowledgeId).some(chunk => chunk.content.includes('Indexed original evidence.')));
    for (const stage of ['document_parse', 'paper_ir_build', 'chunk_generation', 'index_publish'])
      assert.ok(events.some(event => event.stage === stage && event.state === 'ready'), stage);
    const embeddingEvents = events.filter(event => event.stage === 'embedding');
    assert.deepEqual(embeddingEvents.map(event => event.state), ['started', 'ready']);
    assert.ok(embeddingEvents.every(event => event.unit === 'vectors' && event.context.embedding_config_revision === null));
    assert.equal(providerCalls, 0);
    await index.shutdown(); await f.idle(); checkSpans(events);
  } finally {await index.shutdown(); await embeddings.shutdown(); await f.close(); await rm(root, {recursive: true, force: true});}
});

test('multi-paper Wiki compilation retains both evidence identities and no invented single-paper association', async () => {
  const f = createResearchFixture(api, 'reading');
  const {observer, events} = observation();
  f.repository.processing.emit = event => observer.emit(event);
  try {
    const evidenceIds = ['one', 'two'].map((id, i) => {
      const sourceHash = hash(id);
      f.repository.knowledge.upsertFromSource({id, projectId: f.project.id, sourceType: 'file', sourceId: `${id}.pdf`,
        title: id, content: `Original ${id}.`, chunks: [{content: `Original ${id}.`, locator: `PDF page ${i + 1}`,
          semantic: {paperId: `paper-${id}`, parseId: `parse-${id}`, sourceHash, blockId: 'b1',
            sectionPath: [], semanticRole: 'results', blockKind: 'paragraph', relatedBlockIds: []}}], embeddingPolicy: 'none'},
        {paperId: `paper-${id}`, parseId: `parse-${id}`, sourceHash});
      return f.repository.evidence.capture({projectId: f.project.id, chunkId: `${id}:chunk:0`}).id;
    });
    const page = f.repository.wiki.create({projectId: f.project.id, kind: 'comparison', title: 'Two original sources',
      evidenceIds, claimIds: []});
    await f.idle();
    const event = events.find(event => event.stage === 'wiki_compile' && event.state === 'ready'
      && event.context.trace_id.startsWith(`wiki:${page.page.id}:`));
    assert.equal(event.context.paper_id, null); assert.equal(event.context.parse_id, null);
    assert.equal(event.context.source_hash, null); assert.equal(event.inputCount, 0); assert.equal(event.outputCount, 2);
    assert.deepEqual(event.context.related_papers.map(paper => paper.paper_id), ['paper-one', 'paper-two']);
    assert.deepEqual(event.context.related_papers.map(paper => paper.parse_id), ['parse-one', 'parse-two']);
    const current = f.repository.wiki.read(f.project.id, page.page.id);
    assert.deepEqual(current.sources.map(source => source.evidenceId).sort(), evidenceIds.sort());
    checkSpans(events);
  } finally {await f.close();}
});

test('worker forwarding rejects invalid wire, unknown payload fields and mismatched source associations', () => {
  const {observer, events} = observation();
  const trace = observer.trace({trace_id: 'wire', project_id: 'project', paper_id: 'paper', source_hash: 'a'.repeat(64)});
  const span = trace.start('source_read'); span.finish();
  const event = events[1], wire = value => `${api.processingTraceWirePrefix}${JSON.stringify(value)}\n`;
  const {observer: target, events: forwarded} = observation();
  const receiver = target.trace(trace.context);
  receiver.forwardWorker(`native diagnostic\n${wire(event)}`);
  assert.deepEqual(forwarded, [event]);
  for (const changed of [{...event, content: 'raw source'},
    {...event, context: {...event.context, paper_id: 'other'}},
    {...event, context: {...event.context, source_hash: 'b'.repeat(64)}},
    {...event, state: 'failed', failureCode: 'provider returned secret text'}]) {
    assert.throws(() => receiver.forwardWorker(wire(changed)), /trace_invalid/);
  }
  assert.throws(() => receiver.forwardWorker(`${api.processingTraceWirePrefix}{`), /trace_invalid/);
});

test('real packaged HTML worker forwards success and failure observations without changing stdout results', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-processing-worker-')));
  try {
    const text = '<html><h1>Results</h1><p>Private original source 42.</p></html>';
    await writeFile(join(root, 'source.html'), text);
    // Production workers use Electron's bundled Node, whose libraries are inside
    // its granted application directory. Homebrew Node has external dylibs.
    const runner = join(root, 'runner.mjs');
    await writeFile(runner, `
      const api = await import(${JSON.stringify(pathToFileURL(api.modulePath).href)});
      const input = JSON.parse(process.argv[2]);
      const events = [];
      const observer = new api.ResearchProcessingObserver({
        info: (_message, event) => events.push(event), warn: (_message, event) => events.push(event)
      });
      input.trace = observer.trace(input.traceContext); delete input.traceContext;
      let result = null, error = null;
      try { result = await new api.ResearchToolchain(null).parseDocument(input); }
      catch (failure) { error = failure.code ?? failure.message; }
      process.stdout.write(JSON.stringify({result, error, events, pid: process.pid}));
    `);
    for (const pageRange of ['', '2']) {
      const {observer} = observation();
      const trace = observer.trace({trace_id: `worker:${pageRange || 'all'}`, document_id: 'doc', parse_id: 'parse',
        source_hash: hash(text)});
      const input = {projectRoot: root, sourcePath: join(root, 'source.html'), outputDir: join(root, `output${pageRange}`),
        jobDir: root, traceContext: trace.context, options: {tier: 'compact', device: 'cpu', pageRange},
        admission: {projectId: null, priority: 'user'}};
      const output = await promisify(execFile)(electronExecutable, [runner, JSON.stringify(input)],
        {env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, timeout: 30_000, maxBuffer: 1024 * 1024});
      const {result, error, events, pid} = JSON.parse(output.stdout);
      if (!pageRange) {
        assert.equal(error, null);
        assert.equal(result.sourceHash, hash(text));
        assert.ok(result.blocks.some(block => block.text.includes('42')));
        assert.equal(events.at(-1).context.parser_fingerprint, result.parserFingerprint);
        assert.ok(events.some(event => event.stage === 'native_text_extract'));
      } else assert.equal(error, 'research_parse_page_range_invalid');
      checkSpans(events);
      assert.ok(events.some(event => event.resources.pid !== pid));
      assert.ok(!JSON.stringify(events).includes('Private original source'));
      assert.equal(events.at(-1).state, pageRange ? 'failed' : 'ready');
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

test('background embedding and Paper Card jobs retain original paper identities and reject invented citations', async () => {
  const f = createResearchFixture(api, 'reading');
  const {observer, events} = observation();
  f.repository.processing.emit = event => observer.emit(event);
  let embeddings;
  try {
    const input = {id: 'knowledge', projectId: f.project.id, sourceType: 'file', sourceId: 'paper.pdf', title: 'Contract paper',
      content: 'Exact original result.', chunks: [{content: 'Exact original result.', locator: 'PDF page 1',
        semantic: {paperId: 'actual-paper', parseId: 'parse1', sourceHash: 'a'.repeat(64), blockId: 'b1',
          sectionPath: ['Results'], semanticRole: 'results', blockKind: 'paragraph', relatedBlockIds: []}}], embeddingPolicy: 'none'};
    f.repository.knowledge.upsertFromSource(input, {fileId: 'stable-file', parseId: 'parse1', sourceHash: 'a'.repeat(64)});
    const context = {secrets: {get: async () => 'unlogged-key'}, logger: {warn() {}}};
    embeddings = new api.ResearchEmbeddingService(f.repository.knowledge, {embed: async ({texts}) => texts.map(() => [1, 2])}, context);
    assert.equal(await embeddings.embedDocument('knowledge', null), null);
    assert.equal(events.length, 0, 'disabled embedding performs no embedding stage');
    f.repository.knowledge.saveEmbeddingConfig({id: 'config', name: 'config', baseUrl: 'https://fixture.invalid',
      model: 'fixture', dimensions: 2, enabled: true}, 'secret-key');
    await embeddings.embedDocument('knowledge', null);
    const embedded = events.find(e => e.stage === 'embedding' && e.state === 'ready');
    assert.equal(embedded.context.paper_id, 'actual-paper');
    assert.equal(embedded.context.parse_id, 'parse1');
    assert.equal(embedded.context.source_hash, 'a'.repeat(64));
    assert.equal(embedded.context.embedding_config_revision, 'config:1');
    assert.equal(embedded.outputCount, f.repository.knowledge.knowledgeChunks('knowledge').length);
    const roles = ['problem', 'contribution', 'method', 'experimental_setup', 'results', 'limitations'];
    f.repository.paperCards.start(async (_title, blocks) => ({sections: roles.map(role => ({
      role, body: 'Derived section.', chunkIds: [blocks[0].source.chunkId]}))}));
    f.repository.queueKnowledgeFromSource(input); f.repository.flushKnowledgeFromSource();
    await f.idle();
    const card = events.find(e => e.stage === 'paper_card_generation' && e.state === 'ready');
    assert.equal(card.context.paper_id, 'actual-paper'); assert.equal(card.outputCount, 6);
    const wiki = events.find(e => e.stage === 'wiki_compile' && e.state === 'ready' && e.outputCount === 6);
    assert.equal(wiki.context.paper_id, 'actual-paper');
    assert.equal(wiki.context.parse_id, 'parse1'); assert.ok(wiki.context.wiki_generation);
    const page = (await f.repository.wiki.search(f.project.id)).pages[0];
    f.repository.paperCards.start(async () => ({sections: roles.map(role => ({role, body: 'Invalid.', chunkIds: ['invented']}))}));
    f.repository.paperCards.retry(f.project.id, page.id); await f.idle();
    assert.ok(events.some(e => e.stage === 'paper_card_generation' && e.failureCode === 'wiki_paper_citation_invalid'));
    assert.equal(f.repository.evidence.list(f.project.id).length, 0);
    checkSpans(events);
    assert.ok(!JSON.stringify(events).includes('unlogged-key'));
  } finally {await embeddings?.shutdown(); await f.close();}
});
