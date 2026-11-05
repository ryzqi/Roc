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
import {seedPreFreezeReviewerDecision, seedPreFreezeArbitration} from './fixtures/research-screening-migration-seed.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
const include={decision:'include',inclusionCriterionIds:['controlled'],reason:'Title meets the declared comparison criterion.'};
const exclude={decision:'exclude',exclusionCriterionId:'no-outcome',reason:'Required outcome absent from actual material.'};
const uncertain={decision:'uncertain',reason:'Original abstract missing.'};
const origin={kind:'agent_tool',operationId:'freeze-proposal-operation',idempotencyKey:'freeze-proposal-request',
  toolCallId:'freeze-tool-call',canonicalToolIdentity:'screening-proposal',toolVersion:'1',attemptId:'attempt-1',
  capabilityName:'research.reviewScreening.suggest',capabilityVersion:'1.0.0'};
async function scene(options={},selectedApi=api) {
  const f=await createReviewScreeningPlanFixture(api,options,selectedApi);f.plan=f.screening.createPlan(f.input,actor);
  f.phase={...f.get,phase:'title_abstract'};
  f.decision=(index,reviewerId,requestId,outcome=include,extra={})=>({...f.phase,hitId:f.corpus.snapshot.hits[index].id,
    expectedPlanHash:f.plan.snapshotHash,requestId,reviewerId,outcome,consideredSuggestion:null,
    parentDecisionId:null,expectedParentHash:null,revisionReason:null,...extra});
  f.finish=({seed=false}={})=>{
    f.votes=[];
    for(let index=0;index<f.corpus.snapshot.hits.length;index++) {
      for(const reviewer of f.plan.snapshot.request.titleAbstractReviewers) {
        const outcome=index===0&&reviewer.id===reviewerB.id||index===1?exclude:include;
        const request=f.decision(index,reviewer.id,`vote-${index}-${reviewer.id}`,outcome);
        f.votes.push(seed?seedPreFreezeReviewerDecision(api,f,request,actor):f.decisions.save(request,actor));
      }
    }
    if(f.corpus.snapshot.hits.length>0&&f.plan.snapshot.request.titleAbstractReviewers.length===2) {
      const raw=f.decisions.getPhase(f.phase).items[0];
      f.arbitrationInput={...f.phase,hitId:raw.hit.id,expectedPlanHash:f.plan.snapshotHash,requestId:'adjudicate-first',reviewerId:adjudicator.id,
        outcome:include,decisions:raw.decisions.map(decision=>({id:decision.snapshot.id,expectedHash:decision.snapshotHash})),
        parentArbitrationId:null,expectedParentHash:null,revisionReason:null};
      f.arbitrated=seed?seedPreFreezeArbitration(api,f,f.arbitrationInput,actor):f.arbitration.save(f.arbitrationInput,actor);
    }
  };
  f.freezeInput=()=>({...f.phase,requestId:'freeze-title',expectedReviewHash:f.freezing.getPhase(f.phase).reviewHash,
    reviewNote:'All displayed reviewer/adjudication versions explicitly checked.'});
  return f;
}

test('whole title freeze seals all actual hit/reviewer/arbitration references and exact counts without rewriting raw records',async()=>{
  const f=await scene();
  try {
    f.finish();const before=f.corpora.get(f.get),phase=f.freezing.getPhase(f.phase);assert.equal(phase.freeze,null);
    assert.deepEqual(phase.counts,{recordsToScreen:8,pending:0,uncertain:0,conflict:0,included:7,excluded:1});
    const frozen=f.freezing.freeze(f.freezeInput(),actor);
    assert.equal(frozen.freeze.reviewHash,phase.reviewHash);assert.equal(frozen.reviewHash,phase.reviewHash);
    assert.equal(hash(JSON.stringify(frozen.freeze.authority)),phase.reviewHash);
    assert.deepEqual(frozen.freeze.authority.items.map(item=>item.hit),f.corpus.snapshot.hits);
    assert.deepEqual(frozen.freeze.authority.items[0].arbitration,{id:f.arbitrated.snapshot.id,expectedHash:f.arbitrated.snapshotHash});
    assert.equal(frozen.freeze.authority.items[1].primaryExclusionCriterionId,'no-outcome');
    assert.equal(frozen.freeze.authority.items[0].primaryExclusionCriterionId,null);
    assert.ok(frozen.freeze.authority.items.every(item=>item.decisions.length===2));
    assert.ok(frozen.freeze.authority.items.every(item=>!('record' in item)&&!('abstract' in item)));
    assert.deepEqual(f.corpora.get(f.get),before);
    const readonly=f.changes();assert.deepEqual(f.freezing.requireFrozen(f.project.id,f.corpus.snapshot.id,frozen.freezeHash),frozen);
    assert.deepEqual(f.freezing.getPhase(f.phase),frozen);assert.equal(f.changes(),readonly);
  }finally{await f.dispose();}
});

