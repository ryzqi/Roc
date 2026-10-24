import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { load } from 'sqlite-vec';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { ResearchKnowledgeRepository } = await importTypeScriptModule('src/main/plugins/research/knowledge-repository.ts', { platform: 'node' });

// Compare against the original exact search, including real sqlite-vec distances.
// Text size deliberately resembles extracted chunks rather than tiny fixture strings.
test('vector ranking hydrates only top hits and preserves exact project/global results', () => {
  const db = new Database(':memory:');
  try {
    load(db);
    db.exec(`CREATE TABLE research_knowledge_embeddings(chunk_id TEXT, space_key TEXT, dimensions INTEGER, vector_blob BLOB);
      CREATE TABLE research_knowledge_chunks(id TEXT PRIMARY KEY, document_id TEXT, project_id TEXT, content TEXT, locator TEXT);
      CREATE TABLE research_knowledge_documents(id TEXT PRIMARY KEY, title TEXT, source_type TEXT, source_id TEXT);`);
    const insertE = db.prepare('INSERT INTO research_knowledge_embeddings VALUES (?, ?, 32, ?)');
    const insertC = db.prepare('INSERT INTO research_knowledge_chunks VALUES (?, ?, ?, ?, ?)');
    const insertD = db.prepare("INSERT INTO research_knowledge_documents VALUES (?, ?, 'file', ?)");
    const query = Buffer.from(new Float32Array(Array.from({ length: 32 }, (_, i) => Math.sin(i + 1))).buffer);
    db.transaction(() => {
      for (let i = 0; i < 10000; i++) {
        const id = String(i);
        insertD.run(id, `doc-${id}`, id);
        insertC.run(id, id, i % 3 === 0 ? null : i % 3 === 1 ? 'a' : 'b', `${id}:` + 'chunk '.repeat(700), `line-${i}`);
        const blob = Buffer.from(new Float32Array(Array.from({ length: 32 }, (_, j) => Math.sin(i * 0.37 + j + 1))).buffer);
        insertE.run(id, i % 11 === 0 ? 'other' : 'space', blob);
      }
    })();
    const repo = new ResearchKnowledgeRepository(db, () => {}, () => 'now');
    for (const projectId of [null, 'a', 'missing']) {
      const clause = projectId === null ? '' : 'AND (c.project_id = ? OR c.project_id IS NULL)';
      const legacy = db.prepare(`SELECT e.chunk_id, c.document_id, d.title, c.content, c.locator, d.source_type, d.source_id
        FROM research_knowledge_embeddings e JOIN research_knowledge_chunks c ON c.id = e.chunk_id
        JOIN research_knowledge_documents d ON d.id = c.document_id
        WHERE e.space_key = ? AND e.dimensions = ? ${clause}
        ORDER BY vec_distance_cosine(e.vector_blob, ?) ASC LIMIT ?`);
      const args = projectId === null ? ['space', 32, query, 10] : ['space', 32, projectId, query, 10];
      const expected = legacy.all(...args);
      const search = () => repo.vectorSearch(projectId, 10, { spaceKey: 'space', dimensions: 32, blob: query });
      const hits = search();
      assert.deepEqual(hits.map(h => h.chunkId), expected.map(h => h.chunk_id));
      assert.deepEqual(hits.map(h => h.content), expected.map(h => h.content));
      assert.deepEqual(repo.vectorSearch(projectId, 10, { spaceKey: 'absent', dimensions: 32, blob: query }), []);
      // Report measurements without a timing assertion that would be flaky on shared runners.
      const sample = fn => { const times = []; for (let i = 0; i < 9; i++) { const start = performance.now(); fn(); times.push(performance.now() - start); } return times.sort((a, b) => a - b)[4].toFixed(2); };
      console.log(`10k vectors / project=${projectId}: original=${sample(() => legacy.all(...args))}ms, top-k hydration=${sample(search)}ms (median of 9)`);
    }
  } finally { db.close(); }
});
