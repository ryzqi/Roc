import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import Database from 'better-sqlite3';
import {createResearchFixture,loadResearchTestApi,unknownExperiment} from './fixtures/research-test-kit.mjs';
import {proposalChat} from './fixtures/research-proposal-origin.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api.dispose());
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function scene(){
  const root=await mkdtemp(join(tmpdir(),'roc-external-result-')),workspace=join(root,'workspace');await mkdir(workspace);
  const f=createResearchFixture(api,'writing',workspace),projectId=f.project.id;
  const artifact=f.repository.createArtifact({projectId,stage:'writing',kind:'manuscript',title:'External experiment question',path:null});
  const request={projectId,artifactId:artifact.id,expectedArtifactVersion:f.repository.inspectArtifact({projectId,artifactId:artifact.id,expectedVersion:null}).snapshot.version,
    requestId:'external-create',title:'External laboratory assay',instructions:'Report the declared signed concentration and preserve the output CSV.',
    definitions:[{id:'effect',label:'Signed effect',definition:'Externally reported concentration difference',unit:'mg',direction:'neutral'}],
    expectedFiles:[{path:'measurements.csv',role:'output'}],resultFormat:'roc-external-metrics/v1'};
  const human=(capability,action)=>api.withResearchHumanContext({projectId,capability,windowId:73},action);
  const created=human('research.externalExperiments.create',()=>f.repository.externalExperiments.create(request));
  const bind={projectId,contractId:created.contract.snapshot.id,expectedRecordHash:created.recordHash,requestId:'assign',provider:'Fixture laboratory',externalId:'lab-job-42'};
  const record=human('research.externalExperiments.bind',()=>f.repository.externalExperiments.bind(bind));
  const missing={kind:'unavailable',reason:'The external report did not estimate this quantity'};
  const report={schemaVersion:1,contractId:record.contract.snapshot.id,contractHash:record.contract.snapshotHash,externalId:bind.externalId,
    environment:{description:'Instrument and software reported by the laboratory',reportedBy:'External laboratory'},
    method:{name:'Reported assay',rationale:'External declared protocol',assumptions:'As reported by the laboratory',limitations:'Not independently reproduced'},
    result:{schemaVersion:1,metrics:[{id:'effect',value:-1.25,unit:'mg',sampleSize:5,uncertainty:missing,confidenceInterval:missing,effect:missing}]},
    files:[{path:'measurements.csv',role:'output',sha256:sha('value\n-1.25\n')}]};
  await writeFile(join(workspace,'measurements.csv'),'value\n-1.25\n');await writeFile(join(workspace,'report.json'),JSON.stringify(report,null,2));
  const importRequest=async()=>{const preview=await f.repository.externalExperiments.previewImport({projectId,contractId:record.contract.snapshot.id,resultPath:'report.json'});
    return {projectId,contractId:record.contract.snapshot.id,resultPath:'report.json',expectedRecordHash:preview.recordHash,requestId:'import',expectedResultHash:preview.original.sha256};};
  const dispose=async()=>{await f.close();await rm(root,{recursive:true,force:true});};
  return {...f,root,workspace,artifact,request,created,record,bind,report,human,importRequest,dispose};
}

