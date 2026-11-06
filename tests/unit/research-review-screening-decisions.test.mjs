import {applyOfflineResearchSchema} from './fixtures/offline-migration.mjs';
import {createReviewMigrationSeedApi} from './fixtures/research-review-migration-seed.mjs';
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewScreeningPlanFixture, reviewScreeningActorFixture as actor,
  reviewScreeningReviewerAFixture as reviewerA, reviewScreeningReviewerBFixture as reviewerB} from './fixtures/research-review-screening.mjs';
import {reviewSearchPayloadFixture} from './fixtures/research-review-search.mjs';
import {reviewProtocolBodyFixture} from './fixtures/research-review-protocol.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
const include={decision:'include',inclusionCriterionIds:['controlled'],reason:'The reported title meets the declared comparison criterion.'};
const exclude={decision:'exclude',exclusionCriterionId:'no-outcome',reason:'The provided material does not report the required outcome.'};
const uncertain={decision:'uncertain',reason:'The original abstract is missing; an outcome cannot be judged from this material.'};
const origin={kind:'agent_tool',operationId:'controlled-operation',idempotencyKey:'controlled-idempotency',
  toolCallId:'controlled-tool-call',canonicalToolIdentity:'capability:research.reviewScreening.suggest',toolVersion:'1',
  attemptId:'first-attempt',capabilityName:'research.reviewScreening.suggest',capabilityVersion:'1.0.0'};
async function scene({removeDuplicate=false,...options}={},selectedApi=api) {
  const f=await createReviewScreeningPlanFixture(api,{freeze:false,...options},selectedApi);
  if(removeDuplicate)f.dedup.save(f.save(4,0,'remove-duplicate'),actor);
  f.frozen=f.dedup.freeze(f.freeze(),actor);f.input.expectedDedupFreezeHash=f.frozen.freezeHash;
  f.plan=f.screening.createPlan(f.input,actor);f.phase={...f.get,phase:'title_abstract'};
  f.target=(index,requestId)=>({...f.get,expectedPlanHash:f.plan.snapshotHash,hitId:f.corpus.snapshot.hits[index].id,
    phase:'title_abstract',requestId});
  f.decision=(index,reviewerId,requestId,outcome=include,extra={})=>({...f.target(index,requestId),reviewerId,outcome,
    consideredSuggestion:null,parentDecisionId:null,expectedParentHash:null,revisionReason:null,...extra});
  return f;
}

test('two declared human decisions create pending/conflict/consensus states with fixed raw refs and conserved title counts',async()=>{
  const f=await scene({removeDuplicate:true});
  try {
    const original=f.corpora.get(f.get),start=f.decisions.getPhase(f.phase);assert.equal(start.counts.recordsToScreen,7);assert.equal(start.counts.pending,7);
    const first=f.decisions.save(f.decision(0,reviewerA.id,'a-0'),actor);
    assert.deepEqual(first.snapshot.material.hit,f.corpus.snapshot.hits[0]);
    assert.deepEqual(first.snapshot.material.source,f.corpus.snapshot.sources[0]);assert.equal(first.snapshot.material.abstractStatus,'missing');
    assert.deepEqual(first.snapshot.reviewer,reviewerA);assert.deepEqual(first.snapshot.actor,actor);
    assert.equal(f.decisions.getPhase(f.phase).items[0].status,'pending');
    f.decisions.save(f.decision(0,reviewerB.id,'b-0',exclude),actor);
    const conflicted=f.decisions.getPhase(f.phase);assert.equal(conflicted.items[0].status,'conflict');assert.equal(conflicted.counts.conflict,1);
    f.decisions.save(f.decision(1,reviewerA.id,'a-1'),actor);f.decisions.save(f.decision(1,reviewerB.id,'b-1'),actor);
    f.decisions.save(f.decision(2,reviewerA.id,'a-2',exclude),actor);f.decisions.save(f.decision(2,reviewerB.id,'b-2',exclude),actor);
    f.decisions.save(f.decision(3,reviewerA.id,'a-3',uncertain),actor);f.decisions.save(f.decision(3,reviewerB.id,'b-3'),actor);
    const phase=f.decisions.getPhase(f.phase);
    assert.deepEqual(phase.counts,{recordsToScreen:7,pending:3,uncertain:1,conflict:1,included:1,excluded:1});
    assert.deepEqual(phase.items.map(item=>item.hit.id),f.frozen.freeze.screenableHitIds);
    assert.deepEqual(f.corpora.get(f.get),original);assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(),0);
    assert.ok(!('freeze' in phase));assert.ok(!('fullTextExcluded' in phase.counts));
  }finally{await f.dispose();}
});

