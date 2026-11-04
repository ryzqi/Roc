import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewQualityFixture} from './fixtures/research-review-quality.mjs';
import {fullTextActor as actor} from './fixtures/research-review-fulltext-screening.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
const scene=options=>createReviewQualityFixture(api,options);
const count=f=>f.db.prepare('SELECT count(*) FROM research_review_quality_plans').pluck().get();

test('quality definition fixes explicit extracted study design, protocol framework/version and human-declared domains without a universal score',async()=>{
  const f=await scene();
  try {
    const input=f.qualityInput(),extraction=f.extractions.get(f.extractionGet(f.extraction.snapshot.id));
    const source=f.db.prepare('SELECT * FROM research_evidence').all(),initial=f.changes();
    assert.equal(f.qualityPlans.get(f.qualityGet(f.extraction.snapshot.id)),null);assert.deepEqual(f.qualityPlans.list(f.get),[]);assert.equal(f.changes(),initial);
    const plan=await f.qualityPlans.create(input,actor);
    assert.deepEqual(plan.snapshot.request,input);assert.deepEqual(plan.snapshot.reviewer,f.plan.snapshot.request.fullTextReviewers[0]);
    assert.deepEqual(plan.snapshot.actor,actor);assert.equal(plan.snapshot.protocolVersionId,f.protocol.version.id);
    assert.equal(plan.snapshot.protocolVersionHash,f.protocol.versionHash);assert.equal(plan.snapshotHash,hash(JSON.stringify(plan.snapshot)));
    assert.equal(plan.currentExtraction,true);assert.equal(plan.currentProtocol,true);assert.equal(plan.referenceStatus,'current');
    assert.equal(f.db.prepare('SELECT quality_plan_hash FROM research_review_extractions WHERE id=?').pluck().get(f.extraction.snapshot.id),plan.snapshotHash);
    assert.ok(!('score' in plan.snapshot.request.definition));
    assert.deepEqual(f.extractions.get(f.extractionGet(f.extraction.snapshot.id)),extraction);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_evidence').all(),source);
  }finally{await f.cleanup();}
});

test('missing/unjudgeable design, mismatched or undeclared framework/version and strict duplicates cannot select a substitute',async()=>{
  const f=await scene();
  try {
    const valid=f.qualityInput(),before=f.changes();
    for(const [input,error] of [
      [{...valid,expectedExtractionHash:'a'.repeat(64)},/research_review_quality_version_conflict/],
      [{...valid,hitId:f.corpus.snapshot.hits[2].id},/research_review_quality_version_conflict/],
      [{...valid,framework:{...valid.framework,studyDesign:'Guessed different design'}},/research_review_quality_study_design_mismatch/],
      [{...valid,framework:{...valid.framework,framework:'Undeclared framework'}},/research_review_quality_framework_not_declared/],
      [{...valid,framework:{...valid.framework,version:'other'}},/research_review_quality_framework_not_declared/],
      [{...valid,reviewerId:'undeclared'},/research_review_screening_reviewer_not_declared/]
    ])await assert.rejects(f.qualityPlans.create(input,actor),error);
    for(const input of [{...valid,actor},{...valid,definition:{...valid.definition,origin:'official_verified'}},
      {...valid,definition:{...valid.definition,domains:[valid.definition.domains[0],valid.definition.domains[0]]}},
      {...valid,definition:{...valid.definition,overallJudgements:['duplicate','duplicate']}},
      {...valid,definition:{...valid.definition,documentationNote:''}}])await assert.rejects(f.qualityPlans.create(input,actor));
    assert.equal(count(f),0);assert.equal(f.changes(),before);
    for(const kind of ['missing','unjudgeable']) {
      const previous=f.extraction,input=f.extract(`design-${kind}`);input.studyDesign.value={kind,reason:'Human cannot identify a design from selected original material.'};
      input.parentExtractionId=previous.snapshot.id;input.expectedParentHash=previous.snapshotHash;input.revisionReason='Explicit design re-examination.';
      f.extraction=await f.extractions.save(input,actor);
      await assert.rejects(f.qualityPlans.create(f.qualityInput(`quality-${kind}`),actor),/research_review_quality_study_design_unjudgeable/);
    }
    assert.equal(count(f),0);
  }finally{await f.cleanup();}
});

