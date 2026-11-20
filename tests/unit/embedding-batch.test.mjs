import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { makeReport, saveReport, summarizeRows } from '../../scripts/performance/report-lib.mjs';

const options = { platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/performance') };
const { ResearchKnowledgeRepository: Current } = await importTypeScriptModule('src/main/plugins/research/knowledge-repository.ts', options);
const { ResearchEmbeddingService } = await importTypeScriptModule('src/main/plugins/research/embedding-service.ts', options);
const vectors = await importTypeScriptModule('src/main/plugins/research/embedding-vectors.ts', options);
const reference = await importTypeScriptModule('tests/fixtures/performance/legacy-embedding-vectors.ts', options);
const { applyResearchDatabaseSchema } = await importTypeScriptModule('src/main/infrastructure/database-schemas.ts', options);
const frozen = await build({ stdin: { contents: readFileSync('tests/fixtures/performance/legacy-knowledge-repository.ts', 'utf8'),
  resolveDir: resolve('src/main/plugins/research'), loader: 'ts' }, bundle: true, platform: 'node',
  format: 'esm', target: 'node22', write: false, logLevel: 'silent' });
const { ResearchKnowledgeRepository: Legacy } = await import(`data:text/javascript;base64,${Buffer.from(frozen.outputFiles[0].text).toString('base64')}`);
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => '2026-11-15T00:00:00.000Z';
const context = { secrets: { get: async () => 'isolated-test-key' }, logger: { warn() {} } };
function fixture() {
  const db = new Database(':memory:'); applyResearchDatabaseSchema(db);
  const current = new Current(db, () => {}, now), legacy = new Legacy(db, () => {}, now);
  current.saveEmbeddingConfig({ id: 'test', name: 'test', baseUrl: 'https://fixture.invalid',
    model: 'fixture', dimensions: 384, enabled: true }, 'fixture-key');
  const chunks = Array.from({ length: 400 }, (_, index) => ({ content: `Isolated evidence ${index % 40} 中文`,
    locator: `block:${index}`, section: index % 2 ? 'Methods 中文'.repeat(70) : null }));
  current.upsertFromSource({ id: 'document', projectId: null, sourceType: 'literature', sourceId: 'fixture',
    title: 'Long Unicode 标题🙂'.repeat(100), content: chunks.map(chunk => chunk.content).join('\n'), chunks, embeddingPolicy: 'none' });
  return { db, current, legacy };
}
function capture(operation) {
  try { return { value: operation() }; } catch (error) { return { name: error.name, message: error.message }; }
}

test('binary normalization retains exact Float32 bytes and errors including unaligned and extreme inputs', () => {
  let seed = 19790527;
  const cases = [[0], [-0], [NaN, 1], [Infinity, 1], [1, -1], [3.4028234663852886e38, 1.401298464324817e-45]];
  for (const dimensions of [1, 2, 384, 1024]) for (let sample = 0; sample < 40; sample++) {
    cases.push(Array.from({ length: dimensions }, () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return Math.fround(((seed >>> 0) / 0xffffffff - .5) * 2 ** (sample - 20));
    }));
  }
  for (const values of cases) {
    const aligned = Buffer.from(new Float32Array(values).buffer);
    const backing = Buffer.alloc(aligned.length + 1); aligned.copy(backing, 1);
    for (const blob of [aligned, backing.subarray(1)]) {
      assert.deepEqual(capture(() => vectors.normalizeEmbeddingBlob(blob, values.length)),
        capture(() => reference.normalizeEmbeddingBlob(blob, values.length)));
    }
  }
  for (const [blob, dimensions] of [[Buffer.alloc(0), 0], [Buffer.alloc(7), 2], [Buffer.alloc(4), NaN],
    [Buffer.alloc(4), .5], [Buffer.alloc(4), -1]]) {
    assert.deepEqual(capture(() => vectors.normalizeEmbeddingBlob(blob, dimensions)),
      capture(() => reference.normalizeEmbeddingBlob(blob, dimensions)));
  }
});

