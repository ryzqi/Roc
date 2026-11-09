import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { load } from 'sqlite-vec';
import { resolve } from 'node:path';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { ResearchKnowledgeRepository } = await importTypeScriptModule('src/main/plugins/research/knowledge-repository.ts', { platform: 'node', tempDir: resolve('.runtime') });

test('Chinese phrase retrieval finds unsegmented text, short terms, mixed queries and title hits',async()=>{
  const {applyResearchDatabaseSchema}=await importTypeScriptModule('src/main/infrastructure/database-schemas.ts',{platform:'node',external:['better-sqlite3'],tempDir:resolve('.runtime')});
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  try {
    applyResearchDatabaseSchema(db);
    const repo=new ResearchKnowledgeRepository(db,()=>{},()=> '2026-11-08');
    const source={id:'zh',projectId:null,sourceType:'file',sourceId:'fixture',title:'注意力机制与长序列',content:'注意力机制能够处理长序列依赖。',
      chunks:[{content:'注意力机制能够处理长序列依赖。',locator:'p1'}],embeddingPolicy:'none'};
    repo.upsertFromSource(source);
    applyResearchDatabaseSchema(db);
    for(const query of ['注意力机制','长序列','依赖','注意力 Transformer']) {
      assert.equal(repo.searchKnowledge({request:{query,projectId:null,limit:10},vector:null}).hits[0]?.documentId,'zh',query);
    }
    repo.upsertFromSource({...source,content:'new body',chunks:[{content:'new body',locator:'p2'}]});
    assert.equal(repo.searchKnowledge({request:{query:'长序列',projectId:null,limit:10},vector:null}).hits[0]?.locator,'p2');
    assert.equal(repo.searchKnowledge({request:{query:'依赖',projectId:null,limit:10},vector:null}).hits.length,0);
    db.prepare("DELETE FROM research_knowledge_documents WHERE id='zh'").run();
    assert.equal(repo.searchKnowledge({request:{query:'长序列',projectId:null,limit:10},vector:null}).hits.length,0);
  } finally {db.close();}
});

test('fusion recalls beyond the display limit and records optional lexical reranking inputs',async()=>{
  const {applyResearchDatabaseSchema}=await importTypeScriptModule('src/main/infrastructure/database-schemas.ts',{
    platform:'node',external:['better-sqlite3'],tempDir:resolve('.runtime')});
  const db=new Database(':memory:');
  try {
    load(db);applyResearchDatabaseSchema(db);
    const repo=new ResearchKnowledgeRepository(db,()=>{},()=> '2026-11-08');
    repo.saveEmbeddingConfig({id:'test',name:'test',baseUrl:'https://fixture.invalid',model:'test',dimensions:2,enabled:true},'fixture');
    for (const [id,content,vector] of [['a','alpha',[0,1]],['b','alpha beta',[1,0]],['c','unrelated',[1,0.001]]]) {
      repo.upsertFromSource({id,projectId:null,sourceType:'file',sourceId:id,title:id,content,chunks:[{content,locator:null}],embeddingPolicy:'none'});
      repo.storeChunkEmbeddings({configId:'test',configRevision:1,chunks:repo.knowledgeChunks(id),vectors:[Buffer.from(new Float32Array(vector).buffer)]});
    }
    const result=repo.searchKnowledge({request:{query:'alpha beta',projectId:null,limit:1,rerank:'lexical-v1'},
      vector:{configId:'test',configRevision:1,blob:Buffer.from(new Float32Array([1,0]).buffer)}});
    assert.equal(result.hits[0].documentId,'b');
    assert.ok(result.ranking.candidates.length>result.hits.length);
    assert.equal(result.ranking.candidateLimit,50);
    assert.equal(result.ranking.rerank,'lexical-v1');
    assert.equal(result.ranking.candidates[0].rerankScore,1);
    repo.assertSearchCurrent(result);
    const changed=structuredClone(result);changed.ranking.candidateLimit=100;
    assert.throws(()=>repo.assertSearchCurrent(changed),/ranking_changed/);
  }finally{db.close();}
});