test('fixed quality definition replays readonly, cannot mutate and becomes historical when a valid new extraction is reviewed',async()=>{
  const f=await scene();
  try {
    const input=f.qualityInput(),first=await f.qualityPlans.create(input,actor),readonly=f.changes();
    assert.deepEqual(await f.qualityPlans.create(input,actor),first);
    await assert.rejects(f.qualityPlans.create({...input,reviewNote:'Changed note'},actor),/research_review_request_conflict/);
    await assert.rejects(f.qualityPlans.create(input,{kind:'user',id:'other'}),/research_review_request_conflict/);
    await assert.rejects(f.qualityPlans.create({...input,requestId:'new-same-extraction'},actor),/research_review_quality_plan_already_frozen/);
    assert.equal(f.changes(),readonly);
    const revision={...f.extract('new-extraction'),parentExtractionId:f.extraction.snapshot.id,
      expectedParentHash:f.extraction.snapshotHash,revisionReason:'Human revises the captured value.'};
    revision.fields[0].value={kind:'number',number:2};f.extraction=await f.extractions.save(revision,actor);
    assert.deepEqual(f.qualityPlans.get(f.qualityGet(first.snapshot.request.extractionId)),{...first,currentExtraction:false});
    const next=await f.qualityPlans.create(f.qualityInput('new-quality'),actor);
    assert.equal(next.currentExtraction,true);assert.deepEqual(f.qualityPlans.list(f.get),[{...first,currentExtraction:false},next]);
  }finally{await f.cleanup();}
});

test('real byte failure and actual preview reparse refuse quality creation and main-only extraction verification rather than trusting old metadata',async()=>{
  const f=await scene();
  try {
    await writeFile(f.sourcePath,Buffer.from('replaced original'));const before=f.changes();
    await assert.rejects(f.qualityPlans.create(f.qualityInput(),actor),/research_document_source_changed/);
    await assert.rejects(f.extractions.verifyCurrent({...f.extractionGet(f.extraction.snapshot.id),expectedExtractionHash:f.extraction.snapshotHash}),/research_document_source_changed/);
    assert.equal(f.changes(),before);await writeFile(f.sourcePath,f.original);
    const preview=f.service.preview.bind(f.service);
    f.service.preview=async request=>{const result=await preview(request);f.reparse();return result;};
    await assert.rejects(f.qualityPlans.create(f.qualityInput('during-reparse'),actor),/research_review_fulltext_version_conflict/);
    assert.equal(count(f),0);
  }finally{await f.cleanup();}
});