test('batched metadata and cache preserve input bytes, revisions, corruption and bounded SQL', () => {
  const { db, current, legacy } = fixture();
  try {
    assert.deepEqual(current.knowledgeChunks('document'), legacy.knowledgeChunks('document'));
    const chunks = current.knowledgeChunks('document'), hashes = chunks.map(chunk => hash(chunk.embeddingInput));
    const blob = reference.vectorToBlob(Array.from({ length: 384 }, (_, index) => (index + 1) / 384));
    current.cacheEmbeddings('test', 1, chunks[0].inputVersion, hashes, hashes.map(() => blob));
    for (const version of [chunks[0].inputVersion, 'changed']) {
      const expected = new Map(hashes.map(value => [value, legacy.cachedEmbedding('test', 1, version, value)]).filter(([, value]) => value));
      assert.deepEqual(current.cachedEmbeddings('test', 1, version, hashes), expected);
    }
    const many = Array.from({ length: 450 }, (_, index) => hash(`unique input ${index}`));
    current.cacheEmbeddings('test', 1, 'batch-boundary', many, many.map(() => blob));
    const requested = [many[449], 'missing', ...many, many[0]];
    const expected = new Map(requested.map(value => [value, legacy.cachedEmbedding('test', 1, 'batch-boundary', value)]).filter(([, value]) => value));
    assert.deepEqual(current.cachedEmbeddings('test', 1, 'batch-boundary', requested), expected);
    assert.deepEqual(current.cachedEmbeddings('test', 1, 'batch-boundary', []), new Map());
    assert.throws(() => current.cachedEmbeddings('test', 2, chunks[0].inputVersion, hashes), /config_changed/);
    db.prepare('UPDATE research_embedding_cache SET vector_blob=? WHERE input_hash=?').run(Buffer.alloc(7), hashes[0]);
    assert.deepEqual(capture(() => current.cachedEmbeddings('test', 1, chunks[0].inputVersion, hashes)),
      capture(() => legacy.cachedEmbedding('test', 1, chunks[0].inputVersion, hashes[0])));
  } finally { db.close(); }
});

test('real embedding service deduplicates imports and preserves cancellation and provider failures', async () => {
  const { db, current } = fixture(); let calls = 0, service;
  try {
    service = new ResearchEmbeddingService(current, { embed: async ({ texts }) => {
      calls++; return texts.map(() => Array.from({ length: 384 }, (_, index) => index + 1));
    } }, context);
    await service.embedDocument('document', null);
    const first = calls; assert.equal(first, 10, '40 unique inputs with a transport ceiling of four');
    await service.embedDocument('document', null); assert.equal(calls, first);
    const text = await service.embedTexts(['repeat', 'repeat'], 'derived-v1');
    assert.deepEqual(text.vectors[0], text.vectors[1]);
    await service.embedTexts(['repeat', 'repeat'], 'derived-v1'); assert.equal(calls, first + 1);
    assert.equal(db.prepare("SELECT count(*) FROM research_embedding_cache WHERE json_extract(input_version,'$.inputVersion')=?").pluck().get('derived-v1'), 1);
    await assert.rejects(() => service.embedDocument('document', null, AbortSignal.abort()), error => error.code === 'research_embedding_cancelled');
    await service.shutdown();
    service = new ResearchEmbeddingService(current, { embed: async () => { throw new Error('embedding_provider_http_503'); } }, context);
    await assert.rejects(() => service.embedTexts(['uncached'], 'new-v1'), /embedding_provider_http_503/);
    assert.equal(db.prepare("SELECT count(*) FROM research_embedding_cache WHERE json_extract(input_version,'$.inputVersion')=?").pluck().get('new-v1'), 0);
  } finally { await service?.shutdown(); db.close(); }
});

test('provider await still fences changed source context and configuration before publication', async () => {
  for (const change of ['title', 'configuration']) {
    const { db, current } = fixture(); let service, release;
    try {
      let enter; const entered = new Promise(resolve => { enter = resolve; });
      const pending = new Promise(resolve => { release = resolve; });
      service = new ResearchEmbeddingService(current, { embed: async ({ texts }) => {
        enter(); await pending; return texts.map(() => Array.from({ length: 384 }, (_, index) => index + 1));
      } }, context);
      const operation = service.embedDocument('document', null);
      await entered;
      if (change === 'title') db.prepare('UPDATE research_knowledge_documents SET title=?').run('Changed while embedding');
      else current.saveEmbeddingConfig({ id: 'test', name: 'test', baseUrl: 'https://fixture.invalid',
        model: 'new-model', dimensions: 384, enabled: true }, 'fixture-key');
      release();
      await assert.rejects(() => operation, error => error.code === `research_embedding_${change === 'title' ? 'source' : 'config'}_changed`);
      assert.equal(db.prepare('SELECT count(*) FROM research_knowledge_embeddings').pluck().get(), 0);
      assert.equal(db.prepare('SELECT count(*) FROM research_embedding_cache').pluck().get(), 0);
    } finally { release?.(); await service?.shutdown(); db.close(); }
  }
});

