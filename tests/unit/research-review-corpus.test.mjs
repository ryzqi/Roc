import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewSearchFixture, awaitReviewSearchFixture} from './fixtures/research-review-search.mjs';

let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const actor={kind:'user',id:'synthetic-corpus-reviewer'};
const hash=value=>createHash('sha256').update(value).digest('hex');
async function scene({runQueries=true,queries=['controlled query one','controlled query two'],...options}={}) {
  const f=createReviewSearchFixture(api,{queries,...options});
  f.corpora=new api.ResearchReviewCorpusRepository(f.db,f.repository,f.reviews,()=>f.time);
  f.results=[];
  if(runQueries)for(let queryIndex=0;queryIndex<queries.length;queryIndex++) {
    const run=f.reviews.start({...f.request,queryIndex,requestId:`query-${queryIndex}`},actor);
    f.results.push(await awaitReviewSearchFixture(f,run));
  }
  f.input={projectId:f.project.id,requestId:'seal-corpus',versionId:f.protocol.version.id,expectedFreezeHash:f.protocol.freezeHash,
    searches:f.results.map(result=>({reviewSearchId:result.snapshot.id,expectedSnapshotHash:result.snapshotHash,expectedReceiptHash:result.receiptHash}))};
  return f;
}

test('corpus seals all actual query/pool/record references, keeps repeated returns and reads original metadata without another library',async()=>{
  const f=await scene();
  try {
    const corpus=f.corpora.create({...f.input,searches:[...f.input.searches].reverse()},actor);
    assert.equal(corpus.queryCount,2);assert.equal(corpus.identifiedRecords,8);assert.equal(corpus.searchCoverageComplete,true);
    assert.equal(corpus.currentProtocol,true);
    assert.deepEqual(corpus.snapshot.sources.map(source=>source.queryIndex),[0,1]);
    assert.equal(new Set(corpus.snapshot.hits.map(hit=>hit.id)).size,8);
    const first=f.corpora.getHit({projectId:f.project.id,corpusId:corpus.snapshot.id,hitId:corpus.snapshot.hits[0].id});
    const repeated=f.corpora.getHit({projectId:f.project.id,corpusId:corpus.snapshot.id,hitId:corpus.snapshot.hits[4].id});
    assert.equal(first.record.record.title,'Controlled paper 1');assert.equal(first.record.record.publishedYear,null);
    assert.equal(first.record.record.doi,repeated.record.record.doi);assert.notEqual(first.reference.id,repeated.reference.id);
    assert.deepEqual(first.record,f.reviews.readFullPool({projectId:f.project.id,reviewSearchId:first.reference.reviewSearchId}).pool.records[0]);
    assert.deepEqual(repeated.record,f.reviews.readFullPool({projectId:f.project.id,reviewSearchId:repeated.reference.reviewSearchId}).pool.records[0]);
    assert.equal(hash(JSON.stringify(first.record)),first.reference.recordHash);
    assert.ok(corpus.snapshot.hits.every(hit=>!('record' in hit)));
    assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(),0);
    const before=f.changes();
    assert.deepEqual(f.corpora.list({projectId:f.project.id,versionId:f.protocol.version.id,limit:10}),[corpus]);
    assert.equal(f.changes(),before);assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await f.dispose();}
});

test('incomplete query set, pending sources, duplicate selection and hash drift refuse without corpus writes',async()=>{
  const f=await scene({runQueries:false});
  try {
    const running=f.reviews.start(f.request,actor);
    const selected={reviewSearchId:running.snapshot.id,expectedSnapshotHash:running.snapshotHash,expectedReceiptHash:'a'.repeat(64)};
    const before=f.changes();
    assert.throws(()=>f.corpora.create({...f.input,searches:[selected]},actor),/research_review_corpus_source_not_terminal/);
    assert.equal(f.changes(),before);
    const done=await awaitReviewSearchFixture(f,running);
    const current={...selected,expectedReceiptHash:done.receiptHash},readonly=f.changes();
    assert.throws(()=>f.corpora.create({...f.input,searches:[current]},actor),/research_review_corpus_query_set_incomplete/);
    assert.throws(()=>f.corpora.create({...f.input,searches:[current,current]},actor));
    assert.throws(()=>f.corpora.create({...f.input,searches:[{...current,expectedSnapshotHash:'b'.repeat(64)}]},actor),/research_review_corpus_source_changed/);
    assert.equal(f.changes(),readonly);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_corpora').pluck().get(),0);
  }finally{await f.dispose();}
});

