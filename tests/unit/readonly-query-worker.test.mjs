import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {performance} from 'node:perf_hooks';
import { mkdtempSync, realpathSync, statSync, rmSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { loadResearchWorkerTestApi, createResearchFixture } from './fixtures/research-test-kit.mjs';
import { loadResearchPluginApi, createResearchPluginFixture } from '../fixtures/research-plugin-fixture.mjs';

const api = await loadResearchWorkerTestApi();
after(() => api.dispose());
const now = () => '2026-11-15T00:00:00.000Z';
const workerUrl = pathToFileURL(join(dirname(api.modulePath), 'research-query-worker.js'));
const fixtureUrl = new URL('../fixtures/performance/readonly-query-worker-fixture.mjs', import.meta.url);
const request = (query = 'needle', projectId = null, extra = {}) => ({
  query, projectId, limit: 10, candidateLimit: 50, rerank: 'none', embeddingConfigId: null, ...extra
});
const input = query => ({ request: request(query), vector: null });

async function until(predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(label);
}

function client(options = {}) {
  const events = [];
  const value = new api.ResearchQueryClient({
    database: { path: 'fixture', device: '1', inode: '1', schema: 1 },
    workerUrl: fixtureUrl, now, idleMs: 30, deadlineMs: 3000,
    onEvent: event => events.push(event), ...options
  });
  return { value, events };
}

function corpus({ memory = false, large = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'roc-readonly-query-'));
  const db = new Database(memory ? ':memory:' : join(directory, 'research.sqlite'));
  db.pragma('foreign_keys=ON');
  if (!memory) db.pragma('journal_mode=WAL');
  api.applyResearchDatabaseSchema(db, now);
  api.loadResearchVectorExtension(db);
  for (const id of ['a', 'b']) db.prepare(`INSERT INTO research_projects
    (id,title,description,status,current_stage,created_at,updated_at) VALUES (?,?,'','active','reading',?,?)`).run(id, id, now(), now());
  const knowledge = new api.ResearchKnowledgeRepository(db, () => {}, now);
  knowledge.saveEmbeddingConfig({ id: 'fixture', name: 'fixture', baseUrl: 'https://fixture.invalid',
    model: 'fixture', dimensions: 2, enabled: true }, 'offline');
  for (let document = 0; document < (large ? 100 : 3); document++) {
    const id = `doc-${String(document).padStart(3, '0')}`;
    const projectId = document % 3 === 0 ? null : document % 3 === 1 ? 'a' : 'b';
    const chunks = Array.from({ length: large ? 100 : 2 }, (_, index) => ({
      content: `needle proof ${document} ${index} 中文方法`, locator: `page:${index + 1}`
    }));
    knowledge.upsertFromSource({ id, projectId, sourceType: 'file', sourceId: id, title: `Unique title ${document}`,
      content: chunks.map(chunk => chunk.content).join('\n'), chunks, embeddingPolicy: 'none' }, { DOI: `10.12345/literal_%${document}` });
    knowledge.storeChunkEmbeddings({ configId: 'fixture', configRevision: 1, chunks: knowledge.knowledgeChunks(id),
      vectors: chunks.map((_, index) => Buffer.from(new Float32Array([1, (index + document) / 100]).buffer)) });
  }
  const services = [];
  return { db, knowledge, directory, service(options = {}) {
    const service = new api.ResearchReadonlySearchService(db, knowledge, { workerUrl, now, idleMs: 30, ...options });
    services.push(service); return service;
  }, async close() {
    await Promise.all(services.map(service => service.shutdown()));
    db.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

test('real one-Worker client bounds admission, removes queued cancellation, and waits for active exit before replacement', async () => {
  const { value, events } = client({ maxPending: 2 });
  const activeController = new AbortController(), queuedController = new AbortController();
  const active = value.search(input('blocked'), activeController.signal);
  const activeRejected = assert.rejects(active, /active_cancelled/);
  try {
    await until(() => events.some(event => event.type === 'started'), 'active request did not start');
    const queued = value.search(input('needle'), queuedController.signal);
    const queuedRejected = assert.rejects(queued, /queued_cancelled/);
    await assert.rejects(value.search(input('needle')), /research_query_queue_full/);
    queuedController.abort(new Error('queued_cancelled'));
    await queuedRejected;
    assert.equal(value.snapshot().workers, 1);
    assert.equal(value.snapshot().exits, 0, 'queued cancellation must leave the active Worker alive');
    const next = value.search(input('needle'));
    activeController.abort(new Error('active_cancelled'));
    await activeRejected;
    assert.equal(value.snapshot().exits, 1, 'cancellation must await native-query thread exit');
    assert.equal((await next).hits.length, 0);
    assert.equal(value.snapshot().starts, 2);
    const secondSpawn = events.findIndex((event, index) => index > 0 && event.type === 'spawn');
    assert.ok(events.slice(0, secondSpawn).some(event => event.type === 'exit'));
    assert.equal(value.snapshot().queuedBytes, 0);
  } finally { await value.shutdown(); }
});

test('queue deadline does not terminate another request; active and initialization deadlines reclaim the Worker', async () => {
  const { value, events } = client();
  const controller = new AbortController();
  const activeRejected = assert.rejects(value.search(input('blocked'), controller.signal), /done/);
  try {
    await until(() => events.some(event => event.type === 'started'), 'request did not start');
    await assert.rejects(value.search(input('needle'), undefined, Date.now() + 20), /deadline_exceeded/);
    assert.equal(value.snapshot().exits, 0);
    controller.abort(new Error('done'));
    await activeRejected;
    await assert.rejects(value.search(input('blocked'), undefined, Date.now() + 100), /deadline_exceeded/);
    assert.equal(value.snapshot().workers, 0);
  } finally { await value.shutdown(); }
  const slow = client({ database: { path: 'slow-init', device: '1', inode: '1', schema: 1 }, deadlineMs: 30 });
  try {
    await assert.rejects(slow.value.search(input('needle')), /deadline_exceeded/);
    assert.equal(slow.value.snapshot().workers, 0);
    assert.equal(slow.value.snapshot().starts, slow.value.snapshot().exits);
  } finally { await slow.value.shutdown(); }
});

test('crashes and malformed/oversized replies fail explicitly; future readonly requests recreate one Worker', async () => {
  const { value } = client();
  try {
    await assert.rejects(value.search(input('crash')), /worker_crashed/);
    assert.equal((await value.search(input('needle'))).query, 'needle');
    await assert.rejects(value.search(input('wrong-query')), /result_binding_invalid/);
    await assert.rejects(value.search(input('large-reply')));
    await assert.rejects(value.search(input('query-error')), /source_corrupt/);
    assert.equal((await value.search(input('needle'))).query, 'needle');
    await until(() => value.snapshot().workers === 0, 'idle Worker was retained');
    assert.equal(value.snapshot().starts, value.snapshot().exits);
    assert.equal((await value.search(input('needle'))).query, 'needle');
  } finally { await value.shutdown(); }
});

test('valid oversized requests never enter the Worker queue, and unavailable readonly startup retains the old path', async () => {
  const { value } = client();
  try {
    assert.equal(await value.search(input('x'.repeat(api.researchQueryLimits.requestBytes + 1))), null);
    assert.equal(value.snapshot().starts, 0);
    assert.equal(value.snapshot().queuedBytes, 0);
  } finally { await value.shutdown(); }
  const unavailable = client({ workerUrl: new URL('./task-worker-does-not-exist.js', import.meta.url) });
  try {
    assert.equal(await unavailable.value.search(input('needle')), null);
    assert.equal(unavailable.value.snapshot().workers, 0);
  } finally { await unavailable.value.shutdown(); }
});

test('production readonly WAL search preserves complete vector/FTS/DOI/project/rerank receipt bytes', async () => {
  const f = corpus(), service = f.service();
  try {
    for (const projectId of [null, 'a', 'b', 'missing']) for (const query of ['needle', '中文方法', '10.12345/LITERAL_%1', 'Unique title 1 needle', 'unknown']) {
      for (const vector of [null, { configId: 'fixture', configRevision: 1, blob: Buffer.from(new Float32Array([1, 0]).buffer) }]) {
        const value = { request: request(query, projectId), vector };
        const expected = f.knowledge.searchKnowledge(value), actual = await service.search(value);
        assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${projectId}/${query}/${vector !== null}`);
        f.knowledge.assertSearchCurrent(actual);
        const receipt = { status: 'succeeded', model: 'fixture', configHash: 'fixture', elapsedMs: 1 };
        assert.deepEqual(f.knowledge.applyRerank(actual, actual.ranking.candidates.map(() => 1), receipt),
          f.knowledge.applyRerank(expected, expected.ranking.candidates.map(() => 1), receipt));
      }
    }
    for (const documentId of ['doc-001', 'doc-002', 'missing']) {
      const value = { request: request('needle', 'a', { documentId }), vector: null };
      let expected;
      try { expected = f.knowledge.searchKnowledge(value); }
      catch (error) { await assert.rejects(service.search(value), { message: error.message }); continue; }
      assert.deepEqual(await service.search(value), expected);
    }
    assert.equal(service.snapshot().starts, 1);
    const count = Number(f.db.prepare('SELECT total_changes()').pluck().get());
    await service.search(input('needle'));
    assert.equal(Number(f.db.prepare('SELECT total_changes()').pluck().get()), count, 'readonly search must not persist writes');
  } finally { await f.close(); }
});

test('real readonly Worker shares tolerant lexical functions and original receipt bytes across 10000 chunks', async t => {
  const f = corpus(), service = f.service({idleMs:10_000});
  try {
    const original = 'Multi‑Agent 注意力機制与重慶绿色网络。';
    const source = {id:'tolerant',projectId:'a',sourceType:'file',sourceId:'original.md',title:'Original tolerant source',
      content:original,chunks:[{content:original,locator:'original:page:8'}],embeddingPolicy:'none'};
    f.knowledge.upsertFromSource(source);
    f.knowledge.upsertFromSource({...source,id:'foreign-tolerant',projectId:'b'});
    const before = Number(f.db.prepare('SELECT total_changes()').pluck().get());
    const started = performance.now();
    for (const query of ['multiagent', '注意力机制', 'zhu yi li', 'chongqing']) {
      const value = {request:request(query,'a'),vector:null};
      const expected = f.knowledge.searchKnowledge(value), actual = await service.search(value);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), query);
      assert.ok(actual.hits.some(hit => hit.documentId === 'tolerant' && hit.content === original && hit.locator === 'original:page:8'), query);
      assert.ok(actual.hits.every(hit => hit.documentId !== 'foreign-tolerant'), query);
      f.knowledge.assertSearchCurrent(actual);
    }
    const elapsed = performance.now() - started;
    assert.equal(service.snapshot().starts, 1);
    assert.equal(Number(f.db.prepare('SELECT total_changes()').pluck().get()), before);
    assert.ok(elapsed < 15_000, `10000-chunk Main/Worker tolerance parity took ${elapsed.toFixed(1)}ms`);
    t.diagnostic(`10002 original chunks; four Main/readonly Worker tolerance pairs: ${elapsed.toFixed(1)}ms`);
  } finally {await f.close();}
});

test('fresh Main validation rejects source/configuration changes at the Worker return boundary', async () => {
  for (const mutation of [
    "UPDATE research_knowledge_chunks SET locator='changed' WHERE id='doc-000:chunk:0'",
    "UPDATE research_knowledge_documents SET content='corrupt' WHERE id='doc-000'",
    "UPDATE research_embedding_configs SET revision=revision+1 WHERE id='fixture'"
  ]) {
    const f = corpus();
    let changed = false;
    const service = f.service({ onEvent: event => {
      if (event.type === 'result' && !changed) { changed = true; f.db.exec(mutation); }
    } });
    try {
      await assert.rejects(service.search({ request: request('needle'), vector: {
        configId: 'fixture', configRevision: 1, blob: Buffer.from(new Float32Array([1, 0]).buffer)
      } }), /source_changed|source_corrupt|config_changed/);
      assert.equal(changed, true);
    } finally { await f.close(); }
  }
});

test('production cancellation releases real native SQLite work and a later query recovers without a write retry', async () => {
  const f = corpus(), controller = new AbortController();
  let cancelled = false;
  const service = f.service({ onEvent: event => {
    if (event.type === 'started' && !cancelled) { cancelled = true; controller.abort(new Error('native_cancel')); }
  } });
  try {
    await assert.rejects(service.search(input('needle'), controller.signal), /native_cancel/);
    assert.equal(service.snapshot().workers, 0);
    assert.equal(service.snapshot().starts, service.snapshot().exits);
    f.db.prepare("UPDATE research_projects SET title='Still writable' WHERE id='a'").run();
    assert.deepEqual(await service.search(input('needle')), f.knowledge.searchKnowledge(input('needle')));
    assert.equal(service.snapshot().starts, 2);
  } finally { await f.close(); }
});

test('small/in-memory/non-WAL/uncommitted queries remain on Main and file/schema replacement never falls back', async () => {
  for (const options of [{ memory: true }, { large: false }, {}]) {
    const f = corpus(options), service = f.service();
    try {
      if (!options.memory && options.large !== false) f.db.exec('BEGIN');
      assert.deepEqual(await service.search(input('needle')), f.knowledge.searchKnowledge(input('needle')));
      assert.equal(service.snapshot().starts, 0);
      if (f.db.inTransaction) f.db.exec('ROLLBACK');
      if (!options.memory) {
        f.db.pragma('journal_mode=DELETE');
        assert.deepEqual(await service.search(input('needle')), f.knowledge.searchKnowledge(input('needle')));
        assert.equal(service.snapshot().starts, 0);
      }
    } finally { await f.close(); }
  }
  const f = corpus(), service = f.service({ idleMs: 10_000 });
  try {
    await service.search(input('needle'));
    f.db.exec('CREATE TABLE task_schema_change(id TEXT)');
    await assert.rejects(service.search(input('needle')), /schema_changed/);
  } finally { await f.close(); }
  const replaced = corpus(), isolated = replaced.service({ idleMs: 10_000 });
  try {
    await isolated.search(input('needle'));
    const path = realpathSync(replaced.db.name);
    const old = statSync(path).ino;
    renameSync(path, `${path}.task-backup`);
    writeFileSync(path, 'replacement');
    assert.notEqual(statSync(path).ino, old);
    await assert.rejects(isolated.search(input('needle')), /database_changed/);
  } finally { await replaced.close(); }
  const beforeFirst = corpus(), unstarted = beforeFirst.service();
  try {
    beforeFirst.db.pragma('wal_checkpoint(TRUNCATE)');
    const path = realpathSync(beforeFirst.db.name);
    renameSync(path, `${path}.task-backup`);
    copyFileSync(`${path}.task-backup`, path);
    await assert.rejects(unstarted.search(input('needle')), /database_changed/);
    assert.equal(unstarted.snapshot().starts, 0, 'replacement before first query must fail before Worker admission');
  } finally { await beforeFirst.close(); }
});

test('actual Agent and Research role tools propagate cancellation through the production capability handler to Worker exit', async () => {
  const pluginApi = await loadResearchPluginApi({ productionWorkers: true });
  try {
    for (const kind of ['agent', 'role']) {
      const f = corpus(), role = createResearchFixture(api, 'writing');
      const plugin = await createResearchPluginFixture(pluginApi, { databasePath: f.db.name });
      const controller = new AbortController();
      // This test exercises the actual production registration and handler.
      // Cancel after thread admission, before it can publish a readonly result.
      const originalLog = plugin.context.logger.info;
      plugin.context.logger.info = (message, metadata) => {
        originalLog(message, metadata);
        if (message === 'Research readonly query Worker lifecycle.' && metadata.type === 'spawn') {
          controller.abort(new Error('tool_cancelled'));
        }
      };
      try {
        // Force keyword-only search, without calling a provider in this fixture.
        f.db.prepare('UPDATE research_embedding_configs SET enabled=0').run();
        for (const id of ['a', 'b']) plugin.repository.indexing.initializeProject(id);
        await plugin.initialize();
        const tools = kind === 'agent' ? api.createResearchTools({
          capabilities: plugin.registry, projectId: 'a', signal: controller.signal,
          dispatchStage: async () => { throw new Error('unexpected_stage'); },
          dispatchReviewQuery: async () => { throw new Error('unexpected_review'); }
        }) : role.withWorker(() => api.createResearchRoleTools({
          run: role.run, context: role.repository.runs.getContext(role.run.id), repository: role.repository,
          capabilities: plugin.registry, signal: controller.signal
        }));
        const tool = tools.find(item => item.name === (kind === 'agent' ? 'research_search_knowledge' : 'search_knowledge'));
        assert.ok(tool);
        const operation = kind === 'agent' ? tool.invoke({ query: 'needle', limit: 5 }) :
          role.withWorker(() => tool.invoke({ query: 'needle', limit: 5 }));
        await assert.rejects(operation, error => error.code === 'research_embedding_cancelled' || /tool_cancelled/.test(error.message));
        const events = plugin.observations.filter(item => item.message === 'Research readonly query Worker lifecycle.');
        assert.deepEqual(events.map(item => item.metadata.type), ['spawn', 'cancel', 'exit']);
        assert.equal(controller.signal.aborted, true);
        // A fresh invocation must recover normally, with no duplicated writes.
        const count = Number(f.db.prepare('SELECT total_changes()').pluck().get());
        assert.ok((await plugin.registry.invoke('research.knowledge.search', request('needle', 'a'))).hits.length > 0);
        assert.equal(Number(f.db.prepare('SELECT total_changes()').pluck().get()), count);
      } finally { await plugin.close(); role.close(); await f.close(); }
    }
  } finally { await pluginApi.dispose(); }
});

test('plugin-scoped invocation preserves dependency checks and forwards the real cancellation signal', async () => {
  const root = new api.CapabilityRegistry();
  const descriptor = { name: 'parent.read', version: '1', inputSchema: { parse: value => value },
    outputSchema: { parse: value => value } };
  const eventBus = { publish: async () => {}, subscribe: () => () => {} };
  let scoped, received;
  const plugin = (id, dependencies, capabilities, initialize) => ({
    manifest: { id, dependencies, capabilities, version: '1', required: true, order: id === 'parent' ? 1 : 2 },
    initialize, shutdown: async () => {}, healthCheck: async () => ({ status: 'healthy' })
  });
  const parent = plugin('parent', [], [descriptor], async context => {
    context.capabilities.register('parent', descriptor, async () => {
      received = api.getCapabilityAbortSignal();
      return await new Promise((resolve, reject) => received.addEventListener('abort', () => reject(received.reason), { once: true }));
    });
  });
  const child = plugin('child', ['parent'], [], async context => { scoped = context.capabilities; });
  const loader = new api.PluginLoader({ eventBus, capabilities: root,
    createContext: (_, capabilities) => ({ capabilities, eventBus }) });
  try {
    await loader.load([child, parent]);
    const controller = new AbortController();
    const failure = assert.rejects(scoped.invoke('parent.read', {}, controller.signal), /scoped_cancelled/);
    await until(() => received !== undefined, 'scoped handler was not reached');
    assert.equal(received, controller.signal);
    controller.abort(new Error('scoped_cancelled'));
    await failure;
    assert.equal(api.getCapabilityAbortSignal(), undefined, 'signal context must not leak into later invocations');
  } finally { await loader.shutdown(); }
});

test('production read transaction never mixes indexed versions across a concurrent WAL commit', async () => {
  const f = corpus();
  const path = realpathSync(f.db.name), file = statSync(path, { bigint: true });
  let nextContent = false;
  const value = new api.ResearchQueryClient({
    database: { path, device: String(file.dev), inode: String(file.ino),
      schema: Number(f.db.pragma('schema_version', { simple: true })) },
    workerUrl, now, idleMs: 10_000,
    onEvent: event => {
      if (event.type !== 'started') return;
      nextContent = !nextContent;
      // A title participates in every chunk's indexedVersion. A single writer
      // transaction changes the whole selected document while Worker reads.
      f.db.transaction(() => {
        f.db.prepare("UPDATE research_knowledge_documents SET title=? WHERE id='doc-000'").run(nextContent ? 'Snapshot new' : 'Unique title 0');
        f.db.prepare("UPDATE research_knowledge_chunks SET locator=? WHERE document_id='doc-000'").run(nextContent ? 'new-page' : 'old-page');
      })();
    }
  });
  try {
    f.db.prepare("UPDATE research_knowledge_chunks SET locator='old-page' WHERE document_id='doc-000'").run();
    for (let index = 0; index < 10; index++) {
      const before = f.knowledge.searchKnowledge(input('needle'));
      const result = await value.search(input('needle'));
      const after = f.knowledge.searchKnowledge(input('needle'));
      assert.ok(JSON.stringify(result) === JSON.stringify(before) || JSON.stringify(result) === JSON.stringify(after),
        'one WAL read transaction must match a complete pre/post-commit snapshot');
    }
  } finally { await value.shutdown(); await f.close(); }
});

test('queue byte budget rejects excess without retaining unbounded serialized payloads', async () => {
  const { value, events } = client({ idleMs: 10_000 });
  const controller = new AbortController();
  const failure = assert.rejects(value.search(input('blocked'), controller.signal), /budget_done/);
  try {
    await until(() => events.some(event => event.type === 'started'), 'active request did not start');
    const query = 'x'.repeat(900 * 1024);
    const queued = Array.from({ length: 4 }, () => value.search(input(query)));
    assert.ok(value.snapshot().queuedBytes <= api.researchQueryLimits.queuedBytes);
    await assert.rejects(value.search(input(query)), /queue_full/);
    controller.abort(new Error('budget_done'));
    await failure;
    await Promise.all(queued);
    assert.equal(value.snapshot().queuedBytes, 0);
  } finally { await value.shutdown(); }
});

test('shutdown settles active and queued requests after actual Worker exit', async () => {
  const { value, events } = client({ idleMs: 10_000 });
  const active = assert.rejects(value.search(input('blocked')), /research_query_closed/);
  await until(() => events.some(event => event.type === 'started'), 'active request did not start');
  const queued = assert.rejects(value.search(input('needle')), /research_query_closed/);
  await value.shutdown();
  await Promise.all([active, queued]);
  assert.equal(value.snapshot().workers, 0);
  assert.equal(value.snapshot().queued, 0);
  assert.equal(value.snapshot().queuedBytes, 0);
  assert.equal(value.snapshot().starts, value.snapshot().exits);
  await assert.rejects(value.search(input('needle')), /research_query_closed/);
});

test('valid oversized production results use Main without changing public content limits', async () => {
  const f = corpus(), events = [];
  const service = f.service({ onEvent: event => events.push(event) });
  try {
    const chunks = Array.from({ length: 10 }, (_, index) => ({
      content: `largeproof ${index} ${'bounded words '.repeat(70_000)}`, locator: `page:${index + 1}`
    }));
    f.knowledge.upsertFromSource({
      id: 'large', projectId: null, sourceType: 'file', sourceId: 'large', title: 'Large result',
      content: 'largeproof', chunks: chunks.map(chunk => ({ ...chunk, content: 'largeproof' })), embeddingPolicy: 'none'
    }, {});
    // Historical chunks predate the current tokenizer budget. Restore a valid
    // unbounded legacy version without manufacturing thousands of new children.
    const content = chunks.map(chunk => chunk.content).join('\n');
    const hash = value => createHash('sha256').update(value).digest('hex');
    f.db.transaction(() => {
      f.db.prepare("UPDATE research_knowledge_documents SET content=?,content_hash=? WHERE id='large'").run(content, hash(content));
      for (const [index, chunk] of chunks.entries()) {
        const id = `large:chunk:${index}`;
        f.db.prepare('UPDATE research_knowledge_chunks SET content=?,content_hash=? WHERE id=?').run(chunk.content, hash(chunk.content), id);
        f.db.prepare('UPDATE research_knowledge_chunk_structure SET end_utf16=? WHERE chunk_id=?').run(chunk.content.length, id);
        f.db.prepare("UPDATE research_knowledge_chunk_semantics SET metadata_json=json_set(metadata_json,'$.sourceHash',?) WHERE chunk_id=?")
          .run(hash(content), id);
      }
    })();
    const expected = f.knowledge.searchKnowledge(input('largeproof'));
    assert.ok(Buffer.byteLength(JSON.stringify(expected)) > api.researchQueryLimits.resultBytes);
    const count = Number(f.db.prepare('SELECT total_changes()').pluck().get());
    assert.deepEqual(await service.search(input('largeproof')), expected);
    assert.equal(Number(f.db.prepare('SELECT total_changes()').pluck().get()), count);
    assert.equal(service.snapshot().starts, 1);
    assert.ok(events.some(event => event.type === 'fallback'));
    assert.ok(!events.some(event => event.type === 'result'));
  } finally { await f.close(); }
});
