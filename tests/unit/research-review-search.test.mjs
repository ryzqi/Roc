import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {createReviewSearchFixture,awaitReviewSearchFixture as terminal,reviewProviderGovernorFixture,
  reviewBibliographyPreparationFixture as prepare,reviewSearchPayloadFixture as payload} from './fixtures/research-review-search.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {reviewProtocolBodyFixture} from './fixtures/research-review-protocol.mjs';

let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const actor={kind:'user',id:'synthetic-review-search-user'};
const scene=options=>createReviewSearchFixture(api,options);
const governor=()=>reviewProviderGovernorFixture(api);

test('actual provider paging/ledger/raw pool follows frozen parameters and retains records omitted by candidate year/preview filtering',async()=>{
  const f=scene();
  try {
    const started=f.reviews.start(f.request,actor);
    assert.equal(started.status,'running');
    assert.deepEqual(started.snapshot.parameters,{query:'controlled synthetic group',sources:['openalex'],limit:2,maxPages:2,
      yearFrom:2020,yearTo:2026,projectId:f.project.id});
    const done=await terminal(f,started);assert.equal(done.status,'complete');assert.equal(done.coverageComplete,true);
    assert.equal(done.rawRecordCount,4);assert.equal(f.calls.length,2);
    assert.deepEqual(f.calls.map(({url})=>Number(new URL(url).searchParams.get('page'))),[1,2]);
    assert.equal(f.errors.length,0);
    const execution=f.db.prepare('SELECT * FROM research_literature_search_executions WHERE id=?').get(done.receipt.executionId);
    assert.equal(execution.run_id,started.snapshot.id);assert.equal(execution.project_id,f.project.id);
    const preview=JSON.parse(f.db.prepare('SELECT result_json FROM research_literature_searches WHERE id=?').pluck().get(execution.search_id));
    assert.equal(preview.candidates.length,2);
    const first=f.reviews.readPool({projectId:f.project.id,reviewSearchId:started.snapshot.id,offset:0,limit:2});
    const second=f.reviews.readPool({projectId:f.project.id,reviewSearchId:started.snapshot.id,offset:2,limit:2});
    assert.equal(first.pool.total,4);assert.equal(first.pool.nextOffset,2);assert.equal(second.pool.nextOffset,null);
    assert.deepEqual(first.pool.records.map(row=>row.record.publishedYear),[null,2010]);
    assert.equal(first.pool.contentHash,done.receipt.poolHash);
    const before=f.changes();assert.deepEqual(f.reviews.start(f.request,actor),done);
    assert.deepEqual(f.reviews.list({projectId:f.project.id,versionId:f.protocol.version.id,limit:10}),[done]);
    assert.equal(f.changes(),before);assert.equal(f.calls.length,2);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(),0);
  }finally{await f.dispose();}
});

test('page limit is partial and explicit retry keeps original pools and exact parent identity without expanding scope',async()=>{
  const f=scene({maxPages:1});
  try {
    const original=await terminal(f,f.reviews.start(f.request,actor));
    assert.equal(original.status,'partial');assert.equal(original.coverageComplete,false);assert.equal(original.rawRecordCount,2);
    const before=f.changes();
    assert.throws(()=>f.reviews.start({...f.request,requestId:'unlinked-repeat'},actor),/research_review_search_retry_conflict/);
    assert.throws(()=>f.reviews.start({...f.request,requestId:'drift',retryOf:original.snapshot.id,expectedRetrySnapshotHash:'a'.repeat(64)},actor),
      /research_review_search_retry_conflict/);assert.equal(f.changes(),before);
    const retry=f.reviews.start({...f.request,requestId:'explicit-retry',retryOf:original.snapshot.id,expectedRetrySnapshotHash:original.snapshotHash},actor);
    const done=await terminal(f,retry);assert.equal(done.status,'partial');
    assert.deepEqual(done.snapshot.parameters,original.snapshot.parameters);assert.notEqual(done.receipt.executionId,original.receipt.executionId);
    assert.deepEqual(f.reviews.get({projectId:f.project.id,reviewSearchId:original.snapshot.id}),original);
    assert.equal(f.calls.length,1,'existing provider response cache reused with actual new execution ledger');
    assert.equal(f.errors.length,0);
  }finally{await f.dispose();}
});

