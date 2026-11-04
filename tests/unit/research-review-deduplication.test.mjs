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
const actor={kind:'user',id:'synthetic-dedup-reviewer'};
const hash=value=>createHash('sha256').update(value).digest('hex');
async function scene(options={},selectedApi=api) {
  const f=createReviewSearchFixture(selectedApi,{queries:['controlled one','controlled two'],...options});
  const results=[];
  for(let queryIndex=0;queryIndex<f.protocol.version.body.databases[0].queries.length;queryIndex++) {
    results.push(await awaitReviewSearchFixture(f,f.reviews.start({...f.request,queryIndex,requestId:`query-${queryIndex}`},actor)));
  }
  f.corpora=new api.ResearchReviewCorpusRepository(f.db,f.repository,f.reviews,()=>f.time);
  f.corpus=f.corpora.create({projectId:f.project.id,requestId:'capture',versionId:f.protocol.version.id,
    expectedFreezeHash:f.protocol.freezeHash,searches:results.map(result=>({reviewSearchId:result.snapshot.id,
      expectedSnapshotHash:result.snapshotHash,expectedReceiptHash:result.receiptHash}))},actor);
  f.dedup=new api.ResearchReviewDeduplicationRepository(f.db,f.repository,f.corpora,()=>f.time);
  f.get={projectId:f.project.id,corpusId:f.corpus.snapshot.id};
  f.save=(left,right,requestId,extra={})=>({...f.get,expectedCorpusHash:f.corpus.snapshotHash,requestId,
    leftHitId:f.corpus.snapshot.hits[left].id,rightHitId:f.corpus.snapshot.hits[right].id,decision:'duplicate',
    rule:{name:'Human bibliographic comparison',version:'controlled-v1'},reason:'Compared the actual original metadata.',
    parentDecisionId:null,expectedParentHash:null,revisionReason:null,...extra});
  f.freeze=()=>({...f.get,requestId:'freeze',expectedCorpusHash:f.corpus.snapshotHash,reviewNote:'Reviewed all original returns and pair decisions.',
    decisions:f.dedup.get(f.get).decisions.map(decision=>({decisionId:decision.snapshot.id,expectedHash:decision.snapshotHash}))});
  return f;
}

test('human pair snapshots retain both raw identities and source hashes; frozen counts separate duplicate removal from screening',async()=>{
  const f=await scene();
  try {
    const original=f.db.prepare('SELECT snapshot_json,snapshot_hash FROM research_review_corpora').get();
    const duplicate=f.dedup.save(f.save(4,0,'duplicate'),actor);
    const distinct=f.dedup.save(f.save(0,1,'distinct',{decision:'distinct'}),actor);
    assert.deepEqual(duplicate.snapshot.left.hit,f.corpus.snapshot.hits[4]);
    assert.deepEqual(duplicate.snapshot.right.hit,f.corpus.snapshot.hits[0]);
    assert.deepEqual(duplicate.snapshot.left.source,f.corpus.snapshot.sources[1]);
    assert.deepEqual(duplicate.snapshot.right.source,f.corpus.snapshot.sources[0]);
    assert.deepEqual(duplicate.snapshot.actor,actor);assert.equal(duplicate.snapshot.version,1);
    const raw=f.corpora.getHit({...f.get,hitId:duplicate.snapshot.left.hit.id});
    assert.equal(hash(JSON.stringify(raw.record)),duplicate.snapshot.left.hit.recordHash);
    assert.equal(f.dedup.get(f.get).freeze,null);
    const frozen=f.dedup.freeze(f.freeze(),actor);
    assert.equal(frozen.decisions.length,2);assert.ok(frozen.decisions.some(value=>value.snapshot.id===distinct.snapshot.id));
    assert.deepEqual(frozen.freeze.removed,[{hitId:f.corpus.snapshot.hits[4].id,retainedHitId:f.corpus.snapshot.hits[0].id}]);
    assert.equal(frozen.freeze.identifiedRecords,8);assert.equal(frozen.freeze.removedDuplicates,1);
    assert.equal(frozen.freeze.recordsToScreen,7);assert.equal(frozen.freeze.screenableHitIds.length,7);
    assert.equal(frozen.freeze.screenableHitIds.includes(f.corpus.snapshot.hits[4].id),false);
    assert.deepEqual(f.db.prepare('SELECT snapshot_json,snapshot_hash FROM research_review_corpora').get(),original);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(),0);
    assert.ok(!('fullTextExcluded' in frozen.freeze));assert.ok(!('scientificReview' in duplicate.snapshot));
  }finally{await f.dispose();}
});