test('marked missing receipt, marker loss or corrupted definition cannot appear as an uninitialized framework in get/list/create',async()=>{
  const f=await scene();
  try {
    const plan=await f.qualityPlans.create(f.qualityInput(),actor),row=f.db.prepare('SELECT * FROM research_review_quality_plans').get();
    f.db.prepare('DELETE FROM research_review_quality_plans').run();
    const before=f.changes();assert.throws(()=>f.qualityPlans.get(f.qualityGet(f.extraction.snapshot.id)),/research_review_quality_snapshot_invalid/);
    assert.throws(()=>f.qualityPlans.list(f.get),/research_review_quality_snapshot_invalid/);
    await assert.rejects(f.qualityPlans.create(f.qualityInput('lost-new'),actor),/research_review_quality_snapshot_invalid/);
    assert.equal(f.changes(),before);
    f.db.prepare(`INSERT INTO research_review_quality_plans
      (id,project_id,corpus_id,hit_id,extraction_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(row.id,row.project_id,row.corpus_id,row.hit_id,row.extraction_id,row.request_id,row.snapshot_json,row.snapshot_hash,row.created_at);
    f.db.prepare('UPDATE research_review_extractions SET quality_plan_hash=NULL WHERE id=?').run(f.extraction.snapshot.id);
    assert.throws(()=>f.qualityPlans.get(f.qualityGet(f.extraction.snapshot.id)),/research_review_quality_snapshot_invalid/);
    f.db.prepare('UPDATE research_review_extractions SET quality_plan_hash=? WHERE id=?').run(plan.snapshotHash,f.extraction.snapshot.id);
    const changed=JSON.parse(row.snapshot_json);changed.request.definition.domains[0].question='Altered meaning without a valid receipt';
    f.db.prepare('UPDATE research_review_quality_plans SET snapshot_json=?').run(JSON.stringify(changed));
    assert.throws(()=>f.qualityPlans.list(f.get),/research_review_quality_snapshot_invalid/);
  }finally{await f.cleanup();}
});

test('valid extraction revision or Evidence invalidation after quality insert rolls back definition, marker and source drift',async()=>{
  const f=await scene();
  try {
    const parent=f.extraction,request=api.researchReviewExtractionSaveSchema.parse({...f.extract('valid-late-extraction'),
      parentExtractionId:parent.snapshot.id,expectedParentHash:parent.snapshotHash,revisionReason:'Valid extraction revision during framework storage.'});
    const snapshot=api.researchReviewExtractionSnapshotSchema.parse({...parent.snapshot,id:'quality-late-valid-extraction',
      version:2,request,requestHash:hash(JSON.stringify(request))});
    const json=JSON.stringify(snapshot),quote=value=>`'${value.replaceAll("'","''")}'`;
    f.db.exec(`CREATE TRIGGER late_quality_extraction AFTER INSERT ON research_review_quality_plans BEGIN
      INSERT INTO research_review_extractions
      (id,project_id,corpus_id,hit_id,binding_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
      VALUES (${[snapshot.id,request.projectId,request.corpusId,request.hitId,request.bindingId].map(quote).join(',')},2,
        ${[request.parentExtractionId,request.requestId,json,hash(json),snapshot.recordedAt].map(quote).join(',')}); END;`);
    await assert.rejects(f.qualityPlans.create(f.qualityInput(),actor),/research_review_quality_source_changed/);
    assert.equal(count(f),0);assert.equal(f.db.prepare('SELECT quality_plan_hash FROM research_review_extractions WHERE id=?').pluck().get(parent.snapshot.id),null);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_extractions WHERE id=?').pluck().get(snapshot.id),0);
    assert.equal(f.extractions.get(f.extractionGet(parent.snapshot.id)).isLatest,true);
    f.db.exec('DROP TRIGGER late_quality_extraction');
    f.db.exec("CREATE TRIGGER quality_source_drift AFTER INSERT ON research_review_quality_plans BEGIN UPDATE research_evidence SET invalidated_at='2026-11-04T01:00:00Z'; END;");
    await assert.rejects(f.qualityPlans.create(f.qualityInput('source-drift'),actor),/research_review_quality_source_changed/);
    assert.equal(count(f),0);assert.equal(f.repository.evidence.inspectEvidence(f.evidence.id,f.project.id).referenceStatus,'recorded');
  }finally{await f.cleanup();}
});

test('historical protocol and archive retain the explicit framework definition but cannot initialize another quality plan',async()=>{
  const f=await scene();
  try {
    const plan=await f.qualityPlans.create(f.qualityInput(),actor);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'later-protocol',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later protocol.'},actor);
    const historical=f.qualityPlans.get(f.qualityGet(f.extraction.snapshot.id));assert.deepEqual(historical,{...plan,currentProtocol:false});
    const readonly=f.changes();assert.deepEqual(f.qualityPlans.list(f.get),[historical]);assert.equal(f.changes(),readonly);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.deepEqual(f.qualityPlans.get(f.qualityGet(f.extraction.snapshot.id)),historical);
    await assert.rejects(f.qualityPlans.create(f.qualityInput('archive'),actor),/research_project_archived/);
  }finally{await f.cleanup();}
});

test('registered quality plan APIs require actual main sender across verified source awaits and preserve declared reviewer separate from actor',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewQualityCapabilities)registry.declare('research',descriptor);
    const assessments=new api.ResearchReviewQualityAssessmentRepository(f.db,f.repository,f.qualityPlans,f.extractions,f.fullFreezing,()=>f.time);
    api.registerResearchReviewQualityCapabilities({pluginId:'research',capabilities:registry},f.qualityPlans,assessments);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)}),input=f.qualityInput(),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewQuality.createPlan',input),error=>error.code==='research_human_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-quality-plan-create',[{...input,actor}]));
    const missing=await bridge.invoke('research.createReviewQualityPlan',[input]);assert.equal(missing.ok,false);
    assert.equal(missing.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const saved=await bridge.invoke('research.createReviewQualityPlan',[input],161);assert.equal(saved.ok,true,JSON.stringify(saved));
    assert.deepEqual(saved.data.snapshot.actor,{kind:'user',id:'window:161'});assert.deepEqual(saved.data.snapshot.reviewer,f.plan.snapshot.request.fullTextReviewers[0]);
    const readonly=f.changes(),get=await bridge.invoke('research.getReviewQualityPlan',[f.qualityGet(f.extraction.snapshot.id)],161);
    const list=await bridge.invoke('research.listReviewQualityPlans',[f.get],161);
    assert.equal(get.ok,true);assert.equal(list.ok,true);assert.deepEqual(get.data,saved.data);assert.deepEqual(list.data,[saved.data]);assert.equal(f.changes(),readonly);
  }finally{await f.cleanup();}
});

