import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewFullTextScreeningFixture,fullTextActor as actor,fullTextExclude} from './fixtures/research-review-fulltext-screening.mjs';
import {createReviewQualityFixture} from './fixtures/research-review-quality.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
function services(f) {
  f.studies=new api.ResearchReviewStudiesRepository(f.db,f.repository,f.fullFreezing,f.fulltexts,()=>f.time);
  f.assessments=new api.ResearchReviewQualityAssessmentRepository(f.db,f.repository,f.qualityPlans,f.extractions,f.fullFreezing,()=>f.time);
  f.reports=new api.ResearchReviewReportService(f.db,f.repository,f.corpora,f.reviews,f.dedup,f.freezing,f.fullFreezing,
    f.studies,f.extractions,f.qualityPlans,f.assessments);
  f.group=(requestId='group-for-report')=>({...f.get,requestId,expectedFullFreezeHash:f.fullFrozen.freezeHash,
    groups:f.fullFrozen.freeze.authority.items.filter(item=>item.status==='included').map((item,index)=>({
      studyId:`declared-study-${index}`,label:`Declared study ${index}`,reason:'Explicit synthetic human identity, no inferred scientific matching.',
      reports:[{hitId:item.hit.id,expectedBindingHash:item.binding.expectedHash,sourceNote:'Human identifies this synthetic investigation in the bound original report.'}]
    })),reviewerId:f.reviewerIds[0],reviewNote:'Human confirms declared study/report counts.',
    parentGroupingId:null,expectedParentHash:null,revisionReason:null});
  f.assess=plan=>({...f.get,extractionId:f.extraction.snapshot.id,qualityPlanId:plan.snapshot.id,
    requestId:'assess-for-report',expectedPlanHash:plan.snapshotHash,expectedExtractionHash:f.extraction.snapshotHash,
    domains:plan.snapshot.request.definition.domains.map(domain=>({domainId:domain.id,
      value:{kind:'judged',judgement:domain.judgements[0],reason:'Explicit human source judgement.'},evidence:[f.reference]})),
    overall:{value:{kind:'unjudgeable',reason:'Human cannot determine overall quality from selected original material.'},evidence:[f.reference]},
    reviewerId:f.reviewerIds[0],reviewNote:'Human confirms synthetic quality observations.',
    parentAssessmentId:null,expectedParentHash:null,revisionReason:null});
  return f;
}
async function scene({quality=false,fullExclude=true,...options}={}) {
  if(quality)return services(await createReviewQualityFixture(api,options));
  const f=await createReviewFullTextScreeningFixture(api,options),included=f.title.freeze.authority.items.filter(item=>item.status==='included');
  for(const [position,item] of included.entries()) {
    const index=f.corpus.snapshot.hits.findIndex(hit=>hit.id===item.hit.id);
    if(position<2) {
      await f.bind(index);
      for(const reviewer of f.reviewerIds)await f.fullScreening.save(f.vote(index,reviewer,`full-${index}-${reviewer}`,
        position===1&&fullExclude?fullTextExclude:undefined),actor);
    }else await f.fulltexts.save(f.notRetrieved(index,`gap-${index}`),actor);
  }
  f.fullFrozen=await f.fullFreezing.freeze({...f.fullPhase,requestId:'freeze-for-report',expectedReviewHash:f.fullFreezing.getPhase(f.fullPhase).reviewHash,
    reviewNote:'Human confirms complete synthetic original source decisions and gaps.'},actor);
  f.extractions=new api.ResearchReviewExtractionRepository(f.db,f.repository,f.fullFreezing,f.fulltexts,f.service,()=>f.time);
  f.qualityPlans=new api.ResearchReviewQualityPlanRepository(f.db,f.repository,f.extractions,f.fullFreezing,()=>f.time);
  return services(f);
}

