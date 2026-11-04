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
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
const scene=(options,selectedApi)=>createReviewScreeningPlanFixture(api,options,selectedApi);

test('fixed reviewer plan pins exact protocol/dedup hashes and declared identities independently from trusted caller',async()=>{
  const f=await scene();
  try {
    const corpus=f.corpora.get(f.get),dedup=f.dedup.get(f.get),plan=f.screening.createPlan(f.input,actor),before=f.changes();
    assert.deepEqual(plan.snapshot.request,f.input);assert.deepEqual(plan.snapshot.actor,actor);
    assert.deepEqual(plan.snapshot.request.titleAbstractReviewers,[reviewerA,reviewerB]);
    assert.deepEqual(plan.snapshot.request.fullTextReviewers,[reviewerB,reviewerA]);
    assert.deepEqual(plan.snapshot.request.adjudicator,adjudicator);
    assert.equal(plan.snapshot.protocolVersionId,f.protocol.version.id);assert.equal(plan.snapshot.protocolVersionHash,f.protocol.versionHash);
    assert.equal(plan.snapshot.request.expectedDedupFreezeHash,dedup.freezeHash);
    assert.equal(hash(JSON.stringify(plan.snapshot)),plan.snapshotHash);assert.equal(plan.currentProtocol,true);
    assert.deepEqual(f.screening.getPlan(f.get),plan);assert.deepEqual(f.corpora.get(f.get),corpus);assert.deepEqual(f.dedup.get(f.get),dedup);
    assert.equal(f.changes(),before);assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(),0);
    assert.ok(!('decisions' in plan.snapshot));assert.ok(!('scientificReview' in plan.snapshot));
  }finally{await f.dispose();}
});

test('both phase reviewer counts derive from the frozen protocol, with no automatic second reviewer or count downgrade',async()=>{
  for(const titleAbstractReviewers of [1,2])for(const fullTextReviewers of [1,2]) {
    const f=await scene({screening:{titleAbstractReviewers,fullTextReviewers,conflictResolution:'human_adjudication'}});
    try {
      const before=f.changes(),wrongTitle=titleAbstractReviewers===1?[reviewerA,reviewerB]:[reviewerA];
      const wrongFull=fullTextReviewers===1?[reviewerA,reviewerB]:[reviewerA];
      assert.throws(()=>f.screening.createPlan({...f.input,titleAbstractReviewers:wrongTitle},actor),/research_review_screening_reviewer_count_mismatch/);
      assert.throws(()=>f.screening.createPlan({...f.input,fullTextReviewers:wrongFull},actor),/research_review_screening_reviewer_count_mismatch/);
      assert.equal(f.changes(),before);
      const plan=f.screening.createPlan(f.input,actor);assert.equal(plan.snapshot.request.titleAbstractReviewers.length,titleAbstractReviewers);
      assert.equal(plan.snapshot.request.fullTextReviewers.length,fullTextReviewers);
    }finally{await f.dispose();}
  }
});

test('strict declarations reject duplicate reviewer IDs, inconsistent names, forged authority and missing explicit inputs',async()=>{
  const f=await scene();
  try {
    const before=f.changes();
    for(const input of [
      {...f.input,titleAbstractReviewers:[reviewerA,reviewerA]},
      {...f.input,fullTextReviewers:[reviewerB,{...reviewerA,name:'Changed identity'}]},
      {...f.input,adjudicator:{id:reviewerA.id,name:'Changed identity'}},
      {...f.input,adjudicator:null},{...f.input,reviewNote:''},{...f.input,actor},
      {...f.input,titleAbstractReviewers:[]},{...f.input,titleAbstractReviewers:[reviewerA,reviewerB,adjudicator]}
    ])assert.throws(()=>f.screening.createPlan(input,actor));
    assert.equal(f.changes(),before);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_plans').pluck().get(),0);
    assert.throws(()=>f.screening.getPlan(f.get),/research_review_screening_plan_not_found/);
  }finally{await f.dispose();}
});