test('provider failure preserves actual failed request receipts and cannot be called complete retrieval',async()=>{
  const f=scene({fetch:async()=>new Response('controlled provider failure',{status:500})});
  try {
    const done=await terminal(f,f.reviews.start(f.request,actor));
    assert.equal(done.status,'failed');assert.equal(done.coverageComplete,false);assert.equal(done.rawRecordCount,0);
    assert.ok(done.sources[0].requests.length>0);assert.equal(done.sources[0].stopReason,'failed');
    const attempts=f.db.prepare('SELECT * FROM research_literature_request_receipts WHERE execution_id=?').all(done.receipt.executionId);
    assert.equal(attempts.length,done.sources[0].requests.length);
    assert.equal(f.db.prepare('SELECT status FROM research_literature_search_executions WHERE id=?').pluck().get(done.receipt.executionId),'failed');
    assert.equal(f.errors.length,0);
  }finally{await f.dispose();}
});

test('unknown provider coverage stays partial even when its single page executes successfully',async()=>{
  const f=scene({fetch:async()=>Response.json({results:[payload(1,2).results[0]]})});
  try {
    const done=await terminal(f,f.reviews.start(f.request,actor));
    assert.equal(done.status,'partial');assert.equal(done.coverageComplete,false);
    assert.equal(done.sources[0].coverage.state,'unknown');assert.equal(done.rawRecordCount,1);assert.equal(f.errors.length,0);
  }finally{await f.dispose();}
});