test('report conserves actual original, screened, sought, missing, excluded and included counts without inventing a study count or extraction',async()=>{
  const f=await scene();
  try {
    const before=f.changes(),requests=f.calls.length,report=f.reports.get(f.get),c=report.body.counts;
    assert.deepEqual(c,{identifiedRecords:8,removedDuplicates:0,recordsScreened:8,recordsExcluded:1,reportsSought:7,
      reportsNotRetrieved:5,reportsAssessed:2,reportsExcluded:1,includedReports:1,includedStudies:null});
    assert.equal(report.bodyHash,hash(JSON.stringify(report.body)));assert.equal(report.body.studyGrouping,null);
    assert.deepEqual(report.body.evidenceTable,[{hit:f.corpus.snapshot.hits[0],extraction:null,qualityPlan:null,assessment:null}]);
    assert.deepEqual(report.evidenceStatus,[{hitId:f.corpus.snapshot.hits[0].id,extraction:null,qualityPlan:null,assessment:null}]);
    assert.equal(report.currentProtocol,true);assert.equal(report.sourcesCurrent,true);assert.equal(report.body.searchCoverageComplete,true);
    assert.deepEqual(report.body.basis,{protocolVersionHash:f.protocol.versionHash,protocolFreezeHash:f.protocol.freezeHash,
      corpusHash:f.corpus.snapshotHash,dedupFreezeHash:f.frozen.freezeHash,titleFreezeHash:f.title.freezeHash,fullFreezeHash:f.fullFrozen.freezeHash});
    assert.deepEqual(f.reports.get(f.get),report);assert.equal(f.changes(),before);assert.equal(f.calls.length,requests);
    for(const field of ['identifiedRecords','reportsNotRetrieved','includedReports','includedStudies']) {
      const changed=structuredClone(report.body);changed.counts[field]=9;
      assert.throws(()=>api.researchReviewReportBodySchema.parse(changed),/review_report_counts_not_conserved/);
    }
  }finally{await f.cleanup();}
});

test('query appendix retains exact query parameters, dates, terminal source receipts and all raw metadata including repeats and nulls',async()=>{
  const f=await scene();
  try {
    const report=f.reports.get(f.get),original=f.corpus.snapshot;
    assert.equal(report.body.queries.length,2);assert.equal(report.body.records.length,8);
    for(const [index,query] of report.body.queries.entries()) {
      assert.deepEqual(query.source,original.sources[index]);assert.equal(query.search.snapshot.parameters.query,f.protocol.version.body.databases[0].queries[index]);
      assert.equal(query.search.snapshot.startedAt,f.time);assert.equal(query.search.receipt.endedAt,f.time);
      assert.equal(query.search.snapshotHash,query.source.snapshotHash);assert.equal(query.search.receiptHash,query.source.receiptHash);
      assert.deepEqual(query.search,f.reviews.get({projectId:f.project.id,reviewSearchId:query.source.reviewSearchId}));
    }
    for(const row of report.body.records)assert.deepEqual(row.record,f.corpora.getHit({...f.get,hitId:row.hit.id}).record);
    assert.equal(report.body.records[0].record.record.publishedYear,null);
    assert.deepEqual(report.body.records.map(row=>row.hit),original.hits);
    assert.equal(new Set(report.body.records.map(row=>row.record.record.id)).size,4);
  }finally{await f.cleanup();}
});

test('primary human exclusion criteria and exact reviewer/arbitration/source refs are separate from unavailable-report counts',async()=>{
  const f=await scene();
  try {
    const report=f.reports.get(f.get),rows=report.body.exclusions,criterion=f.protocol.version.body.exclusionCriteria.find(value=>value.id==='no-outcome');
    assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.phase),['title_abstract','full_text']);
    assert.deepEqual(rows.map(row=>row.criterion),[criterion,criterion]);
    assert.deepEqual(rows[0].hit,f.corpus.snapshot.hits[1]);assert.equal(rows[0].binding,null);
    assert.deepEqual(rows[1].hit,f.corpus.snapshot.hits[2]);assert.deepEqual(rows[1].binding,{id:f.bound.get(2).snapshot.id,expectedHash:f.bound.get(2).snapshotHash});
    assert.deepEqual(rows[0].decisions,f.title.freeze.authority.items.find(item=>item.hit.id===rows[0].hit.id).decisions);
    assert.deepEqual(rows[1].decisions,f.fullFrozen.freeze.authority.items.find(item=>item.hit.id===rows[1].hit.id).decisions);
    const grouped=await f.studies.save(f.group(),actor),next=f.reports.get(f.get);
    assert.equal(next.body.counts.includedStudies,1);assert.equal(next.body.counts.reportsNotRetrieved,5);
    assert.deepEqual(next.body.studyGrouping,{snapshot:grouped.snapshot,snapshotHash:grouped.snapshotHash});assert.notEqual(next.bodyHash,report.bodyHash);
  }finally{await f.cleanup();}
});

