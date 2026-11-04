import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewFullTextScreeningFixture,fullTextActor as actor,fullTextInclude as include,
  fullTextExclude as exclude,fullTextUncertain as uncertain} from './fixtures/research-review-fulltext-screening.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
async function scene({votes=true,...options}={}) {
  const f=await createReviewFullTextScreeningFixture(api,options);await f.bind();
  if(votes) {
    f.votes=[];
    for(const [index,reviewer] of f.reviewerIds.entries())f.votes.push(await f.fullScreening.save(f.vote(0,reviewer,`reviewer-${index}`,
      f.reviewerIds.length===1?uncertain:index===0?include:exclude),actor));
  }
  f.resolve=(requestId='resolve',outcome=exclude)=>({...f.target(0,requestId),reviewerId:f.plan.snapshot.request.adjudicator.id,outcome,
    decisions:f.fullScreening.getPhase(f.fullPhase).items[0].decisions.map(decision=>({id:decision.snapshot.id,expectedHash:decision.snapshotHash})),
    parentArbitrationId:null,expectedParentHash:null,revisionReason:null});
  return f;
}
const count=f=>f.db.prepare("SELECT count(*) FROM research_review_screening_arbitrations WHERE phase='full_text'").pluck().get();

test('fulltext adjudication pins complete current votes and actual bound source, resolving only the derived view',async()=>{
  const f=await scene();
  try {
    const original=f.fullScreening.getPhase(f.fullPhase),title=f.freezing.getPhase(f.phase),binding=f.fulltexts.get(f.bindingGet(f.bound.get(0).snapshot.id));
    assert.equal(original.items[0].status,'conflict');
    const result=await f.fullArbitration.save(f.resolve(),actor),resolved=f.fullArbitration.getPhase(f.fullPhase);
    assert.equal(result.currentDecisionSet,true);assert.equal(result.isLatest,true);
    assert.deepEqual(result.snapshot.adjudicator,f.plan.snapshot.request.adjudicator);assert.deepEqual(result.snapshot.actor,actor);
    assert.deepEqual(result.snapshot.material,f.votes[0].snapshot.material);
    assert.deepEqual(result.snapshot.request.decisions,f.resolve().decisions);assert.equal(result.snapshotHash,hash(JSON.stringify(result.snapshot)));
    assert.equal(resolved.items[0].status,'excluded');assert.equal(resolved.counts.conflict,0);assert.equal(resolved.counts.excluded,1);
    assert.deepEqual(resolved.items[0].decisions,original.items[0].decisions);assert.deepEqual(resolved.items[0].arbitration,result);
    assert.deepEqual(f.fullScreening.getPhase(f.fullPhase),original);assert.deepEqual(f.freezing.getPhase(f.phase),title);
    assert.deepEqual(f.fulltexts.get(f.bindingGet(binding.snapshot.id)),binding);
    const before=f.changes();assert.deepEqual(await f.fullArbitration.save(result.snapshot.request,actor),result);
    assert.deepEqual(f.fullArbitration.history({...f.get,arbitrationId:result.snapshot.id}),[result]);assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('valid reviewer revision makes prior fulltext arbitration stale and a new exact-parent adjudication preserves both histories',async()=>{
  const f=await scene();
  try {
    const first=await f.fullArbitration.save(f.resolve(),actor);
    const revision=await f.fullScreening.save(f.vote(0,f.reviewerIds[1],'revised-vote',uncertain,{
      parentDecisionId:f.votes[1].snapshot.id,expectedParentHash:f.votes[1].snapshotHash,revisionReason:'Reviewer now cannot judge the same source.'}),actor);
    const phase=f.fullArbitration.getPhase(f.fullPhase);
    assert.equal(phase.items[0].status,'uncertain');assert.equal(phase.items[0].arbitration.currentDecisionSet,false);
    assert.deepEqual(f.fullArbitration.history({...f.get,arbitrationId:first.snapshot.id}),[{...first,currentDecisionSet:false}]);
    const input={...f.resolve('resolve-revision',include),parentArbitrationId:first.snapshot.id,
      expectedParentHash:first.snapshotHash,revisionReason:'Adjudicator inspected the complete revised reviewer set.'};
    const next=await f.fullArbitration.save(input,actor);
    assert.equal(next.snapshot.version,2);assert.equal(f.fullArbitration.getPhase(f.fullPhase).items[0].status,'included');
    assert.ok(next.snapshot.request.decisions.some(ref=>ref.id===revision.snapshot.id));
    const before=f.changes();
    assert.deepEqual(f.fullArbitration.history({...f.get,arbitrationId:next.snapshot.id}),[{...first,isLatest:false,currentDecisionSet:false},next]);
    await assert.rejects(f.fullArbitration.save({...input,requestId:'stale-parent'},actor),/research_review_screening_version_conflict/);
    await assert.rejects(f.fullArbitration.save(input,{kind:'user',id:'other'}),/research_review_request_conflict/);
    assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('incomplete, agreed, changed or duplicate refs and undeclared reviewer/criterion/strict input cannot create adjudication',async()=>{
  const f=await scene();
  try {
    const valid=f.resolve(),before=f.changes();
    for(const [input,error] of [
      [{...valid,decisions:valid.decisions.slice(0,1)},/research_review_screening_arbitration_decisions_changed/],
      [{...valid,decisions:valid.decisions.map((ref,index)=>index===0?{...ref,expectedHash:'a'.repeat(64)}:ref)},/research_review_screening_arbitration_decisions_changed/],
      [{...valid,reviewerId:'undeclared'},/research_review_screening_adjudicator_not_declared/],
      [{...valid,expectedPlanHash:'a'.repeat(64)},/research_review_screening_version_conflict/],
      [{...valid,expectedBindingHash:'a'.repeat(64)},/research_review_fulltext_version_conflict/],
      [{...valid,outcome:{...exclude,exclusionCriterionId:'guessed'}},/research_review_screening_criterion_not_declared/]
    ])await assert.rejects(f.fullArbitration.save(input,actor),error);
    for(const input of [{...valid,actor},{...valid,outcome:uncertain},{...valid,phase:'title_abstract'},
      {...valid,decisions:[valid.decisions[0],valid.decisions[0]]}])await assert.rejects(f.fullArbitration.save(input,actor));
    assert.equal(f.changes(),before);assert.equal(count(f),0);
  }finally{await f.cleanup();}
  const pending=await scene({votes:false});
  try {
    const first=await pending.fullScreening.save(pending.vote(0,pending.reviewerIds[0],'only-one'),actor);
    await assert.rejects(pending.fullArbitration.save({...pending.resolve(),decisions:[{id:first.snapshot.id,expectedHash:first.snapshotHash}]},actor),
      /research_review_screening_arbitration_incomplete/);
    await pending.fullScreening.save(pending.vote(0,pending.reviewerIds[1],'agreement'),actor);
    await assert.rejects(pending.fullArbitration.save(pending.resolve(),actor),/research_review_screening_arbitration_not_needed/);
    assert.equal(count(pending),0);
  }finally{await pending.cleanup();}
});

test('single-reviewer uncertain fulltext verdict can be explicitly resolved by its declared human adjudicator',async()=>{
  const f=await scene({screening:{titleAbstractReviewers:2,fullTextReviewers:1,conflictResolution:'human_adjudication'}});
  try {
    assert.equal(f.fullScreening.getPhase(f.fullPhase).items[0].status,'uncertain');
    const result=await f.fullArbitration.save(f.resolve('single-resolve',include),actor);
    assert.equal(result.snapshot.request.decisions.length,1);assert.equal(f.fullArbitration.getPhase(f.fullPhase).items[0].status,'included');
  }finally{await f.cleanup();}
});

test('source reparse or explicit not-retrieved revision cannot retain effective adjudication or authorize another eligibility decision',async()=>{
  const f=await scene();
  try {
    const result=await f.fullArbitration.save(f.resolve(),actor),binding=f.bound.get(0);
    f.reparse();const changed=f.fullArbitration.getPhase(f.fullPhase);
    assert.equal(changed.items[0].status,'source_changed');assert.equal(changed.items[0].arbitration.currentDecisionSet,false);
    await assert.rejects(f.fullArbitration.save({...f.resolve('changed-source'),parentArbitrationId:result.snapshot.id,
      expectedParentHash:result.snapshotHash,revisionReason:'Attempt on expired source.'},actor),/research_review_fulltext_version_conflict/);
    const gap=await f.fulltexts.save({...f.notRetrieved(0,'now-unavailable'),parentBindingId:binding.snapshot.id,
      expectedParentHash:binding.snapshotHash,revisionReason:'Human declares no available fulltext source.'},actor);
    const unavailable=f.fullArbitration.getPhase(f.fullPhase);
    assert.equal(unavailable.items[0].status,'not_retrieved');assert.equal(unavailable.items[0].arbitration.currentDecisionSet,false);
    await assert.rejects(f.fullArbitration.save({...f.resolve('gap'),bindingId:gap.snapshot.id,expectedBindingHash:gap.snapshotHash,
      parentArbitrationId:result.snapshot.id,expectedParentHash:result.snapshotHash,revisionReason:'Attempt without source.'},actor),/research_review_fulltext_not_retrieved/);
    assert.equal(count(f),1);assert.equal(unavailable.counts.excluded,0);assert.equal(unavailable.counts.not_retrieved,1);
  }finally{await f.cleanup();}
});

test('real byte failure and a valid reviewer version appended after adjudication insert reject acknowledgment and roll back new rows',async()=>{
  const f=await scene();
  try {
    const valid=f.resolve();await writeFile(f.sourcePath,Buffer.from('source replaced'));const before=f.changes();
    await assert.rejects(f.fullArbitration.save(valid,actor),/research_document_source_changed/);
    assert.equal(f.changes(),before);await writeFile(f.sourcePath,f.original);
    const parent=f.votes[1],request=api.researchReviewFullTextDecisionSaveSchema.parse(f.vote(0,f.reviewerIds[1],'late-vote',exclude,{
      parentDecisionId:parent.snapshot.id,expectedParentHash:parent.snapshotHash,revisionReason:'Valid current vote appended during storage.'}));
    const snapshot=api.researchReviewFullTextDecisionSnapshotSchema.parse({...parent.snapshot,id:'late-valid-fulltext-vote',
      version:2,request,requestHash:hash(JSON.stringify(request))});
    const json=JSON.stringify(snapshot),quote=value=>`'${value.replaceAll("'","''")}'`;
    f.db.exec(`CREATE TRIGGER valid_fulltext_revision AFTER INSERT ON research_review_screening_arbitrations WHEN NEW.phase='full_text' BEGIN
      INSERT INTO research_review_screening_decisions
      (id,project_id,corpus_id,phase,hit_id,reviewer_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
      VALUES (${[snapshot.id,request.projectId,request.corpusId,request.phase,request.hitId,request.reviewerId].map(quote).join(',')},2,
        ${[request.parentDecisionId,request.requestId,json,hash(json),snapshot.recordedAt].map(quote).join(',')}); END;`);
    await assert.rejects(f.fullArbitration.save(valid,actor),/research_review_screening_arbitration_decisions_changed/);
    assert.equal(count(f),0);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_decisions WHERE id=?').pluck().get(snapshot.id),0);
    assert.deepEqual(f.fullScreening.getPhase(f.fullPhase).items[0].decisions,f.votes);
    f.db.exec('DROP TRIGGER valid_fulltext_revision');
    const result=await f.fullArbitration.save(valid,actor);assert.equal(result.currentDecisionSet,true);
  }finally{await f.cleanup();}
});

test('corrupt material and source drift during insert fail explicitly without changing reviewer history',async()=>{
  const f=await scene();
  try {
    f.db.exec("CREATE TRIGGER arb_source_drift AFTER INSERT ON research_review_screening_arbitrations WHEN NEW.phase='full_text' BEGIN UPDATE research_documents SET current_parse_id=NULL; END;");
    await assert.rejects(f.fullArbitration.save(f.resolve(),actor),/research_review_fulltext_version_conflict/);
    assert.equal(count(f),0);assert.equal(f.repository.documents.get(f.document.id).currentParseId,f.selection.parseId);
    f.db.exec('DROP TRIGGER arb_source_drift');
    const result=await f.fullArbitration.save(f.resolve(),actor),row=f.db.prepare('SELECT * FROM research_review_screening_arbitrations WHERE id=?').get(result.snapshot.id);
    const changed=JSON.parse(row.snapshot_json);changed.material.binding.expectedHash='a'.repeat(64);const json=JSON.stringify(changed);
    f.db.prepare('UPDATE research_review_screening_arbitrations SET snapshot_json=?,snapshot_hash=? WHERE id=?').run(json,hash(json),row.id);
    const before=f.changes();assert.throws(()=>f.fullArbitration.getPhase(f.fullPhase),/research_review_screening_snapshot_invalid/);
    assert.equal(f.changes(),before);assert.deepEqual(f.fullScreening.getPhase(f.fullPhase).items[0].decisions,f.votes);
  }finally{await f.cleanup();}
});

test('historical protocol and archive preserve current source/ref-matched adjudication for readonly review and deny new writes',async()=>{
  const f=await scene();
  try {
    const result=await f.fullArbitration.save(f.resolve(),actor);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'new-protocol',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later protocol.'},actor);
    const phase=f.fullArbitration.getPhase(f.fullPhase);assert.equal(phase.plan.currentProtocol,false);
    assert.equal(phase.items[0].status,'excluded');assert.deepEqual(f.fullArbitration.history({...f.get,arbitrationId:result.snapshot.id}),[result]);
    const before=f.changes();await assert.rejects(f.fullArbitration.save(f.resolve('new'),actor),/research_review_screening_version_conflict/);
    assert.equal(f.changes(),before);f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.deepEqual(f.fullArbitration.getPhase(f.fullPhase),phase);
    await assert.rejects(f.fullArbitration.save(f.resolve('archive'),actor),/research_project_archived/);
  }finally{await f.cleanup();}
});

test('generated main API requires actual sender for async fulltext adjudication and transports resolved phase/history readonly',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewFullTextScreeningCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewFullTextScreeningCapabilities({pluginId:'research',capabilities:registry},f.fullScreening,f.fullArbitration);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)}),input=f.resolve(),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewFullTextScreening.adjudicate',input),error=>error.code==='research_human_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-fulltext-adjudicate',[{...input,actor}]));
    const missing=await bridge.invoke('research.adjudicateReviewFullText',[input]);assert.equal(missing.ok,false);
    assert.equal(missing.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const saved=await bridge.invoke('research.adjudicateReviewFullText',[input],131);
    assert.equal(saved.ok,true,JSON.stringify(saved));assert.deepEqual(saved.data.snapshot.actor,{kind:'user',id:'window:131'});
    const readonly=f.changes(),phase=await bridge.invoke('research.getReviewFullTextScreeningPhase',[f.fullPhase],131);
    const history=await bridge.invoke('research.getReviewFullTextArbitrationHistory',[{...f.get,arbitrationId:saved.data.snapshot.id}],131);
    assert.equal(phase.ok,true);assert.equal(history.ok,true);assert.deepEqual(history.data,[saved.data]);
    assert.deepEqual(phase.data.items[0].arbitration,saved.data);assert.equal(phase.data.counts.excluded,1);assert.equal(f.changes(),readonly);
  }finally{await f.cleanup();}
});

test('SQLite reopening keeps fulltext adjudication and reviewer/source histories without another import or execution',async()=>{
  const f=await scene();let db,reviews,service;
  try {
    const result=await f.fullArbitration.save(f.resolve(),actor),phase=f.fullArbitration.getPhase(f.fullPhase);
    const path=join(f.root,'reopened-review.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time),dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const plans=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time),titlesVotes=new api.ResearchReviewScreeningDecisions(db,repository,corpora,dedup,plans,()=>f.time);
    const titlesArbitration=new api.ResearchReviewScreeningArbitration(db,repository,titlesVotes,()=>f.time),titles=new api.ResearchReviewScreeningFreeze(db,repository,titlesArbitration,()=>f.time);
    service=new api.ResearchDocumentService(repository,{},f.root);
    const bindings=new api.ResearchReviewFullTextRepository(db,repository,corpora,titles,service,()=>f.time);
    const votes=new api.ResearchReviewFullTextScreening(db,repository,titles,bindings,()=>f.time);
    const arbitration=new api.ResearchReviewFullTextArbitration(db,repository,votes,bindings,()=>f.time);
    const before=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(arbitration.getPhase(f.fullPhase),phase);
    assert.deepEqual(arbitration.history({...f.get,arbitrationId:result.snapshot.id}),[result]);
    assert.deepEqual(votes.history({...f.get,decisionId:f.votes[0].snapshot.id}),[f.votes[0]]);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await service?.shutdown();await reviews?.shutdown();db?.close();await f.cleanup();}
});