test('DB37 upgrade preserves exact extraction fields/source and null quality marker; real SQLite reopen retains definition without new requests',async()=>{
  const oldApi={...api,applyResearchDatabaseSchema(db,now) {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(value=>value.version<=37),now});
  }};
  const f=await createReviewQualityFixture(oldApi);let db,reviews,service;
  try {
    const old=f.db.prepare('SELECT * FROM research_review_extractions').all(),columns=Object.keys(old[0]);
    const evidence=f.db.prepare('SELECT * FROM research_evidence').all();api.applyResearchDatabaseSchema(f.db);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_extractions').all().map(row=>Object.fromEntries(columns.map(key=>[key,row[key]]))),old);
    assert.equal(f.db.prepare('SELECT quality_plan_hash FROM research_review_extractions').pluck().get(),null);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_evidence').all(),evidence);assert.equal(count(f),0);
    const plan=await f.qualityPlans.create(f.qualityInput(),actor),path=join(f.root,'quality-plan-reopen.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time),dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const roster=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time),titleVotes=new api.ResearchReviewScreeningDecisions(db,repository,corpora,dedup,roster,()=>f.time);
    const titleArbitration=new api.ResearchReviewScreeningArbitration(db,repository,titleVotes,()=>f.time),titles=new api.ResearchReviewScreeningFreeze(db,repository,titleArbitration,()=>f.time);
    service=new api.ResearchDocumentService(repository,{},f.root);
    const bindings=new api.ResearchReviewFullTextRepository(db,repository,corpora,titles,service,()=>f.time);
    const votes=new api.ResearchReviewFullTextScreening(db,repository,titles,bindings,()=>f.time),arbitration=new api.ResearchReviewFullTextArbitration(db,repository,votes,bindings,()=>f.time);
    const freezing=new api.ResearchReviewFullTextFreeze(db,repository,arbitration,bindings,()=>f.time);
    const extractions=new api.ResearchReviewExtractionRepository(db,repository,freezing,bindings,service,()=>f.time);
    const quality=new api.ResearchReviewQualityPlanRepository(db,repository,extractions,freezing,()=>f.time),before=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(quality.get(f.qualityGet(f.extraction.snapshot.id)),plan);assert.deepEqual(quality.list(f.get),[plan]);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await service?.shutdown();await reviews?.shutdown();db?.close();await f.cleanup();}
});