test('report Evidence and human quality rows retain actual extraction units, missing/unjudgeable values and precise framework/assessment versions',async()=>{
  const f=await scene({quality:true});
  try {
    const input={...f.extract('missing-extraction'),parentExtractionId:f.extraction.snapshot.id,expectedParentHash:f.extraction.snapshotHash,
      revisionReason:'Human records that this particular required value is missing.'};
    input.fields[0].value={kind:'missing',reason:'Original report does not provide this measure.'};
    f.extraction=await f.extractions.save(input,actor);const plan=await f.qualityPlans.create(f.qualityInput(),actor);
    const assessment=await f.assessments.save(f.assess(plan),actor),report=f.reports.get(f.get),row=report.body.evidenceTable[0];
    assert.deepEqual(row.extraction,{snapshot:f.extraction.snapshot,snapshotHash:f.extraction.snapshotHash});
    assert.equal(row.extraction.snapshot.request.fields[0].unit,f.protocol.version.body.extractionFields[0].unit);
    assert.equal(row.extraction.snapshot.request.fields[0].value.kind,'missing');
    assert.deepEqual(row.extraction.snapshot.sources,f.extraction.snapshot.sources);
    assert.deepEqual(row.qualityPlan,{snapshot:plan.snapshot,snapshotHash:plan.snapshotHash});
    assert.deepEqual(row.assessment,{snapshot:assessment.snapshot,snapshotHash:assessment.snapshotHash});
    assert.equal(row.assessment.snapshot.request.overall.value.kind,'unjudgeable');assert.equal(row.qualityPlan.snapshot.request.definition.origin,'user_declared');
    assert.equal(report.evidenceStatus[0].extraction.referenceStatus,'current');assert.equal(report.body.counts.includedStudies,null);
  }finally{await f.cleanup();}
});