test('unfrozen dedup, wrong source hashes and another project cannot produce a reviewer plan; existing plan replays readonly',async()=>{
  const f=await scene({freeze:false});
  try {
    const other=f.repository.createProject({title:'Other screening project',description:'Synthetic',workspacePath:'/tmp/other-screening'});
    const before=f.changes();
    assert.throws(()=>f.screening.createPlan(f.input,actor),/research_review_duplicate_not_frozen/);
    assert.throws(()=>f.screening.createPlan({...f.input,projectId:other.id},actor),/research_review_project_mismatch/);
    assert.throws(()=>f.screening.createPlan({...f.input,expectedCorpusHash:'c'.repeat(64)},actor),/research_review_screening_version_conflict/);
    assert.equal(f.changes(),before);
    const frozen=f.dedup.freeze(f.freeze(),actor);f.input.expectedDedupFreezeHash=frozen.freezeHash;
    const readonly=f.changes();
    assert.throws(()=>f.screening.createPlan({...f.input,expectedDedupFreezeHash:'c'.repeat(64)},actor),/research_review_duplicate_version_conflict/);
    assert.equal(f.changes(),readonly);
    const plan=f.screening.createPlan(f.input,actor),saved=f.changes();
    assert.deepEqual(f.screening.createPlan(f.input,actor),plan);
    assert.throws(()=>f.screening.createPlan(f.input,{kind:'user',id:'other-caller'}),/research_review_request_conflict/);
    assert.throws(()=>f.screening.createPlan({...f.input,reviewNote:'changed'},actor),/research_review_request_conflict/);
    assert.throws(()=>f.screening.createPlan({...f.input,requestId:'replace'},actor),/research_review_screening_plan_exists/);
    assert.throws(()=>f.screening.getPlan({...f.get,projectId:other.id}),/research_review_project_mismatch/);
    assert.equal(f.changes(),saved);
  }finally{await f.dispose();}
});

test('deleted marked plan and tampered plan bytes cannot silently reset declared reviewers',async()=>{
  const f=await scene();
  try {
    const plan=f.screening.createPlan(f.input,actor),row=f.db.prepare('SELECT * FROM research_review_screening_plans').get();
    f.db.prepare('DELETE FROM research_review_screening_plans WHERE id=?').run(row.id);
    const before=f.changes();
    assert.throws(()=>f.screening.getPlan(f.get),/research_review_screening_snapshot_invalid/);
    assert.throws(()=>f.screening.createPlan({...f.input,requestId:'reset'},actor),/research_review_screening_snapshot_invalid/);
    assert.equal(f.changes(),before);
    f.db.prepare('INSERT INTO research_review_screening_plans VALUES (?,?,?,?,?,?,?)')
      .run(row.id,row.corpus_id,row.project_id,row.request_id,row.snapshot_json,row.snapshot_hash,row.created_at);
    assert.deepEqual(f.screening.getPlan(f.get),plan);
    const changed=JSON.parse(row.snapshot_json);changed.request.adjudicator=reviewerA;const json=JSON.stringify(changed);
    f.db.prepare('UPDATE research_review_screening_plans SET snapshot_json=? WHERE id=?').run(json,row.id);
    assert.throws(()=>f.screening.getPlan(f.get),/research_review_screening_snapshot_invalid/);
    f.db.prepare('UPDATE research_review_screening_plans SET snapshot_hash=? WHERE id=?').run(hash(json),row.id);
    f.db.prepare('UPDATE research_review_corpora SET screening_plan_hash=? WHERE id=?').run(hash(json),f.corpus.snapshot.id);
    assert.throws(()=>f.screening.getPlan(f.get),/research_review_screening_snapshot_invalid/);
  }finally{await f.dispose();}
});

test('post-insert dedup receipt drift rolls back reviewer plan, marker and injected upstream change',async()=>{
  const f=await scene();
  try {
    const original=f.db.prepare('SELECT * FROM research_review_deduplication_freezes').all();
    f.db.exec("CREATE TRIGGER drift_screening_source AFTER INSERT ON research_review_screening_plans BEGIN UPDATE research_review_deduplication_freezes SET snapshot_hash='changed'; END;");
    assert.throws(()=>f.screening.createPlan(f.input,actor),/research_review_duplicate_snapshot_invalid/);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_deduplication_freezes').all(),original);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_plans').pluck().get(),0);
    assert.equal(f.db.prepare('SELECT screening_plan_hash FROM research_review_corpora').pluck().get(),null);
    f.db.exec('DROP TRIGGER drift_screening_source');assert.equal(f.screening.createPlan(f.input,actor).currentProtocol,true);
  }finally{await f.dispose();}
});