test('limited and failed actual queries remain explicit corpus source outcomes without becoming complete search',async()=>{
  for(const options of [{maxPages:1},{fetch:async()=>new Response('controlled failure',{status:500})}]) {
    const f=await scene({queries:['controlled query'],...options});
    try {
      const corpus=f.corpora.create(f.input,actor);
      assert.equal(corpus.queryCount,1);assert.equal(corpus.searchCoverageComplete,false);
      assert.equal(corpus.snapshot.sources[0].status,options.maxPages===1?'partial':'failed');
      assert.equal(corpus.identifiedRecords,options.maxPages===1?2:0);
      assert.equal(f.errors.length,0);
    }finally{await f.dispose();}
  }
});

test('identical requests replay readonly; actor/content drift and cross-project access cannot replace the fixed corpus',async()=>{
  const f=await scene();
  try {
    const corpus=f.corpora.create(f.input,actor);
    const other=f.repository.createProject({title:'Other corpus project',description:'Synthetic',workspacePath:'/tmp/other-corpus'});
    const before=f.changes();assert.deepEqual(f.corpora.create(f.input,actor),corpus);
    assert.throws(()=>f.corpora.create(f.input,{kind:'user',id:'different-user'}),/research_review_request_conflict/);
    assert.throws(()=>f.corpora.create({...f.input,searches:[...f.input.searches].reverse()},actor),/research_review_request_conflict/);
    assert.throws(()=>f.corpora.get({projectId:other.id,corpusId:corpus.snapshot.id}),/research_review_project_mismatch/);
    assert.throws(()=>f.corpora.getHit({projectId:f.project.id,corpusId:corpus.snapshot.id,hitId:'guessed-hit'}),/research_review_corpus_hit_not_found/);
    assert.equal(f.changes(),before);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_corpora').pluck().get(),1);
  }finally{await f.dispose();}
});

test('fixed corpus detects both its own byte corruption and a changed terminal source receipt despite valid pool bytes',async()=>{
  const f=await scene();
  try {
    const corpus=f.corpora.create(f.input,actor);
    const original=f.db.prepare('SELECT snapshot_json FROM research_review_corpora WHERE id=?').pluck().get(corpus.snapshot.id);
    const changed=JSON.parse(original);changed.hits[0].recordHash='c'.repeat(64);
    f.db.prepare('UPDATE research_review_corpora SET snapshot_json=? WHERE id=?').run(JSON.stringify(changed),corpus.snapshot.id);
    assert.throws(()=>f.corpora.get({projectId:f.project.id,corpusId:corpus.snapshot.id}),/research_review_corpus_snapshot_invalid/);
    f.db.prepare('UPDATE research_review_corpora SET snapshot_json=? WHERE id=?').run(original,corpus.snapshot.id);
    const sourceId=corpus.snapshot.sources[0].reviewSearchId;
    const receipt=JSON.parse(f.db.prepare('SELECT receipt_json FROM research_review_searches WHERE id=?').pluck().get(sourceId));
    receipt.errorCode='controlled_receipt_drift';const json=JSON.stringify(receipt);
    f.db.prepare('UPDATE research_review_searches SET receipt_json=?,receipt_hash=? WHERE id=?').run(json,hash(json),sourceId);
    const before=f.changes();
    assert.throws(()=>f.corpora.get({projectId:f.project.id,corpusId:corpus.snapshot.id}),/research_review_corpus_source_changed/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('new protocol marks historical corpus explicitly; archive still permits original source reads but rejects new captures',async()=>{
  const f=await scene();
  try {
    const corpus=f.corpora.create(f.input,actor);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'revision',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,
      deviationReason:'Explicit later scope revision.'},actor);
    const historical=f.corpora.get({projectId:f.project.id,corpusId:corpus.snapshot.id});
    assert.deepEqual(historical,{...corpus,currentProtocol:false});
    assert.throws(()=>f.corpora.create({...f.input,requestId:'old-new-corpus'},actor),/research_review_version_conflict/);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const before=f.changes();
    assert.deepEqual(f.corpora.get({projectId:f.project.id,corpusId:corpus.snapshot.id}),historical);
    assert.equal(f.corpora.getHit({projectId:f.project.id,corpusId:corpus.snapshot.id,hitId:corpus.snapshot.hits[0].id}).record.record.title,'Controlled paper 1');
    assert.throws(()=>f.corpora.create({...f.input,requestId:'archived'},actor),/research_project_archived/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('generated corpus API binds actual sender and returns exact hit/source while tools and forged actors cannot capture',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewCorpusCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewCorpusCapabilities({pluginId:'research',capabilities:registry},f.corpora);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)});
    const before=f.changes();
    await assert.rejects(registry.invoke('research.reviewCorpus.create',f.input),error=>error.code==='research_human_required');
    const noSender=await bridge.invoke('research.createReviewCorpus',[f.input]);assert.equal(noSender.ok,false);
    assert.equal(noSender.error.code,'research_sender_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-corpus-create',[{...f.input,actor}]));
    assert.equal(f.changes(),before);
    const captured=await bridge.invoke('research.createReviewCorpus',[f.input],51);assert.equal(captured.ok,true,JSON.stringify(captured));
    assert.deepEqual(captured.data.snapshot.actor,{kind:'user',id:'window:51'});
    const request={projectId:f.project.id,corpusId:captured.data.snapshot.id},readonly=f.changes();
    const read=await bridge.invoke('research.getReviewCorpus',[request],51);
    const hit=await bridge.invoke('research.getReviewCorpusHit',[{...request,hitId:captured.data.snapshot.hits[0].id}],51);
    assert.equal(read.ok,true);assert.equal(hit.ok,true);assert.equal(hit.data.corpusHash,captured.data.snapshotHash);
    assert.deepEqual(read.data,captured.data);assert.equal(f.changes(),readonly);
  }finally{await f.dispose();}
});

