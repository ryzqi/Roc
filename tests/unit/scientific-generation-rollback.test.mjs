import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture, hash} from './fixtures/scientific-search-fixture.mjs';
let api, Service, contract;
before(async()=>{
  [api,{ScientificGenerationService:Service},contract]=await Promise.all([
    loadScientificSearchApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-generation-service.ts',{platform:'node'}),
    importTypeScriptModule('src/shared/schemas/research-scientific-generations.ts')]);
});
after(()=>api?.dispose());
const scope=f=>({projectId:f.project.id,documentId:f.document.id,storageProjectId:null});
const activate=(f,target,current)=>({...scope(f),generationId:target.id,expectedActiveId:current.id});
const service=f=>new Service(f.repository,f.embeddings,f.router.snapshots);
function candidate(f,{publish=true,embedding=f.embeddings.selectedIdentity(null)}={}) {
  const store=f.repository.scientificIndex;
  const g=store.begin({ir:f.ir,paperIR:f.data.paperIR,projectId:null,source:{kind:'library'},embedding,policy:{tableTokens:512}});
  if(embedding) store.writeEmbeddings(g.id,embedding,store.chunks(g.id,null).filter(c=>c.retrieval).map(c=>({chunkId:c.id,vector:[1,0,0]})));
  return publish?store.publish(g.id,()=>({paperIR:f.data.paperIR,embedding})):g;
}
async function files(root) {
  const out={};
  for(const file of await readdir(root,{recursive:true,withFileTypes:true})) if(file.isFile()) {
    const path=join(file.parentPath,file.name);out[path]=hash(await readFile(path));
  }
  return out;
}
function durableData(db) {
  const result={};
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'research_scientific_index_generations' ORDER BY name").all()) {
    result[name]=db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all();
  }
  return result;
}

test('real source-bound rollback/forward switch keeps every other table and artifact, and survives reopen without parsing or provider calls',async()=>{
  const f=await scientificSearchFixture(api), s=service(f), store=f.repository.scientificIndex;
  try {
    const a=f.generation,b=candidate(f),pending=candidate(f,{publish:false}),data=durableData(f.db),originals=await files(f.root),calls=f.calls();
    const state=contract.scientificGenerationsResultSchema.parse(s.list(scope(f)));
    assert.equal(state.activeGeneration,b.id);assert.equal(state.candidateGeneration,pending.id);
    assert.ok(state.generations.some(g=>g.id===a.id&&g.status==='retired'));
    const result=await s.activate(activate(f,a,b));
    assert.equal(result.activeGeneration,a.id);assert.equal(result.candidateGeneration,null);
    assert.equal(store.get(b.id).status,'retired');assert.equal(store.get(pending.id).status,'cancelled');
    assert.throws(()=>store.publish(pending.id,()=>({paperIR:f.data.paperIR,embedding:f.embeddings.selectedIdentity(null)})),/not_building/);
    assert.equal(f.calls(),calls);assert.deepEqual(durableData(f.db),data);assert.deepEqual(await files(f.root),originals);
    const search=await f.router.search(f.request('Original Table 3 Equation (7)'));
    assert.ok(search.hits.length);assert.deepEqual(search.snapshot.generations.map(g=>g.generationId),[a.id]);
    assert.equal((await s.activate(activate(f,b,a))).activeGeneration,b.id);
    assert.deepEqual(durableData(f.db),data);assert.deepEqual(await files(f.root),originals);
    const path=join(f.root,'reopen.sqlite');await writeFile(path,f.db.serialize());
    const reopened=new Database(path);
    try {
      const restored=new store.constructor(reopened);
      assert.equal(restored.active(null,f.document.id).id,b.id);restored.verify(a.id);restored.verify(b.id);
      assert.deepEqual(reopened.pragma('foreign_key_check'),[]);
    } finally {reopened.close();}
  } finally {await f.close();}
});

