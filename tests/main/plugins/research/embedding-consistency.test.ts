import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyResearchDatabaseSchema, researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { createResearchPlugin } from '../../../../src/main/plugins/research';
import type { EmbeddingFetch } from '../../../../src/main/plugins/research/embedding-client';
import type { ResearchKnowledgeSearchResult } from '../../../../src/shared/types';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { OpenAICompatibleEmbeddingClient } from '../../../../src/main/plugins/research/embedding-client';
import { ResearchEmbeddingService } from '../../../../src/main/plugins/research/embedding-service';
import { vectorToBlob } from '../../../../src/main/plugins/research/embedding-vectors';

let db: Database.Database;
let plugin: ReturnType<typeof createResearchPlugin>;
let capabilities: CapabilityRegistry;
let fetchImpl: EmbeddingFetch;
const secrets = new Map<string, string>();
const config = (id = 'first', baseUrl = 'https://first.test/v1') => ({ id, name: id, baseUrl, model: 'same-model', dimensions: 3, apiKey: 'sample-key', enabled: true });
const document = (content: string, id = 'document', embeddingConfigId = 'first') => ({
  id, projectId: null, sourceType: 'file', sourceId: `${id}.md`, title: id, content, chunks: [{ content, locator: 'line 1' }], embeddingConfigId
});
const response = (vector: number[]) => Response.json({ data: [{ index: 0, embedding: vector }] });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  secrets.clear();
  fetchImpl = async () => response([1, 0, 0]);
  plugin = createResearchPlugin({ embeddingFetch: (url, init) => fetchImpl(url, init) });
  capabilities = new CapabilityRegistry();
  for (const capability of plugin.manifest.capabilities) capabilities.declare(plugin.manifest.id, capability);
  await plugin.initialize({ pluginId: plugin.manifest.id, capabilities, database: { getConnection: () => db },
    eventBus: { publish: async () => {}, subscribe: () => () => {} }, config: { get: () => null, set: () => {} },
    secrets: { get: (key) => secrets.get(key) ?? null, set: (key, value) => { secrets.set(key, value); }, clear: (key) => { secrets.delete(key); } },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
  await capabilities.invoke('research.embedding.save', config());
});
afterEach(async () => { await plugin.shutdown(); db.close(); });

