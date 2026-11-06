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
  reviewScreeningReviewerAFixture as reviewerA, reviewScreeningReviewerBFixture as reviewerB,
  reviewScreeningAdjudicatorFixture as adjudicator} from './fixtures/research-review-screening.mjs';
import {reviewProtocolBodyFixture} from './fixtures/research-review-protocol.mjs';
import {seedPreFreezeReviewerDecision} from './fixtures/research-screening-migration-seed.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
const include={decision:'include',inclusionCriterionIds:['controlled'],reason:'Actual material meets the declared comparison criterion.'};
const exclude={decision:'exclude',exclusionCriterionId:'no-outcome',reason:'Required outcome not reported in provided material.'};
const uncertain={decision:'uncertain',reason:'Actual abstract is missing.'};
async function scene(options={},selectedApi=api) {
  const f=await createReviewScreeningPlanFixture(api,options,selectedApi);
  f.plan=f.screening.createPlan(f.input,actor);f.phase={...f.get,phase:'title_abstract'};
  f.decision=(index,reviewerId,requestId,outcome=include,extra={})=>({...f.get,phase:'title_abstract',hitId:f.corpus.snapshot.hits[index].id,
    expectedPlanHash:f.plan.snapshotHash,requestId,reviewerId,outcome,consideredSuggestion:null,
    parentDecisionId:null,expectedParentHash:null,revisionReason:null,...extra});
  f.disagree=()=>{f.decisions.save(f.decision(0,reviewerA.id,'a'),actor);return f.decisions.save(f.decision(0,reviewerB.id,'b',exclude),actor);};
  f.inputForArbitration=(index=0)=>({...f.get,phase:'title_abstract',expectedPlanHash:f.plan.snapshotHash,hitId:f.corpus.snapshot.hits[index].id,
    requestId:'arbitrate',reviewerId:adjudicator.id,outcome:include,
    decisions:f.decisions.getPhase(f.phase).items[index].decisions.map(decision=>({id:decision.snapshot.id,expectedHash:decision.snapshotHash})),
    parentArbitrationId:null,expectedParentHash:null,revisionReason:null});
  return f;
}

test('declared human adjudication resolves exact complete conflicting decisions while preserving both originals and conserved counts',async()=>{
  const f=await scene();
  try {
    f.disagree();const original=f.db.prepare('SELECT * FROM research_review_screening_decisions').all();
    const request=f.inputForArbitration(),decision=f.arbitration.save({...request,decisions:[...request.decisions].reverse()},actor);
    assert.deepEqual(decision.snapshot.adjudicator,adjudicator);assert.deepEqual(decision.snapshot.actor,actor);
    assert.equal(decision.currentDecisionSet,true);assert.equal(decision.isLatest,true);
    assert.deepEqual(decision.snapshot.material,f.decisions.getPhase(f.phase).items[0].decisions[0].snapshot.material);
    const resolved=f.arbitration.getPhase(f.phase);
    assert.equal(resolved.items[0].status,'included');assert.deepEqual(resolved.items[0].arbitration,decision);
    assert.deepEqual(resolved.counts,{recordsToScreen:8,pending:7,uncertain:0,conflict:0,included:1,excluded:0});
    assert.equal(f.decisions.getPhase(f.phase).items[0].status,'conflict');
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_screening_decisions').all(),original);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(),0);
  }finally{await f.dispose();}
});

test('different primary exclusion reasons and explicit single-reviewer uncertainty can each be resolved by the declared adjudicator',async()=>{
  const body=reviewProtocolBodyFixture();body.exclusionCriteria.push({id:'wrong-population',text:'Population outside declared scope.'});
  for(const options of [{protocolBody:body},{screening:{titleAbstractReviewers:1,fullTextReviewers:2,conflictResolution:'human_adjudication'}}]) {
    const f=await scene(options);
    try {
      if(options.protocolBody) {
        f.decisions.save(f.decision(0,reviewerA.id,'a',exclude),actor);
        f.decisions.save(f.decision(0,reviewerB.id,'b',{...exclude,exclusionCriterionId:'wrong-population'}),actor);
      }else f.decisions.save(f.decision(0,reviewerA.id,'a',uncertain),actor);
      const arbitration=f.arbitration.save({...f.inputForArbitration(),outcome:exclude},actor);
      assert.equal(arbitration.currentDecisionSet,true);
      const resolved=f.arbitration.getPhase(f.phase);assert.equal(resolved.items[0].status,'excluded');assert.equal(resolved.counts.excluded,1);
      assert.equal(resolved.items[0].arbitration.snapshot.request.outcome.exclusionCriterionId,'no-outcome');
    }finally{await f.dispose();}
  }
});

