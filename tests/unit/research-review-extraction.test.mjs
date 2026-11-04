import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewExtractionFixture,extractionDigest} from './fixtures/research-review-extraction.mjs';
import {fullTextActor as actor} from './fixtures/research-review-fulltext-screening.mjs';
import {reviewProtocolBodyFixture} from './fixtures/research-review-protocol.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
const scene=options=>createReviewExtractionFixture(api,options);
const count=f=>f.db.prepare('SELECT count(*) FROM research_review_extractions').pluck().get();

test('human extraction fixes exact real Evidence/managed source/coordinate versions and protocol units without duplicating papers or evidence',async()=>{
  const f=await scene();
  try {
    const library=f.db.prepare('SELECT * FROM research_library').all(),evidence=f.db.prepare('SELECT * FROM research_evidence').all();
    const frozen=f.fullFreezing.getPhase(f.fullPhase),input=f.extract(),result=await f.extractions.save(input,actor);
    assert.deepEqual(result.snapshot.request,input);assert.deepEqual(result.snapshot.hit,f.corpus.snapshot.hits[0]);
    assert.deepEqual(result.snapshot.actor,actor);assert.deepEqual(result.snapshot.reviewer,f.plan.snapshot.request.fullTextReviewers[0]);
    assert.equal(result.snapshot.protocolVersionId,f.protocol.version.id);assert.equal(result.snapshot.protocolVersionHash,f.protocol.versionHash);
    assert.deepEqual(result.snapshot.fieldDefinitions,f.protocol.version.body.extractionFields);
    assert.deepEqual(result.snapshot.sources[0].evidence,f.source.evidence);assert.deepEqual(result.snapshot.sources[0].sourceLocator,f.source.sourceLocator);
    assert.equal(result.snapshot.sources[0].digest,extractionDigest(f.source));
    assert.equal(result.snapshot.sources[0].coordinateHash,f.repository.documents.coordinates(f.document.id,f.selection.parseId).snapshotHash);
    assert.equal(result.snapshot.request.fields[0].unit,'mg/L');assert.equal(result.referenceStatus,'current');
    assert.equal(result.snapshotHash,hash(JSON.stringify(result.snapshot)));
    const before=f.changes();assert.deepEqual(f.extractions.get(f.extractionGet(result.snapshot.id)),result);
    assert.deepEqual(f.extractions.list(f.get),[result]);assert.deepEqual(f.extractions.history(f.extractionHistory),[result]);
    assert.equal(f.changes(),before);assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(),library);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_evidence').all(),evidence);assert.deepEqual(f.fullFreezing.getPhase(f.fullPhase),frozen);
  }finally{await f.cleanup();}
});

