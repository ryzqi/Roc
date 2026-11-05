import {createReviewMigrationSeedApi} from './fixtures/research-review-migration-seed.mjs';
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
const count=f=>f.db.prepare('SELECT count(*) FROM research_review_quality_assessments').pluck().get();
const assessed=(judgement,reason='Human explicitly judges the original source using the declared category.')=>({kind:'judged',judgement,reason});
async function scene(options={},testApi=api) {
  const f=await createReviewQualityFixture(testApi,options);
  f.quality=await f.qualityPlans.create(f.qualityInput(),actor);
  f.assessments=new api.ResearchReviewQualityAssessmentRepository(f.db,f.repository,f.qualityPlans,f.extractions,f.fullFreezing,()=>f.time);
  f.assessmentGet={...f.get,extractionId:f.extraction.snapshot.id,qualityPlanId:f.quality.snapshot.id};
  f.assess=(requestId='assess-quality')=>({...f.assessmentGet,requestId,expectedPlanHash:f.quality.snapshotHash,
    expectedExtractionHash:f.extraction.snapshotHash,
    domains:f.quality.snapshot.request.definition.domains.map(domain=>({domainId:domain.id,value:assessed(domain.judgements[0]),evidence:[f.reference]})),
    overall:{value:assessed(f.quality.snapshot.request.definition.overallJudgements[0]),evidence:[f.reference]},
    reviewerId:f.reviewerIds[0],reviewNote:'Human confirms synthetic source-bound quality categories, without a scientific validation claim.',
    parentAssessmentId:null,expectedParentHash:null,revisionReason:null});
  f.revise=(parent,requestId='revise-quality')=>({...f.assess(requestId),parentAssessmentId:parent.snapshot.id,
    expectedParentHash:parent.snapshotHash,revisionReason:'Human explicitly revises the source interpretation.'});
  return f;
}

test('human quality assessment pins every frozen domain and explicit overall category to actual extraction Evidence without score aggregation',async()=>{
  const f=await scene();
  try {
    const source=f.db.prepare('SELECT * FROM research_evidence').all(),plan=f.qualityPlans.get(f.qualityGet(f.extraction.snapshot.id)),before=f.changes();
    assert.equal(f.assessments.get(f.assessmentGet),null);assert.deepEqual(f.assessments.history(f.assessmentGet),[]);assert.equal(f.changes(),before);
    const request=f.assess(),saved=await f.assessments.save(request,actor);
    assert.deepEqual(saved.snapshot.request,request);assert.equal(saved.snapshot.version,1);
    assert.deepEqual(saved.snapshot.reviewer,f.plan.snapshot.request.fullTextReviewers[0]);assert.deepEqual(saved.snapshot.actor,actor);
    assert.equal(saved.snapshotHash,hash(JSON.stringify(saved.snapshot)));assert.equal(saved.isLatest,true);
    assert.equal(saved.currentExtraction,true);assert.equal(saved.currentProtocol,true);assert.equal(saved.referenceStatus,'current');
    assert.equal(f.db.prepare('SELECT assessment_head_hash FROM research_review_quality_plans').pluck().get(),saved.snapshotHash);
    assert.ok(!('score' in saved.snapshot));assert.deepEqual(f.qualityPlans.get(f.qualityGet(f.extraction.snapshot.id)),plan);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_evidence').all(),source);
    const readonly=f.changes();assert.deepEqual(f.assessments.get(f.assessmentGet),saved);assert.deepEqual(f.assessments.history(f.assessmentGet),[saved]);
    assert.equal(f.changes(),readonly);
  }finally{await f.cleanup();}
});