test('pending, uncertainty and conflict prevent whole-phase freezing and a stale displayed authority hash cannot confirm new decisions',async()=>{
  const f=await scene();
  try {
    const pending=f.freezeInput(),before=f.changes();
    assert.throws(()=>f.freezing.freeze(pending,actor),/research_review_screening_incomplete/);
    assert.throws(()=>f.freezing.requireFrozen(f.project.id,f.corpus.snapshot.id,'a'.repeat(64)),/research_review_screening_not_frozen/);
    assert.equal(f.changes(),before);
    f.decisions.save(f.decision(0,reviewerA.id,'uncertain',uncertain),actor);
    f.decisions.save(f.decision(0,reviewerB.id,'second'),actor);
    assert.equal(f.freezing.getPhase(f.phase).counts.uncertain,1);
    assert.throws(()=>f.freezing.freeze(pending,actor),/research_review_screening_version_conflict/);
    assert.throws(()=>f.freezing.freeze(f.freezeInput(),actor),/research_review_screening_incomplete/);
    for(let index=1;index<8;index++)for(const reviewer of [reviewerA,reviewerB])f.decisions.save(f.decision(index,reviewer.id,`new-${index}-${reviewer.id}`),actor);
    assert.throws(()=>f.freezing.freeze(f.freezeInput(),actor),/research_review_screening_incomplete/);
    const vote=f.decisions.getPhase(f.phase).items[0].decisions[0];
    f.decisions.save(f.decision(0,reviewerA.id,'resolved',include,{parentDecisionId:vote.snapshot.id,expectedParentHash:vote.snapshotHash,revisionReason:'Explicit reread.'}),actor);
    assert.equal(f.freezing.freeze(f.freezeInput(),actor).freeze.authority.counts.included,8);
  }finally{await f.dispose();}
});

test('proposal counts do not alter human authority; frozen phase blocks new votes/proposals/arbitration while exact requests replay readonly',async()=>{
  const f=await scene();
  try {
    f.finish();const displayed=f.freezeInput(),before=f.freezing.getPhase(f.phase);
    const proposalRequest={...f.phase,hitId:f.corpus.snapshot.hits[0].id,expectedPlanHash:f.plan.snapshotHash,requestId:'proposal',outcome:uncertain};
    const proposal=f.decisions.suggest(proposalRequest,origin),after=f.freezing.getPhase(f.phase);
    assert.equal(after.reviewHash,before.reviewHash);assert.equal(after.items[0].suggestionCount,1);
    const frozen=f.freezing.freeze(displayed,actor),readonly=f.changes();
    assert.deepEqual(f.decisions.suggest(proposalRequest,origin),proposal);
    assert.deepEqual(f.decisions.save(f.votes[0].snapshot.request,actor),f.votes[0]);
    assert.deepEqual(f.arbitration.save(f.arbitrationInput,actor),f.arbitrated);
    assert.deepEqual(f.freezing.freeze(displayed,actor),frozen);
    assert.throws(()=>f.decisions.save({...f.votes[0].snapshot.request,requestId:'new-vote'},actor),/research_review_screening_already_frozen/);
    assert.throws(()=>f.decisions.suggest({...proposalRequest,requestId:'new-proposal'},origin),/research_review_screening_already_frozen/);
    assert.throws(()=>f.arbitration.save({...f.arbitrationInput,requestId:'new-arbitration'},actor),/research_review_screening_already_frozen/);
    assert.throws(()=>f.freezing.freeze({...displayed,requestId:'new-freeze'},actor),/research_review_screening_already_frozen/);
    assert.throws(()=>f.freezing.freeze(displayed,{kind:'user',id:'other'}),/research_review_request_conflict/);
    assert.throws(()=>f.freezing.requireFrozen(f.project.id,f.corpus.snapshot.id,'a'.repeat(64)),/research_review_screening_version_conflict/);
    assert.equal(f.changes(),readonly);
  }finally{await f.dispose();}
});