test('missing and unjudgeable stay distinct source-linked values while revisions retain exact prior data and readonly replay',async()=>{
  const f=await scene();
  try {
    const input=f.extract();input.fields[0].value={kind:'missing',reason:'Human did not find the requested value in the inspected source.'};
    input.studyDesign.value={kind:'unjudgeable',reason:'The inspected source does not permit classification.'};
    const first=await f.extractions.save(input,actor);
    const revision={...f.extract('re-examine'),parentExtractionId:first.snapshot.id,expectedParentHash:first.snapshotHash,revisionReason:'Human explicitly re-examined the same material.'};
    revision.fields[0].value={kind:'unjudgeable',reason:'A value is present but cannot be read reliably.'};
    const second=await f.extractions.save(revision,actor),before=f.changes();
    assert.equal(second.snapshot.version,2);assert.equal(first.snapshot.request.fields[0].value.kind,'missing');
    assert.equal(second.snapshot.request.fields[0].value.kind,'unjudgeable');
    assert.ok(!('number' in first.snapshot.request.fields[0].value));assert.ok(!('number' in second.snapshot.request.fields[0].value));
    assert.deepEqual(f.extractions.history(f.extractionHistory),[{...first,isLatest:false},second]);
    assert.deepEqual(await f.extractions.save(input,actor),{...first,isLatest:false});assert.deepEqual(await f.extractions.save(revision,actor),second);
    await assert.rejects(f.extractions.save({...revision,requestId:'stale-parent'},actor),/research_review_extraction_version_conflict/);
    await assert.rejects(f.extractions.save(revision,{kind:'user',id:'other'}),/research_review_request_conflict/);
    assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('required/declaration/unit/finite-number/source/hash/scope contracts refuse forged or missing input without an extraction',async()=>{
  const body=reviewProtocolBodyFixture();body.extractionFields.push({id:'optional-note',label:'Optional observed note',unit:null,required:false});
  const f=await scene({protocolBody:body});
  try {
    const valid=f.extract(),before=f.changes();
    for(const [input,error] of [
      [{...valid,expectedFullFreezeHash:'a'.repeat(64)},/research_review_extraction_version_conflict/],
      [{...valid,expectedBindingHash:'a'.repeat(64)},/research_review_extraction_version_conflict/],
      [{...valid,hitId:f.corpus.snapshot.hits[1].id},/research_review_extraction_hit_not_included/],
      [{...valid,hitId:f.corpus.snapshot.hits[2].id},/research_review_extraction_hit_not_included/],
      [{...valid,reviewerId:'undeclared'},/research_review_screening_reviewer_not_declared/],
      [{...valid,fields:[{...valid.fields[0],unit:'percent'}]},/research_review_extraction_unit_mismatch/],
      [{...valid,fields:[{...valid.fields[0],unit:null}]},/research_review_extraction_unit_mismatch/],
      [{...valid,fields:[{...valid.fields[0],fieldId:'optional-note',unit:null,value:{kind:'text',text:'Manual note'}}]},/research_review_extraction_required_field_missing/],
      [{...valid,fields:[...valid.fields,{...valid.fields[0],fieldId:'guessed'}]},/research_review_extraction_field_not_declared/],
      [{...valid,studyDesign:{...valid.studyDesign,evidence:[{...f.reference,expectedHash:'a'.repeat(64)}]}},/research_review_extraction_version_conflict/]
    ])await assert.rejects(f.extractions.save(input,actor),error);
    for(const input of [{...valid,actor},{...valid,fields:[{...valid.fields[0],value:{kind:'number',number:Infinity}}]},
      {...valid,fields:[{...valid.fields[0],value:{kind:'number',number:NaN}}]},
      {...valid,fields:[{...valid.fields[0],evidence:[]}]},{...valid,fields:[valid.fields[0],valid.fields[0]]},
      {...valid,studyDesign:{value:{kind:'missing',reason:''},evidence:[f.reference]}}])await assert.rejects(f.extractions.save(input,actor));
    assert.equal(count(f),0);assert.equal(f.changes(),before);
    const saved=await f.extractions.save(valid,actor);assert.equal(saved.snapshot.request.fields.length,1);
    assert.equal(saved.snapshot.fieldDefinitions.length,2);assert.ok(!saved.snapshot.request.fields.some(field=>field.fieldId==='optional-note'));
  }finally{await f.cleanup();}
  const unitlessBody=reviewProtocolBodyFixture();unitlessBody.extractionFields[0].unit=null;
  const unitless=await scene({protocolBody:unitlessBody});
  try{await assert.rejects(unitless.extractions.save(unitless.extract(),actor),/research_review_extraction_unit_mismatch/);}
  finally{await unitless.cleanup();}
});

test('source-only report keeps byte authority across reparse while old Evidence is stale and a new explicit Evidence revision preserves history',async()=>{
  const f=await scene({sourceOnly:true});
  try {
    const first=await f.extractions.save(f.extract(),actor);f.reparse();
    assert.deepEqual(f.extractions.get(f.extractionGet(first.snapshot.id)),{...first,referenceStatus:'superseded'});
    assert.equal(f.fullFreezing.getPhase(f.fullPhase).sourcesCurrent,true);
    await assert.rejects(f.extractions.save({...f.extract('stale-evidence'),parentExtractionId:first.snapshot.id,
      expectedParentHash:first.snapshotHash,revisionReason:'Attempt to retain the prior Evidence.'},actor),/research_review_extraction_source_changed/);
    const current=f.repository.evidence.capture({projectId:f.project.id,chunkId:'document:fulltext-reparse:chunk:0'});
    const source=f.repository.evidence.inspectEvidence(current.id,f.project.id),ref={id:current.id,expectedHash:extractionDigest(source)};
    const revision={...f.extract('current-evidence'),parentExtractionId:first.snapshot.id,expectedParentHash:first.snapshotHash,
      revisionReason:'Human selects the actual new current parsed Evidence and re-examines it.'};
    revision.studyDesign.evidence=[ref];revision.fields[0].evidence=[ref];
    const second=await f.extractions.save(revision,actor);
    assert.equal(second.referenceStatus,'current');assert.equal(second.snapshot.sources[0].sourceLocator.parseId,'fulltext-reparse');
    assert.deepEqual(f.extractions.history(f.extractionHistory),[{...first,isLatest:false,referenceStatus:'superseded'},second]);
  }finally{await f.cleanup();}
});

test('foreign or unlocated Evidence, absent current indexed block and missing whole-round freeze cannot authorize extraction',async()=>{
  const f=await scene();
  try {
    const other=f.repository.createProject({title:'Other extraction project',description:'Synthetic',workspacePath:'/tmp/extraction-other'});
    const foreign=f.repository.evidence.capture({projectId:other.id,chunkId:`document:${f.selection.parseId}:chunk:0`});
    const inspected=f.repository.evidence.inspectEvidence(foreign.id,other.id),input=f.extract();
    input.studyDesign.evidence=[{id:foreign.id,expectedHash:extractionDigest(inspected)}];
    await assert.rejects(f.extractions.save(input,actor),/research_evidence_project_mismatch/);
    f.repository.knowledge.upsertFromSource({id:'unlocated-extraction-source',projectId:f.project.id,sourceType:'file',
      sourceId:'unlocated-engineering-source',title:'Actual unlocated engineering record',content:'Explicit synthetic material',
      chunks:[{content:'Explicit synthetic material',locator:'logical-record'}],embeddingPolicy:'none'});
    const unlocated=f.repository.evidence.capture({projectId:f.project.id,chunkId:'unlocated-extraction-source:chunk:0'});
    const unknown=f.repository.evidence.inspectEvidence(unlocated.id,f.project.id),request=f.extract('unlocated');
    request.studyDesign.evidence=[{id:unlocated.id,expectedHash:extractionDigest(unknown)}];
    await assert.rejects(f.extractions.save(request,actor),/research_review_extraction_source_unlocated/);
    f.db.prepare('DELETE FROM research_knowledge_chunks WHERE id=?').run(f.evidence.chunkId);
    await assert.rejects(f.extractions.save(f.extract('lost-index'),actor),/research_review_extraction_source_changed/);
    assert.equal(count(f),0);
  }finally{await f.cleanup();}
  const pending=await scene({freeze:false});
  try{await assert.rejects(pending.extractions.save(pending.extract(),actor),/research_review_screening_not_frozen/);}
  finally{await pending.cleanup();}
});

test('physical original corruption and canonically replaced coordinate metadata after actual preview cannot acknowledge extraction',async()=>{
  const f=await scene({sourceOnly:true});
  try {
    await writeFile(f.sourcePath,Buffer.from('original corrupted'));const before=f.changes();
    await assert.rejects(f.extractions.save(f.extract(),actor),/research_document_source_changed/);
    assert.equal(f.changes(),before);await writeFile(f.sourcePath,f.original);
    const preview=f.service.preview.bind(f.service),row=f.db.prepare('SELECT * FROM research_document_parse_coordinates WHERE parse_id=?').get(f.selection.parseId);
    const changed=JSON.parse(row.snapshot_json);changed.artifact.sha256='a'.repeat(64);const json=JSON.stringify(changed),digest=hash(json);
    f.service.preview=async request=>{
      const result=await preview(request);
      f.db.prepare('UPDATE research_document_parse_coordinates SET snapshot_json=?,snapshot_hash=? WHERE parse_id=?').run(json,digest,f.selection.parseId);
      f.db.prepare('UPDATE research_document_parses SET coordinate_snapshot_hash=? WHERE id=?').run(digest,f.selection.parseId);
      return result;
    };
    await assert.rejects(f.extractions.save(f.extract('coordinate-drift'),actor),/research_review_extraction_source_changed/);
    assert.equal(count(f),0);
  }finally{await f.cleanup();}
});

test('canonically changed extraction payload and Evidence invalidation during insert roll back the new record and scientific drift',async()=>{
  const f=await scene();
  try {
    f.db.function('fixture_sha',{deterministic:true},value=>hash(value));
    f.db.exec(`CREATE TRIGGER change_extraction AFTER INSERT ON research_review_extractions BEGIN
      UPDATE research_review_extractions SET snapshot_json=json_set(snapshot_json,'$.request.fields[0].value.number',999) WHERE id=NEW.id;
      UPDATE research_review_extractions SET snapshot_json=json_set(snapshot_json,'$.requestHash',fixture_sha(json_extract(snapshot_json,'$.request'))) WHERE id=NEW.id;
      UPDATE research_review_extractions SET snapshot_hash=fixture_sha(snapshot_json) WHERE id=NEW.id; END;`);
    await assert.rejects(f.extractions.save(f.extract(),actor),/research_review_extraction_snapshot_invalid/);
    assert.equal(count(f),0);f.db.exec('DROP TRIGGER change_extraction');
    f.db.exec("CREATE TRIGGER invalidate_extraction AFTER INSERT ON research_review_extractions BEGIN UPDATE research_evidence SET invalidated_at='2026-11-04T01:00:00Z'; END;");
    await assert.rejects(f.extractions.save(f.extract('invalidated'),actor),/research_review_extraction_source_changed/);
    assert.equal(count(f),0);assert.equal(f.repository.evidence.inspectEvidence(f.evidence.id,f.project.id).referenceStatus,'recorded');
  }finally{await f.cleanup();}
});

test('canonical source/parent corruption and historical protocol/archive preserve explicit source status rather than replacing fields',async()=>{
  const f=await scene();
  try {
    const first=await f.extractions.save(f.extract(),actor);
    const revision={...f.extract('next'),parentExtractionId:first.snapshot.id,expectedParentHash:first.snapshotHash,revisionReason:'Human explicitly confirms another reading.'};
    const second=await f.extractions.save(revision,actor),row=f.db.prepare('SELECT * FROM research_review_extractions WHERE id=?').get(first.snapshot.id);
    const changed=JSON.parse(row.snapshot_json);changed.sources[0].sourceLocator.blockId='forged';const json=JSON.stringify(changed);
    f.db.prepare('UPDATE research_review_extractions SET snapshot_json=?,snapshot_hash=? WHERE id=?').run(json,hash(json),row.id);
    assert.throws(()=>f.extractions.get(f.extractionGet(second.snapshot.id)),/research_review_extraction_snapshot_invalid/);
    f.db.prepare('UPDATE research_review_extractions SET snapshot_json=?,snapshot_hash=? WHERE id=?').run(row.snapshot_json,row.snapshot_hash,row.id);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'later-protocol',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later protocol.'},actor);
    const historical=f.extractions.get(f.extractionGet(second.snapshot.id));assert.deepEqual(historical,{...second,currentProtocol:false});
    const before=f.changes();await assert.rejects(f.extractions.save({...revision,requestId:'old-protocol'},actor),/research_review_extraction_version_conflict/);
    assert.equal(f.changes(),before);f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.deepEqual(f.extractions.get(f.extractionGet(second.snapshot.id)),historical);
    await assert.rejects(f.extractions.save({...revision,requestId:'archive'},actor),/research_project_archived/);
  }finally{await f.cleanup();}
});

test('generated extraction API binds real main reviewer through file awaits and all four methods preserve fixed data readonly',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewExtractionCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewExtractionCapabilities({pluginId:'research',capabilities:registry},f.extractions);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)}),input=f.extract(),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewExtraction.save',input),error=>error.code==='research_human_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-extraction-save',[{...input,actor}]));
    const missing=await bridge.invoke('research.saveReviewExtraction',[input]);assert.equal(missing.ok,false);
    assert.equal(missing.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const saved=await bridge.invoke('research.saveReviewExtraction',[input],151);assert.equal(saved.ok,true,JSON.stringify(saved));
    assert.deepEqual(saved.data.snapshot.actor,{kind:'user',id:'window:151'});assert.deepEqual(saved.data.snapshot.reviewer,f.plan.snapshot.request.fullTextReviewers[0]);
    const readonly=f.changes(),get=await bridge.invoke('research.getReviewExtraction',[f.extractionGet(saved.data.snapshot.id)],151);
    const list=await bridge.invoke('research.listReviewExtractions',[f.get],151),history=await bridge.invoke('research.getReviewExtractionHistory',[f.extractionHistory],151);
    assert.equal(get.ok,true);assert.equal(list.ok,true);assert.equal(history.ok,true);
    assert.deepEqual(get.data,saved.data);assert.deepEqual(list.data,[saved.data]);assert.deepEqual(history.data,[saved.data]);assert.equal(f.changes(),readonly);
  }finally{await f.cleanup();}
});