test('historical protocols and archive preserve reviewer declarations and reject new plans without rewriting history',async()=>{
  const f=await scene();
  try {
    const plan=f.screening.createPlan(f.input,actor);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'later',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,
      deviationReason:'Explicit later protocol.'},actor);
    const before=f.changes(),historical={...plan,currentProtocol:false};
    assert.deepEqual(f.screening.getPlan(f.get),historical);assert.deepEqual(f.screening.createPlan(f.input,actor),historical);
    assert.throws(()=>f.screening.createPlan({...f.input,requestId:'old-new'},actor),/research_review_screening_version_conflict/);
    assert.equal(f.changes(),before);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const archived=f.changes();assert.deepEqual(f.screening.getPlan(f.get),historical);
    assert.throws(()=>f.screening.createPlan({...f.input,requestId:'archive'},actor),/research_project_archived/);
    assert.equal(f.changes(),archived);
  }finally{await f.dispose();}
});

test('generated plan API binds the main caller; declared names never grant tools human authority',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewScreeningCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewScreeningCapabilities({pluginId:'research',capabilities:registry},f.screening,f.decisions);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)}),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewScreening.createPlan',f.input),error=>error.code==='research_human_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-screening-createPlan',[{...f.input,actor}]));
    const noSender=await bridge.invoke('research.createReviewScreeningPlan',[f.input]);
    assert.equal(noSender.ok,false);assert.equal(noSender.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const created=await bridge.invoke('research.createReviewScreeningPlan',[f.input],71);
    assert.equal(created.ok,true,JSON.stringify(created));assert.deepEqual(created.data.snapshot.actor,{kind:'user',id:'window:71'});
    assert.deepEqual(created.data.snapshot.request.titleAbstractReviewers,[reviewerA,reviewerB]);
    const readonly=f.changes(),read=await bridge.invoke('research.getReviewScreeningPlan',[f.get],71);
    assert.equal(read.ok,true);assert.deepEqual(read.data,created.data);assert.equal(f.changes(),readonly);
  }finally{await f.dispose();}
});

test('disk reopen and DB30 upgrade retain exact raw corpus/dedup history without invented reviewer assignments',async()=>{
  const oldApi={...api,applyResearchDatabaseSchema(db,now) {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(value=>value.version<=30),now});
  }};
  const f=await scene({},oldApi),directory=await mkdtemp(join(tmpdir(),'roc-screening-plan-reopen-'));
  let db,reviews;
  try {
    const tables=['research_review_protocol_versions','research_review_searches','research_review_deduplication_freezes','research_review_duplicate_decisions'];
    const before=tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all());
    const original=f.db.prepare('SELECT * FROM research_review_corpora').all(),migrations=f.db.prepare('SELECT * FROM schema_migrations').all();
    api.applyResearchDatabaseSchema(f.db);
    tables.forEach((table,index)=>assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(),before[index]));
    assert.deepEqual(f.db.prepare(`SELECT ${Object.keys(original[0]).join(',')} FROM research_review_corpora`).all(),original);
    assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=30').all(),migrations);
    assert.equal(f.db.prepare('SELECT screening_plan_hash FROM research_review_corpora').pluck().get(),null);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_plans').pluck().get(),0);
    assert.throws(()=>f.screening.getPlan(f.get),/research_review_screening_plan_not_found/);
    const plan=f.screening.createPlan(f.input,actor),path=join(directory,'research.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time);
    const dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const screening=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time),changes=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(screening.getPlan(f.get),plan);assert.equal(db.prepare('SELECT total_changes()').pluck().get(),changes);
    assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await reviews?.shutdown();db?.close();await f.dispose();await rm(directory,{recursive:true,force:true});}
});