test('waiting identity survives actual SQLite reopen and imported bytes survive later workspace changes without fake local execution',async()=>{
  const f=await scene();let reopened,agent;
  try{
    const path=join(f.root,'research.db');await f.db.backup(path);reopened=new Database(path);agent=new Database(':memory:');api.applyAgentDatabaseSchema(agent);
    const repository=new api.ResearchRepository(reopened,new api.ResearchTaskRepository(agent),()=> '2026-11-22T00:00:00.000Z');
    const waiting=repository.externalExperiments.get({projectId:f.project.id,contractId:f.record.contract.snapshot.id});
    assert.equal(waiting.status,'waiting');assert.equal(waiting.recordHash,f.record.recordHash);
    await repository.knowledgeJobs.shutdown();await repository.paperCards.shutdown();await repository.wiki.shutdown();
    reopened.close();reopened=null;agent.close();agent=null;
    const request=await f.importRequest();
    await assert.rejects(f.repository.externalExperiments.importResult(request),/research_human_required/u);
    const result=await f.human('research.externalExperiments.importResult',()=>f.repository.externalExperiments.importResult(request));
    assert.equal(result.snapshot.verification,'external_report_not_independently_verified');
    assert.equal('execution' in result.snapshot,false);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_experiment_results').pluck().get(),0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_experiment_executions').pluck().get(),0);
    await writeFile(join(f.workspace,'report.json'),'changed source');await writeFile(join(f.workspace,'measurements.csv'),'changed file');
    assert.deepEqual(f.repository.externalExperiments.getResult({projectId:f.project.id,resultId:result.snapshot.id,expectedHash:result.snapshotHash}),result);
    assert.deepEqual(await f.human('research.externalExperiments.importResult',()=>f.repository.externalExperiments.importResult(request)),result);
    const evidence=f.human('research.externalExperiments.captureMetric',()=>f.repository.externalExperiments.captureMetric({projectId:f.project.id,resultId:result.snapshot.id,expectedHash:result.snapshotHash,metricId:'effect'}));
    const metadata=f.repository.evidence.sourceMetadata(f.project.id,evidence.id);
    assert.equal(metadata.type,'external-experiment-report');assert.equal(metadata.verification,result.snapshot.verification);
    const claim=f.repository.evidence.createClaim({projectId:f.project.id,artifactId:f.artifact.id,subjectType:'paragraph',status:'supported',
      content:'The external laboratory reported -1.25 mg; Roc did not independently reproduce it.',evidenceIds:[evidence.id],experiment:{...unknownExperiment}});
    const manuscript=f.repository.manuscripts.saveManuscript({artifactId:f.artifact.id,sections:[{title:'External results',claimIds:[claim.id]}]});
    assert.ok(manuscript.latex.includes('-1.25 mg'));
    const record=f.repository.externalExperiments.get({projectId:f.project.id,contractId:f.record.contract.snapshot.id});
    assert.equal(record.status,'reported');assert.equal(record.sourceCurrent,false);
    const inspected=f.repository.responseMatrix.inspect({projectId:f.project.id,artifactId:f.artifact.id,expectedHash:null});
    const matrix=f.human('research.responseMatrix.save',()=>f.repository.responseMatrix.save({projectId:f.project.id,artifactId:f.artifact.id,
      requestId:'response',expectedArtifactVersion:inspected.report.artifactVersion,parent:null,rationale:'Retain external attribution',rows:[{
        commentId:'review-1',reviewer:'Reviewer',comment:'Obtain external measurement',status:'addressed',response:'The external report is now attributed in Results.',
        locations:[{claimId:claim.id,claimHash:api.relationClaimHash(claim),start:0,end:claim.content.length,text:claim.content}],evidenceIds:[evidence.id]
      }]}));
    assert.equal(matrix.snapshot.request.rows[0].evidenceIds[0],evidence.id);
    const projection=f.repository.externalExperiments.derive({projectId:f.project.id,resultId:result.snapshot.id,expectedHash:result.snapshotHash});
    assert.ok(projection.methods.includes('未独立核验'));
    assert.equal(projection.rows[0].metric.value,-1.25);assert.equal(projection.rows[0].metric.confidenceInterval.kind,'unavailable');
    assert.equal(JSON.parse(projection.figures[0].source).usermeta.roc.kind,'external_experiment_report');
  }finally{reopened?.close();agent?.close();await f.dispose();}
});

test('contract binding, report identity, declared units and bytes reject mismatches before any result publication',async()=>{
  const f=await scene();
  try{
    assert.deepEqual(f.human('research.externalExperiments.bind',()=>f.repository.externalExperiments.bind(f.bind)),f.record);
    const other=f.human('research.externalExperiments.create',()=>f.repository.externalExperiments.create({...f.request,requestId:'other-create'}));
    assert.throws(()=>f.human('research.externalExperiments.bind',()=>f.repository.externalExperiments.bind({...f.bind,contractId:other.contract.snapshot.id,
      requestId:'duplicate-assignment',expectedRecordHash:other.recordHash})),/assignment_exists/u);
    for(const change of [report=>report.externalId='different-job',report=>report.contractHash='f'.repeat(64),report=>report.result.metrics[0].unit='s',report=>report.files[0].sha256='e'.repeat(64)]){
      const changed=structuredClone(f.report);change(changed);await writeFile(join(f.workspace,'report.json'),JSON.stringify(changed));
      await assert.rejects(f.repository.externalExperiments.previewImport({projectId:f.project.id,contractId:f.record.contract.snapshot.id,resultPath:'report.json'}));
    }
    assert.equal(f.db.prepare('SELECT count(*) FROM research_external_experiment_results').pluck().get(),0);
    const changed=structuredClone(f.report);changed.engine='typescript';await writeFile(join(f.workspace,'report.json'),JSON.stringify(changed));
    await assert.rejects(f.repository.externalExperiments.previewImport({projectId:f.project.id,contractId:f.record.contract.snapshot.id,resultPath:'report.json'}),{name:'ZodError'});
  }finally{await f.dispose();}
});