test('actual source reparse or later protocol changes preserve frozen report hash/body/counts while live reference flags become stale',async()=>{
  const f=await scene({quality:true});
  try {
    const plan=await f.qualityPlans.create(f.qualityInput(),actor);await f.assessments.save(f.assess(plan),actor);await f.studies.save(f.group(),actor);
    const first=f.reports.get(f.get);f.reparse();const source=f.reports.get(f.get);
    assert.deepEqual(source.body,first.body);assert.equal(source.bodyHash,first.bodyHash);assert.equal(source.sourcesCurrent,false);
    assert.equal(source.evidenceStatus[0].extraction.referenceStatus,'superseded');assert.equal(source.evidenceStatus[0].assessment.referenceStatus,'superseded');
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'later-protocol',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later review protocol.'},actor);
    const later=f.reports.get(f.get);assert.deepEqual(later.body,first.body);assert.equal(later.bodyHash,first.bodyHash);assert.equal(later.currentProtocol,false);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const before=f.changes();assert.deepEqual(f.reports.get(f.get),later);assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('failed source coverage and reviewed zero reports/studies are explicit terminal facts rather than complete search or substituted records',async()=>{
  const f=await scene({fetch:async()=>new Response('source down',{status:500})});
  try {
    const report=f.reports.get(f.get);assert.equal(report.body.searchCoverageComplete,false);assert.deepEqual(report.body.records,[]);
    for(const query of report.body.queries) {
      assert.equal(query.source.status,'failed');
      assert.equal(query.search.receipt.errorCode,null);
      assert.ok(query.search.sources.some(source=>source.errorCode!==null));
    }
    for(const [key,value] of Object.entries(report.body.counts))assert.equal(value,key==='includedStudies'?null:0);
    await f.studies.save(f.group(),actor);const reviewed=f.reports.get(f.get);assert.equal(reviewed.body.counts.includedStudies,0);
    assert.equal(reviewed.body.counts.reportsExcluded,0);assert.equal(reviewed.body.queries.length,2);
  }finally{await f.cleanup();}
});

test('missing frozen or marked extraction/quality/group receipts and corrupted raw pools refuse reports rather than returning empty scientific data',async()=>{
  const f=await scene({quality:true});
  try {
    const plan=await f.qualityPlans.create(f.qualityInput(),actor);const saved=await f.assessments.save(f.assess(plan),actor);
    f.db.prepare('DELETE FROM research_review_quality_assessments WHERE id=?').run(saved.snapshot.id);
    const before=f.changes();assert.throws(()=>f.reports.get(f.get),/research_review_quality_assessment_snapshot_invalid/);assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
  const g=await scene();
  try {
    await g.studies.save(g.group(),actor);g.db.prepare('DELETE FROM research_review_study_groupings').run();
    assert.throws(()=>g.reports.get(g.get),/research_review_studies_snapshot_invalid/);
    g.db.prepare('UPDATE research_review_screening_plans SET study_group_head_hash=NULL').run();
    const source=g.corpus.snapshot.sources[0],original=g.db.prepare('SELECT pool_json FROM research_literature_search_pools WHERE execution_id=?').pluck().get(source.executionId);
    const changed=JSON.parse(original);changed.records[0].record.title='Corrupted original report metadata';
    g.db.prepare('UPDATE research_literature_search_pools SET pool_json=? WHERE execution_id=?').run(JSON.stringify(changed),source.executionId);
    assert.throws(()=>g.reports.get(g.get),/research_review_search_pool_invalid/);
    g.db.prepare('UPDATE research_literature_search_pools SET pool_json=? WHERE execution_id=?').run(original,source.executionId);
    g.db.prepare("DELETE FROM research_review_screening_freezes WHERE phase='full_text'").run();
    assert.throws(()=>g.reports.get(g.get),/research_review_screening_snapshot_invalid/);
  }finally{await g.cleanup();}
});

test('actual registered report capability/preload IPC reads the original project scope without human writes, network requests or wire fallbacks',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry();registry.declare('research',api.researchReviewReportCapability);
    api.registerResearchReviewReportCapability({pluginId:'research',capabilities:registry},f.reports);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)});
    const other=f.repository.createProject({title:'Other report project',description:'Synthetic',workspacePath:'/tmp/roc-report-foreign'});
    const before=f.changes(),calls=f.calls.length;
    const read=await bridge.invoke('research.getReviewReport',[f.get],191);assert.equal(read.ok,true,JSON.stringify(read));assert.deepEqual(read.data,f.reports.get(f.get));
    assert.equal(f.changes(),before);assert.equal(f.calls.length,calls);
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-report-get',[{...f.get,actor}]));
    const foreign=await bridge.invoke('research.getReviewReport',[{...f.get,projectId:'foreign-project'}],191);
    assert.equal(foreign.ok,false);assert.equal(foreign.error.code,'research_project_not_found');
    const crossing=await bridge.invoke('research.getReviewReport',[{...f.get,projectId:other.id}],191);
    assert.equal(crossing.ok,false);assert.equal(crossing.error.code,'research_review_project_mismatch');
    const missing=await bridge.invoke('research.getReviewReport',[{...f.get,corpusId:'unknown-corpus'}],191);
    assert.equal(missing.ok,false);assert.equal(missing.error.code,'research_review_corpus_not_found');
    assert.equal(f.changes(),before);assert.equal(f.calls.length,calls);
  }finally{await f.cleanup();}
});
