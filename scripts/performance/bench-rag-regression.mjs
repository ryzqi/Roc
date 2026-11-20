import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { load } from 'sqlite-vec';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';
import { makeReport, saveReport, sha256, summarizeRows } from './report-lib.mjs';

// Refine a flagged scene using interleaved old/new production implementations on
// the same generated database, rather than changing the comparison threshold.
const recipe = JSON.parse(readFileSync('docs/research-performance-protocol.json')).retrieval;
const count = 1_000_000, query = 'topic7 evidence';
const options = { platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/performance') };
const { ResearchKnowledgeRepository: Current } = await importTypeScriptModule('src/main/plugins/research/knowledge-repository.ts', options);
const { applyResearchDatabaseSchema } = await importTypeScriptModule('src/main/infrastructure/database-schemas.ts', options);
const { configureRocDatabaseConnection } = await importTypeScriptModule('src/main/infrastructure/database-pragmas.ts', options);
const frozen = await build({ stdin: { contents: readFileSync('tests/fixtures/performance/legacy-knowledge-repository.ts', 'utf8'),
  resolveDir: resolve('src/main/plugins/research'), loader: 'ts' }, bundle: true, platform: 'node',
  format: 'esm', target: 'node22', write: false, logLevel: 'silent' });
const { ResearchKnowledgeRepository: Legacy } = await import(`data:text/javascript;base64,${Buffer.from(frozen.outputFiles[0].text).toString('base64')}`);
const directory = mkdtempSync(join(tmpdir(), 'roc-rag-paired-'));
const db = new Database(join(directory, 'research.sqlite'));
const now = () => '2026-11-06T00:00:00.000Z';
try {
  configureRocDatabaseConnection(db, { databaseName: 'plugin:@roc/plugin-research', busyTimeoutMs: 5000, synchronous: 'NORMAL' });
  db.pragma(`cache_size=-${recipe.sqliteCacheKiB}`); load(db); applyResearchDatabaseSchema(db, now);
  const project = db.prepare(`INSERT INTO research_projects
    (id,title,description,status,current_stage,created_at,updated_at) VALUES (?,?,'Isolated generated benchmark','active','reading',?,?)`);
  for (let index = 0; index < recipe.projectCount; index++) project.run(`project-${index}`, `Generated project ${index}`, now(), now());
  const current = new Current(db, () => {}, now), legacy = new Legacy(db, () => {}, now);
  current.saveEmbeddingConfig({ id: 'bench', name: 'Generated vectors', baseUrl: 'https://fixture.invalid', model: 'generated-384',
    dimensions: recipe.dimensions, apiKey: 'not-a-provider-credential', enabled: true }, 'unused-benchmark-secret');
  let state = recipe.seed;
  const vector = () => {
    const values = new Float32Array(recipe.dimensions);
    for (let index = 0; index < values.length; index++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      values[index] = (state >>> 0) / 0xffffffff - .5;
    }
    return Buffer.from(values.buffer);
  };
  const digest = createHash('sha256');
  for (let first = 0; first < count; first += recipe.chunksPerDocument) {
    const id = `document-${first}`;
    const chunks = Array.from({ length: Math.min(recipe.chunksPerDocument, count - first) }, (_, offset) => ({
      content: `topic${(first + offset) % 128} evidence ${first + offset} 机器学习 复现实验 ${'controlled observation and reproducibility '.repeat(12)}`,
      locator: `block:${offset}`
    }));
    current.upsertFromSource({ id, projectId: `project-${Math.floor(first / recipe.chunksPerDocument) % recipe.projectCount}`,
      sourceType: 'file', sourceId: `${id}.md`, title: `Generated topic${first % 128} study`,
      content: chunks.map(chunk => chunk.content).join('\n'), chunks, embeddingPolicy: 'none' });
    const vectors = chunks.map(() => vector());
    chunks.forEach((chunk, index) => digest.update(chunk.content).update(vectors[index]));
    current.storeChunkEmbeddings({ configId: 'bench', configRevision: 1, chunks: current.knowledgeChunks(id), vectors });
    if (first % 100_000 === 0) console.error(`Paired RAG seeding ${first}/${count}`);
  }
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const input = { request: { query, projectId: null, limit: recipe.limit, embeddingConfigId: 'bench' },
    vector: { configId: 'bench', configRevision: 1, blob: vector() } };
  const samples = { before: [], after: [] };
  const measure = repository => {
    const stage = {}, originals = {};
    for (const [method, metric] of [['keywordSearch', 'ftsMs'], ['vectorSearch', 'vectorMs']]) {
      originals[method] = repository[method];
      repository[method] = (...args) => {
        const start = performance.now(), value = originals[method].apply(repository, args);
        stage[metric] = performance.now() - start; return value;
      };
    }
    try {
      const start = performance.now(), result = repository.searchKnowledge(input);
      return { result, sample: { ...stage, totalMs: performance.now() - start, rssBytes: process.memoryUsage().rss } };
    } finally { Object.assign(repository, originals); }
  };
  assert.deepEqual(legacy.searchKnowledge(input), current.searchKnowledge(input));
  for (let index = 0; index < recipe.samples; index++) {
    const pair = {};
    for (const mode of index % 2 ? ['after', 'before'] : ['before', 'after']) {
      pair[mode] = measure(mode === 'before' ? legacy : current);
      samples[mode].push(pair[mode].sample);
    }
    assert.deepEqual(pair.after.result, pair.before.result);
    console.error(`Paired RAG ${index + 1}/${recipe.samples}: ${pair.before.sample.totalMs.toFixed(1)} -> ${pair.after.sample.totalMs.toFixed(1)}ms`);
  }
  const report = makeReport('rag-paired-regression', { recipe, count, query, projectId: null, cache: 'repeated-connection',
    corpusSha256: digest.digest('hex') }, ['src/main/plugins/research/knowledge-repository.ts',
    'tests/fixtures/performance/legacy-knowledge-repository.ts', 'scripts/performance/bench-rag-regression.mjs']);
  report.beforeSourceSha256 = sha256(readFileSync('tests/fixtures/performance/legacy-knowledge-repository.ts'));
  report.scenarios = Object.entries(samples).map(([id, values]) => ({ id, samples: values, summary: summarizeRows(values) }));
  report.limitations.push('Interleaved 20-pair refinement of the flagged scene; exact output/receipt equality is asserted for every pair.',
    'Shared connection/OS page cache; independent process footprint and a cold cache are not measured here.');
  console.log(saveReport(process.argv[2] ?? '.artifacts/mac-performance/mac-rag-paired.json', report));
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