test('unjudgeable domain and overall judgments retain explicit reasons and immutable human revisions with exact readonly replay',async()=>{
  const f=await scene();
  try {
    const firstRequest=f.assess(),first=await f.assessments.save(firstRequest,actor),request=f.revise(first);
    request.domains[0].value={kind:'unjudgeable',reason:'The actual original material cannot resolve this domain.'};
    request.overall.value={kind:'unjudgeable',reason:'Human cannot determine an overall judgement from the declared sources.'};
    request.reviewerId=f.plan.snapshot.request.adjudicator.id;
    const second=await f.assessments.save(request,actor);assert.equal(second.snapshot.version,2);
    assert.equal(second.snapshot.request.domains[0].value.kind,'unjudgeable');assert.equal(second.snapshot.request.overall.value.kind,'unjudgeable');
    assert.deepEqual(second.snapshot.reviewer,f.plan.snapshot.request.adjudicator);
    const readonly=f.changes();assert.deepEqual(await f.assessments.save(request,actor),second);
    assert.deepEqual(await f.assessments.save(firstRequest,actor),{...first,isLatest:false});
    assert.deepEqual(f.assessments.history(f.assessmentGet),[{...first,isLatest:false},second]);
    for(const [input,caller,error] of [
      [{...request,reviewNote:'Changed request'},actor,/research_review_request_conflict/],
      [request,{kind:'user',id:'other'},/research_review_request_conflict/],
      [f.assess('missing-parent'),actor,/research_review_quality_assessment_version_conflict/],
      [{...f.revise(first,'old-parent')},actor,/research_review_quality_assessment_version_conflict/],
      [{...f.revise(second,'bad-hash'),expectedParentHash:'a'.repeat(64)},actor,/research_review_quality_assessment_version_conflict/]
    ])await assert.rejects(f.assessments.save(input,caller),error);
    assert.equal(count(f),2);assert.equal(f.changes(),readonly);
  }finally{await f.cleanup();}
});

