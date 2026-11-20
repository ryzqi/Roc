import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
const deferred = () => Promise.withResolvers();
const original = {id: 'background-original', projectId: null, sourceType: 'file', sourceId: 'paper.pdf',
  title: 'Background resource fixture', content: 'Original background result.',
  chunks: [{content: 'Original background result.', locator: 'PDF page 1'}], embeddingPolicy: 'none'};

test('detached knowledge work stays busy through cancellation and final recovery writes; empty wakes stay idle', async () => {
  const f = createResearchFixture(api, 'reading'), jobs = f.repository.knowledgeJobs;
  const entered = deferred(), cleanup = deferred(), transitions = [];
  const unsubscribe = api.mainResourceActivity.subscribe(() => transitions.push(api.mainResourceActivity.busy));
  try {
    jobs.start(async (_id, signal) => {
      entered.resolve(signal);
      await cleanup.promise;
      throw new Error('cancelled provider');
    });
    await jobs.idle();
    assert.deepEqual(transitions, []);
    f.repository.knowledge.upsertFromSource(original);
    jobs.enqueue(original.id); jobs.wake();
    const signal = await entered.promise;
    assert.equal(api.mainResourceActivity.busy, true);
    const stopped = jobs.shutdown();
    assert.equal(signal.aborted, true);
    assert.equal(api.mainResourceActivity.busy, true, 'cancelled work owns resources until cleanup settles');
    cleanup.resolve(); await stopped;
    assert.equal(jobs.list(null)[0].status, 'queued');
    assert.deepEqual(transitions, [true, false]);
    assert.equal(api.mainResourceActivity.snapshot().total, 0);
  } finally {
    cleanup.resolve(); await jobs.shutdown(); unsubscribe(); f.close();
  }
});

test('detached paper-card generation owns activity until cancellation returns its generation to queued', async () => {
  const f = createResearchFixture(api, 'reading'), cards = f.repository.paperCards;
  const entered = deferred(), cleanup = deferred(), transitions = [];
  const unsubscribe = api.mainResourceActivity.subscribe(() => transitions.push(api.mainResourceActivity.busy));
  try {
    cards.start(async (_title, _blocks, signal) => {
      entered.resolve(signal);
      await cleanup.promise;
      throw new Error('cancelled generator');
    });
    await cards.idle(); assert.deepEqual(transitions, []);
    const input = {...original, projectId: f.project.id, chunks: [{...original.chunks[0], semantic: {
      paperId: 'paper', parseId: 'parse-background', sourceHash: 'a'.repeat(64), blockId: 'original-page',
      sectionPath: ['Results'], semanticRole: 'results', blockKind: 'paragraph', relatedBlockIds: []
    }}]};
    f.repository.knowledge.upsertFromSource(input, {fileId: 'stable-paper', parseId: 'parse-background', sourceHash: 'a'.repeat(64)});
    f.repository.queueKnowledgeFromSource(input); f.repository.flushKnowledgeFromSource();
    const signal = await entered.promise;
    assert.equal(api.mainResourceActivity.busy, true);
    const stopped = cards.shutdown();
    assert.equal(signal.aborted, true);
    assert.equal(api.mainResourceActivity.busy, true);
    cleanup.resolve(); await stopped;
    assert.equal(f.db.prepare('SELECT status FROM research_paper_cards').pluck().get(), 'queued');
    assert.deepEqual(transitions, [true, false]);
  } finally {
    cleanup.resolve(); await cards.shutdown(); await f.repository.wiki.shutdown(); unsubscribe(); f.close();
  }
});