test('decision revisions append with exact parent hashes and reasons; replay, stale parents and actors cannot overwrite history',async()=>{
  const f=await scene();
  try {
    const input=f.save(4,0,'first'),first=f.dedup.save(input,actor);
    const old=f.db.prepare('SELECT * FROM research_review_duplicate_decisions WHERE id=?').get(first.snapshot.id);
    const revision={...f.save(0,4,'revision',{decision:'distinct'}),parentDecisionId:first.snapshot.id,
      expectedParentHash:first.snapshotHash,revisionReason:'Original identifier is not enough; compare full bibliographic details.'};
    const second=f.dedup.save(revision,actor);assert.equal(second.snapshot.version,2);assert.equal(second.snapshot.pairKey,first.snapshot.pairKey);
    const before=f.changes();
    assert.deepEqual(f.dedup.save(revision,actor),second);
    assert.deepEqual(f.dedup.save(input,actor),{...first,isLatest:false});
    assert.throws(()=>f.dedup.save({...revision,requestId:'stale'},actor),/research_review_duplicate_version_conflict/);
    assert.throws(()=>f.dedup.save({...input,requestId:'no-parent'},actor),/research_review_duplicate_version_conflict/);
    assert.throws(()=>f.dedup.save(revision,{kind:'user',id:'other'}),/research_review_request_conflict/);
    assert.throws(()=>f.dedup.save({...revision,reason:'changed'},actor),/research_review_request_conflict/);
    assert.deepEqual(f.dedup.history({...f.get,decisionId:first.snapshot.id}),[{...first,isLatest:false},second]);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_duplicate_decisions WHERE id=?').get(first.snapshot.id),old);
    assert.equal(f.changes(),before);
    const frozen=f.dedup.freeze(f.freeze(),actor);assert.equal(frozen.freeze.removedDuplicates,0);assert.equal(frozen.freeze.recordsToScreen,8);
  }finally{await f.dispose();}
});

test('freeze requires every latest decision including distinct results and the exact displayed hashes',async()=>{
  const f=await scene();
  try {
    const first=f.dedup.save(f.save(4,0,'first'),actor);
    const stale=f.freeze();
    f.dedup.save(f.save(1,2,'different',{decision:'distinct'}),actor);
    const latest=f.freeze(),before=f.changes();
    for(const request of [stale,{...latest,decisions:[]},{...latest,decisions:latest.decisions.map(value=>({...value,expectedHash:'b'.repeat(64)}))}]) {
      assert.throws(()=>f.dedup.freeze(request,actor),/research_review_duplicate_decision_set_changed/);
    }
    assert.throws(()=>f.dedup.freeze({...latest,decisions:[...latest.decisions,latest.decisions[0]]},actor));
    assert.equal(f.changes(),before);assert.equal(f.dedup.get(f.get).freeze,null);
    const second=f.dedup.save({...first.snapshot.request,requestId:'rev',parentDecisionId:first.snapshot.id,
      expectedParentHash:first.snapshotHash,revisionReason:'Explicit rule version review.',rule:{name:'Human comparison',version:'v2'}},actor);
    assert.equal(second.snapshot.version,2);
    assert.throws(()=>f.dedup.freeze(latest,actor),/research_review_duplicate_decision_set_changed/);
    assert.equal(f.dedup.freeze(f.freeze(),actor).freeze.removedDuplicates,1);
  }finally{await f.dispose();}
});