test('complete declared domains, domain-specific choices, overall choices and exact extraction Evidence are required with strict human input',async()=>{
  const f=await scene();
  try {
    const valid=f.assess(),before=f.changes();
    for(const [input,error] of [
      [{...valid,domains:valid.domains.slice(0,1)},/research_review_quality_domains_incomplete/],
      [{...valid,domains:[{...valid.domains[0],domainId:'guessed'},valid.domains[1]]},/research_review_quality_domain_not_declared/],
      [{...valid,domains:[{...valid.domains[0],value:assessed('reported')},valid.domains[1]]},/research_review_quality_judgement_not_declared/],
      [{...valid,overall:{...valid.overall,value:assessed('guessed-score')}},/research_review_quality_judgement_not_declared/],
      [{...valid,domains:[{...valid.domains[0],evidence:[{id:'unselected-evidence',expectedHash:f.reference.expectedHash}]},valid.domains[1]]},/research_review_quality_evidence_mismatch/],
      [{...valid,overall:{...valid.overall,evidence:[{...f.reference,expectedHash:'a'.repeat(64)}]}},/research_review_quality_evidence_mismatch/],
      [{...valid,expectedPlanHash:'a'.repeat(64)},/research_review_quality_assessment_version_conflict/],
      [{...valid,expectedExtractionHash:'a'.repeat(64)},/research_review_quality_assessment_version_conflict/],
      [{...valid,qualityPlanId:'guessed'},/research_review_quality_plan_not_found/],
      [{...valid,reviewerId:'undeclared'},/research_review_screening_reviewer_not_declared/]
    ])await assert.rejects(f.assessments.save(input,actor),error);
    for(const input of [{...valid,actor},{...valid,domains:[valid.domains[0],valid.domains[0]]},
      {...valid,overall:{value:{kind:'judged',judgement:'reviewed',reason:''},evidence:[f.reference]}},
      {...valid,domains:[{...valid.domains[0],evidence:[]},valid.domains[1]]},
      {...valid,overall:{...valid.overall,evidence:[f.reference,f.reference]}},
      {...valid,parentAssessmentId:'parent',expectedParentHash:null},
      {...valid,overall:{value:{kind:'number',number:0},evidence:[f.reference]}}])await assert.rejects(f.assessments.save(input,actor));
    assert.throws(()=>f.assessments.get({...f.assessmentGet,actor}));
    assert.equal(count(f),0);assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('real original bytes and actual asynchronous source reparse must be verified before any new quality judgment',async()=>{
  const f=await scene();
  try {
    await writeFile(f.sourcePath,Buffer.from('changed original'));const before=f.changes();
    await assert.rejects(f.assessments.save(f.assess(),actor),/research_document_source_changed/);assert.equal(f.changes(),before);
    await writeFile(f.sourcePath,f.original);
    const preview=f.service.preview.bind(f.service);f.service.preview=async request=>{const result=await preview(request);f.reparse();return result;};
    await assert.rejects(f.assessments.save(f.assess('reparse-during-review'),actor),/research_review_fulltext_version_conflict/);
    assert.equal(count(f),0);assert.equal(f.db.prepare('SELECT assessment_head_hash FROM research_review_quality_plans').pluck().get(),null);
  }finally{await f.cleanup();}
});

test('lost latest receipt, missing head, damaged payload or parent never resets an already reviewed framework to unassessed',async()=>{
  const f=await scene();
  try {
    const first=await f.assessments.save(f.assess(),actor),second=await f.assessments.save(f.revise(first),actor);
    const row=f.db.prepare('SELECT * FROM research_review_quality_assessments WHERE id=?').get(second.snapshot.id);
    f.db.prepare('DELETE FROM research_review_quality_assessments WHERE id=?').run(second.snapshot.id);
    const before=f.changes();assert.throws(()=>f.assessments.get(f.assessmentGet),/research_review_quality_assessment_snapshot_invalid/);
    assert.throws(()=>f.assessments.history(f.assessmentGet),/research_review_quality_assessment_snapshot_invalid/);
    await assert.rejects(f.assessments.save(f.revise(first,'lost-receipt'),actor),/research_review_quality_assessment_snapshot_invalid/);
    assert.equal(f.changes(),before);
    f.db.prepare(`INSERT INTO research_review_quality_assessments
      (id,project_id,corpus_id,plan_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id,row.project_id,row.corpus_id,row.plan_id,row.version,row.parent_id,row.request_id,row.snapshot_json,row.snapshot_hash,row.created_at);
    f.db.prepare('UPDATE research_review_quality_plans SET assessment_head_hash=NULL').run();
    assert.throws(()=>f.assessments.get(f.assessmentGet),/research_review_quality_assessment_snapshot_invalid/);
    f.db.prepare('UPDATE research_review_quality_plans SET assessment_head_hash=?').run(second.snapshotHash);
    f.db.prepare('UPDATE research_review_quality_assessments SET snapshot_json=? WHERE id=?').run('{}',second.snapshot.id);
    assert.throws(()=>f.assessments.history(f.assessmentGet));
    f.db.prepare('UPDATE research_review_quality_assessments SET snapshot_json=?,parent_id=NULL WHERE id=?').run(row.snapshot_json,second.snapshot.id);
    assert.throws(()=>f.assessments.get(f.assessmentGet),/research_review_quality_assessment_snapshot_invalid/);
  }finally{await f.cleanup();}
});

test('canonically changed judgment, a valid new extraction and Evidence invalidation during storage roll back receipt, head and drift',async()=>{
  const f=await scene();
  try {
    f.db.function('quality_hash',value=>hash(value));
    f.db.function('alter_quality',value=>{
      const snapshot=JSON.parse(value);snapshot.request.domains[0].value.judgement='inadequate';
      snapshot.requestHash=hash(JSON.stringify(api.researchReviewQualityAssessmentSaveSchema.parse(snapshot.request)));
      return JSON.stringify(api.researchReviewQualityAssessmentSnapshotSchema.parse(snapshot));
    });
    f.db.exec(`CREATE TRIGGER altered_quality AFTER UPDATE OF assessment_head_hash ON research_review_quality_plans
      WHEN json_extract((SELECT snapshot_json FROM research_review_quality_assessments WHERE plan_id=NEW.id),'$.request.domains[0].value.judgement')='adequate'
      BEGIN UPDATE research_review_quality_assessments SET snapshot_json=alter_quality(snapshot_json),snapshot_hash=quality_hash(alter_quality(snapshot_json)) WHERE plan_id=NEW.id;
      UPDATE research_review_quality_plans SET assessment_head_hash=(SELECT snapshot_hash FROM research_review_quality_assessments WHERE plan_id=NEW.id) WHERE id=NEW.id; END;`);
    await assert.rejects(f.assessments.save(f.assess(),actor),/research_review_quality_assessment_snapshot_invalid/);
    assert.equal(count(f),0);assert.equal(f.db.prepare('SELECT assessment_head_hash FROM research_review_quality_plans').pluck().get(),null);
    f.db.exec('DROP TRIGGER altered_quality');
    const parent=f.extraction,request=api.researchReviewExtractionSaveSchema.parse({...f.extract('valid-late-extraction'),
      parentExtractionId:parent.snapshot.id,expectedParentHash:parent.snapshotHash,revisionReason:'Valid extraction during quality assessment.'});
    const snapshot=api.researchReviewExtractionSnapshotSchema.parse({...parent.snapshot,id:'assessment-late-valid-extraction',
      version:2,request,requestHash:hash(JSON.stringify(request))}),json=JSON.stringify(snapshot),quote=value=>`'${value.replaceAll("'","''")}'`;
    f.db.exec(`CREATE TRIGGER late_quality_extraction AFTER INSERT ON research_review_quality_assessments BEGIN
      INSERT INTO research_review_extractions
      (id,project_id,corpus_id,hit_id,binding_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
      VALUES (${[snapshot.id,request.projectId,request.corpusId,request.hitId,request.bindingId].map(quote).join(',')},2,
        ${[request.parentExtractionId,request.requestId,json,hash(json),snapshot.recordedAt].map(quote).join(',')}); END;`);
    await assert.rejects(f.assessments.save(f.assess('late-extraction'),actor),/research_review_quality_source_changed/);
    assert.equal(count(f),0);assert.equal(f.extractions.get(f.extractionGet(parent.snapshot.id)).isLatest,true);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_extractions WHERE id=?').pluck().get(snapshot.id),0);
    f.db.exec('DROP TRIGGER late_quality_extraction');
    f.db.exec("CREATE TRIGGER quality_evidence_drift AFTER INSERT ON research_review_quality_assessments BEGIN UPDATE research_evidence SET invalidated_at='2026-11-04T01:00:00Z'; END;");
    await assert.rejects(f.assessments.save(f.assess('evidence-drift'),actor),/research_review_quality_source_changed/);
    assert.equal(count(f),0);assert.equal(f.db.prepare('SELECT assessment_head_hash FROM research_review_quality_plans').pluck().get(),null);
    assert.equal(f.repository.evidence.inspectEvidence(f.evidence.id,f.project.id).referenceStatus,'recorded');
  }finally{await f.cleanup();}
});

test('revised extraction and source versions preserve historical judgments and require a new explicitly selected quality plan',async()=>{
  const f=await scene({sourceOnly:true});
  try {
    const first=await f.assessments.save(f.assess(),actor),request={...f.extract('revised-values'),
      parentExtractionId:f.extraction.snapshot.id,expectedParentHash:f.extraction.snapshotHash,revisionReason:'Human updates the extracted value.'};
    request.fields[0].value={kind:'number',number:2};f.extraction=await f.extractions.save(request,actor);
    assert.deepEqual(f.assessments.get(f.assessmentGet),{...first,currentExtraction:false});
    await assert.rejects(f.assessments.save(f.revise(first,'old-plan'),actor),/research_review_quality_assessment_version_conflict|research_review_quality_source_changed/);
    const newPlan=await f.qualityPlans.create(f.qualityInput('new-extraction-plan'),actor);
    const nextGet={...f.assessmentGet,extractionId:f.extraction.snapshot.id,qualityPlanId:newPlan.snapshot.id};
    assert.equal(f.assessments.get(nextGet),null);
    f.reparse();
    assert.deepEqual(f.assessments.history(f.assessmentGet),[{...first,currentExtraction:false,referenceStatus:'superseded'}]);
    assert.equal(f.assessments.get(nextGet),null);
    const before=f.changes();await assert.rejects(f.assessments.save({...f.assess('stale-new-plan'),...nextGet,expectedPlanHash:newPlan.snapshotHash},actor),/research_review_quality_source_changed/);
    assert.equal(f.changes(),before);assert.equal(count(f),1);
  }finally{await f.cleanup();}
});

test('actual registered quality assessment IPC binds main human through file awaits and preserves historical protocol/archive readonly',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewQualityCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewQualityCapabilities({pluginId:'research',capabilities:registry},f.qualityPlans,f.assessments);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)}),input=f.assess(),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewQuality.saveAssessment',input),error=>error.code==='research_human_required');
    await assert.rejects(api.withResearchHumanContext({capability:'research.reviewQuality.createPlan',projectId:f.project.id,windowId:171},
      ()=>registry.invoke('research.reviewQuality.saveAssessment',input)),error=>error.code==='research_human_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-quality-assessment-save',[{...input,actor}]));
    const missing=await bridge.invoke('research.saveReviewQualityAssessment',[input]);assert.equal(missing.ok,false);assert.equal(missing.error.code,'research_sender_required');
    assert.equal(f.changes(),before);
    const saved=await bridge.invoke('research.saveReviewQualityAssessment',[input],171);assert.equal(saved.ok,true,JSON.stringify(saved));
    assert.deepEqual(saved.data.snapshot.actor,{kind:'user',id:'window:171'});assert.deepEqual(saved.data.snapshot.reviewer,f.plan.snapshot.request.fullTextReviewers[0]);
    const readonly=f.changes(),get=await bridge.invoke('research.getReviewQualityAssessment',[f.assessmentGet],171);
    const history=await bridge.invoke('research.getReviewQualityAssessmentHistory',[f.assessmentGet],171);
    assert.equal(get.ok,true);assert.equal(history.ok,true);assert.deepEqual(get.data,saved.data);assert.deepEqual(history.data,[saved.data]);assert.equal(f.changes(),readonly);
    const foreign=await bridge.invoke('research.getReviewQualityAssessment',[{...f.assessmentGet,projectId:'foreign'}],171);assert.equal(foreign.ok,false);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'later-protocol',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later protocol.'},actor);
    const historical={...saved.data,currentProtocol:false};assert.deepEqual(f.assessments.get(f.assessmentGet),historical);
    const revised={...f.revise(saved.data,'historical'),reviewerId:f.reviewerIds[0]};
    await assert.rejects(f.assessments.save(revised,actor),/research_review_quality_source_changed/);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.deepEqual(f.assessments.history(f.assessmentGet),[historical]);await assert.rejects(f.assessments.save(revised,actor),/research_project_archived/);
  }finally{await f.cleanup();}
});

