import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewFullTextScreeningFixture,fullTextActor as actor} from './fixtures/research-review-fulltext-screening.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
const count=f=>f.db.prepare('SELECT count(*) FROM research_review_study_groupings').pluck().get();
async function scene({included=[0,2],...options}={},testApi=api) {
  const f=await createReviewFullTextScreeningFixture(testApi,options);
  for(const index of [0,2,3,4,5,6,7]) {
    if(included.includes(index)) {
      await f.bind(index);
      for(const reviewer of f.reviewerIds)await f.fullScreening.save(f.vote(index,reviewer,`include-${index}-${reviewer}`),actor);
    }else await f.fulltexts.save(f.notRetrieved(index,`gap-${index}`),actor);
  }
  f.frozen=await f.fullFreezing.freeze({...f.fullPhase,requestId:'freeze-for-study-groups',
    expectedReviewHash:f.fullFreezing.getPhase(f.fullPhase).reviewHash,reviewNote:'Human confirms explicit synthetic source eligibility and retrieval gaps.'},actor);
  f.studies=new api.ResearchReviewStudiesRepository(f.db,f.repository,f.fullFreezing,f.fulltexts,()=>f.time);
  f.report=index=>({hitId:f.corpus.snapshot.hits[index].id,expectedBindingHash:f.bound.get(index).snapshotHash,
    sourceNote:'Human identifies this declared synthetic investigation in the explicitly selected original report.'});
  f.group=(studyId,reports)=>({studyId,label:`Declared ${studyId}`,reason:'Explicit synthetic human study identity, not inferred title or DOI matching.',reports});
  f.groups=(requestId='group-reports')=>({...f.get,requestId,expectedFullFreezeHash:f.frozen.freezeHash,
    groups:included.length===0?[]:[f.group('study-one',included.map(index=>f.report(index)))],
    reviewerId:f.reviewerIds[0],reviewNote:'Human confirms complete report membership; no scientific study identity accuracy claim.',
    parentGroupingId:null,expectedParentHash:null,revisionReason:null});
  f.revise=(parent,requestId='revise-groups')=>({...f.groups(requestId),parentGroupingId:parent.snapshot.id,
    expectedParentHash:parent.snapshotHash,revisionReason:'Human explicitly revises the study identities and report memberships.'});
  return f;
}

test('explicit human report membership fixes distinct report and study counts with exact frozen hit/source refs and no duplicate paper library',async()=>{
  const f=await scene();
  try {
    const papers=f.db.prepare('SELECT * FROM research_library').all(),full=f.fullFreezing.getPhase(f.fullPhase),before=f.changes();
    assert.equal(f.studies.get(f.get),null);assert.deepEqual(f.studies.history(f.get),[]);assert.equal(f.changes(),before);
    const request=f.groups(),saved=await f.studies.save(request,actor);
    assert.deepEqual(saved.snapshot.request,request);assert.equal(saved.includedReports,2);assert.equal(saved.includedStudies,1);
    assert.deepEqual(saved.snapshot.reports.map(report=>report.hit.id),[f.corpus.snapshot.hits[0].id,f.corpus.snapshot.hits[2].id]);
    assert.deepEqual(saved.snapshot.actor,actor);assert.deepEqual(saved.snapshot.reviewer,f.plan.snapshot.request.fullTextReviewers[0]);
    assert.equal(saved.snapshotHash,hash(JSON.stringify(saved.snapshot)));assert.equal(saved.currentProtocol,true);assert.equal(saved.sourcesCurrent,true);
    assert.equal(f.db.prepare('SELECT study_group_head_hash FROM research_review_screening_plans').pluck().get(),saved.snapshotHash);
    assert.deepEqual(f.fullFreezing.getPhase(f.fullPhase),full);assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(),papers);
  }finally{await f.cleanup();}
});

test('human revisions support multiple reports per study and explicit multiple studies within one report without changing report totals',async()=>{
  const f=await scene();
  try {
    const initial=f.groups(),first=await f.studies.save(initial,actor),split=f.revise(first);
    split.groups=[f.group('study-one',[f.report(0)]),f.group('study-two',[f.report(2)])];
    const second=await f.studies.save(split,actor);assert.equal(second.includedReports,2);assert.equal(second.includedStudies,2);
    const multiple=f.revise(second,'multiple-studies-in-report');multiple.groups=[...split.groups,f.group('study-three',[{
      ...f.report(0),sourceNote:'Human explicitly identifies a different second investigation within this same original report.'}])];
    multiple.reviewerId=f.plan.snapshot.request.adjudicator.id;
    const third=await f.studies.save(multiple,actor);assert.equal(third.includedReports,2);assert.equal(third.includedStudies,3);
    assert.deepEqual(third.snapshot.reviewer,f.plan.snapshot.request.adjudicator);assert.equal(third.snapshot.version,3);
    const readonly=f.changes();assert.deepEqual(await f.studies.save(multiple,actor),third);
    assert.deepEqual(await f.studies.save(initial,actor),{...first,isLatest:false});
    assert.deepEqual(f.studies.history(f.get),[{...first,isLatest:false},{...second,isLatest:false},third]);
    await assert.rejects(f.studies.save({...multiple,reviewNote:'Changed request'},actor),/research_review_request_conflict/);
    await assert.rejects(f.studies.save(multiple,{kind:'user',id:'other'}),/research_review_request_conflict/);
    await assert.rejects(f.studies.save(f.revise(first,'old-parent'),actor),/research_review_studies_version_conflict/);
    await assert.rejects(f.studies.save(f.groups('missing-parent'),actor),/research_review_studies_version_conflict/);
    assert.equal(f.changes(),readonly);assert.equal(count(f),3);
  }finally{await f.cleanup();}
});