test('marked receipt deletion cannot reopen writes; frozen receipt/authority drift is a read error instead of empty success',async()=>{
  const f=await scene();
  try {
    f.finish();const frozen=f.freezing.freeze(f.freezeInput(),actor),row=f.db.prepare('SELECT * FROM research_review_screening_freezes').get();
    f.db.prepare('DELETE FROM research_review_screening_freezes').run();
    const before=f.changes();
    assert.throws(()=>f.freezing.getPhase(f.phase),/research_review_screening_snapshot_invalid/);
    assert.throws(()=>f.decisions.save(f.decision(0,reviewerA.id,'reset'),actor),/research_review_screening_snapshot_invalid/);
    assert.throws(()=>f.arbitration.save({...f.arbitrationInput,requestId:'reset-arbitration'},actor),/research_review_screening_snapshot_invalid/);
    assert.equal(f.changes(),before);
    f.db.prepare('INSERT INTO research_review_screening_freezes VALUES (?,?,?,?,?,?,?)')
      .run(row.project_id,row.corpus_id,row.phase,row.request_id,row.snapshot_json,row.snapshot_hash,row.created_at);
    assert.deepEqual(f.freezing.getPhase(f.phase),frozen);
    const changed=JSON.parse(row.snapshot_json);changed.authority.items[1].primaryExclusionCriterionId='invented';
    const json=JSON.stringify(changed);
    f.db.prepare('UPDATE research_review_screening_freezes SET snapshot_json=?').run(json);
    assert.throws(()=>f.freezing.getPhase(f.phase),/research_review_screening_snapshot_invalid/);
  }finally{await f.dispose();}
});

test('lost receipt and post-insert source drift roll back freeze, marker and all injected changes',async()=>{
  const f=await scene();
  try {
    f.finish();const votes=f.db.prepare('SELECT * FROM research_review_screening_decisions').all();
    f.db.exec('CREATE TRIGGER lose_title_receipt AFTER INSERT ON research_review_screening_freezes BEGIN DELETE FROM research_review_screening_freezes WHERE corpus_id=NEW.corpus_id; END;');
    assert.throws(()=>f.freezing.freeze(f.freezeInput(),actor),/research_review_screening_snapshot_invalid/);
    assert.equal(f.db.prepare('SELECT title_freeze_hash FROM research_review_screening_plans').pluck().get(),null);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_freezes').pluck().get(),0);
    f.db.exec('DROP TRIGGER lose_title_receipt');
    f.db.exec("CREATE TRIGGER drift_title_votes AFTER INSERT ON research_review_screening_freezes BEGIN UPDATE research_review_screening_decisions SET snapshot_hash='changed'; END;");
    assert.throws(()=>f.freezing.freeze(f.freezeInput(),actor),/research_review_screening_snapshot_invalid/);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_screening_decisions').all(),votes);
    assert.equal(f.db.prepare('SELECT title_freeze_hash FROM research_review_screening_plans').pluck().get(),null);
    f.db.exec('DROP TRIGGER drift_title_votes');
    f.db.function('late_vote',json=>{
      const original=JSON.parse(json),request=api.researchReviewScreeningDecisionSaveSchema.parse({
        ...original.request,requestId:'late-freeze-vote',parentDecisionId:original.id,expectedParentHash:hash(json),
        revisionReason:'Controlled valid revision during freeze storage.'});
      return JSON.stringify(api.researchReviewScreeningDecisionSnapshotSchema.parse({
        ...original,id:'late-freeze-vote',version:original.version+1,request,requestHash:hash(JSON.stringify(request))}));
    });
    f.db.function('late_vote_hash',hash);
    f.db.exec(`CREATE TRIGGER append_title_vote AFTER INSERT ON research_review_screening_freezes BEGIN
      INSERT INTO research_review_screening_decisions
        (id,project_id,corpus_id,phase,hit_id,reviewer_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
      SELECT 'late-freeze-vote',project_id,corpus_id,phase,hit_id,reviewer_id,version+1,id,
        'late-freeze-vote',late_vote(snapshot_json),late_vote_hash(late_vote(snapshot_json)),created_at
      FROM research_review_screening_decisions WHERE request_id='vote-0-declared-researcher-a';
    END;`);
    assert.throws(()=>f.freezing.freeze(f.freezeInput(),actor),/research_review_screening_snapshot_invalid/);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_screening_decisions').all(),votes);
    assert.equal(f.db.prepare('SELECT title_freeze_hash FROM research_review_screening_plans').pluck().get(),null);
    f.db.exec('DROP TRIGGER append_title_vote');assert.ok(f.freezing.freeze(f.freezeInput(),actor).freezeHash);
  }finally{await f.dispose();}
});