test('human duplicate chains resolve to the final retained original hit with conserved counts',async()=>{
  const f=await scene();
  try {
    f.dedup.save(f.save(4,0,'one'),actor);f.dedup.save(f.save(5,4,'two'),actor);
    f.dedup.save(f.save(6,5,'three'),actor);
    const frozen=f.dedup.freeze(f.freeze(),actor);
    assert.deepEqual(frozen.freeze.removed,[4,5,6].map(index=>({hitId:f.corpus.snapshot.hits[index].id,retainedHitId:f.corpus.snapshot.hits[0].id})));
    assert.equal(frozen.freeze.identifiedRecords,8);assert.equal(frozen.freeze.removedDuplicates,3);assert.equal(frozen.freeze.recordsToScreen,5);
    assert.equal(frozen.freeze.screenableHitIds.includes(f.corpus.snapshot.hits[0].id),true);
  }finally{await f.dispose();}
});

test('cycles, ambiguous removals and distinct conflicts remain visible decisions and refuse freeze without writes',async()=>{
  const cases=[
    {pairs:[[0,1],[1,2],[2,0]],code:'research_review_duplicate_cycle'},
    {pairs:[[4,0],[4,1]],code:'research_review_duplicate_ambiguous_removal'},
    {pairs:[[4,0],[0,1],[4,1,'distinct']],code:'research_review_duplicate_distinct_conflict'}
  ];
  for(const {pairs,code} of cases) {
    const f=await scene();
    try {
      pairs.forEach(([left,right,decision='duplicate'],index)=>f.dedup.save(f.save(left,right,`decision-${index}`,{decision}),actor));
      const request=f.freeze(),before=f.changes(),state=f.dedup.get(f.get);
      assert.equal(state.decisions.length,pairs.length);assert.equal(state.freeze,null);
      assert.throws(()=>f.dedup.freeze(request,actor),new RegExp(code));
      assert.equal(f.changes(),before);assert.deepEqual(f.dedup.get(f.get),state);
    }finally{await f.dispose();}
  }
});

test('explicit no-duplicate and zero-hit failed-source freezes preserve actual coverage and do not invent removed records',async()=>{
  for(const options of [{},{fetch:async()=>new Response('actual offline failure',{status:500})}]) {
    const f=await scene(options);
    try {
      assert.throws(()=>f.dedup.requireFrozen(f.project.id,f.corpus.snapshot.id,'a'.repeat(64)),/research_review_duplicate_not_frozen/);
      const frozen=f.dedup.freeze(f.freeze(),actor);
      assert.equal(frozen.freeze.removedDuplicates,0);assert.deepEqual(frozen.freeze.removed,[]);
      assert.equal(frozen.freeze.recordsToScreen,f.corpus.identifiedRecords);assert.equal(frozen.freeze.identifiedRecords,f.corpus.identifiedRecords);
      assert.equal(f.corpus.searchCoverageComplete,options.fetch===undefined);
      assert.deepEqual(f.dedup.requireFrozen(f.project.id,f.corpus.snapshot.id,frozen.freezeHash),frozen);
    }finally{await f.dispose();}
  }
});