test('the exact external metric source renders in the existing native figure service without an execution-engine cast',async()=>{
  const f=await scene();let figures;
  try{
    const result=await f.human('research.externalExperiments.importResult',async()=>f.repository.externalExperiments.importResult(await f.importRequest()));
    const projected=f.repository.externalExperiments.derive({projectId:f.project.id,resultId:result.snapshot.id,expectedHash:result.snapshotHash}),source=projected.figures[0];
    await writeFile(join(f.workspace,source.filename),source.source);
    f.db.prepare("UPDATE research_projects SET current_stage='figure' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='figure'").run(f.project.id);
    figures=new api.ResearchFigureService(f.repository,{renderFigure:request=>api.renderResearchFigure({operation:'render_figure',projectRoot:request.projectRoot,
      sourcePath:request.sourcePath,outputDir:request.outputDir,inputPaths:request.inputPaths,label:request.label,timeoutMs:request.timeoutMs,figure:request.figure},request.signal)},f.root,{error:()=>assert.fail('unexpected renderer persistence error')});
    const started=await figures.start({projectId:f.project.id,ownerRunId:null,requestId:'external-figure',label:'External signed result',engine:'vega-lite',sourceVersion:1,
      sourcePath:source.filename,expectedSourceHash:source.sourceHash,inputPaths:[],timeoutMs:10000,figure:{widthInches:3,heightInches:2,dpi:72,seed:42}});
    const deadline=Date.now()+10000;
    while(['preparing','running'].includes(figures.getRun(f.project.id,started.id).status)){assert.ok(Date.now()<deadline);await wait(10);}
    const complete=figures.getRun(f.project.id,started.id);assert.equal(complete.status,'completed',complete.error);
    const published=await figures.publish(f.project.id,started.id,null);
    const trace=JSON.parse((await figures.readRunFile({projectId:f.project.id,runId:started.id,area:'output',path:'figure-data.json'})).bytes.toString('utf8'));
    assert.ok(trace.marks.some(mark=>mark.items.some(item=>item.numericFields.value===-1.25)));
    assert.equal(published.sourcePath,source.filename);
    assert.equal(complete.files.find(file=>file.area==='input'&&file.path===source.filename).sha256,source.sourceHash);
  }finally{await figures?.shutdown();await f.dispose();}
});

test('Agent prepares only an external contract proposal and durable imported source damage fails closed',async()=>{
  const f=await scene();
  try{
    const {projectId,requestId:_request,...payload}=f.request;
    const proposed={projectId,artifactId:f.artifact.id,expectedArtifactVersion:f.request.expectedArtifactVersion,rationale:'Proposed external assay',basis:[],
      proposal:{kind:'external_experiment',payload}};
    const chat=proposalChat(api,f),operation=chat.operation(proposed),before=f.db.prepare('SELECT count(*) FROM research_external_experiments').pluck().get();
    const result=api.runWithCapabilityOperationContext(operation,()=>f.repository.proposals.create({...proposed,requestId:operation.idempotencyKey}));
    assert.equal(result.snapshot.origin.runId,chat.runId);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_external_experiments').pluck().get(),before);
    const imported=await f.human('research.externalExperiments.importResult',async()=>f.repository.externalExperiments.importResult(await f.importRequest()));
    f.db.prepare('UPDATE research_external_experiment_files SET bytes=? WHERE result_id=?').run(Buffer.from('damaged durable data'),imported.snapshot.id);
    assert.throws(()=>f.repository.externalExperiments.derive({projectId,resultId:imported.snapshot.id,expectedHash:imported.snapshotHash}),/snapshot_invalid/u);
    const other=f.repository.createProject({title:'Other',description:'',workspacePath:'/tmp/other-external-project'});
    assert.throws(()=>f.repository.externalExperiments.get({projectId:other.id,contractId:f.record.contract.snapshot.id}),/project_mismatch/u);
  }finally{await f.dispose();}
});