test('failed, building, active, foreign scope, stale CAS and wrong embedding never change the active index',async()=>{
  const f=await scientificSearchFixture(api),s=service(f),store=f.repository.scientificIndex;
  try {
    const a=f.generation,b=candidate(f),failed=candidate(f,{publish:false});store.fail(failed.id,'fixture_failed');
    const pending=candidate(f,{publish:false});
    const badEmbedding={...f.embeddings.selectedIdentity(null),revision:2};
    const other=candidate(f,{embedding:badEmbedding});
    // Restore the known active generation directly to exercise a retired target with a different vector identity.
    store.activateRetired(b.id,other.id,()=>({paperIR:f.data.paperIR,embedding:f.embeddings.selectedIdentity(null)}));
    for(const [input,pattern] of [
      [activate(f,failed,b),/not_retired/],[activate(f,pending,b),/not_retired/],[activate(f,b,b),/not_retired/],
      [activate(f,a,a),/active_changed/],[activate(f,other,b),/embedding_changed/],
      [{...activate(f,a,b),storageProjectId:f.project.id},/scope_invalid/],
      [{...activate(f,a,b),documentId:'foreign-document'},/scope_invalid/]]) {
      const before=f.db.serialize();await assert.rejects(s.activate(input),pattern);assert.deepEqual(f.db.serialize(),before);
      assert.equal(store.active(null,f.document.id).id,b.id);
    }
  } finally {await f.close();}
});

for(const [label,mutate,pattern] of [
  ['chunk',f=>f.db.prepare("UPDATE research_scientific_chunks SET content='corrupt' WHERE generation_id=?").run(f.generation.id),/chunks_changed/],
  ['fts',f=>f.db.prepare('DELETE FROM research_scientific_fts WHERE generation_id=?').run(f.generation.id),/fts_invalid/],
  ['vectors',f=>f.db.prepare('DELETE FROM research_scientific_embeddings WHERE generation_id=?').run(f.generation.id),/embeddings_incomplete/],
  ['source',f=>writeFile(f.source,Buffer.from('changed original')),/source_changed|hash/],
  ['IR',f=>writeFile(join(f.root,f.data.paperIR.path),'{}'),/paper_ir/]
]) test(`retired ${label} corruption rejects rollback atomically`,async()=>{
  const f=await scientificSearchFixture(api),s=service(f);
  try {
    const b=candidate(f);await mutate(f);const before=f.db.serialize();
    await assert.rejects(s.activate(activate(f,f.generation,b)),pattern);assert.deepEqual(f.db.serialize(),before);
  } finally {await f.close();}
});

test('rollback can recover a corrupt active index using verified retained bytes',async()=>{
  const f=await scientificSearchFixture(api),s=service(f);
  try {
    const b=candidate(f);f.db.prepare('DELETE FROM research_scientific_embeddings WHERE generation_id=?').run(b.id);
    await assert.rejects(f.router.search(f.request('Original')),/embeddings_incomplete/);
    assert.equal((await s.activate(activate(f,f.generation,b))).activeGeneration,f.generation.id);
    assert.ok((await f.router.search(f.request('Original'))).hits.length>0);
  } finally {await f.close();}
});

test('cancel, concurrent activation and changed owner parse reject without reparsing',async()=>{
  const f=await scientificSearchFixture(api),s=service(f),store=f.repository.scientificIndex;
  try {
    const a=f.generation,b=candidate(f),controller=new AbortController(),before=f.db.serialize();
    const cancelled=s.activate(activate(f,a,b),controller.signal);controller.abort();
    await assert.rejects(cancelled,/abort/i);assert.deepEqual(f.db.serialize(),before);
    const racing=s.activate(activate(f,a,b));const c=candidate(f),after=f.db.serialize();
    await assert.rejects(racing,/active_changed/);assert.deepEqual(f.db.serialize(),after);
    const publication=await f.publish(),published=f.db.serialize();
    await assert.rejects(s.activate(activate(f,a,publication.generation)),/source_changed/);
    assert.deepEqual(f.db.serialize(),published);assert.equal(store.get(c.id).status,'retired');
  } finally {await f.close();}
});

test('source mutation after successful byte verification is fenced at the switch transaction',async()=>{
  const f=await scientificSearchFixture(api);let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const snapshots=f.router.snapshots;
  const s=new Service(f.repository,f.embeddings,{
    catalog:(...args)=>snapshots.catalog(...args),assertOwner:(...args)=>snapshots.assertOwner(...args),
    guardRetainedSource:async(...args)=>{const guard=await snapshots.guardRetainedSource(...args);entered();await gate;return guard;}
  });
  try {
    const b=candidate(f),before=f.db.serialize(),operation=s.activate(activate(f,f.generation,b));
    await ready;await writeFile(f.source,Buffer.alloc(f.bytes.length,32));release();
    await assert.rejects(operation,/source_changed/);assert.deepEqual(f.db.serialize(),before);
  } finally {release();await f.close();}
});