test('pending and agreed reviewer sets, undeclared adjudicators and incomplete/current-hash drift cannot be arbitrated',async()=>{
  const f=await scene();
  try {
    f.decisions.save(f.decision(0,reviewerA.id,'a'),actor);
    const pending=f.inputForArbitration(),before=f.changes();
    assert.throws(()=>f.arbitration.save(pending,actor),/research_review_screening_arbitration_incomplete/);
    assert.equal(f.changes(),before);
    f.decisions.save(f.decision(0,reviewerB.id,'b'),actor);
    assert.throws(()=>f.arbitration.save(f.inputForArbitration(),actor),/research_review_screening_arbitration_not_needed/);
    f.decisions.save(f.decision(1,reviewerA.id,'a-1'),actor);f.decisions.save(f.decision(1,reviewerB.id,'b-1',exclude),actor);
    const valid=f.inputForArbitration(1),readonly=f.changes();
    assert.throws(()=>f.arbitration.save({...valid,reviewerId:reviewerA.id},actor),/research_review_screening_adjudicator_not_declared/);
    assert.throws(()=>f.arbitration.save({...valid,decisions:valid.decisions.slice(0,1)},actor),/research_review_screening_arbitration_decisions_changed/);
    assert.throws(()=>f.arbitration.save({...valid,decisions:valid.decisions.map(ref=>({...ref,expectedHash:'a'.repeat(64)}))},actor),/research_review_screening_arbitration_decisions_changed/);
    for(const input of [{...valid,actor},{...valid,outcome:uncertain},{...valid,decisions:[valid.decisions[0],valid.decisions[0]]},
      {...valid,expectedParentHash:'a'.repeat(64)}])assert.throws(()=>f.arbitration.save(input,actor));
    assert.throws(()=>f.arbitration.save({...valid,outcome:{...exclude,exclusionCriterionId:'unknown'}},actor),/research_review_screening_criterion_not_declared/);
    assert.equal(f.changes(),readonly);
  }finally{await f.dispose();}
});

test('reviewer revisions make prior arbitration stale; a new immutable arbitration must bind current decisions and exact prior arbitration',async()=>{
  const f=await scene();
  try {
    const vote=f.disagree(),input=f.inputForArbitration(),first=f.arbitration.save(input,actor);
    const original=f.db.prepare('SELECT * FROM research_review_screening_arbitrations').all();
    f.decisions.save(f.decision(0,reviewerB.id,'review-again',exclude,{parentDecisionId:vote.snapshot.id,
      expectedParentHash:vote.snapshotHash,revisionReason:'Re-examined original title; retained reason.'}),actor);
    const stale=f.arbitration.getPhase(f.phase);assert.equal(stale.items[0].status,'conflict');assert.equal(stale.items[0].arbitration.currentDecisionSet,false);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_screening_arbitrations').all(),original);
    const before=f.changes();assert.deepEqual(f.arbitration.save(input,actor),{...first,currentDecisionSet:false});
    assert.throws(()=>f.arbitration.save({...input,requestId:'stale-click'},actor),/research_review_screening_arbitration_decisions_changed/);
    assert.throws(()=>f.arbitration.save({...f.inputForArbitration(),requestId:'missing-parent'},actor),/research_review_screening_version_conflict/);
    assert.equal(f.changes(),before);
    const revision={...f.inputForArbitration(),requestId:'new-arbitration',outcome:exclude,parentArbitrationId:first.snapshot.id,
      expectedParentHash:first.snapshotHash,revisionReason:'New exact reviewer versions inspected.'};
    const second=f.arbitration.save(revision,actor);assert.equal(second.snapshot.version,2);assert.equal(second.currentDecisionSet,true);
    const readonly=f.changes();assert.deepEqual(f.arbitration.save(revision,actor),second);
    assert.throws(()=>f.arbitration.save(revision,{kind:'user',id:'other'}),/research_review_request_conflict/);
    assert.deepEqual(f.arbitration.history({...f.get,arbitrationId:first.snapshot.id}),
      [{...first,isLatest:false,currentDecisionSet:false},second]);assert.equal(f.changes(),readonly);
    assert.equal(f.arbitration.getPhase(f.phase).items[0].status,'excluded');
  }finally{await f.dispose();}
});

