import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let generations, builder, quality, schema, api;
before(async () => {
  [generations, builder, quality, schema] = await Promise.all([
    importTypeScriptModule('src/main/plugins/research/scientific-index-repository.ts', {platform: 'node'}),
    importTypeScriptModule('src/main/plugins/research/paper-ir-builder.ts', {platform: 'node'}),
    importTypeScriptModule('src/main/plugins/research/pdf-quality-assessor.ts', {platform: 'node'}),
    importTypeScriptModule('src/main/infrastructure/database-schemas.ts',
      {platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/tmp')})
  ]);
  api = await loadResearchTestApi();
});
after(() => api?.dispose());
const embedding = {configId: 'embedding', revision: 1, model: 'original-model', dimensions: 3};
function paper(parseId = 'parse-one', text = 'Original method 🧪. Original result.') {
  const blocks = [
    {id:'heading',kind:'heading',text:'2 Method',label:'heading',locator:'page 1 heading',
      imagePath:null,locations:[{page:1,bbox:[10,10,300,30],coordinateOrigin:'TOPLEFT'}]},
    {id:'body',kind:'paragraph',text,label:'paragraph',locator:'page 1 body',
      imagePath:null,locations:[{page:1,bbox:[10,40,300,80],coordinateOrigin:'TOPLEFT'}]}
  ];
  const content = {sourceHash:'a'.repeat(64),parserFingerprint:'b'.repeat(64),blocks,
    quality:quality.assessPdfQuality({pages:[{page:1,regions:[],coordinateFrame:{
      kind:'image',page:1,width:400,height:400,unit:'raster-pixel',coordinateOrigin:'TOPLEFT'}}],blocks})};
  return builder.buildPaperIR({identity:{paperId:'paper',documentId:'document',parseId,
    knowledgeDocumentId:`document:${parseId}`,sourceHash:content.sourceHash,parserFingerprint:content.parserFingerprint},content});
}
function open(path = ':memory:') {
  const db = new Database(path);
  db.pragma('foreign_keys=ON'); schema.applyResearchDatabaseSchema(db);
  return {db, store:new generations.ScientificIndexRepository(db, () => '2026-11-16T00:00:00.000Z')};
}
function begin(store, ir = paper(), configuration = embedding, projectId = null) {
  return store.begin({ir,projectId,embedding:configuration,source:projectId === null
    ? {kind:'library'} : {kind:'project',fileId:'file',artifactId:ir.identity.parseId}});
}
function complete(store, generation, configuration = generation.snapshot.embedding) {
  if (configuration) store.writeEmbeddings(generation.id, configuration,
    store.chunks(generation.id,generation.snapshot.projectId).filter(c=>c.retrieval).map(c=>({chunkId:c.id,vector:[3,4,0]})));
  return store.publish(generation.id,()=>({paperIR:generation.snapshot.paperIR,embedding:configuration}));
}
function activeFts(db, projectId = null) {
  return db.prepare(`SELECT f.chunk_id,f.content,g.id AS generation_id FROM research_scientific_fts f
    JOIN research_scientific_index_generations g ON g.id=f.generation_id
    WHERE research_scientific_fts MATCH 'Original' AND g.status='active' AND g.project_id IS ?
    ORDER BY f.chunk_id`).all(projectId);
}
test('building FTS/vectors stay isolated; atomic publication retires only the previous active generation', () => {
  const {db,store}=open();
  try {
    const a=complete(store,begin(store)), original=store.chunks(a.id,null), oldVectors=store.embeddings(a.id,null);
    const oldHits=activeFts(db), b=begin(store,paper('parse-two','Original changed method.'));
    assert.ok(oldHits.length>0); assert.deepEqual(activeFts(db),oldHits);
    assert.equal(store.active(null,'document').id,a.id);
    assert.throws(()=>store.publish(b.id,()=>({paperIR:b.snapshot.paperIR,embedding})),/embeddings_incomplete/);
    assert.deepEqual(activeFts(db),oldHits);
    store.fail(b.id,'provider_failed');
    assert.equal(store.get(b.id).status,'failed');
    const c=complete(store,begin(store,paper('parse-three','Original new result.')));
    assert.equal(store.active(null,'document').id,c.id); assert.equal(store.get(a.id).status,'retired');
    assert.ok(activeFts(db).every(hit=>hit.generation_id===c.id));
    assert.deepEqual(store.chunks(a.id,null),original); assert.deepEqual(store.embeddings(a.id,null),oldVectors);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  } finally {db.close();}
});
test('same IR chunks can have different model/revision generations without vector or FTS collisions', () => {
  const {db,store}=open();
  try {
    const a=complete(store,begin(store)), revised={...embedding,revision:2,model:'revised-model'};
    const b=complete(store,begin(store,paper(),revised));
    assert.deepEqual(store.chunks(a.id,null).map(c=>c.id),store.chunks(b.id,null).map(c=>c.id));
    assert.equal(db.prepare('SELECT count(DISTINCT generation_id) FROM research_scientific_embeddings').pluck().get(),2);
    assert.equal(store.get(a.id).snapshot.embedding.revision,1);
    assert.equal(store.get(b.id).snapshot.embedding.revision,2);
    assert.ok(activeFts(db).every(hit=>hit.generation_id===b.id));
  } finally {db.close();}
});
test('source/config revalidation and a failed consumer transaction preserve old active and consumer data', () => {
  const {db,store}=open();
  try {
    const a=complete(store,begin(store)), b=begin(store,paper('parse-two'));
    store.writeEmbeddings(b.id,embedding,store.chunks(b.id,null).filter(c=>c.retrieval).map(c=>({chunkId:c.id,vector:[1,1,1]})));
    const oldHits=activeFts(db);
    for(const field of ['sourceHash','parseHash','parseId','parserFingerprint']) {
      const receipt=structuredClone(b.snapshot.paperIR); receipt.identity[field]=field==='parseId'?'stale':'c'.repeat(64);
      assert.throws(()=>store.publish(b.id,()=>({paperIR:receipt,embedding})),/source_changed/);
    }
    for(const changed of [null,{...embedding,revision:2},{...embedding,model:'changed'},{...embedding,dimensions:4}]) {
      assert.throws(()=>store.publish(b.id,()=>({paperIR:b.snapshot.paperIR,embedding:changed})),/embedding_changed/);
    }
    assert.throws(()=>store.publish(b.id,()=>({paperIR:b.snapshot.paperIR,embedding}),()=>{
      db.prepare("UPDATE research_scientific_index_generations SET error='should_rollback' WHERE id=?").run(a.id);
      throw new Error('consumer_failed');
    }),/consumer_failed/);
    assert.throws(()=>store.publish(b.id,()=>({paperIR:b.snapshot.paperIR,embedding}),()=>Promise.resolve()),
      /must_be_synchronous/);
    assert.equal(store.active(null,'document').id,a.id); assert.equal(store.get(a.id).status,'active');
    assert.equal(store.get(a.id).error,null); assert.equal(store.get(b.id).status,'building');
    assert.deepEqual(activeFts(db),oldHits);
  } finally {db.close();}
});
test('invalid vectors, duplicate/nonretrieval/foreign chunks and configuration mismatch roll back a whole batch', () => {
  const {db,store}=open();
  try {
    const b=begin(store), chunks=store.chunks(b.id,null).filter(c=>c.retrieval);
    for(const field of ['embedding_config_id','embedding_config_revision','embedding_model','dimensions']) {
      assert.throws(()=>db.prepare(`UPDATE research_scientific_index_generations SET ${field}=NULL WHERE id=?`).run(b.id),
        /CHECK constraint failed/);
    }
    const value=vector=>({chunkId:chunks[0].id,vector});
    for(const vector of [[0,0,0],[NaN,1,1],[Infinity,1,1],[1,2]]) {
      assert.throws(()=>store.writeEmbeddings(b.id,embedding,[value(vector)]),/vector_invalid|dimensions_invalid/);
    }
    assert.throws(()=>store.writeEmbeddings(b.id,{...embedding,revision:2},[value([1,1,1])]),/embedding_changed/);
    for(const bad of [
      [value([1,1,1]),value([1,1,1])],
      [value([1,1,1]),{chunkId:'foreign',vector:[1,1,1]}]
    ]) assert.throws(()=>store.writeEmbeddings(b.id,embedding,bad),/chunk_invalid/);
    assert.equal(db.prepare('SELECT count(*) FROM research_scientific_embeddings').pluck().get(),0);
    assert.throws(()=>store.publish(b.id,()=>({paperIR:b.snapshot.paperIR,embedding})),/incomplete/);
    complete(store,b);
    assert.throws(()=>store.writeEmbeddings(b.id,embedding,[]),/not_building/);
  } finally {db.close();}
});
test('new attempts supersede unfinished work only; text-only generation has no implied vectors', () => {
  const {db,store}=open();
  try {
    const a=complete(store,begin(store)), b=begin(store,paper('parse-two'));
    const c=begin(store,paper('parse-three'),null);
    assert.equal(store.get(b.id).status,'cancelled'); assert.equal(store.active(null,'document').id,a.id);
    assert.throws(()=>store.publish(b.id,()=>({paperIR:b.snapshot.paperIR,embedding})),/not_building/);
    complete(store,c); assert.deepEqual(store.embeddings(c.id,null),[]);
    assert.equal(store.get(a.id).status,'retired'); store.fail(a.id,'do_not_change_active_history');
    assert.equal(store.get(a.id).error,null);
  } finally {db.close();}
});
test('publication rejects corrupted chunks, relations, FTS, manifest and vector receipts', () => {
  const mutations=[
    [db=>db.exec("UPDATE research_scientific_chunks SET content='invented' WHERE generation_id IN (SELECT id FROM research_scientific_index_generations WHERE status='building')"),/chunks_changed/],
    [db=>db.exec("DELETE FROM research_scientific_chunk_relations WHERE generation_id IN (SELECT id FROM research_scientific_index_generations WHERE status='building')"),/relations_changed/],
    [db=>db.exec("DELETE FROM research_scientific_fts WHERE generation_id IN (SELECT id FROM research_scientific_index_generations WHERE status='building')"),/fts_invalid/],
    [db=>db.exec("INSERT INTO research_scientific_fts SELECT * FROM research_scientific_fts WHERE generation_id IN (SELECT id FROM research_scientific_index_generations WHERE status='building')"),/fts_invalid/],
    [db=>db.exec("UPDATE research_scientific_index_generations SET parse_hash='invalid' WHERE status='building'"),/snapshot_changed/],
    [db=>db.exec("UPDATE research_scientific_embeddings SET input_hash='invalid' WHERE generation_id IN (SELECT id FROM research_scientific_index_generations WHERE status='building')"),/embedding_changed/],
    [db=>db.exec("UPDATE research_scientific_embeddings SET embedding=zeroblob(dimensions*4) WHERE generation_id IN (SELECT id FROM research_scientific_index_generations WHERE status='building')"),/embedding_changed/]
  ];
  for(const [mutate,error] of mutations) {
    const {db,store}=open();
    try {
      const a=complete(store,begin(store)), b=begin(store,paper('parse-two'));
      store.writeEmbeddings(b.id,embedding,store.chunks(b.id,null).filter(c=>c.retrieval).map(c=>({chunkId:c.id,vector:[3,4,0]})));
      mutate(db);
      assert.throws(()=>store.publish(b.id,()=>({paperIR:b.snapshot.paperIR,embedding})),error);
      assert.equal(store.active(null,'document').id,a.id);
    } finally {db.close();}
  }
});
test('current source binding and project/library namespaces cannot alias; history pins all original project artifacts', async () => {
  const fixture=await createResearchFixture(api);
  try {
    const project=fixture.project, store=fixture.repository.scientificIndex;
    const a=complete(store,begin(store,paper(),null,project.id));
    const library=complete(store,begin(store,paper(),null));
    assert.equal(store.active(project.id,'document').id,a.id);
    assert.equal(store.active(null,'document').id,library.id);
    assert.throws(()=>store.chunks(a.id,null),/scope_invalid/);
    assert.throws(()=>store.embeddings(library.id,project.id),/scope_invalid/);
    const b=complete(store,begin(store,paper('parse-two'),null,project.id));
    assert.deepEqual(store.referencedArtifacts(),new Set(['parse-one','parse-two']));
    assert.deepEqual(fixture.repository.indexing.referencedArtifacts(),new Set(['parse-one','parse-two']));
    assert.equal(store.get(a.id).status,'retired'); assert.equal(store.get(b.id).status,'active');
    assert.throws(()=>store.begin({ir:paper(),projectId:null,source:{kind:'project',fileId:'file',artifactId:'parse-one'},embedding:null}),/scope_invalid/);
    assert.throws(()=>store.begin({ir:paper(),projectId:project.id,source:{kind:'project',fileId:'file',artifactId:'foreign'},embedding:null}),/scope_invalid/);
  } finally {await fixture.close();}
});
test('artifact GC pins legacy generation owners and fails closed on damaged or unknown metadata', async () => {
  const fixture=await createResearchFixture(api);
  try {
    const {db,repository,project}=fixture, store=repository.scientificIndex;
    const old=complete(store,begin(store,paper(),null,project.id));
    complete(store,begin(store,paper('parse-two'),null,project.id));
    const library=complete(store,begin(store,paper(),null));
    const save=(id,snapshot) => {
      const json=JSON.stringify(snapshot);
      db.prepare(`UPDATE research_scientific_index_generations
        SET paper_ir_version=?,snapshot_json=?,snapshot_hash=? WHERE id=?`)
        .run(snapshot.paperIR.version,json,createHash('sha256').update(json).digest('hex'),id);
    };
    for (const generation of [old,library]) {
      save(generation.id,{...generation.snapshot,paperIR:{...generation.snapshot.paperIR,version:'roc-paper-ir/2.1'}});
    }
    const retained=() => db.prepare('SELECT * FROM research_scientific_index_generations ORDER BY rowid').all();
    const original=retained();
    assert.deepEqual(repository.indexing.referencedArtifacts(),new Set(['parse-one','parse-two']));
    assert.deepEqual(retained(),original);
    assert.throws(()=>store.get(old.id),/roc-paper-ir\/2\.2/);
    assert.throws(()=>store.publish(old.id,()=>({paperIR:old.snapshot.paperIR,embedding:null})),/roc-paper-ir\/2\.2/);
    db.prepare('UPDATE research_scientific_index_generations SET snapshot_hash=? WHERE id=?')
      .run('f'.repeat(64),old.id);
    assert.throws(()=>repository.indexing.referencedArtifacts(),/snapshot_changed/);
    const legacy=JSON.parse(original.find(row=>row.id===old.id).snapshot_json);
    save(old.id,{...legacy,source:{...legacy.source,artifactId:'foreign-parse'}});
    assert.throws(()=>repository.indexing.referencedArtifacts(),/scope_invalid/);
    save(old.id,{...legacy,paperIR:{...legacy.paperIR,version:'roc-paper-ir/unknown'}});
    assert.throws(()=>repository.indexing.referencedArtifacts(),/roc-paper-ir/);
  } finally {await fixture.close();}
});
test('real SQLite close/reopen cancels interrupted work, retains partial data and returns original owners for rebuilding', () => {
  const directory=mkdtempSync(join(tmpdir(),'roc-scientific-restart-')), path=join(directory,'research.db');
  let db;
  try {
    ({db}=open(path)); let store=new generations.ScientificIndexRepository(db);
    const a=complete(store,begin(store)), b=begin(store,paper('parse-two'));
    const chunk=store.chunks(b.id,null).find(c=>c.retrieval);
    store.writeEmbeddings(b.id,embedding,[{chunkId:chunk.id,vector:[3,4,0]}]);
    db.close(); ({db}=open(path)); store=new generations.ScientificIndexRepository(db);
    const recovery=store.recover();
    assert.deepEqual(recovery.map(g=>g.id),[b.id]); assert.equal(recovery[0].snapshot.paperIR.identity.parseId,'parse-two');
    assert.equal(store.get(b.id).status,'cancelled'); assert.equal(store.get(b.id).error,'research_scientific_interrupted');
    assert.equal(store.active(null,'document').id,a.id);
    assert.equal(db.prepare('SELECT count(*) FROM research_scientific_embeddings WHERE generation_id=?').pluck().get(b.id),1);
    assert.deepEqual(store.recover(),[]);
    const c=complete(store,begin(store,paper('parse-two')));
    assert.equal(store.active(null,'document').id,c.id); assert.equal(store.get(a.id).status,'retired');
  } finally {db?.close(); rmSync(directory,{recursive:true,force:true});}
});
test('a concurrent WAL reader observes one old generation through the entire atomic switch', () => {
  const directory=mkdtempSync(join(tmpdir(),'roc-scientific-wal-')),path=join(directory,'research.db');
  let db,reader;
  try {
    ({db}=open(path)); db.pragma('journal_mode=WAL');
    const store=new generations.ScientificIndexRepository(db), a=complete(store,begin(store));
    reader=new Database(path); const reads=new generations.ScientificIndexRepository(reader);
    reader.exec('BEGIN'); assert.equal(reads.active(null,'document').id,a.id);
    const b=complete(store,begin(store,paper('parse-two')));
    assert.equal(reads.active(null,'document').id,a.id); assert.ok(activeFts(reader).every(hit=>hit.generation_id===a.id));
    assert.deepEqual(reads.embeddings(a.id,null),store.embeddings(a.id,null));
    reader.exec('COMMIT'); assert.equal(reads.active(null,'document').id,b.id);
    assert.ok(activeFts(reader).every(hit=>hit.generation_id===b.id));
  } finally {reader?.close();db?.close();rmSync(directory,{recursive:true,force:true});}
});