test('historical protocol and archive keep fixed frozen authority readable while current full-text authorization and new freezes refuse',async()=>{
  const f=await scene();
  try {
    f.finish();const frozen=f.freezing.freeze(f.freezeInput(),actor);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'later',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later protocol.'},actor);
    const before=f.changes(),historical={...frozen,plan:{...frozen.plan,currentProtocol:false}};
    assert.deepEqual(f.freezing.getPhase(f.phase),historical);assert.equal(historical.reviewHash,frozen.reviewHash);
    assert.throws(()=>f.freezing.requireFrozen(f.project.id,f.corpus.snapshot.id,frozen.freezeHash),/research_review_screening_version_conflict/);
    assert.equal(f.changes(),before);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const archived=f.changes();assert.deepEqual(f.freezing.getPhase(f.phase),historical);
    assert.throws(()=>f.freezing.freeze({...f.freezeInput(),requestId:'archived'},actor),/research_project_archived/);assert.equal(f.changes(),archived);
  }finally{await f.dispose();}
});

test('generated freeze API binds actual sender and exact displayed authority hash; read is readonly and tools cannot freeze',async()=>{
  const f=await scene();
  try {
    f.finish();const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewScreeningCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewScreeningCapabilities({pluginId:'research',capabilities:registry},f.screening,f.decisions,f.arbitration,f.freezing);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)}),request=f.freezeInput(),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewScreening.freeze',request),error=>error.code==='research_human_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-screening-freeze',[{...request,actor}]));
    const noSender=await bridge.invoke('research.freezeReviewScreeningPhase',[request]);
    assert.equal(noSender.ok,false);assert.equal(noSender.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const saved=await bridge.invoke('research.freezeReviewScreeningPhase',[request],101);
    assert.equal(saved.ok,true,JSON.stringify(saved));assert.deepEqual(saved.data.freeze.actor,{kind:'user',id:'window:101'});
    const readonly=f.changes(),read=await bridge.invoke('research.getReviewScreeningPhase',[f.phase],101);
    assert.equal(read.ok,true);assert.deepEqual(read.data,saved.data);assert.equal(f.changes(),readonly);
  }finally{await f.dispose();}
});

test('DB33 upgrade preserves canonical pre-freeze votes/arbitration and disk reopen retains the resulting freeze without new requests',async()=>{
  const oldApi=createReviewMigrationSeedApi(api,33);
  const f=await scene({},oldApi),directory=await mkdtemp(join(tmpdir(),'roc-title-freeze-reopen-'));
  let db,reviews;
  try {
    f.finish({seed:true});
    oldApi.finishSeed(f.db);
    const tables=['research_review_screening_plans','research_review_screening_decisions','research_review_screening_arbitrations',
      'research_review_screening_suggestions','research_review_corpora','research_review_deduplication_freezes','research_review_protocol_versions'];
    const columns=tables.map(table=>f.db.pragma(`table_info(${table})`).map(column=>column.name).join(','));
    const before=tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all()),migrations=f.db.prepare('SELECT * FROM schema_migrations').all();
    api.applyResearchDatabaseSchema(f.db);
    tables.forEach((table,index)=>assert.deepEqual(f.db.prepare(`SELECT ${columns[index]} FROM ${table}`).all(),before[index]));
    assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=33').all(),migrations);
    assert.equal(f.db.prepare('SELECT title_freeze_hash FROM research_review_screening_plans').pluck().get(),null);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_freezes').pluck().get(),0);
    const frozen=f.freezing.freeze(f.freezeInput(),actor),path=join(directory,'research.sqlite');await f.db.backup(path);await f.reviews.releaseProject(f.project.id);
    assert.deepEqual(f.freezing.getPhase(f.phase),frozen);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>{},()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time),dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const plans=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time);
    const decisions=new api.ResearchReviewScreeningDecisions(db,repository,corpora,dedup,plans,()=>f.time),arbitration=new api.ResearchReviewScreeningArbitration(db,repository,decisions,()=>f.time);
    const freezing=new api.ResearchReviewScreeningFreeze(db,repository,arbitration,()=>f.time),changes=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(freezing.getPhase(f.phase),frozen);assert.deepEqual(freezing.requireFrozen(f.project.id,f.corpus.snapshot.id,frozen.freezeHash),frozen);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),changes);assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await reviews?.shutdown();db?.close();await f.dispose();await rm(directory,{recursive:true,force:true});}
});

test('failed zero-hit source needs explicit empty-set freeze and its incomplete search coverage remains unchanged',async()=>{
  const f=await scene({fetch:async()=>new Response('actual offline failure',{status:500})});
  try {
    const phase=f.freezing.getPhase(f.phase);assert.equal(phase.counts.recordsToScreen,0);assert.equal(phase.freeze,null);
    const frozen=f.freezing.freeze(f.freezeInput(),actor);assert.deepEqual(frozen.freeze.authority.items,[]);
    assert.equal(frozen.freeze.authority.counts.included,0);assert.equal(frozen.freeze.authority.counts.excluded,0);
    assert.equal(f.corpora.get(f.get).searchCoverageComplete,false);
  }finally{await f.dispose();}
});
