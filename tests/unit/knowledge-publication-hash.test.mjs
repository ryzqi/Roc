import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const options = {platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/performance')};
const {ResearchKnowledgeRepository: Current} = await importTypeScriptModule('src/main/plugins/research/knowledge-repository.ts', options);
const {applyResearchDatabaseSchema} = await importTypeScriptModule('src/main/infrastructure/database-schemas.ts', options);
const frozen = await build({stdin: {contents: readFileSync('tests/fixtures/performance/legacy-knowledge-repository.ts', 'utf8'),
  resolveDir: resolve('src/main/plugins/research'), loader: 'ts'}, bundle: true, platform: 'node', format: 'esm',
  write: false, logLevel: 'silent'});
const {ResearchKnowledgeRepository: Legacy} = await import(`data:text/javascript;base64,${Buffer.from(frozen.outputFiles[0].text).toString('base64')}`);
const now = () => '2026-11-15T00:00:00.000Z';
const request = () => ({id: 'document', projectId: null, sourceType: 'note', sourceId: 'note',
  title: 'Unicode source 中文', content: 'Original full publication 中文 '.repeat(100),
  embeddingConfigId: null, chunks: Array.from({length: 100}, (_, index) => ({
    content: `Evidence 中文 ${index}`, locator: `block:${index}`, section: index % 2 ? 'Methods' : null
  }))});
function fixture(Repository) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); applyResearchDatabaseSchema(db, now);
  return {db, repository: new Repository(db, () => {}, now)};
}
function measured(f, input, metadata = {}) {
  const original = crypto.createHash;
  let calls = 0;
  crypto.createHash = (...args) => {
    const hash = original(...args), update = hash.update;
    hash.update = function(data, ...options) {
      if (data === input.content) calls++;
      return update.call(this, data, ...options);
    };
    return hash;
  };
  syncBuiltinESMExports();
  try { return {value: f.repository.upsertKnowledgeDocument(input, metadata), calls}; }
  finally { crypto.createHash = original; syncBuiltinESMExports(); }
}
function snapshot(db) {
  return ['research_knowledge_documents', 'research_knowledge_chunks', 'research_knowledge_chunk_structure',
    'research_knowledge_chunk_semantics'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
}

test('versioned scientific roles survive actual SQLite publication and semantic readback', async () => {
  const {indexDocumentBlocks} = await importTypeScriptModule('src/main/plugins/research/index-files.ts', options);
  const f = fixture(Current);
  try {
    const chunks = indexDocumentBlocks([{id: 'h', kind: 'heading', text: '3 Results', locator: 'PDF page 1'},
      {id: 'b', kind: 'paragraph', text: 'The dataset accuracy improves by 4%.', locator: 'PDF page 2'}],
    {paperId: 'paper', parseId: 'parse', sourceHash: 'a'.repeat(64)});
    f.repository.upsertFromSource({id: 'scientific', projectId: null, sourceType: 'file', sourceId: 'paper',
      title: 'Paper', content: chunks.map(c => c.content).join('\n\n'), chunks, embeddingPolicy: 'none'},
    {parseId: 'parse', sourceHash: 'a'.repeat(64)});
    const semantic = f.repository.chunkSemantic('scientific:chunk:1');
    assert.deepEqual(semantic, chunks[1].semantic);
    assert.deepEqual(semantic.scientific.roles.map(r => r.role), ['dataset', 'metric', 'result']);
    const restarted = new Current(f.db, () => {}, now);
    assert.deepEqual(restarted.chunkSemantic('scientific:chunk:1'), semantic);
    const hit = restarted.searchKnowledge({request: {projectId: null, query: 'dataset accuracy', limit: 5}, vector: null}).hits[0];
    assert.deepEqual(hit.semantic.scientific, semantic.scientific);
    assert.equal(hit.semantic.blockId, 'b');
  } finally {f.db.close();}
});

test('one publication hash replaces 101 identical full-body hashes with exact native persisted/output parity', () => {
  for (const metadata of [{}, {parseId: 'original-parse', sourceHash: 'a'.repeat(64)}]) {
    const current = fixture(Current), legacy = fixture(Legacy), input = request();
    try {
      const before = measured(legacy, input, metadata), after = measured(current, input, metadata);
      assert.deepEqual(after.value, before.value);
      assert.equal(before.calls, metadata.sourceHash ? 1 : 101);
      assert.equal(after.calls, 1);
      assert.deepEqual(snapshot(current.db), snapshot(legacy.db));
      input.content += ' New version';
      const next = measured(current, input, metadata);
      assert.equal(next.calls, 1);
      const stored = current.db.prepare('SELECT content_hash FROM research_knowledge_documents').get();
      assert.equal(stored.content_hash, crypto.createHash('sha256').update(input.content).digest('hex'));
      assert.equal(current.db.pragma('integrity_check', {simple: true}), 'ok');
      assert.deepEqual(current.db.pragma('foreign_key_check'), []);
    } finally { current.db.close(); legacy.db.close(); }
  }
});

test('metadata/semantic corruption and project errors retain error order and atomic rollback', () => {
  for (const mutate of [
    input => {input.chunks[50].semantic = {sourceHash: 'invalid'};},
    input => {input.projectId = 'missing-project';}
  ]) {
    const current = fixture(Current), legacy = fixture(Legacy), input = request();
    try {
      for (const f of [current, legacy]) f.repository.upsertKnowledgeDocument(input);
      const before = snapshot(current.db);
      mutate(input);
      function failure(f) {
        try { f.repository.upsertKnowledgeDocument(input); assert.fail('corruption must fail'); }
        catch (error) { return {name: error.name, message: error.message}; }
      }
      assert.deepEqual(failure(current), failure(legacy));
      assert.deepEqual(snapshot(current.db), before);
      assert.deepEqual(snapshot(current.db), snapshot(legacy.db));
      const circular = {}; circular.self = circular;
      const valid = request();
      const failures = [current, legacy].map(f => {
        try { measured(f, valid, circular); assert.fail('circular metadata must fail'); }
        catch (error) { return {name: error.name, message: error.message}; }
      });
      assert.deepEqual(failures[0], failures[1]);
      assert.deepEqual(snapshot(current.db), before);
    } finally { current.db.close(); legacy.db.close(); }
  }
});