test('cancellation records user intent before actual abort, preserves ledger and replays without another request',async()=>{
  let started,observedSignal;
  const ready=new Promise(resolve=>{started=resolve;});
  const f=scene({fetch:async(_url,{signal})=>{
    observedSignal=signal;started();
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  try {
    const run=f.reviews.start(f.request,actor);await ready;
    const request={projectId:f.project.id,reviewSearchId:run.snapshot.id,requestId:'stop-query',expectedRevision:run.revision,note:'Stop controlled request.'};
    const stopping=f.reviews.cancel(request,actor);assert.equal(stopping.status,'cancelling');assert.equal(observedSignal.aborted,true);
    const replay=f.changes();assert.deepEqual(f.reviews.cancel(request,actor),stopping);assert.equal(f.changes(),replay);
    const done=await terminal(f,run);assert.equal(done.status,'cancelled');assert.equal(done.coverageComplete,false);
    assert.equal(f.db.prepare('SELECT status FROM research_literature_search_executions WHERE id=?').pluck().get(done.receipt.executionId),'cancelled');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_search_cancellations').pluck().get(),1);
    assert.deepEqual(done.cancellation.actor,actor);assert.equal(done.cancellation.request.note,request.note);
    assert.equal(f.calls.length,1);assert.equal(f.errors.length,0);
    f.db.prepare('DELETE FROM research_review_search_cancellations WHERE review_search_id=?').run(run.snapshot.id);
    assert.throws(()=>f.reviews.get({projectId:f.project.id,reviewSearchId:run.snapshot.id}),/research_review_search_snapshot_invalid/);
  }finally{await f.dispose();}
});

test('candidate expiry leaves fixed raw pool readable; corrupt pool refuses rather than losing source facts silently',async()=>{
  const f=scene();
  try {
    const done=await terminal(f,f.reviews.start(f.request,actor));
    f.time='2026-11-20T00:00:00.000Z';f.db.prepare('DELETE FROM research_literature_searches').run();
    assert.equal(f.reviews.readPool({projectId:f.project.id,reviewSearchId:done.snapshot.id,offset:0,limit:30}).pool.total,4);
    const original=f.db.prepare('SELECT pool_json FROM research_literature_search_pools WHERE execution_id=?').pluck().get(done.receipt.executionId);
    const changed=JSON.parse(original);changed.records[0].record.title='Changed raw source';
    f.db.prepare('UPDATE research_literature_search_pools SET pool_json=? WHERE execution_id=?').run(JSON.stringify(changed),done.receipt.executionId);
    const before=f.changes();
    assert.throws(()=>f.reviews.get({projectId:f.project.id,reviewSearchId:done.snapshot.id}),/research_review_search_pool_invalid/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('wrong scope, forged parameters, request drift, pending duplicate and obsolete protocol cannot dispatch',async()=>{
  const f=scene();
  try {
    const before=f.changes();
    assert.throws(()=>f.reviews.start({...f.request,queryIndex:2},actor),/research_review_query_not_declared/);
    assert.throws(()=>f.reviews.start({...f.request,parameters:{query:'outside scope'}},actor));
    assert.throws(()=>f.reviews.start({...f.request,expectedFreezeHash:'b'.repeat(64)},actor),/research_review_version_conflict/);
    assert.equal(f.changes(),before);assert.equal(f.calls.length,0);
    const run=f.reviews.start(f.request,actor),pending=f.changes();
    assert.throws(()=>f.reviews.start({...f.request,requestId:'parallel'},actor),/research_review_search_retry_conflict/);
    assert.throws(()=>f.reviews.start(f.request,{kind:'user',id:'different-user'}),/research_review_request_conflict/);
    assert.equal(f.changes(),pending);
    const other=f.repository.createProject({title:'Other query scope',description:'Synthetic',workspacePath:'/tmp/other-review-query'});
    assert.throws(()=>f.reviews.get({projectId:other.id,reviewSearchId:run.snapshot.id}),/research_review_project_mismatch/);
    await terminal(f,run);
    const draft=f.repository.systematicReviews.save({projectId:f.project.id,requestId:'revise',
      protocolId:f.protocol.version.protocolId,expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,
      body:f.protocol.version.body,deviationReason:'New search protocol version.'},actor);
    assert.throws(()=>f.reviews.start({...f.request,requestId:'obsolete'},actor),/research_review_version_conflict/);
    assert.equal(draft.freeze,null);assert.equal(f.errors.length,0);
  }finally{await f.dispose();}
});

test('disk restart preserves dispatched ledger as interrupted and does not automatically repeat query or user decisions',async()=>{
  let notify;const ready=new Promise(resolve=>{notify=resolve;});
  const f=scene({fetch:async(_url,{signal})=>{
    notify();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const directory=await mkdtemp(join(tmpdir(),'roc-review-query-restart-'));
  let db,imports,review,search;
  try {
    const run=f.reviews.start(f.request,actor);await ready;
    const path=join(directory,'research.sqlite');await f.db.backup(path);await f.reviews.shutdown();
    db=new Database(path);db.pragma('foreign_keys = ON');
    const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    let newRequests=0;search=new api.LiteratureSearchService(async()=>{newRequests++;throw new Error('restart_must_not_dispatch');},governor());
    imports=new api.LiteratureImportService(db,repository.library,search,prepare,async()=>{},()=>f.time);imports.recover();
    review=new api.ResearchReviewSearchService(db,repository,imports,error=>f.errors.push(error),()=>f.time);review.recover();
    const interrupted=review.get({projectId:f.project.id,reviewSearchId:run.snapshot.id});
    assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.coverageComplete,false);assert.ok(interrupted.receipt.executionId);
    assert.equal(db.prepare('SELECT status FROM research_literature_search_executions WHERE id=?').pluck().get(interrupted.receipt.executionId),'interrupted');
    assert.ok(db.prepare('SELECT state FROM research_literature_request_receipts WHERE execution_id=?').all(interrupted.receipt.executionId)
      .every(row=>row.state==='unknown'));
    assert.equal(newRequests,0);assert.equal(f.errors.length,0);
    assert.equal(db.prepare('SELECT count(*) FROM research_review_protocol_freezes').pluck().get(),1);
  }finally{await review?.shutdown();await imports?.shutdown();await search?.shutdown();db?.close();await f.dispose();await rm(directory,{recursive:true,force:true});}
});

test('generated search bridge binds sender, validates full pool paging and denies model/no-sender/forged scope before dispatch',async()=>{
  const f=scene();
  try {
    const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewSearchCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewSearchCapabilities({pluginId:'research',capabilities:registry},f.reviews);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)});
    const before=f.changes();
    await assert.rejects(registry.invoke('research.reviewSearch.start',f.request),error=>error.code==='research_human_required');
    const denied=await bridge.invoke('research.startReviewSearch',[f.request]);assert.equal(denied.ok,false);
    assert.equal(denied.error.code,'research_sender_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-search-start',[{...f.request,actor}]));
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-search-start',[f.request,41]));
    assert.equal(f.changes(),before);assert.equal(f.calls.length,0);
    const started=await bridge.invoke('research.startReviewSearch',[f.request],41);assert.equal(started.ok,true,JSON.stringify(started));
    assert.deepEqual(started.data.snapshot.actor,{kind:'user',id:'window:41'});
    const done=await terminal(f,started.data),readonly=f.changes();
    const get=await bridge.invoke('research.getReviewSearch',[{projectId:f.project.id,reviewSearchId:done.snapshot.id}],41);
    const pool=await bridge.invoke('research.getReviewSearchPool',[{projectId:f.project.id,reviewSearchId:done.snapshot.id,offset:0,limit:2}],41);
    const list=await bridge.invoke('research.listReviewSearches',[{projectId:f.project.id,versionId:f.protocol.version.id,limit:10}],41);
    for(const result of [get,pool,list])assert.equal(result.ok,true,JSON.stringify(result));
    assert.deepEqual(get.data,done);assert.equal(pool.data.pool.total,4);assert.equal(pool.data.pool.records.length,2);
    assert.deepEqual(list.data,[done]);assert.equal(f.changes(),readonly);assert.equal(f.errors.length,0);
  }finally{await f.dispose();}
});

test('terminal persistence failure surfaces lost state and recovery retains actual completed pool without rerunning',async()=>{
  const f=scene();
  try {
    f.db.exec("CREATE TRIGGER fail_review_terminal BEFORE UPDATE OF receipt_json ON research_review_searches BEGIN SELECT RAISE(ABORT,'synthetic_review_storage_failure'); END;");
    const run=f.reviews.start(f.request,actor);
    await assert.rejects(terminal(f,run),/research_review_search_state_lost/);
    assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/synthetic_review_storage_failure/);
    assert.equal(f.db.prepare('SELECT status FROM research_review_searches WHERE id=?').pluck().get(run.snapshot.id),'running');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_literature_search_pools').pluck().get(),1);
    f.db.exec('DROP TRIGGER fail_review_terminal');f.reviews.recover();
    const recovered=f.reviews.get({projectId:f.project.id,reviewSearchId:run.snapshot.id});
    assert.equal(recovered.status,'interrupted');assert.equal(recovered.coverageComplete,false);assert.equal(recovered.rawRecordCount,4);
    assert.equal(f.calls.length,2);
  }finally{await f.dispose();}
});

test('terminal receipt deletion refuses instead of returning an empty successful corpus',async()=>{
  const f=scene();
  try {
    const done=await terminal(f,f.reviews.start(f.request,actor));
    f.db.prepare('UPDATE research_review_searches SET receipt_json=NULL WHERE id=?').run(done.snapshot.id);
    const before=f.changes();
    assert.throws(()=>f.reviews.get({projectId:f.project.id,reviewSearchId:done.snapshot.id}),/research_review_search_snapshot_invalid/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('provider ledger receipt drift is refused even when the preserved raw pool still has its original valid hash',async()=>{
  const f=scene();
  try {
    const done=await terminal(f,f.reviews.start(f.request,actor));
    const receipt=f.db.prepare('SELECT * FROM research_literature_request_receipts WHERE execution_id=? ORDER BY attempt LIMIT 1')
      .get(done.receipt.executionId),changed=JSON.parse(receipt.receipt_json);
    changed.status=201;
    f.db.prepare('UPDATE research_literature_request_receipts SET receipt_json=? WHERE execution_id=? AND source=? AND attempt=?')
      .run(JSON.stringify(changed),done.receipt.executionId,receipt.source,receipt.attempt);
    const before=f.changes();
    assert.throws(()=>f.reviews.get({projectId:f.project.id,reviewSearchId:done.snapshot.id}),/research_review_search_ledger_conflict/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('project release aborts only its own active query and keeps another project execution intact',async()=>{
  let notify;const ready=new Promise(resolve=>{notify=resolve;});
  const f=scene({fetch:async(_url,{signal})=>{
    notify();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  try {
    const other=f.repository.createProject({title:'Other live review',description:'Synthetic',workspacePath:'/tmp/other-live-review'});
    const body=reviewProtocolBodyFixture();body.databases[0].queries=['other controlled query'];
    const draft=f.repository.systematicReviews.save({projectId:other.id,requestId:'other-protocol',protocolId:null,
      expectedVersionId:null,expectedVersionHash:null,body,deviationReason:null},actor);
    const frozen=f.repository.systematicReviews.freeze({projectId:other.id,requestId:'other-confirm',versionId:draft.version.id,
      expectedVersionHash:draft.versionHash,reviewNote:'Other controlled query.'},actor);
    const first=f.reviews.start(f.request,actor);await ready;
    const second=f.reviews.start({...f.request,projectId:other.id,versionId:frozen.version.id,expectedFreezeHash:frozen.freezeHash},actor);
    await f.reviews.releaseProject(f.project.id);
    assert.equal(f.reviews.get({projectId:f.project.id,reviewSearchId:first.snapshot.id}).status,'cancelled');
    assert.equal(f.reviews.get({projectId:other.id,reviewSearchId:second.snapshot.id}).status,'running');
    await f.reviews.releaseProject(other.id);
    assert.equal(f.reviews.get({projectId:other.id,reviewSearchId:second.snapshot.id}).status,'cancelled');
    assert.equal(f.errors.length,0);
  }finally{await f.dispose();}
});

test('DB27 upgrade preserves frozen protocol bytes and migration receipts without fabricating searches',()=>{
  const oldApi={...api,applyResearchDatabaseSchema(db,now) {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(value=>value.version<=27),now});
  }};
  const f=createResearchFixture(oldApi,'reading');
  try {
    const draft=f.repository.systematicReviews.save({projectId:f.project.id,requestId:'old-protocol',protocolId:null,
      expectedVersionId:null,expectedVersionHash:null,body:reviewProtocolBodyFixture(),deviationReason:null},actor);
    const frozen=f.repository.systematicReviews.freeze({projectId:f.project.id,requestId:'old-confirm',versionId:draft.version.id,
      expectedVersionHash:draft.versionHash,reviewNote:'Frozen before search storage migration.'},actor);
    const versions=f.db.prepare('SELECT * FROM research_review_protocol_versions').all();
    const receipts=f.db.prepare('SELECT * FROM research_review_protocol_freezes').all();
    const migrations=f.db.prepare('SELECT * FROM schema_migrations').all();
    api.applyResearchDatabaseSchema(f.db);
    assert.equal(f.db.prepare('SELECT current_version FROM schema_metadata').pluck().get(),api.researchMigrations.at(-1).version);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_protocol_versions').all(),versions);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_protocol_freezes').all(),receipts);
    assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=27').all(),migrations);
    assert.deepEqual(f.repository.systematicReviews.get({projectId:f.project.id,versionId:draft.version.id}),frozen);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_searches').pluck().get(),0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_search_cancellations').pluck().get(),0);
  }finally{f.close();}
});