describe('research embedding consistency', () => {
  it('embeds source writes when an embedding configuration is enabled', async () => {
    const repository = new ResearchRepository(db);
    const embeddings = new ResearchEmbeddingService(repository.knowledge, new OpenAICompatibleEmbeddingClient(fetchImpl), {
      secrets: { get: (key: string) => secrets.get(key) ?? null, set: () => undefined, clear: () => undefined },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
    });
    const document = await embeddings.upsertFromSource({
      id: 'source-auto', projectId: null, sourceType: 'file', sourceId: 'auto.md', title: 'Auto',
      content: 'Auto embedded.', chunks: [{ content: 'Auto embedded.', locator: 'line 1' }], embeddingPolicy: 'selected'
    });
    expect(document.id).toBe('source-auto');
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_embeddings WHERE chunk_id = ?').get('source-auto:chunk:0')).toEqual({ count: 1 });
  });
  it('does not let a late vector overwrite an updated chunk', async () => {
    const entered = deferred<void>();
    const delayed = deferred<Response>();
    fetchImpl = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      if (body.input[0] === 'Old content') { entered.resolve(); return await delayed.promise; }
      return response([0, 1, 0]);
    };
    const old = capabilities.invoke('research.knowledge.upsert', document('Old content')).then(() => 'committed', () => 'rejected');
    try {
      await entered.promise;
      await capabilities.invoke('research.knowledge.upsert', document('New content'));
    } finally { delayed.resolve(response([1, 0, 0])); }
    expect(await old).toBe('rejected');
    const row = db.prepare('SELECT vector_blob FROM research_knowledge_embeddings WHERE chunk_id = ?').get('document:chunk:0') as { vector_blob: Buffer };
    expect(row.vector_blob.readFloatLE(0)).toBe(0);
    expect(row.vector_blob.readFloatLE(4)).toBe(1);
  });

  it('isolates identically named models served by different configurations', async () => {
    await capabilities.invoke('research.embedding.save', config('second', 'https://second.test/v1'));
    await capabilities.invoke('research.knowledge.upsert', document('Alpha source', 'alpha', 'first'));
    await capabilities.invoke('research.knowledge.upsert', document('Beta source', 'beta', 'second'));
    const result = await capabilities.invoke<unknown, ResearchKnowledgeSearchResult>('research.knowledge.search', {
      query: 'no_keyword_match', projectId: null, limit: 10, embeddingConfigId: 'first'
    });
    expect(result.keywordCount).toBe(0);
    expect(result.hits.map((hit) => hit.documentId)).toEqual(['alpha']);
  });

  it('rejects an old configuration response after an endpoint change', async () => {
    const entered = deferred<void>();
    const delayed = deferred<Response>();
    fetchImpl = async () => { entered.resolve(); return await delayed.promise; };
    const pending = capabilities.invoke('research.knowledge.upsert', document('Stable source')).then(() => 'committed', () => 'rejected');
    await entered.promise;
    await capabilities.invoke('research.embedding.save', config('first', 'https://replacement.test/v1'));
    delayed.resolve(response([1, 0, 0]));
    expect(await pending).toBe('rejected');
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_embeddings').get()).toEqual({ count: 0 });
  });

  it('keeps the current credential when database persistence of new settings fails', async () => {
    const before = new Map(secrets);
    const entered = deferred<void>();
    const delayed = deferred<Response>();
    fetchImpl = async () => { entered.resolve(); return await delayed.promise; };
    const pending = capabilities.invoke('research.knowledge.upsert', document('Existing request')).then(() => 'committed', () => 'rejected');
    await entered.promise;
    db.exec("CREATE TRIGGER reject_embedding_config BEFORE UPDATE ON research_embedding_configs BEGIN SELECT RAISE(ABORT, 'config_write_failed'); END;");
    try { await expect(capabilities.invoke('research.embedding.save', { ...config(), apiKey: 'new-sample-key' })).rejects.toThrow('config_write_failed'); }
    finally { delayed.resolve(response([1, 0, 0])); }
    expect(secrets).toEqual(before);
    expect(await pending).toBe('committed');
  });

  it('retains caches for a display-name change and excludes them after a model endpoint change', async () => {
    await capabilities.invoke('research.knowledge.upsert', document('Source material'));
    await capabilities.invoke('research.embedding.save', { ...config(), name: 'Renamed configuration' });
    const first = await capabilities.invoke<unknown, ResearchKnowledgeSearchResult>('research.knowledge.search', { query: 'no_keyword_match', projectId: null, limit: 10, embeddingConfigId: 'first' });
    expect(first.vectorCount).toBe(1);
    await capabilities.invoke('research.embedding.save', config('first', 'https://replacement.test/v1'));
    const second = await capabilities.invoke<unknown, ResearchKnowledgeSearchResult>('research.knowledge.search', { query: 'no_keyword_match', projectId: null, limit: 10, embeddingConfigId: 'first' });
    expect(second.vectorCount).toBe(0);
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_documents').get()).toEqual({ count: 1 });
  });

  it('does not publish partial vectors when a later batch fails', async () => {
    let count = 0;
    fetchImpl = async (_url, init) => {
      count += 1;
      if (count === 2) return new Response('Unavailable', { status: 503 });
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) });
    };
    await expect(capabilities.invoke('research.knowledge.upsert', { ...document('Many parts'),
      chunks: Array.from({ length: 40 }, (_, index) => ({ content: `Part ${index}`, locator: `line ${index + 1}` })) })).rejects.toThrow('embedding_provider_http_503');
    expect(count).toBe(2);
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_embeddings').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_chunks').get()).toEqual({ count: 40 });
  });

  it('embeds source writes when the knowledge policy is selected', async () => {
    const repository = new ResearchRepository(db);
    const embeddings = new ResearchEmbeddingService(repository.knowledge, new OpenAICompatibleEmbeddingClient(fetchImpl), {
      secrets: { get: (key) => secrets.get(key) ?? null, set() {}, clear() {} },
      logger: { info() {}, warn() {}, error() {} }
    });
    await embeddings.upsertFromSource({
      id: 'selected-source', projectId: null, sourceType: 'file', sourceId: 'selected.md',
      title: 'Selected source', content: 'Selected source', chunks: [{ content: 'Selected source', locator: 'line 1' }],
      embeddingPolicy: 'selected'
    });
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_embeddings WHERE chunk_id = ?').get('selected-source:chunk:0')).toEqual({ count: 1 });
    repository.knowledge.upsertFromSource({
      id: 'keyword-source', projectId: null, sourceType: 'file', sourceId: 'keyword.md',
      title: 'Keyword source', content: 'Keyword source', chunks: [{ content: 'Keyword source', locator: 'line 1' }],
      embeddingPolicy: 'none'
    });
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_embeddings WHERE chunk_id = ?').get('keyword-source:chunk:0')).toEqual({ count: 0 });
  });

  it('rejects an explicitly selected missing configuration before mutating knowledge data', async () => {
    await expect(capabilities.invoke('research.knowledge.upsert', document('Source', 'document', 'missing'))).rejects.toThrow('research_embedding_config_not_found');
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_documents').get()).toEqual({ count: 0 });
  });

  it('isolates pre-revision vector caches during v7 migration without dropping source records', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.pragma('foreign_keys = ON');
      applyDatabaseMigrations(legacy, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((migration) => migration.version <= 7) });
      legacy.exec("INSERT INTO research_embedding_configs VALUES ('first','First','https://first.test/v1','same-model',3,'old-reference',1,'2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z')");
      const repository = new ResearchRepository(legacy);
      repository.knowledge.upsertKnowledgeDocument({ ...document('Preserved source'), sourceType: 'file' });
      legacy.prepare('INSERT INTO research_knowledge_embeddings VALUES (?,?,?,?,?)').run('document:chunk:0', 'same-model', 3, vectorToBlob([1, 0, 0]), '2026-09-11T00:00:00.000Z');
      applyResearchDatabaseSchema(legacy);
      applyResearchDatabaseSchema(legacy);
      expect(repository.knowledge.listEmbeddingConfigRows()[0].revision).toBe(1);
      expect(repository.knowledge.knowledgeChunks('document')[0].content).toBe('Preserved source');
      const row = legacy.prepare('SELECT space_key,vector_blob FROM research_knowledge_embeddings').get() as { space_key: string; vector_blob: Buffer };
      expect(row.space_key).toMatch(/^legacy:/u);
      expect(row.vector_blob).toEqual(vectorToBlob([1, 0, 0]));
    } finally { legacy.close(); }
  });

  it('cancels requests and waits for late responses before shutdown completes', async () => {
    const entered = deferred<void>();
    const delayed = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    fetchImpl = async (_url, init) => { signal = init.signal; entered.resolve(); return await delayed.promise; };
    const pending = capabilities.invoke('research.knowledge.upsert', document('Source')).then(() => 'committed', () => 'rejected');
    await entered.promise;
    let closed = false;
    const closing = plugin.shutdown().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closedEarly = closed;
    delayed.resolve(response([1, 0, 0]));
    const outcome = await pending;
    await closing;
    expect(signal?.aborted).toBe(true);
    expect(closedEarly).toBe(false);
    expect(outcome).toBe('rejected');
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_embeddings').get()).toEqual({ count: 0 });
  });
});
