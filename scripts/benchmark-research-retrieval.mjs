import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, mkdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {cpus, totalmem, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import Database from 'better-sqlite3';
import {load} from 'sqlite-vec';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';

const protocolPath = resolve('docs/research-performance-protocol.json');
const protocolBytes = readFileSync(protocolPath);
const protocol = JSON.parse(protocolBytes);
const recipe = protocol.retrieval;
const worker = process.argv[2] === '--worker';
const size = worker ? Number(process.argv[3]) : null;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const metrics = values => ({samples: values.length, p50: percentile(values, .5), p95: percentile(values, .95)});
const now = () => '2026-11-06T00:00:00.000Z';

async function measureScale(chunkCount) {
  assert.ok(recipe.scales.includes(chunkCount));
  const [{ResearchKnowledgeRepository}, {applyResearchDatabaseSchema}, {configureRocDatabaseConnection}] = await Promise.all([
    importTypeScriptModule('src/main/plugins/research/knowledge-repository.ts', {platform: 'node'}),
    importTypeScriptModule('src/main/infrastructure/database-schemas.ts', {platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime')}),
    importTypeScriptModule('src/main/infrastructure/database-pragmas.ts', {platform: 'node'})
  ]);
  const root = mkdtempSync(join(tmpdir(), 'roc-retrieval-scale-'));
  const path = join(root, 'research.sqlite');
  let db;
  const open = () => {
    const connection = new Database(path);
    configureRocDatabaseConnection(connection, {databaseName: 'plugin:@roc/plugin-research', busyTimeoutMs: 5000, synchronous: 'NORMAL'});
    connection.pragma(`cache_size = -${recipe.sqliteCacheKiB}`);
    load(connection);
    return connection;
  };
  const repository = connection => new ResearchKnowledgeRepository(connection, id => {
    assert.ok(connection.prepare('SELECT id FROM research_projects WHERE id=?').get(id));
  }, now);
  try {
    db = open(); applyResearchDatabaseSchema(db, now);
    const projectInsert = db.prepare(`INSERT INTO research_projects
      (id,title,description,status,current_stage,created_at,updated_at) VALUES (?,?,'Isolated generated benchmark','active','reading',?,?)`);
    for (let index = 0; index < recipe.projectCount; index++) projectInsert.run(`project-${index}`, `Generated project ${index}`, now(), now());
    const repo = repository(db);
    repo.saveEmbeddingConfig({id: 'bench', name: 'Generated vectors', baseUrl: 'https://fixture.invalid', model: 'generated-384',
      dimensions: recipe.dimensions, apiKey: 'not-a-provider-credential', enabled: true}, 'unused-benchmark-secret');
    let randomState = recipe.seed;
    const vector = () => {
      const values = new Float32Array(recipe.dimensions);
      for (let index = 0; index < values.length; index++) {
        randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
        values[index] = (randomState >>> 0) / 0xffffffff - .5;
      }
      return Buffer.from(values.buffer);
    };
    const inputDigest = createHash('sha256');
    const seedStart = performance.now();
    for (let first = 0; first < chunkCount; first += recipe.chunksPerDocument) {
      const documentId = `document-${first}`;
      const chunks = Array.from({length: Math.min(recipe.chunksPerDocument, chunkCount - first)}, (_, offset) => {
        const index = first + offset;
        return {content: `topic${index % 128} evidence ${index} 机器学习 复现实验 ${'controlled observation and reproducibility '.repeat(12)}`, locator: `block:${offset}`};
      });
      repo.upsertFromSource({id: documentId, projectId: `project-${Math.floor(first / recipe.chunksPerDocument) % recipe.projectCount}`,
        sourceType: 'file', sourceId: `${documentId}.md`, title: `Generated topic${first % 128} study`,
        content: chunks.map(chunk => chunk.content).join('\n'), chunks, embeddingPolicy: 'none'});
      const vectors = chunks.map(() => vector());
      for (const [index, chunk] of chunks.entries()) inputDigest.update(chunk.content).update(vectors[index]);
      repo.storeChunkEmbeddings({configId: 'bench', configRevision: 1, chunks: repo.knowledgeChunks(documentId), vectors});
      if (first % 100000 === 0) console.error(`Seeding isolated retrieval data: ${first}/${chunkCount}`);
    }
    const seedMs = performance.now() - seedStart;
    assert.equal(db.prepare('SELECT count(*) FROM research_knowledge_chunks').pluck().get(), chunkCount);
    assert.equal(db.prepare('SELECT count(*) FROM research_knowledge_embeddings').pluck().get(), chunkCount);
    assert.equal(db.pragma('integrity_check', {simple: true}), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const databaseBytes = statSync(path).size;
    const queryBlob = vector();
    const rows = [];
    for (const projectId of [null, 'project-0']) {
      const vectorCandidates = db.prepare(`SELECT count(*) FROM research_knowledge_embeddings e
        JOIN research_knowledge_chunks c ON c.id=e.chunk_id WHERE e.space_key='embedding:bench:1'
        AND (? IS NULL OR c.project_id=? OR c.project_id IS NULL)`).pluck().get(projectId, projectId);
      for (const query of recipe.queries) {
        const match = query.split(/\s+/u).map(term => `"${term.replace(/"/gu, '')}"`).join(' OR ');
        const keywordCandidates = db.prepare(`SELECT count(*) FROM (
          SELECT c.id FROM research_knowledge_chunks_fts
          JOIN research_knowledge_chunks c ON c.rowid=research_knowledge_chunks_fts.rowid
          JOIN research_knowledge_documents d ON d.id=c.document_id
          WHERE research_knowledge_chunks_fts MATCH ?
            AND (? IS NULL OR c.project_id=? OR c.project_id IS NULL)
            AND (? IS NULL OR d.project_id=? OR d.project_id IS NULL)
          UNION
          SELECT c.id FROM research_knowledge_documents_fts
          JOIN research_knowledge_documents d ON d.rowid=research_knowledge_documents_fts.rowid
          JOIN research_knowledge_chunks c ON c.document_id=d.id
          WHERE research_knowledge_documents_fts MATCH ?
            AND (? IS NULL OR c.project_id=? OR c.project_id IS NULL)
            AND (? IS NULL OR d.project_id=? OR d.project_id IS NULL)
        )`).pluck().get(match, projectId, projectId, projectId, projectId, `title : (${match})`, projectId, projectId, projectId, projectId);
        for (const cache of ['connection-cold', 'repeated-connection']) {
          const samples = [];
          let searchRepo = repository(db);
          const installMeasurement = current => {
            const originalKeyword = current.keywordSearch.bind(current), originalVector = current.vectorSearch.bind(current);
            const stage = {};
            let keywordIds = [];
            current.keywordSearch = (...args) => {
              const start = performance.now(), result = originalKeyword(...args);
              stage.ftsMs = performance.now() - start; keywordIds = result.map(hit => hit.chunkId); return result;
            };
            current.vectorSearch = (...args) => {
              const start = performance.now(), result = originalVector(...args);
              stage.vectorMs = performance.now() - start;
              stage.fusionCandidates = new Set([...keywordIds, ...result.map(hit => hit.chunkId)]).size;
              return result;
            };
            return stage;
          };
          let stage = installMeasurement(searchRepo);
          if (cache === 'repeated-connection') searchRepo.searchKnowledge({request: {query, projectId, limit: recipe.limit, embeddingConfigId: 'bench'}, vector: {configId: 'bench', configRevision: 1, blob: queryBlob}});
          for (let iteration = 0; iteration < recipe.samples; iteration++) {
            if (cache === 'connection-cold') {
              db.close(); db = open(); searchRepo = repository(db); stage = installMeasurement(searchRepo);
            }
            const start = performance.now();
            const result = searchRepo.searchKnowledge({request: {query, projectId, limit: recipe.limit, embeddingConfigId: 'bench'},
              vector: {configId: 'bench', configRevision: 1, blob: queryBlob}});
            const totalMs = performance.now() - start;
            assert.equal(result.hits.length, recipe.limit);
            assert.equal(result.vectorCount, recipe.limit);
            assert.ok(result.keywordCount <= recipe.limit);
            assert.equal(new Set(result.hits.map(hit => hit.chunkId)).size, result.hits.length);
            assert.ok(result.hits.every((hit, index) => index === 0 || hit.rrfScore <= result.hits[index - 1].rrfScore));
            if (projectId !== null) for (const hit of result.hits) assert.equal(db.prepare('SELECT project_id FROM research_knowledge_chunks WHERE id=?').pluck().get(hit.chunkId), projectId);
            samples.push({...stage, totalMs, fusionAndConfigMs: totalMs - stage.ftsMs - stage.vectorMs,
              keywordReturned: result.keywordCount, vectorReturned: result.vectorCount, rssBytes: process.memoryUsage().rss});
          }
          const summary = Object.fromEntries(['ftsMs', 'vectorMs', 'fusionAndConfigMs', 'totalMs', 'rssBytes'].map(key => [key, metrics(samples.map(sample => sample[key]))]));
          const goals = recipe.p95TargetsMs;
          rows.push({projectId, query, cache, keywordCandidates, vectorCandidates, summary, targetExceeded:
            ['ftsMs', 'vectorMs', 'totalMs'].filter(key => summary[key].p95 > goals[key]), samples});
          console.error(`Measured ${chunkCount} chunks / ${projectId ?? 'all projects'} / ${query} / ${cache}: P95=${summary.totalMs.p95.toFixed(1)}ms`);
        }
      }
    }
    return {chunkCount, seedMs, sourceSha256: inputDigest.digest('hex'), databaseBytes, peakRssBytes: process.resourceUsage().maxRSS * 1024,
      sqliteVersion: db.prepare('SELECT sqlite_version()').pluck().get(), pragmas: {cacheKiB: recipe.sqliteCacheKiB, journalMode: db.pragma('journal_mode', {simple: true}), synchronous: db.pragma('synchronous', {simple: true})}, rows};
  } finally {
    db?.close(); rmSync(root, {recursive: true, force: true});
  }
}

if (worker) {
  console.log(JSON.stringify(await measureScale(size)));
} else {
  const outputPath = resolve(process.argv[2] ?? '.artifacts/research-optimization/retrieval-performance.json');
  assert.equal(process.argv.length <= 3, true);
  const report = {schemaVersion: 1, measuredAt: new Date().toISOString(), protocolSha256: sha256(protocolBytes),
    baselineSha: spawnSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).stdout.trim(),
    hardware: {cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem(), platform: process.platform, arch: process.arch, node: process.version},
    cacheMeaning: 'Connection-cold resets SQLite page cache only. OS/filesystem cache is not flushed. Repeated connection does not guarantee the dataset fits cache.',
    vectorMeaning: 'Generated 384-dimensional vectors measure exact SQLite cosine scan throughput; they are not a semantic quality evaluation.',
    recipe, scales: []};
  mkdirSync(dirname(outputPath), {recursive: true});
  for (const chunkCount of recipe.scales) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', String(chunkCount)], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit']});
    if (result.status !== 0) throw new Error(`retrieval_benchmark_failed:${chunkCount}:${result.status}`);
    report.scales.push(JSON.parse(result.stdout));
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({outputPath, scales: report.scales.map(scale => ({chunks: scale.chunkCount, bytes: scale.databaseBytes, peakRssBytes: scale.peakRssBytes, targetExceeded: scale.rows.filter(row => row.targetExceeded.length !== 0).map(({query, projectId, cache, targetExceeded}) => ({query, projectId, cache, targetExceeded}))}))}, null, 2));
}