test('arbitration snapshot and parent corruption fail inspection without resetting saved reviewer decisions',async()=>{
  const f=await scene();
  try {
    f.disagree();const first=f.arbitration.save(f.inputForArbitration(),actor);
    f.arbitration.save({...f.inputForArbitration(),requestId:'revision',outcome:exclude,parentArbitrationId:first.snapshot.id,
      expectedParentHash:first.snapshotHash,revisionReason:'Revised explicit human judgment.'},actor);
    const old=f.db.prepare('SELECT * FROM research_review_screening_arbitrations WHERE id=?').get(first.snapshot.id);
    const changed=JSON.parse(old.snapshot_json);changed.material.hit.recordHash='a'.repeat(64);const json=JSON.stringify(changed);
    f.db.prepare('UPDATE research_review_screening_arbitrations SET snapshot_json=?,snapshot_hash=? WHERE id=?').run(json,hash(json),old.id);
    const before=f.changes();
    assert.throws(()=>f.arbitration.getPhase(f.phase),/research_review_screening_snapshot_invalid/);
    assert.throws(()=>f.arbitration.history({...f.get,arbitrationId:first.snapshot.id}),/research_review_screening_snapshot_invalid/);
    assert.equal(f.changes(),before);assert.equal(f.decisions.getPhase(f.phase).items[0].status,'conflict');
  }finally{await f.dispose();}
});

test('post-insert reviewer-source drift aborts arbitration and rolls back both inserted judgment and injected change',async()=>{
  const f=await scene();
  try {
    f.disagree();const before=f.db.prepare('SELECT * FROM research_review_screening_decisions').all();
    f.db.exec("CREATE TRIGGER drift_arbitration_source AFTER INSERT ON research_review_screening_arbitrations BEGIN UPDATE research_review_screening_decisions SET snapshot_hash='changed'; END;");
    assert.throws(()=>f.arbitration.save(f.inputForArbitration(),actor),/research_review_screening_snapshot_invalid/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_arbitrations').pluck().get(),0);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_screening_decisions').all(),before);
    f.db.exec('DROP TRIGGER drift_arbitration_source');
    f.db.function('revised_vote',json=>{
      const snapshot=JSON.parse(json),parentHash=hash(json),parentId=snapshot.id;
      snapshot.id='trigger-new-reviewer-revision';snapshot.version+=1;
      snapshot.request={...snapshot.request,requestId:'trigger-new-reviewer-request',parentDecisionId:parentId,
        expectedParentHash:parentHash,revisionReason:'Controlled new valid reviewer revision.'};
      snapshot.requestHash=hash(JSON.stringify(snapshot.request));
      return JSON.stringify(snapshot);
    });
    f.db.function('vote_hash',hash);
    const original=f.db.prepare('SELECT * FROM research_review_screening_decisions').all();
    f.db.exec(`CREATE TRIGGER append_arbitration_vote AFTER INSERT ON research_review_screening_arbitrations BEGIN
      INSERT INTO research_review_screening_decisions
        (id,project_id,corpus_id,phase,hit_id,reviewer_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
      SELECT 'trigger-new-reviewer-revision',project_id,corpus_id,phase,hit_id,reviewer_id,version+1,id,
        'trigger-new-reviewer-request',revised_vote(snapshot_json),vote_hash(revised_vote(snapshot_json)),created_at
      FROM research_review_screening_decisions WHERE reviewer_id='declared-researcher-b';
    END;`);
    assert.throws(()=>f.arbitration.save(f.inputForArbitration(),actor),/research_review_screening_arbitration_decisions_changed/);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_screening_decisions').all(),original);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_arbitrations').pluck().get(),0);
    f.db.exec('DROP TRIGGER append_arbitration_vote');
    assert.equal(f.arbitration.save(f.inputForArbitration(),actor).currentDecisionSet,true);
  }finally{await f.dispose();}
});