test('paired production embedding workload reduces queries without a persistent shared-vector migration', () => {
  const { db, current, legacy } = fixture();
  try {
    const chunks = current.knowledgeChunks('document'), hashes = chunks.map(chunk => hash(chunk.embeddingInput));
    const blob = reference.vectorToBlob(Array.from({ length: 384 }, (_, index) => index + 1));
    current.cacheEmbeddings('test', 1, chunks[0].inputVersion, hashes, hashes.map(() => blob));
    let calls = 0;
    const observed = new Proxy(db, { get(target, key) {
      if (key !== 'prepare') { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
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
    const repositories = { before: new Legacy(observed, () => {}, now), after: new Current(observed, () => {}, now) };
    const samples = { before: [], after: [] };
    // Exercise both orders in regression runs; repeated timing samples belong to the report.
    const sampleCount = process.env.ROC_PERF_EMBEDDING_REPORT ? 20 : 2;
    for (let index = 0; index < sampleCount; index++) for (const mode of index % 2 ? ['after', 'before'] : ['before', 'after']) {
      calls = 0; const started = performance.now(), cpuStarted = process.cpuUsage(), repository = repositories[mode];
      assert.deepEqual(repository.knowledgeChunks('document'), chunks);
      const cached = mode === 'after' ? repository.cachedEmbeddings('test', 1, chunks[0].inputVersion, hashes)
        : new Map(hashes.map(value => [value, repository.cachedEmbedding('test', 1, chunks[0].inputVersion, value)]));
      assert.equal(cached.size, new Set(hashes).size);
      const cpu = process.cpuUsage(cpuStarted);
      samples[mode].push({ totalMs: performance.now() - started, sqlCalls: calls, cpuMicros: cpu.user + cpu.system, ...process.memoryUsage() });
    }
    for (const sample of samples.before) assert.equal(sample.sqlCalls, 1201);
    for (const sample of samples.after) assert.equal(sample.sqlCalls, 3);
    if (process.env.ROC_PERF_EMBEDDING_REPORT) {
      const normalization = { before: [], after: [] };
      for (let sample = 0; sample < sampleCount; sample++) for (const mode of sample % 2 ? ['after', 'before'] : ['before', 'after']) {
        const normalize = mode === 'after' ? vectors.normalizeEmbeddingBlob : reference.normalizeEmbeddingBlob;
        const started = performance.now(), cpuStarted = process.cpuUsage();
        for (let index = 0; index < 2000; index++) normalize(blob, 384);
        const cpu = process.cpuUsage(cpuStarted);
        normalization[mode].push({ totalMs: performance.now() - started, cpuMicros: cpu.user + cpu.system,
          vectors: 2000, temporaryNumberArrays: mode === 'after' ? 0 : 2000, ...process.memoryUsage() });
      }
      const report = makeReport('embedding-batch', { chunks: 400, uniqueInputs: new Set(hashes).size,
        duplicateRate: 1 - new Set(hashes).size / hashes.length, dimensions: 384, corpusSha256: hash(JSON.stringify(chunks)) },
      ['src/main/plugins/research/embedding-service.ts', 'src/main/plugins/research/knowledge-repository.ts',
        'src/main/plugins/research/embedding-vectors.ts', 'tests/fixtures/performance/legacy-embedding-vectors.ts',
        'tests/fixtures/performance/legacy-knowledge-repository.ts',
        'tests/unit/embedding-batch.test.mjs']);
      report.scenarios = Object.entries(samples).map(([id, values]) => ({ id, samples: values, summary: summarizeRows(values) }));
      report.scenarios.push(...Object.entries(normalization).map(([id, values]) => ({ id: `normalization-${id}`, samples: values, summary: summarizeRows(values) })));
      report.limitations.push('Generated isolated production document; its duplication rate is not a user-corpus estimate.',
        'Repository before/after samples share the byte-equivalent current normalizer; separate normalization samples use the frozen pre-change function.',
        'Temporary number-array counts follow the frozen/current functions; native allocation events are not available.',
        'Paired process memory snapshots include the shared database and test runtime; they are not exclusive footprint or a per-operation allocation peak.',
        'No shared-vector table is introduced: the existing cache is already content-addressed and schema migration benefit is unproven.');
      saveReport(process.env.ROC_PERF_EMBEDDING_REPORT, report);
    }
  } finally { db.close(); }
});