test('all included reports, exact bindings, unique study IDs and member notes are required; gaps/exclusions and guessed sources refuse',async()=>{
  const f=await scene();
  try {
    const valid=f.groups(),before=f.changes();
    for(const [request,error] of [
      [{...valid,groups:[]},/research_review_studies_incomplete/],
      [{...valid,groups:[f.group('study',[f.report(0)])]},/research_review_studies_incomplete/],
      [{...valid,groups:[f.group('study',[f.report(0),{...f.report(2),hitId:f.corpus.snapshot.hits[1].id}])]},/research_review_studies_report_not_included/],
      [{...valid,groups:[f.group('study',[f.report(0),{...f.report(2),hitId:f.corpus.snapshot.hits[3].id}])]},/research_review_studies_report_not_included/],
      [{...valid,groups:[f.group('study',[f.report(0),{...f.report(2),expectedBindingHash:'a'.repeat(64)}])]},/research_review_studies_version_conflict/],
      [{...valid,expectedFullFreezeHash:'a'.repeat(64)},/research_review_studies_version_conflict/],
      [{...valid,reviewerId:'undeclared'},/research_review_screening_reviewer_not_declared/]
    ])await assert.rejects(f.studies.save(request,actor),error);
    for(const request of [{...valid,actor},{...valid,groups:[valid.groups[0],valid.groups[0]]},
      {...valid,groups:[f.group('study',[f.report(0),f.report(0),f.report(2)])]},
      {...valid,groups:[f.group('study',[{...f.report(0),sourceNote:''},f.report(2)])]},
      {...valid,parentGroupingId:'parent',expectedParentHash:null}])await assert.rejects(f.studies.save(request,actor));
    assert.equal(count(f),0);assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('explicit zero-included-report grouping records reviewed zero studies rather than inventing undeclared counts',async()=>{
  const f=await scene({included:[]});
  try {
    assert.equal(f.studies.get(f.get),null);const saved=await f.studies.save(f.groups(),actor);
    assert.equal(saved.includedReports,0);assert.equal(saved.includedStudies,0);assert.deepEqual(saved.snapshot.reports,[]);
    assert.equal(f.frozen.freeze.authority.counts.not_retrieved,7);assert.deepEqual(f.studies.get(f.get),saved);
  }finally{await f.cleanup();}
});

test('actual original byte and asynchronous reparse verification refuse new study identities while frozen historical memberships remain readable',async()=>{
  const f=await scene();
  try {
    const saved=await f.studies.save(f.groups(),actor);await writeFile(f.sourcePath,Buffer.from('changed original'));
    const before=f.changes();await assert.rejects(f.studies.save(f.revise(saved),actor),/research_document_source_changed/);assert.equal(f.changes(),before);
    await writeFile(f.sourcePath,f.original);
    const preview=f.service.preview.bind(f.service);f.service.preview=async request=>{const result=await preview(request);f.reparse();return result;};
    await assert.rejects(f.studies.save(f.revise(saved,'reparse-during-group'),actor),/research_review_fulltext_version_conflict/);
    assert.deepEqual(f.studies.get(f.get),{...saved,sourcesCurrent:false});
    assert.deepEqual(f.studies.history(f.get),[{...saved,sourcesCurrent:false}]);assert.equal(count(f),1);
  }finally{await f.cleanup();}
});

test('lost latest receipt, missing marker, corrupted payload and broken parent cannot reset reviewed study counts',async()=>{
  const f=await scene();
  try {
    const first=await f.studies.save(f.groups(),actor),second=await f.studies.save(f.revise(first),actor),row=f.db.prepare('SELECT * FROM research_review_study_groupings WHERE id=?').get(second.snapshot.id);
    f.db.prepare('DELETE FROM research_review_study_groupings WHERE id=?').run(second.snapshot.id);
    const before=f.changes();assert.throws(()=>f.studies.get(f.get),/research_review_studies_snapshot_invalid/);assert.throws(()=>f.studies.history(f.get),/research_review_studies_snapshot_invalid/);
    await assert.rejects(f.studies.save(f.revise(first,'lost'),actor),/research_review_studies_snapshot_invalid/);assert.equal(f.changes(),before);
    f.db.prepare(`INSERT INTO research_review_study_groupings
      (id,project_id,corpus_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(row.id,row.project_id,row.corpus_id,row.version,row.parent_id,row.request_id,row.snapshot_json,row.snapshot_hash,row.created_at);
    f.db.prepare('UPDATE research_review_screening_plans SET study_group_head_hash=NULL').run();
    assert.throws(()=>f.studies.get(f.get),/research_review_studies_snapshot_invalid/);
    f.db.prepare('UPDATE research_review_screening_plans SET study_group_head_hash=?').run(second.snapshotHash);
    f.db.prepare('UPDATE research_review_study_groupings SET snapshot_json=? WHERE id=?').run('{}',second.snapshot.id);
    assert.throws(()=>f.studies.history(f.get));
    f.db.prepare('UPDATE research_review_study_groupings SET snapshot_json=?,parent_id=NULL WHERE id=?').run(row.snapshot_json,second.snapshot.id);
    assert.throws(()=>f.studies.get(f.get),/research_review_studies_snapshot_invalid/);
  }finally{await f.cleanup();}
});

test('canonically replaced study identity and actual source drift during storage roll back grouping, head and scientific drift',async()=>{
  const f=await scene();
  try {
    f.db.function('study_hash',value=>hash(value));f.db.function('alter_study',value=>{
      const snapshot=JSON.parse(value);snapshot.request.groups[0].studyId='altered-study';
      snapshot.requestHash=hash(JSON.stringify(api.researchReviewStudiesSaveSchema.parse(snapshot.request)));
      return JSON.stringify(api.researchReviewStudiesSnapshotSchema.parse(snapshot));
    });
    f.db.exec(`CREATE TRIGGER alter_study AFTER UPDATE OF study_group_head_hash ON research_review_screening_plans
      WHEN json_extract((SELECT snapshot_json FROM research_review_study_groupings WHERE corpus_id=NEW.corpus_id),'$.request.groups[0].studyId')='study-one'
      BEGIN UPDATE research_review_study_groupings SET snapshot_json=alter_study(snapshot_json),snapshot_hash=study_hash(alter_study(snapshot_json)) WHERE corpus_id=NEW.corpus_id;
      UPDATE research_review_screening_plans SET study_group_head_hash=(SELECT snapshot_hash FROM research_review_study_groupings WHERE corpus_id=NEW.corpus_id) WHERE id=NEW.id; END;`);
    await assert.rejects(f.studies.save(f.groups(),actor),/research_review_studies_snapshot_invalid/);assert.equal(count(f),0);
    assert.equal(f.db.prepare('SELECT study_group_head_hash FROM research_review_screening_plans').pluck().get(),null);f.db.exec('DROP TRIGGER alter_study');
    f.db.exec('CREATE TRIGGER study_source_drift AFTER INSERT ON research_review_study_groupings BEGIN UPDATE research_documents SET current_parse_id=NULL; END;');
    await assert.rejects(f.studies.save(f.groups('source-drift'),actor),/research_review_studies_source_changed/);assert.equal(count(f),0);
    assert.equal(f.repository.documents.get(f.document.id).currentParseId,f.selection.parseId);
  }finally{await f.cleanup();}
});

test('generated study-membership IPC requires actual main sender and declared human reviewer; protocol/archive history stays readonly',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry();for(const descriptor of api.researchReviewStudiesCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewStudiesCapabilities({pluginId:'research',capabilities:registry},f.studies);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)}),request=f.groups(),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewStudies.save',request),error=>error.code==='research_human_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-studies-save',[{...request,actor}]));
    const missing=await bridge.invoke('research.saveReviewStudies',[request]);assert.equal(missing.ok,false);assert.equal(missing.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const saved=await bridge.invoke('research.saveReviewStudies',[request],181);assert.equal(saved.ok,true,JSON.stringify(saved));
    assert.deepEqual(saved.data.snapshot.actor,{kind:'user',id:'window:181'});assert.deepEqual(saved.data.snapshot.reviewer,f.plan.snapshot.request.fullTextReviewers[0]);
    const readonly=f.changes(),get=await bridge.invoke('research.getReviewStudies',[f.get],181),history=await bridge.invoke('research.getReviewStudiesHistory',[f.get],181);
    assert.equal(get.ok,true);assert.equal(history.ok,true);assert.deepEqual(get.data,saved.data);assert.deepEqual(history.data,[saved.data]);assert.equal(f.changes(),readonly);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'later-protocol',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later protocol.'},actor);
    assert.deepEqual(f.studies.get(f.get),{...saved.data,currentProtocol:false});
    await assert.rejects(f.studies.save(f.revise(saved.data),actor),/research_review_studies_source_changed/);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.deepEqual(f.studies.history(f.get),[{...saved.data,currentProtocol:false}]);await assert.rejects(f.studies.save(f.revise(saved.data,'archive'),actor),/research_project_archived/);
  }finally{await f.cleanup();}
});

test('independent grouping after actual byte await and valid new membership revision during insert refuse the stale parent and roll back head drift',async()=>{
  const f=await scene();
  try {
    const first=await f.studies.save(f.groups(),actor),preview=f.service.preview.bind(f.service);let concurrent;
    f.service.preview=async request=>{
      const result=await preview(request);f.service.preview=preview;
      concurrent=await f.studies.save(f.revise(first,'independent-grouping'),actor);return result;
    };
    await assert.rejects(f.studies.save(f.revise(first,'stale-afterawait'),actor),/research_review_studies_version_conflict/);
    assert.deepEqual(f.studies.get(f.get),concurrent);assert.equal(count(f),2);
    assert.equal(f.db.prepare("SELECT count(*) FROM research_review_study_groupings WHERE request_id='stale-afterawait'").pluck().get(),0);
    f.db.function('study_hash',value=>hash(value));f.db.function('next_study',value=>{
      const previous=api.researchReviewStudiesSnapshotSchema.parse(JSON.parse(value)),request={...previous.request,
        requestId:'late-valid-group',parentGroupingId:previous.id,expectedParentHash:hash(value),revisionReason:'Valid grouping during storage.'};
      return JSON.stringify(api.researchReviewStudiesSnapshotSchema.parse({...previous,id:'late-valid-group',
        version:previous.version+1,request,requestHash:hash(JSON.stringify(request))}));
    });
    f.db.exec(`CREATE TRIGGER late_valid_study AFTER INSERT ON research_review_study_groupings WHEN NEW.request_id<>'late-valid-group'
      BEGIN INSERT INTO research_review_study_groupings
      (id,project_id,corpus_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
      VALUES ('late-valid-group',NEW.project_id,NEW.corpus_id,NEW.version+1,NEW.id,'late-valid-group',
        next_study(NEW.snapshot_json),study_hash(next_study(NEW.snapshot_json)),NEW.created_at); END;`);
    await assert.rejects(f.studies.save(f.revise(concurrent,'stale-postinsert'),actor),/research_review_studies_snapshot_invalid/);
    assert.equal(count(f),2);assert.deepEqual(f.studies.get(f.get),concurrent);
    assert.equal(f.db.prepare("SELECT count(*) FROM research_review_study_groupings WHERE id='late-valid-group'").pluck().get(),0);
  }finally{await f.cleanup();}
});

test('SQLite reopen preserves reviewed records without network requests or writes',async()=>{
  const f=await scene();let db,reviews,service;
  try {

    const tables=['research_review_screening_plans','research_review_screening_freezes','research_review_corpora','research_documents'];
    const original=tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all()),columns=Object.keys(original[0][0]);
    api.applyResearchDatabaseSchema(f.db);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_screening_plans').all().map(row=>Object.fromEntries(columns.map(key=>[key,row[key]]))),original[0]);
    for(const [index,table] of tables.entries())if(index>0)assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(),original[index]);
    assert.equal(f.db.prepare('SELECT study_group_head_hash FROM research_review_screening_plans').pluck().get(),null);assert.equal(count(f),0);
    const saved=await f.studies.save(f.groups(),actor),path=join(f.root,'study-groups-reopen.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>{},()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time),dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const roster=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time),titleVotes=new api.ResearchReviewScreeningDecisions(db,repository,corpora,dedup,roster,()=>f.time);
    const titleArbitration=new api.ResearchReviewScreeningArbitration(db,repository,titleVotes,()=>f.time),titles=new api.ResearchReviewScreeningFreeze(db,repository,titleArbitration,()=>f.time);
    service=new api.ResearchDocumentService(repository,{},f.root);
    const bindings=new api.ResearchReviewFullTextRepository(db,repository,corpora,titles,service,()=>f.time);
    const votes=new api.ResearchReviewFullTextScreening(db,repository,titles,bindings,()=>f.time),arbitration=new api.ResearchReviewFullTextArbitration(db,repository,votes,bindings,()=>f.time);
    const freezing=new api.ResearchReviewFullTextFreeze(db,repository,arbitration,bindings,()=>f.time);
    const studies=new api.ResearchReviewStudiesRepository(db,repository,freezing,bindings,()=>f.time),before=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(studies.get(f.get),saved);assert.deepEqual(studies.history(f.get),[saved]);assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);
    assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await service?.shutdown();await reviews?.shutdown();db?.close();await f.cleanup();}
});