test('Wiki background vector batches count actual provider work and leave empty recovery polls idle', async () => {
  const {ResearchEmbeddingService} = await importTypeScriptModule('src/main/plugins/research/embedding-service.ts', {platform: 'node'});
  const f = createResearchFixture(api, 'reading'), wiki = f.repository.wiki;
  const entered = deferred(), cleanup = deferred(), transitions = [];
  const unsubscribe = api.mainResourceActivity.subscribe(() => transitions.push(api.mainResourceActivity.busy));
  const service = new ResearchEmbeddingService(f.repository.knowledge, {embed: async ({signal}) => {
    entered.resolve(signal); await cleanup.promise; throw new Error('cancelled provider');
  }}, {secrets: {get: async () => 'synthetic-key'}, logger: {warn() {}}});
  try {
    f.repository.knowledge.saveEmbeddingConfig({id: 'test', name: 'Test', baseUrl: 'https://fixture.invalid',
      model: 'fixture', dimensions: 2, enabled: true}, 'fixture-key');
    wiki.configureSearch(service); await wiki.navigation.idle();
    for (let i = 0; i < 3; i++) {wiki.navigation.wake(); await wiki.navigation.idle();}
    assert.deepEqual(transitions, []);
    f.repository.knowledge.upsertFromSource({...original, projectId: f.project.id});
    const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: `${original.id}:chunk:0`});
    wiki.create({projectId: f.project.id, kind: 'topic', title: 'Vector fixture', evidenceIds: [evidence.id], claimIds: []});
    const signal = await entered.promise;
    assert.equal(api.mainResourceActivity.busy, true);
    const stopped = wiki.shutdown();
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
    assert.equal(signal.aborted, true);
    assert.equal(api.mainResourceActivity.busy, true);
    cleanup.resolve(); await stopped;
    assert.deepEqual(transitions, [true, false]);
  } finally {
    cleanup.resolve(); await wiki.shutdown(); await service.shutdown(); unsubscribe(); f.close();
  }
});

test('real project-index work remains busy through provider cancellation and complete scan/job cleanup', {timeout: 10_000}, async () => {
  const {ResearchIndexService} = await importTypeScriptModule('src/main/plugins/research/index-service.ts', {platform: 'node'});
  const {ResearchEmbeddingService} = await importTypeScriptModule('src/main/plugins/research/embedding-service.ts', {platform: 'node'});
  const root = await mkdtemp(join(tmpdir(), 'roc-resource-index-'));
  const f = createResearchFixture(api, 'reading', root), entered = deferred(), cleanup = deferred();
  await writeFile(join(root, 'results.md'), '# Original\n\nOriginal resource fixture result.');
  f.repository.knowledge.saveEmbeddingConfig({id: 'test', name: 'Test', baseUrl: 'https://fixture.invalid',
    model: 'fixture', dimensions: 2, enabled: true}, 'fixture-key');
  const embeddings = new ResearchEmbeddingService(f.repository.knowledge, {embed: async ({signal}) => {
    entered.resolve(signal); await cleanup.promise; throw new Error('research_index_cancelled');
  }}, {secrets: {get: async () => 'synthetic-key'}, logger: {warn() {}}});
  const service = new ResearchIndexService(f.repository,
    {defaultParseOptions: () => ({tier: 'compact'}), identity: async () => 'unused', parseDocument: async () => {throw new Error('unexpected PDF');}},
    embeddings, join(root, 'storage'), {info() {}, warn() {}}, undefined, api.mainResourceActivity);
  try {
    const {revision, projectId, ...settings} = f.repository.indexing.settings(f.project.id);
    service.configure({...settings, projectId, expectedRevision: revision, paused: false, watch: false});
    const signal = await entered.promise;
    assert.equal(api.mainResourceActivity.busy, true);
    const stopped = service.shutdown();
    assert.equal(signal.aborted, true);
    assert.equal(api.mainResourceActivity.busy, true);
    cleanup.resolve(); await stopped;
    assert.equal(api.mainResourceActivity.snapshot().total, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) FROM research_index_jobs WHERE status='running'").pluck().get(), 0);
  } finally {
    cleanup.resolve(); await service.shutdown(); await embeddings.shutdown(); await f.repository.wiki.shutdown(); await f.close();
    await rm(root, {recursive: true, force: true});
  }
});