test('agreement on exclusion with different primary reasons remains a conflict rather than choosing a reason for the user',async()=>{
  const body=reviewProtocolBodyFixture();body.exclusionCriteria.push({id:'wrong-population',text:'Population outside the declared scope.'});
  const f=await scene({protocolBody:body});
  try {
    f.decisions.save(f.decision(0,reviewerA.id,'a',exclude),actor);
    f.decisions.save(f.decision(0,reviewerB.id,'b',{...exclude,exclusionCriterionId:'wrong-population'}),actor);
    const phase=f.decisions.getPhase(f.phase);
    assert.equal(phase.items[0].status,'conflict');assert.equal(phase.counts.conflict,1);assert.equal(phase.counts.excluded,0);
    assert.deepEqual(phase.items[0].decisions.map(value=>value.snapshot.request.outcome.exclusionCriterionId),['no-outcome','wrong-population']);
  }finally{await f.dispose();}
});

test('single-reviewer decisions and revisions preserve prior versions, exact parent hashes and replay authority',async()=>{
  const f=await scene({screening:{titleAbstractReviewers:1,fullTextReviewers:2,conflictResolution:'human_adjudication'}});
  try {
    const request=f.decision(0,reviewerA.id,'first',uncertain),first=f.decisions.save(request,actor);
    assert.equal(f.decisions.getPhase(f.phase).items[0].status,'uncertain');
    const revision=f.decision(0,reviewerA.id,'revision',exclude,{parentDecisionId:first.snapshot.id,
      expectedParentHash:first.snapshotHash,revisionReason:'Explicit re-examination of the captured title.'});
    const second=f.decisions.save(revision,actor),before=f.changes();
    assert.equal(second.snapshot.version,2);assert.equal(f.decisions.getPhase(f.phase).items[0].status,'excluded');
    assert.deepEqual(f.decisions.history({...f.get,decisionId:first.snapshot.id}),[{...first,isLatest:false},second]);
    assert.deepEqual(f.decisions.save(request,actor),{...first,isLatest:false});assert.deepEqual(f.decisions.save(revision,actor),second);
    assert.throws(()=>f.decisions.save({...revision,requestId:'stale'},actor),/research_review_screening_version_conflict/);
    assert.throws(()=>f.decisions.save({...request,requestId:'no-parent'},actor),/research_review_screening_version_conflict/);
    assert.throws(()=>f.decisions.save(revision,{kind:'user',id:'other-caller'}),/research_review_request_conflict/);
    assert.throws(()=>f.decisions.save({...revision,outcome:include},actor),/research_review_request_conflict/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('agent proposals stay separate from human decisions; considering a proposal does not force the human verdict',async()=>{
  const f=await scene();
  try {
    const suggestion=f.decisions.suggest({...f.target(0,'proposal'),outcome:include},origin);
    assert.deepEqual(suggestion.snapshot.origin,origin);assert.equal(suggestion.snapshot.material.abstractStatus,'missing');
    const phase=f.decisions.getPhase(f.phase);assert.equal(phase.items[0].suggestionCount,1);
    assert.equal(phase.items[0].decisions.length,0);assert.equal(phase.counts.pending,8);assert.equal(phase.counts.included,0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_decisions').pluck().get(),0);
    const human=f.decisions.save(f.decision(0,reviewerA.id,'human',uncertain,{
      consideredSuggestion:{id:suggestion.snapshot.id,expectedHash:suggestion.snapshotHash}}),actor);
    assert.deepEqual(human.snapshot.request.outcome,uncertain);assert.deepEqual(human.snapshot.request.consideredSuggestion,{id:suggestion.snapshot.id,expectedHash:suggestion.snapshotHash});
    assert.deepEqual(f.decisions.listSuggestions({...f.phase,hitId:f.target(0,'').hitId,offset:0,limit:20}),[suggestion]);
    assert.equal(f.decisions.getPhase(f.phase).items[0].status,'pending');
  }finally{await f.dispose();}
});

test('raw missing and present abstracts remain original material facts rather than generated screening data',async()=>{
  const f=await scene({fetch:async url=>{
    const payload=reviewSearchPayloadFixture(Number(new URL(url).searchParams.get('page')));
    for(const record of payload.results)record.abstract_inverted_index={Controlled:[0],abstract:[1]};
    return Response.json(payload);
  }});
  try {
    const original=f.corpora.getHit({...f.get,hitId:f.target(0,'').hitId});
    assert.equal(original.record.record.abstract,'Controlled abstract');
    const human=f.decisions.save(f.decision(0,reviewerA.id,'human'),actor);
    assert.equal(human.snapshot.material.abstractStatus,'present');
    assert.deepEqual(f.corpora.getHit({...f.get,hitId:f.target(0,'').hitId}),original);
  }finally{await f.dispose();}
});

test('strict declared reviewer/criterion/plan/hit contracts refuse removed duplicates and forged or incomplete inputs without writes',async()=>{
  const f=await scene({removeDuplicate:true});
  try {
    const valid=f.decision(0,reviewerA.id,'valid'),before=f.changes();
    for(const request of [{...valid,actor},{...valid,phase:'full_text'},{...valid,outcome:{decision:'include',reason:'No criteria'}},
      {...valid,outcome:{...include,inclusionCriterionIds:['controlled','controlled']}},{...valid,outcome:{decision:'exclude',reason:'Missing criterion'}},
      {...valid,outcome:{...uncertain,reason:''}},{...valid,expectedParentHash:'a'.repeat(64)}])assert.throws(()=>f.decisions.save(request,actor));
    assert.throws(()=>f.decisions.save({...valid,reviewerId:'unknown'},actor),/research_review_screening_reviewer_not_declared/);
    assert.throws(()=>f.decisions.save({...valid,outcome:{...include,inclusionCriterionIds:['unknown']}},actor),/research_review_screening_criterion_not_declared/);
    assert.throws(()=>f.decisions.save({...valid,outcome:{...exclude,exclusionCriterionId:'controlled'}},actor),/research_review_screening_criterion_not_declared/);
    assert.throws(()=>f.decisions.save(f.decision(4,reviewerA.id,'removed'),actor),/research_review_screening_hit_not_screenable/);
    assert.throws(()=>f.decisions.save({...valid,expectedPlanHash:'a'.repeat(64)},actor),/research_review_screening_version_conflict/);
    assert.throws(()=>f.decisions.save({...valid,consideredSuggestion:{id:'missing',expectedHash:'a'.repeat(64)}},actor),/research_review_screening_suggestion_not_found/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('proposal operation identity replays its first attempt; content, operation and considered-source drift cannot overwrite observations',async()=>{
  const f=await scene();
  try {
    const request={...f.target(0,'proposal'),outcome:include},first=f.decisions.suggest(request,origin);
    const other=f.decisions.suggest({...f.target(1,'other-proposal'),outcome:uncertain},{...origin,operationId:'other'});
    const before=f.changes();assert.deepEqual(f.decisions.suggest(request,{...origin,attemptId:'retry-attempt'}),first);
    assert.throws(()=>f.decisions.suggest({...request,outcome:uncertain},origin),/research_review_request_conflict/);
    assert.throws(()=>f.decisions.suggest(request,{...origin,operationId:'changed'}),/research_review_request_conflict/);
    assert.throws(()=>f.decisions.suggest(request,{...origin,capabilityVersion:'changed'}),/research_review_request_conflict/);
    assert.throws(()=>f.decisions.save(f.decision(0,reviewerA.id,'wrong-hash',include,{
      consideredSuggestion:{id:first.snapshot.id,expectedHash:'a'.repeat(64)}}),actor),/research_review_screening_version_conflict/);
    assert.throws(()=>f.decisions.save(f.decision(0,reviewerA.id,'wrong-hit',include,{
      consideredSuggestion:{id:other.snapshot.id,expectedHash:other.snapshotHash}}),actor),/research_review_screening_version_conflict/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('historical protocol and archive retain exact reviewer/proposal history but refuse new observations',async()=>{
  const f=await scene();
  try {
    const decision=f.decisions.save(f.decision(0,reviewerA.id,'human'),actor);
    const proposal=f.decisions.suggest({...f.target(0,'proposal'),outcome:uncertain},origin);
    const beforeState=f.decisions.getPhase(f.phase);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'later',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later protocol.'},actor);
    const before=f.changes(),historical=f.decisions.getPhase(f.phase);
    assert.deepEqual(historical,{...beforeState,plan:{...beforeState.plan,currentProtocol:false}});
    assert.deepEqual(f.decisions.history({...f.get,decisionId:decision.snapshot.id}),[decision]);
    assert.deepEqual(f.decisions.listSuggestions({...f.phase,hitId:proposal.snapshot.request.hitId,offset:0,limit:5}),[proposal]);
    assert.throws(()=>f.decisions.save(f.decision(1,reviewerA.id,'new'),actor),/research_review_screening_version_conflict/);
    assert.throws(()=>f.decisions.suggest({...f.target(1,'new-proposal'),outcome:include},origin),/research_review_screening_version_conflict/);
    assert.equal(f.changes(),before);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const archived=f.changes();assert.deepEqual(f.decisions.getPhase(f.phase),historical);
    assert.throws(()=>f.decisions.save(f.decision(1,reviewerA.id,'archived'),actor),/research_project_archived/);
    assert.throws(()=>f.decisions.suggest({...f.target(1,'archived-proposal'),outcome:include},origin),/research_project_archived/);
    assert.equal(f.changes(),archived);
  }finally{await f.dispose();}
});

test('changed parent/material and proposal bytes are explicit read errors with no loss of human/proposal separation',async()=>{
  const f=await scene();
  try {
    const first=f.decisions.save(f.decision(0,reviewerA.id,'first',uncertain),actor);
    f.decisions.save(f.decision(0,reviewerA.id,'second',include,{parentDecisionId:first.snapshot.id,
      expectedParentHash:first.snapshotHash,revisionReason:'Explicit re-examination.'}),actor);
    const parent=f.db.prepare('SELECT * FROM research_review_screening_decisions WHERE id=?').get(first.snapshot.id);
    f.db.prepare("UPDATE research_review_screening_decisions SET phase='full_text' WHERE id=?").run(first.snapshot.id);
    assert.throws(()=>f.decisions.getPhase(f.phase),/research_review_screening_snapshot_invalid/);
    f.db.prepare("UPDATE research_review_screening_decisions SET phase='title_abstract' WHERE id=?").run(first.snapshot.id);
    const changed=JSON.parse(parent.snapshot_json);changed.material.hit.recordHash='a'.repeat(64);const json=JSON.stringify(changed);
    f.db.prepare('UPDATE research_review_screening_decisions SET snapshot_json=?,snapshot_hash=? WHERE id=?').run(json,hash(json),parent.id);
    assert.throws(()=>f.decisions.getPhase(f.phase),/research_review_screening_snapshot_invalid/);
    f.db.prepare('UPDATE research_review_screening_decisions SET snapshot_json=?,snapshot_hash=? WHERE id=?').run(parent.snapshot_json,parent.snapshot_hash,parent.id);
    const proposal=f.decisions.suggest({...f.target(1,'proposal'),outcome:uncertain},origin);
    const corrupted=JSON.stringify({...proposal.snapshot,recordedAt:'2026-11-04T01:00:00.000Z'});
    f.db.prepare('UPDATE research_review_screening_suggestions SET snapshot_json=? WHERE id=?').run(corrupted,proposal.snapshot.id);
    const before=f.changes();
    assert.throws(()=>f.decisions.getPhase(f.phase),/research_review_screening_snapshot_invalid/);
    assert.throws(()=>f.decisions.listSuggestions({...f.phase,hitId:proposal.snapshot.request.hitId,offset:0,limit:5}),/research_review_screening_snapshot_invalid/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('post-insert decision corruption and lost proposal row roll back rather than acknowledging unsaved data',async()=>{
  const f=await scene();
  try {
    f.db.exec("CREATE TRIGGER corrupt_screening_decision AFTER INSERT ON research_review_screening_decisions BEGIN UPDATE research_review_screening_decisions SET snapshot_hash='changed' WHERE id=NEW.id; END;");
    assert.throws(()=>f.decisions.save(f.decision(0,reviewerA.id,'human'),actor),/research_review_screening_snapshot_invalid/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_decisions').pluck().get(),0);
    f.db.exec('DROP TRIGGER corrupt_screening_decision');
    f.db.exec('CREATE TRIGGER lose_screening_proposal AFTER INSERT ON research_review_screening_suggestions BEGIN DELETE FROM research_review_screening_suggestions WHERE id=NEW.id; END;');
    assert.throws(()=>f.decisions.suggest({...f.target(0,'proposal'),outcome:include},origin),/research_review_screening_snapshot_invalid/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_suggestions').pluck().get(),0);
    f.db.exec('DROP TRIGGER lose_screening_proposal');assert.equal(f.decisions.save(f.decision(0,reviewerA.id,'human'),actor).snapshot.version,1);
  }finally{await f.dispose();}
});

test('registered APIs enforce human decision authority and actual main tool provenance for proposals',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry(),receipts=[];
    for(const descriptor of api.researchReviewScreeningCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewScreeningCapabilities({pluginId:'research',capabilities:registry},f.screening,f.decisions,f.arbitration,f.freezing);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)});
    const proposalRequest={...f.target(0,'proposal'),outcome:include},humanRequest=f.decision(0,reviewerA.id,'human',uncertain),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewScreening.suggest',proposalRequest),error=>error.code==='research_review_screening_tool_context_required');
    await assert.rejects(registry.invoke('research.reviewScreening.save',humanRequest),error=>error.code==='research_human_required');
    await assert.rejects(registry.invoke('research.reviewScreening.suggest',{...proposalRequest,origin}));
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-screening-save',[{...humanRequest,actor}]));
    const noSender=await bridge.invoke('research.saveReviewScreeningDecision',[humanRequest]);
    assert.equal(noSender.ok,false);assert.equal(noSender.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const operation=api.createCapabilityOperationContext({...origin,toolName:'screening-proposal',leaseGeneration:1,recordReceipt:value=>receipts.push(value)});
    const suggestion=await api.runWithCapabilityOperationContext(operation,()=>registry.invoke('research.reviewScreening.suggest',proposalRequest));
    assert.deepEqual(suggestion.snapshot.origin,origin);assert.equal(receipts[0].capabilityName,'research.reviewScreening.suggest');
    assert.equal(receipts[0].phase,'request_sent');
    const saved=await bridge.invoke('research.saveReviewScreeningDecision',[humanRequest],81);
    assert.equal(saved.ok,true,JSON.stringify(saved));assert.deepEqual(saved.data.snapshot.actor,{kind:'user',id:'window:81'});
    const readonly=f.changes(),phase=await bridge.invoke('research.getReviewScreeningPhase',[f.phase],81);
    const history=await bridge.invoke('research.getReviewScreeningDecisionHistory',[{...f.get,decisionId:saved.data.snapshot.id}],81);
    const proposals=await bridge.invoke('research.listReviewScreeningSuggestions',[{...f.phase,hitId:proposalRequest.hitId,offset:0,limit:5}],81);
    assert.equal(phase.ok,true);assert.equal(history.ok,true);assert.equal(proposals.ok,true);
    assert.deepEqual(proposals.data,[suggestion]);assert.deepEqual(history.data,[saved.data]);assert.equal(phase.data.counts.pending,8);
    assert.equal(f.changes(),readonly);
  }finally{await f.dispose();}
});

test('failed zero-hit source remains empty/coverage-incomplete and cannot invent screening material',async()=>{
  const f=await scene({fetch:async()=>new Response('actual offline failure',{status:500})});
  try {
    const before=f.changes(),phase=f.decisions.getPhase(f.phase);
    assert.deepEqual(phase.items,[]);assert.deepEqual(phase.counts,{recordsToScreen:0,pending:0,uncertain:0,conflict:0,included:0,excluded:0});
    assert.equal(f.corpus.searchCoverageComplete,false);
    assert.throws(()=>f.decisions.save({...f.get,expectedPlanHash:f.plan.snapshotHash,hitId:'guessed',phase:'title_abstract',
      requestId:'invented',reviewerId:reviewerA.id,outcome:include,consideredSuggestion:null,parentDecisionId:null,
      expectedParentHash:null,revisionReason:null},actor),/research_review_screening_hit_not_screenable/);
    assert.equal(f.changes(),before);
  }finally{await f.dispose();}
});

test('DB31 upgrade and actual disk reopen preserve reviewed title decisions/proposals without new requests or fabricated rows',async()=>{
  const oldApi=createReviewMigrationSeedApi(api,31);
  const f=await scene({},oldApi),directory=await mkdtemp(join(tmpdir(),'roc-screening-decisions-reopen-'));
  let db,reviews;
  try {
    oldApi.finishSeed(f.db);
    const tables=['research_review_screening_plans','research_review_corpora','research_review_deduplication_freezes',
      'research_review_protocol_versions','research_review_searches'];
    const columns=tables.map(table=>f.db.pragma(`table_info(${table})`).map(column=>column.name).join(','));
    const before=tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all()),migrations=f.db.prepare('SELECT * FROM schema_migrations').all();
    applyOfflineResearchSchema(api, f.db);
    tables.forEach((table,index)=>assert.deepEqual(f.db.prepare(`SELECT ${columns[index]} FROM ${table}`).all(),before[index]));
    assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=31').all(),migrations);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_decisions').pluck().get(),0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_suggestions').pluck().get(),0);
    f.decisions.save(f.decision(0,reviewerA.id,'human',uncertain),actor);f.decisions.suggest({...f.target(0,'proposal'),outcome:include},origin);
    const phase=f.decisions.getPhase(f.phase),path=join(directory,'research.sqlite');await f.db.backup(path);await f.reviews.releaseProject(f.project.id);
    assert.deepEqual(f.decisions.getPhase(f.phase),phase);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>{},()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time);
    const dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const plans=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time);
    const decisions=new api.ResearchReviewScreeningDecisions(db,repository,corpora,dedup,plans,()=>f.time),changes=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(decisions.getPhase(f.phase),phase);assert.equal(db.prepare('SELECT total_changes()').pluck().get(),changes);
    assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await reviews?.shutdown();db?.close();await f.dispose();await rm(directory,{recursive:true,force:true});}
});