test('actual independent review after byte await and valid new assessment during insert cannot acknowledge a stale parent or head',async()=>{
  const f=await scene();
  try {
    const first=await f.assessments.save(f.assess(),actor),preview=f.service.preview.bind(f.service);let concurrent;
    f.service.preview=async request=>{
      const result=await preview(request);f.service.preview=preview;
      concurrent=await f.assessments.save(f.revise(first,'independent-review'),actor);return result;
    };
    await assert.rejects(f.assessments.save(f.revise(first,'stale-afterawait'),actor),/research_review_quality_assessment_version_conflict/);
    assert.deepEqual(f.assessments.get(f.assessmentGet),concurrent);assert.equal(count(f),2);
    assert.equal(f.db.prepare("SELECT count(*) FROM research_review_quality_assessments WHERE request_id='stale-afterawait'").pluck().get(),0);
    f.db.function('quality_hash',value=>hash(value));
    f.db.function('next_quality',value=>{
      const previous=api.researchReviewQualityAssessmentSnapshotSchema.parse(JSON.parse(value)),request={
        ...previous.request,requestId:'late-valid-assessment',parentAssessmentId:previous.id,
        expectedParentHash:hash(value),revisionReason:'Another valid assessment during storage.'};
      return JSON.stringify(api.researchReviewQualityAssessmentSnapshotSchema.parse({...previous,
        id:'late-valid-assessment',version:previous.version+1,request,requestHash:hash(JSON.stringify(request))}));
    });
    f.db.exec(`CREATE TRIGGER late_valid_quality AFTER INSERT ON research_review_quality_assessments
      WHEN NEW.request_id<>'late-valid-assessment' BEGIN
      INSERT INTO research_review_quality_assessments
      (id,project_id,corpus_id,plan_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
      VALUES ('late-valid-assessment',NEW.project_id,NEW.corpus_id,NEW.plan_id,NEW.version+1,NEW.id,
        'late-valid-assessment',next_quality(NEW.snapshot_json),quality_hash(next_quality(NEW.snapshot_json)),NEW.created_at); END;`);
    await assert.rejects(f.assessments.save(f.revise(concurrent,'stale-postinsert'),actor),/research_review_quality_assessment_snapshot_invalid/);
    assert.equal(count(f),2);assert.deepEqual(f.assessments.get(f.assessmentGet),concurrent);
    assert.equal(f.db.prepare("SELECT count(*) FROM research_review_quality_assessments WHERE id='late-valid-assessment'").pluck().get(),0);
  }finally{await f.cleanup();}
});