test('real SQLite reopen retains fixed pool references and corpus counts without another Provider request',async()=>{
  const f=await scene(),directory=await mkdtemp(join(tmpdir(),'roc-review-corpus-reopen-'));
  let db,reviews;
  try {
    const corpus=f.corpora.create(f.input,actor),path=join(directory,'research.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');
    const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time);
    const before=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(corpora.get({projectId:f.project.id,corpusId:corpus.snapshot.id}),corpus);
    assert.equal(corpora.getHit({projectId:f.project.id,corpusId:corpus.snapshot.id,hitId:corpus.snapshot.hits[7].id}).record.record.title,'Controlled paper 4');
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await reviews?.shutdown();db?.close();await f.dispose();await rm(directory,{recursive:true,force:true});}
});

test('post-insert source drift aborts corpus capture and rolls back both the corpus and injected source change',async()=>{
  const f=await scene();
  try {
    const sources=f.db.prepare('SELECT * FROM research_review_searches').all();
    f.db.exec("CREATE TRIGGER change_corpus_source AFTER INSERT ON research_review_corpora BEGIN UPDATE research_review_searches SET receipt_hash='changed'; END;");
    assert.throws(()=>f.corpora.create(f.input,actor),/research_review_search_snapshot_invalid/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_corpora').pluck().get(),0);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_searches').all(),sources);
    f.db.exec('DROP TRIGGER change_corpus_source');
    assert.equal(f.corpora.create(f.input,actor).identifiedRecords,8);
  }finally{await f.dispose();}
});

test('DB28 upgrade preserves actual protocols, query receipts and raw pools without fabricating corpus decisions',async()=>{
  const oldApi={...api,applyResearchDatabaseSchema(db,now) {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(value=>value.version<=28),now});
  }};
  const f=createReviewSearchFixture(oldApi);
  try {
    await awaitReviewSearchFixture(f,f.reviews.start(f.request,actor));
    const tables=['research_review_protocol_versions','research_review_protocol_freezes','research_review_searches',
      'research_review_search_cancellations','research_literature_search_executions','research_literature_search_pools','research_literature_request_receipts'];
    const before=tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all());
    const migrations=f.db.prepare('SELECT * FROM schema_migrations').all();
    api.applyResearchDatabaseSchema(f.db);
    assert.equal(f.db.prepare('SELECT current_version FROM schema_metadata').pluck().get(),api.researchMigrations.at(-1).version);
    tables.forEach((table,index)=>assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(),before[index]));
    assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=28').all(),migrations);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_corpora').pluck().get(),0);
  }finally{await f.dispose();}
});