test('frozen decisions refuse subsequent edits and preserve idempotent receipts with no authority or request drift',async()=>{
  const f=await scene();
  try {
    const input=f.save(4,0,'first'),decision=f.dedup.save(input,actor),request=f.freeze();
    const frozen=f.dedup.freeze(request,actor),before=f.changes();
    assert.deepEqual(f.dedup.freeze(request,actor),frozen);assert.deepEqual(f.dedup.save(input,actor),decision);
    assert.throws(()=>f.dedup.freeze(request,{kind:'user',id:'other'}),/research_review_request_conflict/);
    assert.throws(()=>f.dedup.freeze({...request,reviewNote:'changed'},actor),/research_review_request_conflict/);
    assert.throws(()=>f.dedup.freeze({...request,requestId:'again'},actor),/research_review_duplicate_already_frozen/);
    assert.throws(()=>f.dedup.save({...input,requestId:'new'},actor),/research_review_duplicate_already_frozen/);
    assert.throws(()=>f.dedup.requireFrozen(f.project.id,f.corpus.snapshot.id,'a'.repeat(64)),/research_review_duplicate_version_conflict/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('strict wire requests and exact corpus ownership refuse guessed hits, self-pairs and incomplete revision lineage',async()=>{
  const f=await scene();
  try {
    const other=f.repository.createProject({title:'Other',description:'Synthetic',workspacePath:'/tmp/other-dedup'});
    const before=f.changes(),valid=f.save(4,0,'valid');
    for(const request of [{...valid,leftHitId:valid.rightHitId},{...valid,actor},{...valid,reason:''},
      {...valid,rule:{name:'Comparison'}},{...valid,expectedParentHash:'c'.repeat(64)},
      {...valid,parentDecisionId:'unknown',expectedParentHash:'c'.repeat(64),revisionReason:null}]) {
      assert.throws(()=>f.dedup.save(request,actor));
    }
    assert.throws(()=>f.dedup.save({...valid,leftHitId:'guessed-hit'},actor),/research_review_corpus_hit_not_found/);
    assert.throws(()=>f.dedup.save({...valid,expectedCorpusHash:'d'.repeat(64)},actor),/research_review_duplicate_version_conflict/);
    assert.throws(()=>f.dedup.save({...valid,projectId:other.id},actor),/research_review_project_mismatch/);
    assert.throws(()=>f.dedup.get({...f.get,projectId:other.id}),/research_review_project_mismatch/);
    assert.throws(()=>f.dedup.history({...f.get,decisionId:'guessed'}),/research_review_duplicate_not_found/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('protocol revisions and archive preserve fixed decisions for reading but cannot authorize new screening or dedup writes',async()=>{
  const f=await scene();
  try {
    const decision=f.dedup.save(f.save(4,0,'first'),actor),frozen=f.dedup.freeze(f.freeze(),actor);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'revision',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,
      deviationReason:'Later explicit protocol.'},actor);
    const before=f.changes(),historical=f.dedup.get(f.get);
    assert.deepEqual(historical,{...frozen,currentProtocol:false});
    assert.throws(()=>f.dedup.save(f.save(1,2,'new'),actor),/research_review_duplicate_version_conflict/);
    assert.throws(()=>f.dedup.requireFrozen(f.project.id,f.corpus.snapshot.id,frozen.freezeHash),/research_review_duplicate_version_conflict/);
    assert.deepEqual(f.dedup.history({...f.get,decisionId:decision.snapshot.id}),[decision]);assert.equal(f.changes(),before);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const archived=f.changes();assert.deepEqual(f.dedup.get(f.get),historical);
    assert.throws(()=>f.dedup.save(f.save(1,2,'archived'),actor),/research_project_archived/);
    assert.throws(()=>f.dedup.freeze({...f.freeze(),requestId:'archived'},actor),/research_project_archived/);
    assert.equal(f.changes(),archived);
  }finally{await f.dispose();}
});

test('decision endpoint/parent corruption and a missing marked freeze receipt fail rather than silently reset review state',async()=>{
  const f=await scene();
  try {
    const first=f.dedup.save(f.save(4,0,'first'),actor);
    const second=f.dedup.save({...first.snapshot.request,requestId:'second',parentDecisionId:first.snapshot.id,
      expectedParentHash:first.snapshotHash,revisionReason:'Explicit revised comparison.'},actor);
    const parent=f.db.prepare('SELECT * FROM research_review_duplicate_decisions WHERE id=?').get(first.snapshot.id);
    const changed=JSON.parse(parent.snapshot_json);changed.left.hit.recordHash='a'.repeat(64);const json=JSON.stringify(changed);
    f.db.prepare('UPDATE research_review_duplicate_decisions SET snapshot_json=?,snapshot_hash=? WHERE id=?').run(json,hash(json),parent.id);
    assert.throws(()=>f.dedup.get(f.get),/research_review_duplicate_snapshot_invalid/);
    assert.throws(()=>f.dedup.history({...f.get,decisionId:second.snapshot.id}),/research_review_duplicate_snapshot_invalid/);
    f.db.prepare('UPDATE research_review_duplicate_decisions SET snapshot_json=?,snapshot_hash=? WHERE id=?')
      .run(parent.snapshot_json,parent.snapshot_hash,parent.id);
    const frozen=f.dedup.freeze(f.freeze(),actor);
    const receipt=f.db.prepare('SELECT * FROM research_review_deduplication_freezes').get();
    f.db.prepare('DELETE FROM research_review_deduplication_freezes WHERE corpus_id=?').run(f.corpus.snapshot.id);
    const before=f.changes();assert.throws(()=>f.dedup.get(f.get),/research_review_duplicate_snapshot_invalid/);
    assert.throws(()=>f.dedup.save(f.save(1,2,'cannot-reset'),actor),/research_review_duplicate_snapshot_invalid/);
    assert.equal(f.changes(),before);
    f.db.prepare('INSERT INTO research_review_deduplication_freezes VALUES (?,?,?,?,?,?)')
      .run(receipt.corpus_id,receipt.project_id,receipt.request_id,receipt.snapshot_json,receipt.snapshot_hash,receipt.created_at);
    assert.deepEqual(f.dedup.get(f.get),frozen);
    const drift=JSON.parse(receipt.snapshot_json);drift.removed[0].retainedHitId=f.corpus.snapshot.hits[1].id;
    const driftJson=JSON.stringify(drift),driftHash=hash(driftJson);
    f.db.prepare('UPDATE research_review_deduplication_freezes SET snapshot_json=?,snapshot_hash=? WHERE corpus_id=?')
      .run(driftJson,driftHash,f.corpus.snapshot.id);
    f.db.prepare('UPDATE research_review_corpora SET dedup_freeze_hash=? WHERE id=?').run(driftHash,f.corpus.snapshot.id);
    assert.throws(()=>f.dedup.get(f.get),/research_review_duplicate_snapshot_invalid/);
  }finally{await f.dispose();}
});

test('transactional post-insert source drift and lost freeze receipt roll back all new writes and markers',async()=>{
  const f=await scene();
  try {
    const before=f.db.prepare('SELECT * FROM research_review_searches').all();
    f.db.exec("CREATE TRIGGER drift_dedup_source AFTER INSERT ON research_review_duplicate_decisions BEGIN UPDATE research_review_searches SET receipt_hash='changed'; END;");
    assert.throws(()=>f.dedup.save(f.save(4,0,'first'),actor),/research_review_search_snapshot_invalid/);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_searches').all(),before);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_duplicate_decisions').pluck().get(),0);
    f.db.exec('DROP TRIGGER drift_dedup_source');
    f.dedup.save(f.save(4,0,'first'),actor);
    const decisions=f.db.prepare('SELECT * FROM research_review_duplicate_decisions').all();
    f.db.exec('CREATE TRIGGER lose_dedup_receipt AFTER INSERT ON research_review_deduplication_freezes BEGIN DELETE FROM research_review_deduplication_freezes WHERE corpus_id=NEW.corpus_id; END;');
    assert.throws(()=>f.dedup.freeze(f.freeze(),actor),/research_review_duplicate_snapshot_invalid/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_deduplication_freezes').pluck().get(),0);
    assert.equal(f.db.prepare('SELECT dedup_freeze_hash FROM research_review_corpora').pluck().get(),null);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_duplicate_decisions').all(),decisions);
    f.db.exec('DROP TRIGGER lose_dedup_receipt');assert.equal(f.dedup.freeze(f.freeze(),actor).freeze.removedDuplicates,1);
  }finally{await f.dispose();}
});

test('generated APIs bind real main sender for decisions and freeze; tools, forged actors and another capability context cannot write',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewDeduplicationCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewDeduplicationCapabilities({pluginId:'research',capabilities:registry},f.dedup);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)}),request=f.save(4,0,'first'),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewDeduplication.save',request),error=>error.code==='research_human_required');
    await assert.rejects(api.withResearchHumanContext({capability:'research.reviewCorpus.create',projectId:f.project.id,windowId:61},
      ()=>registry.invoke('research.reviewDeduplication.save',request)),error=>error.code==='research_human_required');
    await assert.rejects(api.withResearchHumanContext({capability:'research.reviewDeduplication.save',projectId:'other',windowId:61},
      ()=>registry.invoke('research.reviewDeduplication.save',request)),error=>error.code==='research_human_project_mismatch');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-deduplication-save',[{...request,actor}]));
    const noSender=await bridge.invoke('research.saveReviewDuplicateDecision',[request]);
    assert.equal(noSender.ok,false);assert.equal(noSender.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const saved=await bridge.invoke('research.saveReviewDuplicateDecision',[request],61);
    assert.equal(saved.ok,true,JSON.stringify(saved));assert.deepEqual(saved.data.snapshot.actor,{kind:'user',id:'window:61'});
    const freezeRequest=f.freeze(),readonly=f.changes();
    await assert.rejects(registry.invoke('research.reviewDeduplication.freeze',freezeRequest),error=>error.code==='research_human_required');
    assert.equal(f.changes(),readonly);
    const frozen=await bridge.invoke('research.freezeReviewDeduplication',[freezeRequest],61);
    assert.equal(frozen.ok,true,JSON.stringify(frozen));assert.deepEqual(frozen.data.freeze.actor,{kind:'user',id:'window:61'});
    const readBefore=f.changes();
    const read=await bridge.invoke('research.getReviewDeduplication',[f.get],61);
    const history=await bridge.invoke('research.getReviewDuplicateDecisionHistory',[{...f.get,decisionId:saved.data.snapshot.id}],61);
    assert.equal(read.ok,true);assert.equal(history.ok,true);assert.deepEqual(read.data,frozen.data);assert.deepEqual(history.data,[saved.data]);
    assert.equal(f.changes(),readBefore);
  }finally{await f.dispose();}
});

test('real SQLite reopen and query shutdown retain reviewed decisions/freeze without network requests or writes',async()=>{
  const f=await scene(),directory=await mkdtemp(join(tmpdir(),'roc-dedup-reopen-'));
  let db,reviews;
  try {
    f.dedup.save(f.save(4,0,'first'),actor);const frozen=f.dedup.freeze(f.freeze(),actor);
    await f.reviews.releaseProject(f.project.id);assert.deepEqual(f.dedup.get(f.get),frozen);
    const path=join(directory,'research.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time);
    const dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time),before=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(dedup.get(f.get),frozen);
    assert.deepEqual(dedup.requireFrozen(f.project.id,f.corpus.snapshot.id,frozen.freezeHash),frozen);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await reviews?.shutdown();db?.close();await f.dispose();await rm(directory,{recursive:true,force:true});}
});

test('DB29 upgrade preserves exact corpus and protocol/search records without fabricated duplicate reviews',async()=>{
  const oldApi={...api,applyResearchDatabaseSchema(db,now) {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(value=>value.version<=29),now});
  }};
  const f=await scene({},oldApi);
  try {
    const original=f.db.prepare('SELECT * FROM research_review_corpora').all();
    const tables=['research_review_protocol_versions','research_review_protocol_freezes','research_review_searches',
      'research_literature_search_pools','research_literature_request_receipts'];
    const before=tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all()),migrations=f.db.prepare('SELECT * FROM schema_migrations').all();
    api.applyResearchDatabaseSchema(f.db);
    assert.equal(f.db.prepare('SELECT current_version FROM schema_metadata').pluck().get(),api.researchMigrations.at(-1).version);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_corpora').all(),original.map(row=>({...row,dedup_freeze_hash:null})));
    tables.forEach((table,index)=>assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(),before[index]));
    assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=29').all(),migrations);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_duplicate_decisions').pluck().get(),0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_deduplication_freezes').pluck().get(),0);
    assert.equal(f.dedup.get(f.get).freeze,null);assert.deepEqual(f.corpora.get(f.get),f.corpus);
  }finally{await f.dispose();}
});