test('DB36 upgrade and actual SQLite reopen preserve frozen review/source/Evidence without fabricated extraction or new retrieval',async()=>{
  const oldApi={...api,applyResearchDatabaseSchema(db,now) {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(value=>value.version<=36),now});
  }};
  const f=await createReviewExtractionFixture(oldApi);let db,reviews,service;
  try {
    const tables=['research_review_screening_freezes','research_review_screening_plans','research_review_fulltext_bindings',
      'research_evidence','research_evidence_source_locators','research_documents'];
    const old=tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all());api.applyResearchDatabaseSchema(f.db);
    tables.forEach((table,index)=>assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(),old[index]));
    assert.equal(count(f),0);
    const result=await f.extractions.save(f.extract(),actor),path=join(f.root,'extraction-reopen.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time),dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const plans=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time),titleVotes=new api.ResearchReviewScreeningDecisions(db,repository,corpora,dedup,plans,()=>f.time);
    const titleArbitration=new api.ResearchReviewScreeningArbitration(db,repository,titleVotes,()=>f.time),titles=new api.ResearchReviewScreeningFreeze(db,repository,titleArbitration,()=>f.time);
    service=new api.ResearchDocumentService(repository,{},f.root);
    const bindings=new api.ResearchReviewFullTextRepository(db,repository,corpora,titles,service,()=>f.time);
    const votes=new api.ResearchReviewFullTextScreening(db,repository,titles,bindings,()=>f.time),arbitration=new api.ResearchReviewFullTextArbitration(db,repository,votes,bindings,()=>f.time);
    const freezing=new api.ResearchReviewFullTextFreeze(db,repository,arbitration,bindings,()=>f.time);
    const extractions=new api.ResearchReviewExtractionRepository(db,repository,freezing,bindings,service,()=>f.time),before=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(extractions.get(f.extractionGet(result.snapshot.id)),result);assert.deepEqual(extractions.history(f.extractionHistory),[result]);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await service?.shutdown();await reviews?.shutdown();db?.close();await f.cleanup();}
});