test('DB38 upgrade preserves all existing framework/extraction columns and real disk reopen retains reviewed quality without requests',async()=>{
  const oldApi=createReviewMigrationSeedApi(api,38);
  const f=await scene({},oldApi);let db,reviews,service;
  try {
    oldApi.finishSeed(f.db);
    const old=f.db.prepare('SELECT * FROM research_review_quality_plans').all(),columns=Object.keys(old[0]);
    const extraction=f.db.prepare('SELECT * FROM research_review_extractions').all(),evidence=f.db.prepare('SELECT * FROM research_evidence').all();
    api.applyResearchDatabaseSchema(f.db);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_quality_plans').all().map(row=>Object.fromEntries(columns.map(key=>[key,row[key]]))),old);
    assert.equal(f.db.prepare('SELECT assessment_head_hash FROM research_review_quality_plans').pluck().get(),null);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_extractions').all(),extraction);assert.deepEqual(f.db.prepare('SELECT * FROM research_evidence').all(),evidence);
    assert.equal(count(f),0);const saved=await f.assessments.save(f.assess(),actor),path=join(f.root,'quality-assessment-reopen.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>{},()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time),dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const roster=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time),titleVotes=new api.ResearchReviewScreeningDecisions(db,repository,corpora,dedup,roster,()=>f.time);
    const titleArbitration=new api.ResearchReviewScreeningArbitration(db,repository,titleVotes,()=>f.time),titles=new api.ResearchReviewScreeningFreeze(db,repository,titleArbitration,()=>f.time);
    service=new api.ResearchDocumentService(repository,{},f.root);
    const bindings=new api.ResearchReviewFullTextRepository(db,repository,corpora,titles,service,()=>f.time);
    const votes=new api.ResearchReviewFullTextScreening(db,repository,titles,bindings,()=>f.time),arbitration=new api.ResearchReviewFullTextArbitration(db,repository,votes,bindings,()=>f.time);
    const freezing=new api.ResearchReviewFullTextFreeze(db,repository,arbitration,bindings,()=>f.time);
    const extractions=new api.ResearchReviewExtractionRepository(db,repository,freezing,bindings,service,()=>f.time);
    const plans=new api.ResearchReviewQualityPlanRepository(db,repository,extractions,freezing,()=>f.time);
    const assessments=new api.ResearchReviewQualityAssessmentRepository(db,repository,plans,extractions,freezing,()=>f.time),before=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(assessments.get(f.assessmentGet),saved);assert.deepEqual(assessments.history(f.assessmentGet),[saved]);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await service?.shutdown();await reviews?.shutdown();db?.close();await f.cleanup();}
});