test('generated adjudication API binds main sender and does not grant model tools the declared adjudicator identity',async()=>{
  const f=await scene();
  try {
    f.disagree();const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewScreeningCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewScreeningCapabilities({pluginId:'research',capabilities:registry},f.screening,f.decisions,f.arbitration,f.freezing);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)}),input=f.inputForArbitration(),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewScreening.adjudicate',input),error=>error.code==='research_human_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-screening-adjudicate',[{...input,actor}]));
    const noSender=await bridge.invoke('research.adjudicateReviewScreening',[input]);assert.equal(noSender.ok,false);
    assert.equal(noSender.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const saved=await bridge.invoke('research.adjudicateReviewScreening',[input],91);
    assert.equal(saved.ok,true,JSON.stringify(saved));assert.deepEqual(saved.data.snapshot.actor,{kind:'user',id:'window:91'});
    assert.deepEqual(saved.data.snapshot.adjudicator,adjudicator);
    const readonly=f.changes(),phase=await bridge.invoke('research.getReviewScreeningPhase',[f.phase],91);
    const history=await bridge.invoke('research.getReviewScreeningArbitrationHistory',[{...f.get,arbitrationId:saved.data.snapshot.id}],91);
    assert.equal(phase.ok,true);assert.equal(history.ok,true);assert.equal(phase.data.items[0].status,'included');
    assert.deepEqual(phase.data.items[0].arbitration,saved.data);assert.deepEqual(history.data,[saved.data]);assert.equal(f.changes(),readonly);
  }finally{await f.dispose();}
});

test('historical protocol and archive preserve exact adjudications with explicit current-protocol status and reject new judgments',async()=>{
  const f=await scene();
  try {
    f.disagree();const saved=f.arbitration.save(f.inputForArbitration(),actor),original=f.arbitration.getPhase(f.phase);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'later',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later protocol.'},actor);
    const before=f.changes(),historical={...original,plan:{...original.plan,currentProtocol:false}};
    assert.deepEqual(f.arbitration.getPhase(f.phase),historical);assert.deepEqual(f.arbitration.history({...f.get,arbitrationId:saved.snapshot.id}),[saved]);
    assert.throws(()=>f.arbitration.save({...f.inputForArbitration(),requestId:'new'},actor),/research_review_screening_version_conflict/);
    assert.equal(f.changes(),before);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const archived=f.changes();assert.deepEqual(f.arbitration.getPhase(f.phase),historical);
    assert.throws(()=>f.arbitration.save({...f.inputForArbitration(),requestId:'archived'},actor),/research_project_archived/);assert.equal(f.changes(),archived);
  }finally{await f.dispose();}
});

test('DB32 upgrade and SQLite reopen retain exact reviewer/proposal history without invented arbitration or new requests',async()=>{
  const oldApi=createReviewMigrationSeedApi(api,32);
  const f=await scene({},oldApi),directory=await mkdtemp(join(tmpdir(),'roc-screening-arbitration-reopen-'));
  let db,reviews;
  try {
    seedPreFreezeReviewerDecision(api,f,f.decision(0,reviewerA.id,'a'),actor);
    seedPreFreezeReviewerDecision(api,f,f.decision(0,reviewerB.id,'b',exclude),actor);
    oldApi.finishSeed(f.db);
    const tables=['research_review_screening_plans','research_review_screening_decisions','research_review_screening_suggestions',
      'research_review_corpora','research_review_deduplication_freezes','research_review_protocol_versions','research_review_searches'];
    const columns=tables.map(table=>f.db.pragma(`table_info(${table})`).map(column=>column.name).join(','));
    const before=tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all()),migrations=f.db.prepare('SELECT * FROM schema_migrations').all();
    applyOfflineResearchSchema(api, f.db);
    tables.forEach((table,index)=>assert.deepEqual(f.db.prepare(`SELECT ${columns[index]} FROM ${table}`).all(),before[index]));
    assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=32').all(),migrations);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_arbitrations').pluck().get(),0);
    f.arbitration.save(f.inputForArbitration(),actor);const phase=f.arbitration.getPhase(f.phase),path=join(directory,'research.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>{},()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time);
    const dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const plans=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time);
    const decisions=new api.ResearchReviewScreeningDecisions(db,repository,corpora,dedup,plans,()=>f.time);
    const arbitration=new api.ResearchReviewScreeningArbitration(db,repository,decisions,()=>f.time),changes=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(arbitration.getPhase(f.phase),phase);assert.equal(db.prepare('SELECT total_changes()').pluck().get(),changes);
    assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await reviews?.shutdown();db?.close();await f.dispose();await rm(directory,{recursive:true,force:true});}
});
