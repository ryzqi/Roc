import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { load } from 'sqlite-vec';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const options = { platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/performance') };
const { ResearchKnowledgeRepository: Current } = await importTypeScriptModule('src/main/plugins/research/knowledge-repository.ts', options);
const frozen = await build({ stdin: { contents: readFileSync('tests/fixtures/performance/legacy-knowledge-repository.ts', 'utf8'),
  resolveDir: resolve('src/main/plugins/research'), loader: 'ts' }, bundle: true, platform: 'node',
  format: 'esm', target: 'node22', write: false, logLevel: 'silent' });
const { ResearchKnowledgeRepository: Legacy } = await import(`data:text/javascript;base64,${Buffer.from(frozen.outputFiles[0].text).toString('base64')}`);
const { applyResearchDatabaseSchema } = await importTypeScriptModule('src/main/infrastructure/database-schemas.ts', options);
const now = () => '2026-11-15T00:00:00.000Z';
const receipt = { status: 'succeeded', model: 'fixture', configHash: 'fixture', elapsedMs: 1 };

function fixture() {
  const db = new Database(':memory:'); load(db); db.pragma('foreign_keys=ON'); applyResearchDatabaseSchema(db);
  for (const id of ['a', 'b']) db.prepare(`INSERT INTO research_projects
    (id,title,description,status,current_stage,created_at,updated_at) VALUES (?,?,'','active','reading',?,?)`).run(id, id, now(), now());
  const current = new Current(db, () => {}, now), legacy = new Legacy(db, () => {}, now);
  current.saveEmbeddingConfig({ id: 'fixture', name: 'fixture', baseUrl: 'https://fixture.invalid',
    model: 'fixture', dimensions: 2, enabled: true }, 'offline');
  for (let document = 0; document < 8; document++) {
    const id = `document-${document}`, projectId = document % 3 === 0 ? null : document % 3 === 1 ? 'a' : 'b';
    const chunks = Array.from({ length: 30 }, (_, index) => ({ content: `needle evidence ${document} ${index} 方法 中文`,
      locator: `page:${index + 1}`, section: index % 3 === 0 ? 'Methods' : index % 3 === 1 ? 'Results' : null }));
    current.upsertFromSource({ id, projectId, sourceType: 'file', sourceId: id, title: `Unique title ${document}`,
      content: chunks.map(chunk => chunk.content).join('\n'), chunks, embeddingPolicy: 'none' },
    { DOI: `10.12345/literal_%${document}`, other: document === 1 ? '10.54321/metadata-token' : '',
      nested: document === 1 ? '10.11111/outer10.56789/inside-token' : '',
      binding: document === 1 ? '10.12345/�-needle' : '' });
    current.storeChunkEmbeddings({ configId: 'fixture', configRevision: 1, chunks: current.knowledgeChunks(id),
      vectors: chunks.map((_, index) => Buffer.from(new Float32Array([1, (index + document) / 100]).buffer)) });
  }
  return { db, current, legacy };
}

function capture(operation) {
  try { return { output: JSON.parse(JSON.stringify(operation())) }; }
  catch (error) { return { error: { name: error.name, message: error.message } }; }
}

test('frozen RAG parity with the specified relevance-first role rule includes all receipts and scopes', () => {
  const { db, current, legacy } = fixture();
  try {
    // Keep the frozen implementation intact. This one intentional behavior change
    // has an independent reference rule; every other output still requires parity.
    legacy.preferScientificSections = (hits, intent) => {
      const preferred = new Set({
        method: ['method'], comparison: ['method'],
        results: ['experimental_setup', 'results', 'ablation'],
        overview: ['abstract', 'problem', 'contribution']
      }[intent] ?? []);
      hits.sort((a, b) => b.rrfScore - a.rrfScore ||
        Number(preferred.has(b.semantic?.semanticRole)) - Number(preferred.has(a.semantic?.semanticRole)));
    };
    for (const projectId of [null, 'a', 'b', 'missing']) for (const query of [
      'needle', 'compare needle methods', '中文方法', 'Unique title 1 needle', '10.12345/LITERAL_%1',
      '10.54321/metadata-token', '10.56789/inside-token', '10.12345/\ud800-needle', 'unknown', ''
    ]) for (const candidateLimit of [20, 200]) for (const vector of [null,
      { configId: 'fixture', configRevision: 1, blob: Buffer.from(new Float32Array([1, 0]).buffer) }]) {
      const input = { request: { query, projectId, limit: 10, candidateLimit }, vector };
      const expected = legacy.searchKnowledge(input), actual = current.searchKnowledge(input);
      assert.deepEqual(actual, expected, JSON.stringify(input.request));
      assert.ok(actual.ranking.candidates.every((row, index, rows) =>
        index === 0 || rows[index - 1].score >= row.score));
      assert.deepEqual(current.searchCandidates(actual), legacy.searchCandidates(expected));
      assert.deepEqual(capture(() => current.assertSearchCurrent(actual)), capture(() => legacy.assertSearchCurrent(expected)));
      for (const scores of [null, expected.ranking.candidates.map((_, index) => index % 3)]) {
        assert.deepEqual(current.applyRerank(actual, scores, scores === null ? { ...receipt, status: 'timeout' } : receipt),
          legacy.applyRerank(expected, scores, scores === null ? { ...receipt, status: 'timeout' } : receipt));
      }
    }
    for (const documentId of ['document-1', 'document-2', 'missing']) {
      const input = { request: { query: 'needle', projectId: 'a', limit: 10, documentId }, vector: null };
      assert.deepEqual(capture(() => current.searchKnowledge(input)), capture(() => legacy.searchKnowledge(input)));
    }
  } finally { db.close(); }
});

test('fresh version validation retains corruption, project, ranking and semantic error precedence after rerank await', () => {
  for (const mutation of [
    "UPDATE research_knowledge_chunks SET locator='changed' WHERE id='document-1:chunk:0'",
    "UPDATE research_knowledge_chunks SET content_hash='bad' WHERE id='document-1:chunk:0'",
    "UPDATE research_knowledge_documents SET content='corrupt' WHERE id='document-1'",
    "UPDATE research_knowledge_chunks SET project_id='b' WHERE id='document-1:chunk:0'",
    "UPDATE research_knowledge_chunk_semantics SET metadata_json='{}' WHERE chunk_id='document-1:chunk:0'",
    "DELETE FROM research_knowledge_chunks WHERE id='document-1:chunk:0'",
    "UPDATE research_knowledge_documents SET content='corrupt' WHERE id='document-1'; UPDATE research_knowledge_chunk_semantics SET metadata_json='{}' WHERE chunk_id='document-1:chunk:0'"
  ]) {
    const { db, current, legacy } = fixture();
    try {
      const input = { request: { query: 'needle', projectId: 'a', limit: 10, candidateLimit: 200 }, vector: null };
      const expected = legacy.searchKnowledge(input), actual = current.searchKnowledge(input);
      db.exec(mutation);
      assert.deepEqual(capture(() => current.searchKnowledge(input)), capture(() => legacy.searchKnowledge(input)), mutation);
      assert.deepEqual(capture(() => current.assertSearchCurrent(actual)), capture(() => legacy.assertSearchCurrent(expected)), mutation);
      assert.deepEqual(capture(() => current.applyRerank(actual, null, receipt)),
        capture(() => legacy.applyRerank(expected, null, receipt)), mutation);
    } finally { db.close(); }
  }
  const { db, current, legacy } = fixture();
  try {
    const input = { request: { query: 'needle', projectId: 'a', limit: 10 }, vector: null };
    const expected = legacy.searchKnowledge(input), actual = current.searchKnowledge(input);
    for (const result of [actual, expected]) result.ranking.candidates[0].score = 0;
    assert.deepEqual(capture(() => current.applyRerank(actual, [], receipt)), capture(() => legacy.applyRerank(expected, [], receipt)));
  } finally { db.close(); }
});

test('production hydration SQL stays bounded at 20 and 200 candidates including rerank revalidation', () => {
  const { db } = fixture();
  try {
    function measured(Repository, candidateLimit) {
      let calls = 0;
      const observed = new Proxy(db, { get(target, key) {
        if (key !== 'prepare') {
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...args) => {
          const statement = target.prepare(...args);
          const proxy = new Proxy(statement, { get(native, method) {
            const value = Reflect.get(native, method, native);
            return typeof value !== 'function' ? value : (...values) => {
              if (['get', 'all', 'run', 'iterate'].includes(method)) calls++;
              const result = value.apply(native, values);
              return result === native ? proxy : result;
            };
          } });
          return proxy;
        };
      } });
      const repository = new Repository(observed, () => {}, now);
      const counts = [];
      // Check first use and reuse; SQL bounds do not need repeated latency samples.
      for (let index = 0; index < 2; index++) {
        calls = 0;
        const result = repository.searchKnowledge({ request: { query: 'needle', projectId: null, limit: 10, candidateLimit }, vector: null });
        assert.equal(result.ranking.candidates.length, candidateLimit);
        repository.searchCandidates(result);
        repository.applyRerank(result, result.ranking.candidates.map(() => 1), receipt);
        counts.push(calls);
      }
      return counts;
    }
    const rows = [20, 200].map(candidateLimit => ({ candidateLimit,
      before: measured(Legacy, candidateLimit), after: measured(Current, candidateLimit) }));
    assert.ok(rows.every(row => row.after.every(count => count <= 15)));
    assert.deepEqual(rows[0].after, rows[1].after);
    assert.ok(rows[1].before.every((count, index) => count > rows[0].before[index] * 5));
  } finally { db.close(); }
});

test('external WAL changes invalidate candidate reuse and the disposable DOI index', () => {
  const seed = fixture(), directory = mkdtempSync(join(tmpdir(), 'roc-rag-parity-'));
  const path = join(directory, 'research.sqlite');
  writeFileSync(path, seed.db.serialize()); seed.db.close();
  const db = new Database(path); db.pragma('journal_mode=WAL'); load(db);
  const writer = new Database(path);
  const current = new Current(db, () => {}, now), legacy = new Legacy(db, () => {}, now);
  try {
    const search = repository => repository.searchKnowledge({ request: { query: '10.12345/literal_%1 needle',
      projectId: 'a', limit: 10 }, vector: null });
    const actual = search(current), expected = search(legacy);
    assert.deepEqual(actual, expected); assert.equal(actual.ranking.route.documentId, 'document-1');
    writer.prepare("UPDATE research_knowledge_documents SET metadata_json=? WHERE id='document-1'")
      .run(JSON.stringify({ DOI: '10.12345/replacement_%1' }));
    assert.deepEqual(capture(() => current.assertSearchCurrent(actual)), capture(() => legacy.assertSearchCurrent(expected)));
    assert.deepEqual(search(current), search(legacy)); assert.equal(search(current).ranking.route.documentId, null);
    const query = { request: { query: '10.12345/replacement_%1 needle', projectId: 'a', limit: 10 }, vector: null };
    assert.deepEqual(current.searchKnowledge(query), legacy.searchKnowledge(query));
    assert.equal(current.searchKnowledge(query).ranking.route.documentId, 'document-1');
    writer.exec("UPDATE research_knowledge_chunk_semantics SET metadata_json='{}' WHERE chunk_id='document-1:chunk:0'");
    assert.deepEqual(capture(() => current.searchCandidates(actual)), capture(() => legacy.searchCandidates(expected)));
  } finally { writer.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