test('keyword ranking retains content priority, deduplication, ordered chunks and both project boundaries', async () => {
  const {applyResearchDatabaseSchema} = await importTypeScriptModule('src/main/infrastructure/database-schemas.ts', {
    platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime')
  });
  const db = new Database(':memory:'), now = () => '2026-11-06T00:00:00.000Z';
  try {
    applyResearchDatabaseSchema(db, now);
    for (const project of ['a', 'b']) db.prepare(`INSERT INTO research_projects
      (id,title,description,status,current_stage,created_at,updated_at) VALUES (?,?,'','active','reading',?,?)`)
      .run(project, project, now(), now());
    const repo = new ResearchKnowledgeRepository(db, () => {}, now);
    for (const [id, projectId, title, content] of [
      ['a-body', 'a', 'needle title', 'needle proof'],
      ['b-title', 'a', 'needle title', 'unrelated proof'],
      ['c-foreign', 'b', 'other title', 'needle proof'],
      ['g-global', null, 'other title', 'needle proof'],
      ['x-parent', 'b', 'other title', 'needle proof']
    ]) repo.upsertFromSource({id, projectId, title, sourceType: 'file', sourceId: `${id}.md`,
      content: `${content}\n${content}`, chunks: [0, 1].map(index => ({content, locator: `block:${index}`})), embeddingPolicy: 'none'});
    // A chunk in scope must not admit a document from another project.
    db.prepare("UPDATE research_knowledge_chunks SET project_id='a' WHERE document_id='x-parent'").run();
    const search = (projectId, limit = 20) => repo.searchKnowledge({request: {query: 'needle', projectId, limit}, vector: null});
    const scoped = search('a');
    assert.deepEqual(scoped.hits.map(hit => [hit.documentId, hit.locator]), [
      ['a-body', 'block:0'], ['a-body', 'block:1'], ['g-global', 'block:0'], ['g-global', 'block:1'],
      ['b-title', 'block:0'], ['b-title', 'block:1']
    ]);
    assert.equal(new Set(scoped.hits.map(hit => hit.chunkId)).size, 6);
    assert.deepEqual(search('a', 2).hits.map(hit => hit.chunkId), scoped.hits.slice(0, 2).map(hit => hit.chunkId));
    assert.ok(scoped.hits.every(hit => hit.content === (hit.documentId === 'b-title' ? 'unrelated proof' : 'needle proof')));
    assert.deepEqual(search('missing').hits.map(hit => hit.documentId), ['g-global', 'g-global']);
    assert.equal(search(null).hits.length, 10);
    assert.equal(repo.searchKnowledge({request: {query: '  ', projectId: 'a', limit: 20}, vector: null}).hits.length, 0);
    assert.deepEqual(scoped.ranking.coverage, {keyword: 'results', vector: 'not_searched'});
    assert.equal(scoped.ranking.ranker, 'rrf-v1-k60');
    assert.deepEqual(scoped.ranking.candidates.map(candidate => candidate.chunkId), scoped.hits.map(hit => hit.chunkId));
    assert.equal(scoped.ranking.candidates[0].score, 1 / 61);
    assert.equal(scoped.ranking.candidates[0].outputRank, 1);
    assert.equal(scoped.ranking.inputHash, search('a').ranking.inputHash);
    assert.notEqual(scoped.ranking.inputHash, search('a', 2).ranking.inputHash);
    repo.assertSearchCurrent(scoped);
    const changedReceipt = structuredClone(scoped);
    changedReceipt.ranking.candidates[0].score = 0;
    assert.throws(() => repo.assertSearchCurrent(changedReceipt), /research_knowledge_ranking_changed/);
    db.prepare("UPDATE research_knowledge_chunks SET locator='block:changed' WHERE id='a-body:chunk:0'").run();
    assert.throws(() => repo.assertSearchCurrent(scoped), /research_knowledge_source_changed/);
    const refreshed = search('a');
    assert.notEqual(refreshed.ranking.inputHash, scoped.ranking.inputHash);
    repo.assertSearchCurrent(refreshed);
    db.prepare("UPDATE research_knowledge_chunks SET content_hash=? WHERE id='a-body:chunk:0'").run('0'.repeat(64));
    assert.throws(() => search('a'), /research_knowledge_source_corrupt/);
  } finally {db.close();}
});

// Compare against the original exact search, including real sqlite-vec distances.
// Text size deliberately resembles extracted chunks rather than tiny fixture strings.
test('vector ranking hydrates only top hits and preserves exact project/global results', () => {
  const db = new Database(':memory:');
  try {
    load(db);
    db.exec(`CREATE TABLE research_knowledge_chunk_structure(chunk_id TEXT, parent_chunk_id TEXT);
      CREATE TABLE research_knowledge_embeddings(chunk_id TEXT, space_key TEXT, dimensions INTEGER, vector_blob BLOB);
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

test('current schema preserves parent chunks and contextual inputs for short and long sources',async()=>{
  const {applyResearchDatabaseSchema}=await importTypeScriptModule('src/main/infrastructure/database-schemas.ts',{platform:'node',external:['better-sqlite3'],tempDir:resolve('.runtime')});
  const db=new Database(':memory:'); db.pragma('foreign_keys=ON');
  try {
    applyResearchDatabaseSchema(db);
    const repo=new ResearchKnowledgeRepository(db,()=>{},()=> '2026-11-08');
    for (const [id,content] of [['long','限定条件与原始证据。'.repeat(200)],['short','short evidence']]) {
      repo.upsertFromSource({id,projectId:null,sourceType:'file',sourceId:id,title:id,content,chunks:[{content,locator:'page:1'}],embeddingPolicy:'none'});
    }
    const original=db.prepare('SELECT * FROM research_knowledge_chunks ORDER BY id').all();
    applyResearchDatabaseSchema(db);
    for(const row of original) assert.deepEqual(db.prepare('SELECT * FROM research_knowledge_chunks WHERE id=?').get(row.id),row);
    assert.ok(repo.knowledgeChunks('long').length>1);
    assert.equal(repo.knowledgeChunks('short')[0].embeddingInput,'Document: short\nText:\nshort evidence');
    assert.equal(db.prepare('SELECT count(*) FROM research_knowledge_embeddings').pluck().get(),0);
    const before=db.prepare('SELECT total_changes()').pluck().get();applyResearchDatabaseSchema(db);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);
  }finally{db.close();}
});
