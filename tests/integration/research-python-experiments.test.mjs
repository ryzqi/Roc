import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, readFile, symlink, rm, chmod, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { loadResearchTestApi, createResearchFixture, figureRequest } from '../unit/fixtures/research-test-kit.mjs';

const python = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
  'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":sys.version.split()[0]}))'], { encoding: 'utf8' }));
assert.match(python.version, /^3\.14\.\d+$/u);
let api, root;
const receipts = [];
before(async () => { api = await loadResearchTestApi(); root = await realpath(await mkdtemp('/private/tmp/roc-python-experiments-')); });
after(async () => {
  const output = join(process.cwd(), '.artifacts/research-optimization/pr08-a4e');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'python-experiments.json'), JSON.stringify({
    python, actualIsolatedPython: true, nativePicker: 'fixture response; no user product selection', receipts
  }, null, 2));
  await rm(root, { recursive: true, force: true }); api.dispose();
});

const source = `import json, os, random
import roc_experiment as roc
import fixture_pkg
with open(os.path.join(roc.input_dir, "data.txt")) as data:
    value = int(data.read()) * int(roc.parameters["scale"]) + fixture_pkg.VALUE
with open(os.path.join(roc.output_dir, "result.json"), "w") as output:
    json.dump({"value": value, "random": random.random()}, output, sort_keys=True)
print("ACTUAL_PYTHON_RESULT", flush=True)
`;

const metricSource=`import json, os, statistics
import roc_experiment as roc
with open(os.path.join(roc.input_dir, "data.txt")) as data:
    observations = [float(value) * float(roc.parameters["scale"]) for value in data.read().split()]
result = {"schemaVersion": 1, "metrics": [{
    "id": "mean", "value": statistics.mean(observations), "unit": "ms", "sampleSize": len(observations),
    "uncertainty": {"kind": "recorded", "type": "standard_deviation", "value": statistics.stdev(observations)},
    "confidenceInterval": {"kind": "unavailable", "reason": "No interval was estimated in this synthetic run"},
    "effect": {"kind": "unavailable", "reason": "No control group was measured"}
}]}
with open(os.path.join(roc.output_dir, "metrics.json"), "w") as output:
    json.dump(result, output)
print("ACTUAL_METRIC_RESULT", flush=True)
`;

test('actual metric review freezes measured values, full method and source identity; comparisons expose changed data and parameters',async()=>{
  const f=await fixture(metricSource);
  try {
    await writeFile(join(f.workspace,'data.txt'),'1 2 3\n');
    const results=new api.ResearchExperimentResultService(f.repository,f.service);
    const review=async(run,requestId)=>{
      const output=run.files.find(file=>file.area==='output'&&file.path==='metrics.json');
      return api.withResearchHumanContext({capability:'research.experimentResults.review',projectId:f.project.id,windowId:72},
        ()=>results.review({projectId:f.project.id,requestId,runId:run.id,expectedInputHash:run.inputHash,
          resultPath:output.path,expectedResultHash:output.sha256,
          definitions:[{id:'mean',label:'Synthetic latency mean',definition:'Arithmetic mean of every declared data.txt observation after scale multiplication',
            unit:'ms',direction:'lower'}],
          method:{name:'Arithmetic mean and sample standard deviation',rationale:'Summarize every observation',
            assumptions:'Synthetic independent observations only',limitations:'No confidence interval or control group'}}));
    };
    const first=await f.execute(f.request),a=await review(first,'metric-first');
    assert.equal(a.snapshot.result.metrics[0].value,4);
    assert.equal(a.snapshot.result.metrics[0].sampleSize,3);
    assert.equal(a.snapshot.result.metrics[0].uncertainty.value,2);
    assert.equal(a.snapshot.execution.source.sha256,first.files.find(file=>file.path==='analysis.py').sha256);
    assert.equal(a.snapshot.actor.id,'window:72');
    assert.deepEqual(await review(first,'metric-first'),a);
    const reference=result=>({resultId:result.snapshot.id,expectedHash:result.snapshotHash});
    const second=await f.execute({...f.request,requestId:'metric-repeat'}),b=await review(second,'metric-second');
    const same=await results.compare({projectId:f.project.id,left:reference(a),right:reference(b)});
    assert.equal(same.comparable,true);assert.deepEqual(same.differences,[]);
    const scaled=await f.execute({...f.request,requestId:'metric-scaled',parameters:{scale:'3'}}),c=await review(scaled,'metric-third');
    const changed=await results.compare({projectId:f.project.id,left:reference(a),right:reference(c)});
    assert.equal(changed.comparable,false);assert.deepEqual(changed.differences,['parameters']);
    assert.equal(c.snapshot.result.metrics[0].value,6);
    await writeFile(join(f.workspace,'data.txt'),'2 3 4\n');
    const next=await f.execute({...f.request,requestId:'metric-data'}),d=await review(next,'metric-fourth');
    const data=await results.compare({projectId:f.project.id,left:reference(a),right:reference(d)});
    assert.equal(data.comparable,false);assert.deepEqual(data.differences,['data']);
    assert.deepEqual(f.repository.experimentResults.list({projectId:f.project.id,runId:first.id,offset:0,limit:20}),{items:[a],total:1});
    assert.equal(f.repository.experiments.get(f.project.id,first.id).status,'completed');
    const handlers=new Map();
    api.registerResearchExperimentResultCapabilities({pluginId:'fixture',capabilities:{register(_id,descriptor,handler){handlers.set(descriptor.name,handler);}}},
      f.repository.experimentResults,results);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>handlers.get(name)(input)});
    const wire=await bridge.invoke('research.reviewExperimentResult',[a.snapshot.request],72);
    assert.equal(wire.ok,true);assert.deepEqual(wire.data,a);
    assert.equal((await bridge.invoke('research.reviewExperimentResult',[a.snapshot.request])).ok,false);
    const read=await bridge.invoke('research.compareExperimentResults',[{projectId:f.project.id,left:reference(a),right:reference(b)}],72);
    assert.equal(read.ok,true);assert.equal(read.data.comparable,true);
    const databasePath=join(f.path,'result-history.sqlite');
    await f.db.backup(databasePath);
    const disk=new Database(databasePath);disk.pragma('foreign_keys=ON');
    let reopened;
    try {
      api.applyResearchDatabaseSchema(disk);
      assert.equal(disk.prepare('SELECT current_version FROM schema_metadata').pluck().get(),45);
      const repository=new api.ResearchRepository(disk,f.tasks),before=f.observed.length;
      reopened=new api.ResearchExperimentService(repository,{
        inspect:async()=>assert.fail('result history must not inspect an execution environment')
      },f.path,{error:()=>assert.fail('unexpected result recovery error')},
      async()=>assert.fail('result history must not dispatch computation'));
      const history=new api.ResearchExperimentResultService(repository,reopened);
      assert.deepEqual(await history.get({projectId:f.project.id,...reference(a)}),a);
      assert.deepEqual(await history.compare({projectId:f.project.id,left:reference(a),right:reference(b)}),same);
      assert.equal(f.observed.length,before);
      disk.prepare('UPDATE research_experiment_results SET created_at=? WHERE id=?').run('damaged',a.snapshot.id);
      await assert.rejects(history.get({projectId:f.project.id,...reference(a)}),/research_result_snapshot_invalid/u);
    }finally{await reopened?.shutdown();disk.close();}
    receipts.push({scenario:'actual-metric-comparison',same,changed,data});
  } finally {await f.cleanup();}
});

test('metric review requires actual complete output and human authority; source rehash and stale identities cannot rewrite a frozen result',async()=>{
  const f=await fixture(metricSource);
  try {
    await writeFile(join(f.workspace,'data.txt'),'1 2 3\n');
    const run=await f.execute(f.request),output=run.files.find(file=>file.path==='metrics.json');
    const service=new api.ResearchExperimentResultService(f.repository,f.service);
    const request={projectId:f.project.id,requestId:'review-errors',runId:run.id,expectedInputHash:run.inputHash,
      resultPath:output.path,expectedResultHash:output.sha256,definitions:[{id:'mean',label:'Mean',definition:'Arithmetic mean',unit:'ms',direction:'lower'}],
      method:{name:'Arithmetic mean',rationale:'Every observation',assumptions:'Synthetic independent observations',limitations:'No inference'}};
    const human=action=>api.withResearchHumanContext({capability:'research.experimentResults.review',projectId:f.project.id,windowId:72},action);
    await assert.rejects(service.review(request),/research_human_required/u);
    await assert.rejects(human(()=>service.review({...request,expectedResultHash:'0'.repeat(64)})),/research_result_output_changed/u);
    await assert.rejects(human(()=>service.review({...request,definitions:[{...request.definitions[0],unit:'s'}]})),/research_result_definition_mismatch/u);
    await assert.rejects(human(()=>service.review({...request,expectedInputHash:'0'.repeat(64)})),/research_result_input_changed/u);
    const saved=await human(()=>service.review(request));
    await assert.rejects(human(()=>service.review({...request,method:{...request.method,name:'Changed after seeing data'}})),/research_result_request_conflict/u);
    const reference={projectId:f.project.id,resultId:saved.snapshot.id,expectedHash:saved.snapshotHash};
    assert.deepEqual(await service.get(reference),saved);
    await assert.rejects(service.get({...reference,expectedHash:'0'.repeat(64)}),/research_result_hash_mismatch/u);
    const path=join(f.repository.experiments.root(f.project.id,run.id),'input/analysis.py');
    await chmod(path,0o600);await writeFile(path,metricSource+'\nprint("host changed source")\n');
    await assert.rejects(service.get(reference),/research_experiment_snapshot_changed/u);
    const changed={...run,files:run.files.map(file=>file.path==='analysis.py'?{...file,sha256:createHash('sha256').update(metricSource+'\nprint("host changed source")\n').digest('hex'),
      size:Buffer.byteLength(metricSource+'\nprint("host changed source")\n')}:file)};
    f.db.prepare('UPDATE research_experiment_executions SET snapshot_json=? WHERE run_id=?').run(JSON.stringify(changed),run.id);
    const {artifactId:_artifact,...manifest}=changed,manifestPath=join(f.repository.experiments.root(f.project.id,run.id),'manifest.json');
    await chmod(manifestPath,0o600);await writeFile(manifestPath,JSON.stringify(manifest,null,2));
    await assert.rejects(service.get(reference),/research_result_execution_changed/u);
    assert.deepEqual(await human(()=>service.review(request)),saved);
    assert.equal(f.repository.experimentResults.list({projectId:f.project.id,runId:run.id,offset:0,limit:100}).total,1);
  }finally{await f.cleanup();}
});

test('actual result metric evidence traces claims, figures and Idea history to an immutable negative output across restart',async()=>{
  const f=await fixture(metricSource,{scenario:'metric-evidence'});
  let reopened,figureService,figure;
  try {
    await writeFile(join(f.workspace,'data.txt'),'-3 -2 -1\n');
    const run=await f.execute(),output=run.files.find(file=>file.path==='metrics.json');
    assert.equal(run.status,'completed',run.error);
    const service=new api.ResearchExperimentResultService(f.repository,f.service);
    const receipt=await api.withResearchHumanContext({capability:'research.experimentResults.review',projectId:f.project.id,windowId:72},
      ()=>service.review({projectId:f.project.id,requestId:'metric-evidence',runId:run.id,expectedInputHash:run.inputHash,
        resultPath:output.path,expectedResultHash:output.sha256,definitions:[{id:'mean',label:'Mean',definition:'Mean of all scaled observations',unit:'ms',direction:'lower'}],
        method:{name:'Mean',rationale:'All observations',assumptions:'Independent synthetic observations',limitations:'No inference'}}));
    const request={projectId:f.project.id,resultId:receipt.snapshot.id,expectedHash:receipt.snapshotHash,metricId:'mean'};
    const capture=value=>api.withResearchHumanContext({capability:'research.experimentResults.captureEvidence',projectId:f.project.id,windowId:72},
      ()=>service.captureEvidence(value));
    await assert.rejects(service.captureEvidence(request),/research_human_required/u);
    await assert.rejects(capture({...request,metricId:'absent'}),/research_result_metric_not_found/u);
    await assert.rejects(capture({...request,expectedHash:'0'.repeat(64)}),/research_result_hash_mismatch/u);
    const before=f.db.prepare('SELECT count(*) FROM research_knowledge_documents').pluck().get();
    f.db.exec(`CREATE TRIGGER fixture_evidence_failure BEFORE INSERT ON research_evidence BEGIN SELECT RAISE(ABORT,'fixture_capture_failure'); END`);
    await assert.rejects(capture(request),/fixture_capture_failure/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_knowledge_documents').pluck().get(),before);
    f.db.exec('DROP TRIGGER fixture_evidence_failure');
    const evidence=await capture(request),document=f.db.prepare('SELECT * FROM research_knowledge_documents WHERE id=?').get(evidence.documentId);
    assert.deepEqual(await capture(request),evidence);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_knowledge_documents WHERE id=?').get(evidence.documentId),document);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_knowledge_embeddings WHERE chunk_id=?').pluck().get(evidence.chunkId),0);
    const excerpt=JSON.parse(evidence.excerpt);
    assert.equal(excerpt.metric.value,-4);assert.equal(excerpt.metric.sampleSize,3);
    assert.equal(excerpt.source.pointer,'/metrics/0');assert.equal(excerpt.source.sha256,output.sha256);
    assert.equal(excerpt.source.resultHash,receipt.snapshotHash);
    assert.deepEqual(await service.evidence({projectId:f.project.id,evidenceId:evidence.id}),{receipt,metricId:'mean'});
    assert.deepEqual(f.service.evidenceSource(f.project.id,evidence.id),{projectId:f.project.id,runId:run.id,area:'output',path:'metrics.json'});
    const file=await f.service.source(f.service.evidenceSource(f.project.id,evidence.id));
    assert.equal(JSON.parse(file.bytes).metrics[0].value,-4);
    const otherWorkspace=join(f.path,'other-workspace');await mkdir(otherWorkspace);
    const other=f.repository.createProject({title:'Other project',description:'Isolation',workspacePath:otherWorkspace});
    await assert.rejects(service.evidence({projectId:other.id,evidenceId:evidence.id}),/research_evidence_project_mismatch/u);
    const originalStage=f.repository.getProject(f.project.id).currentStage;
    const artifacts=[];
    for(const [stage,kind,subjectType] of [['reading','reading_notes','claim'],['figure','figure','figure'],['writing','manuscript','paragraph']]) {
      f.db.prepare('UPDATE research_projects SET current_stage=? WHERE id=?').run(stage,f.project.id);
      f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage=?").run(f.project.id,stage);
      let artifact;
      if(kind==='figure') {
        await writeFile(join(f.workspace,'figure.vl.json'),JSON.stringify({
          data:{values:[{metric:'mean',value:excerpt.metric.value}]},mark:'bar',
          encoding:{x:{field:'metric',type:'nominal'},y:{field:'value',type:'quantitative',title:excerpt.metric.unit}}
        }));
        figureService=new api.ResearchFigureService(f.repository,{renderFigure:request=>api.renderResearchFigure({
          operation:'render_figure',projectRoot:request.projectRoot,sourcePath:request.sourcePath,
          outputDir:request.outputDir,inputPaths:request.inputPaths,label:request.label,
          timeoutMs:request.timeoutMs,figure:request.figure
        },request.signal)},f.path,{error:()=>assert.fail('no figure persistence errors')});
        const started=await figureService.start(figureRequest(f.project.id,null,{inputPaths:[],timeoutMs:10000}));
        const deadline=Date.now()+20000;
        let completed;
        do {
          completed=figureService.getRun(f.project.id,started.id);
          if(!['preparing','running'].includes(completed.status))break;
          assert.ok(Date.now()<deadline,'actual metric figure timed out');
          await new Promise(done=>setTimeout(done,20));
        }while(true);
        assert.equal(completed.status,'completed',completed.error);
        figure=await figureService.publish(f.project.id,started.id,null);
        assert.equal((await figureService.verify(f.project.id,figure.id)).id,figure.id);
        artifact=f.repository.getArtifact(figure.artifactId);
      } else {
        artifact=f.repository.createArtifact({projectId:f.project.id,stage,kind,title:`Metric ${kind}`,path:null});
      }
      const claim=f.repository.evidence.createClaim({projectId:f.project.id,artifactId:artifact.id,subjectType,
        content:'The measured mean is -4 ms.',status:'hypothesis',evidenceIds:[evidence.id]});
      const revised=f.repository.evidence.updateClaim({id:claim.id,expectedVersion:claim.version,
        content:'The negative mean remains -4 ms.',status:subjectType==='claim'?'hypothesis':'supported',evidenceIds:[evidence.id]});
      assert.deepEqual(f.repository.evidence.claimHistory(claim.id).map(value=>value.evidenceIds),[[evidence.id],[evidence.id]]);
      assert.equal(revised.status,subjectType==='claim'?'hypothesis':'supported');
      const inspected=f.repository.inspectArtifact({projectId:f.project.id,artifactId:artifact.id,expectedVersion:null});
      assert.deepEqual(inspected.snapshot.evidence.map(source=>source.evidence.id),[evidence.id]);
      artifacts.push(artifact);
      if(subjectType!=='claim') {
        const source=f.repository.evidence.inspectEvidence(evidence.id,f.project.id),sourceDigest=api.relationSourceDigest(source);
        const relation=f.repository.evidence.relations.propose({projectId:f.project.id,claimId:revised.id,expectedClaimVersion:revised.version,
          evidenceId:evidence.id,expectedSourceDigest:sourceDigest,kind:'supports',condition:null,supersedesRelationId:null},
          {kind:'user',id:'window:72'});
        f.repository.evidence.relations.review({projectId:f.project.id,relationId:relation.id,expectedVersion:relation.version,
          expectedClaimVersion:revised.version,expectedSourceDigest:sourceDigest,decision:'confirm',note:'Synthetic human acceptance of exact measured value'},
          {kind:'user',id:'window:72'});
      }
      if(subjectType==='paragraph') {
        f.repository.manuscripts.saveManuscript({artifactId:artifact.id,sections:[{title:'Results',claimIds:[revised.id]}]});
        f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(artifact.id);
        f.db.prepare("UPDATE research_projects SET current_stage='export' WHERE id=?").run(f.project.id);
        f.db.prepare(`INSERT INTO research_review_cycles
          (project_id,origin_artifact_id,manuscript_artifact_id,revision_round,status,report_artifact_ids_json,updated_at)
          VALUES (?,?,?,0,'accepted','[]',?)`).run(f.project.id,artifact.id,artifact.id,'2026-11-03T00:00:00.000Z');
        f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(figure.artifactId);
        const exports=new api.ResearchExportSourceService(f.repository,figureService,f.service,
          {files:async()=>assert.fail('default template')});
        const exportRequest={projectId:f.project.id,requestId:'metric-export',title:'Metric sources',manuscriptArtifactId:artifact.id,
          figureIds:[figure.id],template:{kind:'default',language:'en'}};
        const sources=await exports.capture(exportRequest,new AbortController().signal);
        assert.deepEqual(sources.experimentResults,[receipt]);
        assert.deepEqual(sources.evidence,[evidence]);
        assert.equal(sources.experiments[0].id,run.id);
        assert.equal(sources.figures[0].id,figure.id);
        const metadata=f.repository.evidence.sourceMetadata(f.project.id,evidence.id);
        f.db.prepare('UPDATE research_evidence_source_metadata SET metadata_json=? WHERE evidence_id=?')
          .run(JSON.stringify({...metadata,pointer:'/metrics/1'}),evidence.id);
        await assert.rejects(service.evidence({projectId:f.project.id,evidenceId:evidence.id}),/research_result_evidence_changed/u);
        assert.throws(()=>exports.assertCurrent(exportRequest,sources),/research_result_evidence_changed/u);
        f.db.prepare('UPDATE research_evidence_source_metadata SET metadata_json=? WHERE evidence_id=?').run(JSON.stringify(metadata),evidence.id);
        exports.assertCurrent(exportRequest,sources);
      }
    }
    f.db.prepare("UPDATE research_projects SET current_stage='ideation' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='ideation'").run(f.project.id);
    const idea=f.repository.createArtifact({projectId:f.project.id,stage:'ideation',kind:'idea_canvas',title:'Negative result hypothesis',path:null});
    const fields={problem:'Measure latency',hypothesis:'Positive mean is expected',novelty:'Pending verification',
      supportingEvidence:'',counterevidence:'Observed -4 ms',experiment:'Actual measured run',risks:'Synthetic only'};
    const canvas=f.repository.ideas.save({artifactId:idea.id,expectedVersion:null,...fields,priority:'medium',rationale:'Inspect negative observation',
      fields:Object.entries(fields).map(([key,content])=>({key,content,status:'hypothesis',evidenceIds:key==='counterevidence'?[evidence.id]:[]}))});
    const revised=f.repository.ideas.save({artifactId:idea.id,expectedVersion:canvas.version,
      ...fields,priority:canvas.priority,rationale:'Retain original hypothesis',
      fields:canvas.fields});
    assert.equal(revised.hypothesis,fields.hypothesis);
    assert.deepEqual(f.repository.ideas.history(idea.id).map(value=>value.fields.find(field=>field.key==='counterevidence').evidenceIds),
      [[evidence.id],[evidence.id]]);
    assert.deepEqual(f.repository.inspectArtifact({projectId:f.project.id,artifactId:idea.id,expectedVersion:null}).snapshot.evidence.map(value=>value.evidence.id),[evidence.id]);
    const nextReceipt=await api.withResearchHumanContext({capability:'research.experimentResults.review',projectId:f.project.id,windowId:72},
      ()=>service.review({...receipt.snapshot.request,requestId:'metric-evidence-new',
        method:{...receipt.snapshot.request.method,limitations:'Post-observation revision, synthetic only'}}));
    const nextRequest={...request,resultId:nextReceipt.snapshot.id,expectedHash:nextReceipt.snapshotHash};
    const nextEvidence=await capture(nextRequest);
    assert.notEqual(nextEvidence.id,evidence.id);
    assert.equal(f.repository.evidence.inspectEvidence(evidence.id,f.project.id).evidence.excerpt,evidence.excerpt);
    assert.deepEqual(f.repository.ideas.history(idea.id).map(value=>value.fields.find(field=>field.key==='counterevidence').evidenceIds),
      [[evidence.id],[evidence.id]]);
    f.repository.evidence.invalidateEvidence(nextEvidence.id,f.project.id);
    await assert.rejects(service.evidence({projectId:f.project.id,evidenceId:nextEvidence.id}),/research_evidence_reference_superseded/u);
    await assert.rejects(capture(nextRequest),/research_evidence_reference_superseded/u);
    f.db.prepare('UPDATE research_projects SET current_stage=? WHERE id=?').run(originalStage,f.project.id);
    const handlers=new Map();
    api.registerResearchExperimentResultCapabilities({pluginId:'fixture',capabilities:{register(_id,descriptor,handler){handlers.set(descriptor.name,handler);}}},
      f.repository.experimentResults,service);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>handlers.get(name)(input)});
    assert.deepEqual((await bridge.invoke('research.captureExperimentResultEvidence',[request],72)).data,evidence);
    assert.equal((await bridge.invoke('research.captureExperimentResultEvidence',[request])).ok,false);
    const databasePath=join(f.path,'metric-evidence.sqlite');await f.db.backup(databasePath);
    const disk=new Database(databasePath);
    try {
      disk.pragma('foreign_keys=ON');api.applyResearchDatabaseSchema(disk);
      const repository=new api.ResearchRepository(disk,f.tasks);
      reopened=new api.ResearchExperimentService(repository,{inspect:async()=>assert.fail('no recovery probes')},f.path,
        {error:()=>assert.fail('no recovery error')},async()=>assert.fail('no recovery execution'));
      const history=new api.ResearchExperimentResultService(repository,reopened),dispatches=f.observed.length;
      assert.deepEqual(await history.evidence({projectId:f.project.id,evidenceId:evidence.id}),{receipt,metricId:'mean'});
      assert.equal(f.observed.length,dispatches);
    }finally{await reopened?.shutdown();disk.close();}
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await assert.rejects(capture(request),/research_project_archived/u);
    assert.deepEqual(await service.evidence({projectId:f.project.id,evidenceId:evidence.id}),{receipt,metricId:'mean'});
    f.db.prepare("UPDATE research_projects SET status='active' WHERE id=?").run(f.project.id);
    const outputPath=join(f.repository.experiments.root(f.project.id,run.id),'output',output.path);
    await chmod(outputPath,0o600);await writeFile(outputPath,'{"changed":true}');
    await assert.rejects(service.evidence({projectId:f.project.id,evidenceId:evidence.id}),/research_experiment_snapshot_changed/u);
    assert.equal(f.repository.evidence.inspectEvidence(evidence.id,f.project.id).evidence.excerpt,evidence.excerpt);
    await assert.rejects(capture(request),/research_experiment_snapshot_changed/u);
    receipts.push({scenario:'metric-evidence',receipt,evidence,artifacts,idea});
  }finally{await figureService?.shutdown();await f.cleanup();}
});

async function fixture(code = source, options = {}) {
  const path = await mkdtemp(join(root, 'case-')), workspace = join(path, 'workspace'), venv = join(path, 'venv');
  const packagePath = join(venv, 'lib/python3.14/site-packages'), executable = join(venv, 'bin/python3');
  for (const dir of [workspace, packagePath, join(venv, 'bin')]) await mkdir(dir, { recursive: true });
  await symlink(python.executable, executable);
  await writeFile(join(venv, 'pyvenv.cfg'), `home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion = ${python.version}\n`);
  await mkdir(join(packagePath, 'fixture_pkg'));
  await writeFile(join(packagePath, 'fixture_pkg/__init__.py'), 'VALUE = 42\n');
  const metadata = join(packagePath, 'Fixture_Pkg-1.0.0.dist-info');
  await mkdir(metadata);
  await writeFile(join(metadata, 'METADATA'), 'Metadata-Version: 2.4\nName: Fixture_Pkg\nVersion: 1.0.0\n');
  await writeFile(join(workspace, 'roc-python.lock.json'), JSON.stringify({
    schemaVersion: 1, python: { implementation: 'cpython', version: python.version, platform: 'darwin', architecture: 'arm64' },
    distributions: [{ name: 'fixture-pkg', version: '1.0.0' }]
  }));
  await writeFile(join(workspace, 'analysis.py'), code); await writeFile(join(workspace, 'data.txt'), '3\n');
  const f = createResearchFixture(api, 'experiment', workspace);
  const observed = [], failures = [];
  const pythonService = new api.ResearchPythonEnvironmentService(f.repository, async () => executable, async request => {
    const result = await api.runResearchProcess(request);
    observed.push({ kind: 'environment', request: { command: request.command, admission: request.admission }, result });
    receipts.push({ scenario: 'actual-environment-dispatch', projectId: f.project.id, result });
    return result;
  });
  const environments = new api.ResearchExperimentEnvironmentService({
    nativeRuntime: async () => assert.fail('Python must not resolve native tools'),
    typescriptRuntime: async () => assert.fail('Python must not resolve TypeScript')
  }, pythonService);
  const service = new api.ResearchExperimentService(f.repository, environments, path, { error: (...args) => failures.push(args) }, async request => {
    try {
      const result = await api.runResearchProcess(request);
      observed.push({ kind: 'compute', request: { command: request.command, admission: request.admission }, result });
      if (options.afterCompute) await options.afterCompute({ ...f, workspace, packagePath, request, result });
      return result;
    } catch (error) {
      observed.push({ kind: 'compute', error: { code: error.code, stdout: error.stdout, stderr: error.stderr,
        resourceUsage: error.resourceUsage, admission: error.admission } });
      throw error;
    }
  });
  const selected = await api.withResearchHumanContext({ capability: 'research.pythonEnvironments.select', projectId: f.project.id, windowId: 72 },
    () => pythonService.select({ projectId: f.project.id, requestId: 'explicit-environment' }));
  const runtime = { kind: 'python', selectionId: selected.snapshot.id, expectedHash: selected.snapshotHash };
  const preview = await service.inspect(f.project.id, runtime);
  const request = { projectId: f.project.id, ownerRunId: f.run.id, requestId: 'python-first', label: 'Python fixed result',
    engine: 'python', sourceVersion: 1, source: { kind: 'file', path: 'analysis.py' }, inputPaths: ['data.txt'], parameters: { scale: '2' },
    seed: 73, arguments: [], runtime, expectedEnvironmentHash: preview.hash, timeoutMs: 5000, network: 'disabled' };
  const read = async (run, area, path) => (await service.read({ projectId: f.project.id, runId: run.id, area, path })).content;
  const wait = async id => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const run = f.repository.experiments.get(f.project.id, id);
      if (!['preparing', 'running'].includes(run.status)) {
        const logs = await Promise.all(run.files.filter(file => file.area === 'log').map(async file => ({ file, content: await read(run, 'log', file.path) })));
        receipts.push({ scenario: options.scenario ?? 'experiment', run, logs, observed: [...observed] });
        return run;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Python experiment terminal state timed out');
  };
  return { ...f, path, workspace, packagePath, observed, failures, service, pythonService, request, runtime, preview, read, wait,
    execute: async overrides => wait((await service.start({ ...request, ...overrides })).id),
    async cleanup() { await service.shutdown(); await pythonService.shutdown(); f.close(); } };
}

test('actual Python service freezes inputs and identity, repeats deterministic outputs and publishes immutable audit files', async () => {
  const f = await fixture();
  try {
    const first = await f.execute(), second = await f.execute({ requestId: 'python-repeat' });
    assert.equal(first.status, 'completed', first.error); assert.equal(second.status, 'completed', second.error);
    assert.deepEqual(f.failures, []); assert.equal(first.inputHash, second.inputHash);
    const firstOutput = first.files.find(file => file.area === 'output' && file.path === 'result.json');
    assert.deepEqual(second.files.find(file => file.area === 'output' && file.path === 'result.json'), firstOutput);
    assert.equal(JSON.parse(await f.read(first, 'output', 'result.json')).value, 48);
    const rootPath = f.repository.experiments.root(f.project.id, first.id);
    for (const file of first.files.filter(file => file.area === 'input' || file.area === 'log')) {
      assert.equal((await stat(join(rootPath, file.area, file.path))).mode & 0o777, 0o400);
    }
    assert.equal(await f.read(first, 'input', 'analysis.py'), source);
    const resources = api.researchExperimentResourceReportSchema.parse(JSON.parse(await f.read(first, 'log', 'resources.json')));
    assert.equal(resources.engine, 'python'); assert.equal(resources.exitCode, 0);
    assert.deepEqual(resources.probes.map(probe => [probe.phase, probe.kind, probe.exitCode]),
      [['preparation', 'environment', 0], ['verification', 'environment', 0]]);
    const actual = f.observed.find(entry => entry.kind === 'compute').result;
    assert.deepEqual(resources.usage, actual.resourceUsage); assert.deepEqual(resources.admission, actual.admission);
    const code = api.pythonCodeReportSchema.parse(JSON.parse(await f.read(first, 'log', 'environment-code.json')));
    api.assertPythonCodeReceipt(code.python, first.environment.metadataHash);
    assert.equal(code.inputHash, first.inputHash); assert.equal(code.runId, first.id);
    const startup = api.pythonExecutionReportSchema.parse(JSON.parse(await f.read(first, 'log', 'python-startup.json')));
    assert.equal(startup.startup.sourcePath, join(rootPath, 'input/analysis.py'));
    assert.equal(startup.startup.seed, 73); assert.equal(startup.inputHash, first.inputHash);
    assert.equal(startup.bootstrapHash, api.pythonExperimentBootstrapHash());
    assert.equal(f.db.prepare("SELECT count(*) FROM research_knowledge_documents WHERE source_id=? AND (id LIKE '%environment-code.json' OR id LIKE '%python-startup.json')").pluck().get(first.id), 0);
    const before = f.observed.length;
    assert.deepEqual(await f.service.start(f.request), first);
    assert.equal(f.observed.length, before);
    await assert.rejects(f.service.start({ ...f.request, seed: 74 }), /research_experiment_request_conflict/u);
    const foreignWorkspace = await mkdtemp(join(f.path, 'foreign-'));
    const foreign = f.repository.createProject({ title: 'Foreign', description: '', workspacePath: foreignWorkspace });
    await assert.rejects(f.service.inspect(foreign.id, f.runtime), /research_python_selection_project_mismatch/u);
    await assert.rejects(f.service.read({ projectId: foreign.id, runId: first.id, area: 'output', path: 'result.json' }), /research_experiment_project_mismatch/u);
    const published = await f.service.publish(f.project.id, first.id);
    await f.service.verifyPublication(f.project.id, published.artifactId);
    const writerRoot = await mkdtemp(join(f.path, 'export-')), writer = new api.ResearchExportFiles(writerRoot);
    for (const path of ['environment-code.json', 'python-startup.json', 'resources.json']) {
      const file = first.files.find(file => file.area === 'log' && file.path === path);
      const target = `provenance/experiments/${first.id}/log/${path}`;
      const exported = await writer.copy(rootPath, { ...file, path: `log/${path}` }, target);
      assert.equal(exported.sha256, file.sha256);
      assert.equal(await readFile(join(writerRoot, target), 'utf8'), await f.read(first, 'log', path));
    }
    await writeFile(join(f.workspace, 'data.txt'), '4\n');
    await assert.rejects(f.service.start(f.request), /research_experiment_input_changed/u);
    assert.equal(f.observed.length, before);
    // The frozen published result remains verifiable after its original workspace changes.
    await f.service.verifyPublication(f.project.id, published.artifactId);
  } finally { await f.cleanup(); }
});

test('real nonzero exit retains code, startup, stdout and accurate computation resources; failed publication is refused', async () => {
  const f = await fixture('print("BEFORE_EXIT", flush=True)\nraise SystemExit(7)\n');
  try {
    const run = await f.execute();
    assert.equal(run.status, 'failed'); assert.equal(run.error, 'research_experiment_process_failed'); assert.equal(run.exitCode, 7);
    assert.match(await f.read(run, 'log', 'stdout.txt'), /BEFORE_EXIT/u);
    const resource = JSON.parse(await f.read(run, 'log', 'resources.json'));
    assert.equal(resource.outcome, 'returned'); assert.equal(resource.exitCode, 7);
    assert.equal(resource.probes.length, 1);
    assert.equal(JSON.parse(await f.read(run, 'log', 'python-startup.json')).runId, run.id);
    assert.equal(JSON.parse(await f.read(run, 'log', 'environment-code.json')).runId, run.id);
    await assert.rejects(f.service.publish(f.project.id, run.id), /research_experiment_completed_required/u);
  } finally { await f.cleanup(); }
});

test('original workspace input drift and installed package drift during real computation both fail', async () => {
  for (const kind of ['input', 'package']) {
    const f = await fixture(source, { scenario: `${kind}-drift`, afterCompute: async ({ workspace, packagePath }) => {
      await writeFile(kind === 'input' ? join(workspace, 'data.txt') : join(packagePath, 'fixture_pkg/__init__.py'),
        kind === 'input' ? '999\n' : 'VALUE = 43\n');
    } });
    try {
      const run = await f.execute();
      assert.equal(run.status, 'failed');
      assert.equal(run.error, kind === 'input' ? 'research_experiment_input_changed' : 'research_python_selection_environment_changed');
      assert.equal(await f.read(run, 'input', 'data.txt'), '3\n');
      const resource = JSON.parse(await f.read(run, 'log', 'resources.json'));
      assert.equal(resource.outcome, 'returned'); assert.equal(resource.exitCode, 0);
      assert.equal(resource.probes.length, kind === 'input' ? 1 : 2);
      await assert.rejects(f.service.publish(f.project.id, run.id), /research_experiment_completed_required/u);
    } finally { await f.cleanup(); }
  }
});

test('source and seed each alter snapshot identity while missing and changed preview identities never dispatch computation', async () => {
  const f = await fixture();
  try {
    const first = await f.execute(), seeded = await f.execute({ requestId: 'seed-change', seed: 74 });
    assert.equal(first.status, 'completed', first.error); assert.equal(seeded.status, 'completed', seeded.error);
    assert.notEqual(first.inputHash, seeded.inputHash);
    await writeFile(join(f.workspace, 'analysis.py'), source + '# new source version bytes\n');
    const changed = await f.execute({ requestId: 'source-change' });
    assert.equal(changed.status, 'completed', changed.error); assert.notEqual(first.inputHash, changed.inputHash);
    const count = f.observed.filter(entry => entry.kind === 'compute').length;
    const rejected = await f.execute({ requestId: 'wrong-preview', expectedEnvironmentHash: 'f'.repeat(64) });
    assert.equal(rejected.status, 'failed'); assert.equal(rejected.error, 'research_experiment_environment_changed');
    assert.equal(JSON.parse(await f.read(rejected, 'log', 'resources.json')).outcome, 'not_dispatched');
    assert.equal(f.observed.filter(entry => entry.kind === 'compute').length, count);
    const { seed: _seed, ...missingSeed } = f.request;
    await assert.rejects(f.service.start(missingSeed));
    assert.equal(f.observed.filter(entry => entry.kind === 'compute').length, count);
  } finally { await f.cleanup(); }
});

test('host rehashed startup log still cannot change project, seed, bootstrap or source identity during publication', async () => {
  const f = await fixture();
  try {
    const run = await f.execute(); assert.equal(run.status, 'completed', run.error);
    const storage = f.repository.experiments.root(f.project.id, run.id), path = join(storage, 'log/python-startup.json');
    const original = await readFile(path), report = JSON.parse(original);
    const row = f.db.prepare('SELECT snapshot_json FROM research_experiment_executions WHERE run_id=?').pluck().get(run.id);
    for (const changed of [
      { ...report, projectId: 'foreign' }, { ...report, bootstrapHash: 'f'.repeat(64) },
      { ...report, startup: { ...report.startup, seed: 74 } },
      { ...report, startup: { ...report.startup, sourcePath: join(storage, 'input/other.py') } }
    ]) {
      const content = JSON.stringify(changed), snapshot = JSON.parse(row);
      const file = snapshot.files.find(file => file.area === 'log' && file.path === 'python-startup.json');
      file.sha256 = createHash('sha256').update(content).digest('hex'); file.size = Buffer.byteLength(content);
      await chmod(path, 0o600); await writeFile(path, content); await chmod(path, 0o400);
      f.db.prepare('UPDATE research_experiment_executions SET snapshot_json=? WHERE run_id=?').run(JSON.stringify(snapshot), run.id);
      await assert.rejects(f.service.publish(f.project.id, run.id), /research_experiment_python_startup_report_changed/u);
    }
    await chmod(path, 0o600); await writeFile(path, original); await chmod(path, 0o400);
    f.db.prepare('UPDATE research_experiment_executions SET snapshot_json=? WHERE run_id=?').run(row, run.id);
    const published = await f.service.publish(f.project.id, run.id);
    await f.service.verifyPublication(f.project.id, published.artifactId);
    await chmod(path, 0o600); await writeFile(path, JSON.stringify({ ...report, projectId: 'foreign' }));
    await assert.rejects(f.service.verifyPublication(f.project.id, published.artifactId), /research_experiment_snapshot_changed/u);
  } finally { await f.cleanup(); }
});

test('actual service timeout and cancellation retain terminal resources and cancellation removes descendants', async () => {
  const f = await fixture(`import os, signal, time, json
import roc_experiment as roc
signal.signal(signal.SIGTERM, signal.SIG_IGN)
parent = os.getpid()
child = os.fork()
if child == 0:
    grandchild = os.fork()
    if grandchild == 0:
        with open(os.path.join(roc.output_dir, "pids.json"), "w") as file:
            json.dump([parent, os.getppid(), os.getpid()], file)
    while True:
        time.sleep(0.01)
while True:
    time.sleep(0.01)
`);
  try {
    const timeout = await f.execute({ requestId: 'timeout', timeoutMs: 1000 });
    assert.equal(timeout.status, 'failed'); assert.equal(timeout.error, 'research_process_timeout');
    assert.equal(JSON.parse(await f.read(timeout, 'log', 'resources.json')).outcome, 'rejected');
    const active = await f.service.start({ ...f.request, requestId: 'cancel', timeoutMs: 15000 });
    const storage = f.repository.experiments.root(f.project.id, active.id);
    const deadline = Date.now() + 10000; let pids;
    while (Date.now() < deadline) {
      try { pids = JSON.parse(await readFile(join(storage, 'output/pids.json'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(pids?.length, 3); for (const pid of pids) process.kill(pid, 0);
    await f.service.cancel(f.project.id, active.id);
    const cancelled = await f.wait(active.id);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.error, 'research_experiment_cancelled');
    const resource = JSON.parse(await f.read(cancelled, 'log', 'resources.json'));
    assert.equal(resource.outcome, 'rejected'); assert.equal(resource.error, 'research_process_cancelled');
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(f.service.publish(f.project.id, active.id), /research_experiment_completed_required/u);
    receipts.push({ scenario: 'service-cancel-tree', pids, allAbsent: true });
  } finally { await f.cleanup(); }
});

test('actual experiment role consumes selected Python preview and owns start, terminal polling and publication', async () => {
  const f = await fixture(source, { scenario: 'owned-role-tools' });
  try {
    const registry = new api.CapabilityRegistry();
    for (const descriptor of api.researchExperimentCapabilities) registry.declare('research', descriptor);
    api.registerResearchExperimentCapabilities({ pluginId: 'research', capabilities: registry }, f.repository.experiments, f.service);
    const effects = new api.ResearchProductionEffectService(f.repository, undefined, f.service);
    const tools = Object.fromEntries(api.createResearchRoleTools({
      run: f.run, context: f.repository.runs.getContext(f.run.id), repository: f.repository,
      capabilities: registry, effects, signal: new AbortController().signal
    }).map(tool => [tool.name, tool]));
    const listed = await tools.list_python_environments.invoke({ offset: 0, limit: 10 });
    assert.equal(listed.total, 1); assert.deepEqual(listed.items[0].runtime, f.runtime);
    const preview = await tools.inspect_experiment_environment.invoke({ runtime: listed.items[0].runtime, offset: 0, limit: 8000 });
    assert.equal(preview.expectedEnvironmentHash, f.preview.hash);
    const { projectId: _projectId, ownerRunId: _ownerRunId, ...owned } = f.request;
    const started = await tools.start_experiment.invoke({ ...owned, runtime: preview.runtime,
      expectedEnvironmentHash: preview.expectedEnvironmentHash });
    const run = await f.wait(started.experimentId);
    assert.equal(run.status, 'completed', run.error); assert.equal(run.ownerRunId, f.run.id);
    const polled = await tools.get_experiment.invoke({ experimentId: run.id });
    assert.equal(polled.status, 'completed'); assert.equal(polled.ownerRunId, f.run.id);
    const before = f.observed.length;
    assert.deepEqual(await tools.start_experiment.invoke(owned), polled);
    assert.equal(f.observed.length, before);
    await assert.rejects(tools.start_experiment.invoke({ ...owned, projectId: f.project.id }));
    const published = await tools.publish_experiment.invoke({ experimentId: run.id });
    assert.ok(published.artifactId); await f.service.verifyPublication(f.project.id, published.artifactId);
    const unowned = await f.execute({ ownerRunId: null, requestId: 'unowned' });
    assert.equal(unowned.status, 'completed', unowned.error);
    await assert.rejects(tools.get_experiment.invoke({ experimentId: unowned.id }), /research_production_owner_mismatch/u);
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture_cancelled');
    await assert.rejects(tools.publish_experiment.invoke({ experimentId: run.id }), /research_run_not_current/u);
    await assert.rejects(tools.inspect_experiment_environment.invoke({ runtime: f.runtime, offset: 0, limit: 100 }), /research_run_not_current/u);
    assert.equal(f.observed.filter(entry => entry.kind === 'compute').length, 2);
    receipts.push({ scenario: 'owned-role-tools-result', listed, preview, polled, published, actualComputations: 2 });
  } finally { await f.cleanup(); }
});

const treeSource = `import os, signal, time, json
import roc_experiment as roc
signal.signal(signal.SIGTERM, signal.SIG_IGN)
parent = os.getpid()
child = os.fork()
if child == 0:
    grandchild = os.fork()
    if grandchild == 0:
        print("RECOVERY_TREE_STARTED", flush=True)
        with open(os.path.join(roc.output_dir, "pids.json"), "w") as file:
            json.dump([parent, os.getppid(), os.getpid()], file)
    while True:
        time.sleep(0.01)
while True:
    time.sleep(0.01)
`;

async function waitForTree(repository, projectId, runId) {
  const path = join(repository.experiments.root(projectId, runId), 'output/pids.json');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const pids = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(pids.length, 3);
      for (const pid of pids) process.kill(pid, 0);
      return pids;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Actual Python recovery process tree did not start');
}

test('actual Python shutdown interrupts computation, persists rejected resources and removes the full process tree', async () => {
  const f = await fixture(treeSource, { scenario: 'shutdown' });
  try {
    const active = await f.service.start({ ...f.request, timeoutMs: 15000 });
    const pids = await waitForTree(f.repository, f.project.id, active.id);
    await f.service.shutdown();
    const interrupted = await f.wait(active.id);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.error, 'research_experiment_interrupted');
    assert.equal(interrupted.exitCode, 1);
    assert.equal(await f.read(interrupted, 'input', 'analysis.py'), treeSource);
    assert.match(await f.read(interrupted, 'log', 'stdout.txt'), /RECOVERY_TREE_STARTED/u);
    const resources = JSON.parse(await f.read(interrupted, 'log', 'resources.json'));
    const actual = f.observed.find(entry => entry.kind === 'compute').error;
    assert.equal(resources.outcome, 'rejected');
    assert.equal(resources.error, 'research_process_cancelled');
    assert.deepEqual(resources.usage, actual.resourceUsage);
    assert.deepEqual(resources.admission, actual.admission);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual(f.failures, []);
    receipts.push({ scenario: 'shutdown-tree', pids, allAbsent: true, interrupted });
  } finally { await f.cleanup(); }
});

test('Python disk recovery retains selected environments and historical audits, never reruns old requests and requires a new owner', async () => {
  const f = await fixture(source, { scenario: 'disk-recovery' });
  let restartedDb, restartedAgentDb, restartedService, restartedPython;
  try {
    const completed = await f.execute();
    assert.equal(completed.status, 'completed', completed.error);
    const published = await f.service.publish(f.project.id, completed.id);
    const selectionRequest = { projectId: f.project.id, selectionId: f.runtime.selectionId, expectedHash: f.runtime.expectedHash };
    const selection = f.repository.pythonEnvironments.get(selectionRequest);
    const historicalResources = await f.read(completed, 'log', 'resources.json');
    const historicalStartup = await f.read(completed, 'log', 'python-startup.json');
    await writeFile(join(f.workspace, 'analysis.py'), treeSource);
    const interruptedRequest = { ...f.request, requestId: 'running-at-restart', timeoutMs: 15000 };
    const active = await f.service.start(interruptedRequest);
    const pids = await waitForTree(f.repository, f.project.id, active.id);
    const durable = f.repository.experiments.get(f.project.id, active.id);
    assert.equal(durable.status, 'running');
    const researchPath = join(f.path, 'running-research.db'), agentPath = join(f.path, 'running-agent.db');
    // Capture crash-time durable state, then clean up the real processes.
    // This is disk recovery, not a new host SIGKILL acceptance test.
    await f.db.backup(researchPath); await f.agentDb.backup(agentPath);
    await f.service.shutdown(); await f.pythonService.shutdown();
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    restartedDb = new Database(researchPath); restartedAgentDb = new Database(agentPath);
    const tasks = new api.ResearchTaskRepository(restartedAgentDb);
    const repository = new api.ResearchRepository(restartedDb, tasks);
    let dispatches = 0;
    const actualRun = async request => { dispatches++; return api.runResearchProcess(request); };
    restartedPython = new api.ResearchPythonEnvironmentService(repository,
      async () => assert.fail('Recovery must never open the native picker'), actualRun);
    const environments = new api.ResearchExperimentEnvironmentService({
      nativeRuntime: async () => assert.fail('Recovery must not resolve native tools'),
      typescriptRuntime: async () => assert.fail('Recovery must not resolve TypeScript')
    }, restartedPython);
    restartedService = new api.ResearchExperimentService(repository, environments, f.path,
      { error: (...args) => assert.fail(JSON.stringify(args)) }, actualRun);
    repository.runs.recoverInterrupted(); restartedService.recover();
    const recovered = repository.experiments.get(f.project.id, active.id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.error, 'research_experiment_interrupted');
    assert.equal(recovered.exitCode, null);
    assert.deepEqual(recovered.files, durable.files);
    assert.equal(repository.runs.get(f.run.id, f.project.id).status, 'interrupted');
    assert.equal(tasks.get(f.run.taskId, f.project.id).status, 'interrupted');
    assert.deepEqual(repository.pythonEnvironments.get(selectionRequest), selection);
    assert.deepEqual(await restartedService.verifyPublication(f.project.id, published.artifactId), published);
    for (const [path, content] of [['resources.json', historicalResources], ['python-startup.json', historicalStartup]]) {
      assert.equal((await restartedService.read({ projectId: f.project.id, runId: completed.id, area: 'log', path })).content, content);
    }
    assert.equal((await restartedService.read({ projectId: f.project.id, runId: recovered.id,
      area: 'input', path: 'analysis.py' })).content, treeSource);
    assert.equal(recovered.files.some(file => file.path === 'resources.json'), false);
    assert.deepEqual(await restartedService.start(interruptedRequest), recovered);
    assert.equal(dispatches, 0);
    await assert.rejects(restartedService.publish(f.project.id, recovered.id), /research_experiment_completed_required/u);
    await assert.rejects(restartedService.start({ ...interruptedRequest, requestId: 'old-owner-new-request' }),
      /research_run_not_current/u);
    assert.equal(dispatches, 0);
    await writeFile(join(f.workspace, 'analysis.py'), source);
    assert.deepEqual(await restartedService.start(f.request), published);
    assert.equal(dispatches, 0);
    const { ownerRunId: _owner, ...direct } = f.request;
    const fresh = await restartedService.start({ ...direct, requestId: 'explicit-new-request' });
    const deadline = Date.now() + 20000;
    let finished;
    while (Date.now() < deadline) {
      finished = repository.experiments.get(f.project.id, fresh.id);
      if (!['preparing', 'running'].includes(finished.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(finished.status, 'completed', finished.error);
    assert.notEqual(finished.id, recovered.id);
    assert.notEqual(tasks.requireExecution('experiment', fresh.id, f.project.id).taskId, f.run.taskId);
    assert.equal(dispatches, 3); // preparation probe, compute, verification probe
    assert.equal(tasks.get(f.run.taskId, f.project.id).status, 'interrupted');
    receipts.push({ scenario: 'disk-recovery', simulation: 'live DB snapshots; original processes shut down',
      pids, allAbsent: true, recovered, historical: published, fresh: finished, dispatches });
  } finally {
    await restartedService?.shutdown(); await restartedPython?.shutdown();
    restartedDb?.close(); restartedAgentDb?.close();
    await f.cleanup();
  }
});

const notebookResultCells = [
  'import json\nfrom pathlib import Path\nimport roc_experiment as roc\nvalue = int(Path(roc.input_dir, "data.txt").read_text())\n',
  '# Complete original cell source, longer than the preview\n' + '# original line\n'.repeat(700) +
    'def measurement():\n    return value * int(roc.parameters["scale"]) + 42\n',
  'Path(roc.output_dir, "result.json").write_text(json.dumps({"value": measurement(), "seed": roc.seed}, sort_keys=True))\nprint("ACTUAL_NOTEBOOK_RESULT")\n'
];

async function importNotebook(f, cells = notebookResultCells, requestId = 'notebook-import') {
  const notebook = { nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } },
    cells: cells.map((source, index) => ({ id: `original-${index}`, cell_type: 'code', metadata: { trusted: true },
      source, execution_count: 900 + index, outputs: [{ output_type: 'display_data',
        data: { 'text/plain': 'OLD_UNTRUSTED_RESULT', 'text/html': '<script>throw "MALICIOUS_OUTPUT"</script>' }, metadata: {} }] })) };
  const bytes = Buffer.from(JSON.stringify(notebook, null, 2) + '\n');
  await writeFile(join(f.workspace, 'analysis.ipynb'), bytes);
  const imported = await api.withResearchHumanContext({ capability: 'research.notebooks.import', projectId: f.project.id, windowId: 72 },
    () => f.repository.notebooks.import({ projectId: f.project.id, path: 'analysis.ipynb', requestId,
      expectedSha256: createHash('sha256').update(bytes).digest('hex') }));
  return { bytes, imported, source: { kind: 'notebook', notebookId: imported.receipt.snapshot.id,
    expectedHash: imported.receipt.snapshotHash, subsetVersion: 1 } };
}

test('actual Notebook execution freezes full original cells and receipts, keeps versions after source deletion, and publishes through PR08', async () => {
  const f = await fixture();
  try {
    const nb = await importNotebook(f);
    const request = { ...f.request, source: nb.source, requestId: 'notebook-first' };
    const first = await f.execute(request);
    assert.equal(first.status, 'completed', first.error);
    assert.deepEqual(JSON.parse(await f.read(first, 'output', 'result.json')), { value: 48, seed: 73 });
    assert.match(await f.read(first, 'log', 'stdout.txt'), /ACTUAL_NOTEBOOK_RESULT/u);
    assert.doesNotMatch(await f.read(first, 'log', 'stdout.txt'), /OLD_UNTRUSTED_RESULT|MALICIOUS_OUTPUT/u);
    assert.equal(await f.read(first, 'input', 'roc-notebook/original.ipynb'), nb.bytes.toString('utf8'));
    assert.deepEqual(JSON.parse(await f.read(first, 'input', 'roc-notebook/receipt.json')), nb.imported.receipt);
    const generated = await f.read(first, 'input', 'roc-notebook/run.py');
    const encoded = generated.match(/^_nb_encoded = "([^"]+)"/u)[1];
    const payload = JSON.parse(Buffer.from(encoded, 'base64'));
    assert.equal(payload.receiptHash, nb.source.expectedHash);
    assert.equal(payload.sha256, createHash('sha256').update(nb.bytes).digest('hex'));
    assert.deepEqual(payload.cells.map(cell => [cell.id, cell.index]), [['original-0', 0], ['original-1', 1], ['original-2', 2]]);
    assert.equal(payload.cells[1].source, notebookResultCells[1]); assert.ok(payload.cells[1].source.length > 8000);
    assert.equal(payload.cells[1].cellHash, nb.imported.preview.cells[1].cellHash);
    const startup = JSON.parse(await f.read(first, 'log', 'python-startup.json'));
    assert.equal(startup.startup.sourcePath, join(f.repository.experiments.root(f.project.id, first.id), 'input/roc-notebook/run.py'));
    const resources = JSON.parse(await f.read(first, 'log', 'resources.json'));
    assert.equal(resources.outcome, 'returned'); assert.equal(resources.exitCode, 0);
    assert.deepEqual(resources.usage, f.observed.find(entry => entry.kind === 'compute').result.resourceUsage);
    for (const file of first.files.filter(file => file.area === 'input')) {
      assert.equal((await stat(join(f.repository.experiments.root(f.project.id, first.id), 'input', file.path))).mode & 0o777, 0o400);
    }
    await assert.rejects(readFile(join(f.workspace, 'roc-notebook/run.py')), { code: 'ENOENT' });
    await writeFile(join(f.workspace, 'analysis.ipynb'), 'CHANGED ORIGINAL');
    const second = await f.execute({ ...request, requestId: 'notebook-repeat' });
    assert.equal(second.status, 'completed', second.error); assert.equal(second.inputHash, first.inputHash);
    await rm(join(f.workspace, 'analysis.ipynb'));
    const count = f.observed.length;
    assert.deepEqual(await f.service.start(request), first); assert.equal(f.observed.length, count);
    const registry = new api.CapabilityRegistry();
    for (const descriptor of api.researchExperimentCapabilities) registry.declare('research', descriptor);
    api.registerResearchExperimentCapabilities({ pluginId: 'research', capabilities: registry }, f.repository.experiments, f.service);
    const tools = Object.fromEntries(api.createResearchRoleTools({ run: f.run, context: f.repository.runs.getContext(f.run.id),
      repository: f.repository, capabilities: registry, effects: new api.ResearchProductionEffectService(f.repository, undefined, f.service),
      signal: new AbortController().signal }).map(tool => [tool.name, tool]));
    const { projectId: _project, ownerRunId: _owner, ...owned } = request;
    assert.equal((await tools.start_experiment.invoke(owned)).experimentId, first.id);
    assert.equal(f.observed.length, count);
    const publishedResult = await tools.publish_experiment.invoke({ experimentId: first.id });
    const published = f.repository.experiments.get(f.project.id, first.id);
    assert.equal(publishedResult.artifactId, published.artifactId);
    await f.service.verifyPublication(f.project.id, published.artifactId);
    assert.deepEqual(f.failures, []);
    receipts.push({ scenario: 'notebook-complete', original: nb.imported.receipt, payload, first, second, published });
  } finally { await f.cleanup(); }
});

test('actual Notebook compiles every cell before side effects and retains failing cell provenance and negative outputs', async () => {
  const f = await fixture();
  try {
    for (const [index, bad] of ['valid = 1\nbroken =\n', '%time print(1)\n', 'from __future__ import annotations\n'].entries()) {
      const nb = await importNotebook(f, ['from pathlib import Path\nimport roc_experiment as roc\nPath(roc.output_dir, "EARLY_EXECUTED").write_text("unsafe")\n', bad],
        `compile-${index}`);
      const run = await f.execute({ source: nb.source, requestId: `compile-${index}` });
      assert.equal(run.status, 'failed'); assert.equal(run.error, 'research_experiment_process_failed');
      assert.equal(run.files.some(file => file.area === 'output'), false);
      const error = await f.read(run, 'log', 'stderr.txt');
      assert.match(error, /SyntaxError/u); assert.ok(error.includes(`roc-notebook:${nb.imported.preview.sha256}/original-1`));
      if (index === 0) assert.match(error, /line 2/u);
      const resources = JSON.parse(await f.read(run, 'log', 'resources.json'));
      assert.equal(resources.outcome, 'returned'); assert.notEqual(resources.exitCode, 0);
      const before = f.observed.length;
      assert.deepEqual(await f.service.start({ ...f.request, source: nb.source, requestId: `compile-${index}` }), run);
      assert.equal(f.observed.length, before);
      await assert.rejects(f.service.publish(f.project.id, run.id), /research_experiment_completed_required/u);
    }
    const nb = await importNotebook(f, ['print("EARLIER_ACTUAL_OUTPUT")\n', 'raise ValueError("negative outcome")\n',
      'print("LATER_EXECUTED")\n'], 'negative');
    const run = await f.execute({ source: nb.source, requestId: 'negative' });
    assert.equal(run.status, 'failed');
    assert.match(await f.read(run, 'log', 'stdout.txt'), /EARLIER_ACTUAL_OUTPUT/u);
    assert.doesNotMatch(await f.read(run, 'log', 'stdout.txt'), /LATER_EXECUTED/u);
    assert.match(await f.read(run, 'log', 'stderr.txt'), /ValueError: negative outcome/u);
  } finally { await f.cleanup(); }
});

test('actual Notebook uses selected Python filesystem isolation and records timeout and cancellation resources', async () => {
  const f = await fixture();
  try {
    const outside = join(f.path, 'OUTSIDE_NOTEBOOK_WRITTEN');
    const denied = await importNotebook(f, [`from pathlib import Path\nPath(${JSON.stringify(outside)}).write_text("unsafe")\n`], 'boundary');
    const refusal = await f.execute({ source: denied.source, requestId: 'boundary' });
    assert.equal(refusal.status, 'failed'); assert.match(await f.read(refusal, 'log', 'stderr.txt'), /PermissionError/u);
    await assert.rejects(readFile(outside), { code: 'ENOENT' });
    const busy = await importNotebook(f, ['from pathlib import Path\nimport roc_experiment as roc\nPath(roc.output_dir, "STARTED").write_text("actual")\nwhile True:\n    pass\n'], 'busy');
    const timeout = await f.execute({ source: busy.source, requestId: 'notebook-timeout', timeoutMs: 1000 });
    assert.equal(timeout.status, 'failed'); assert.equal(timeout.error, 'research_process_timeout');
    assert.equal(JSON.parse(await f.read(timeout, 'log', 'resources.json')).outcome, 'rejected');
    const active = await f.service.start({ ...f.request, source: busy.source, requestId: 'notebook-cancel', timeoutMs: 15000 });
    const started = join(f.repository.experiments.root(f.project.id, active.id), 'output/STARTED');
    const deadline = Date.now() + 10000;
    while (true) {
      try { assert.equal(await readFile(started, 'utf8'), 'actual'); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.ok(Date.now() < deadline, 'Notebook cell did not start');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancelled = await f.service.cancel(f.project.id, active.id);
    assert.equal(cancelled.status, 'cancelled');
    const resource = JSON.parse(await f.read(cancelled, 'log', 'resources.json'));
    assert.equal(resource.outcome, 'rejected'); assert.equal(resource.error, 'research_process_cancelled');
  } finally { await f.cleanup(); }
});

test('Notebook reference ownership, exact import hash and reserved inputs reject without computation', async () => {
  const f = await fixture();
  try {
    const nb = await importNotebook(f), before = f.observed.filter(entry => entry.kind === 'compute').length;
    const foreign = f.repository.createProject({ title: 'Foreign Notebook', description: '', workspacePath: await mkdtemp(join(f.path, 'foreign-notebook-')) });
    const foreignBytes = Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } },
      cells: [{ id: 'foreign', cell_type: 'code', metadata: {}, source: 'print(1)', execution_count: null, outputs: [] }] }));
    await writeFile(join(foreign.workspacePath, 'foreign.ipynb'), foreignBytes);
    const imported = await api.withResearchHumanContext({ capability: 'research.notebooks.import', projectId: foreign.id, windowId: 72 },
      () => f.repository.notebooks.import({ projectId: foreign.id, path: 'foreign.ipynb', requestId: 'foreign',
        expectedSha256: createHash('sha256').update(foreignBytes).digest('hex') }));
    for (const [index, source] of [
      { ...nb.source, expectedHash: 'f'.repeat(64) },
      { ...nb.source, notebookId: imported.receipt.snapshot.id, expectedHash: imported.receipt.snapshotHash }
    ].entries()) {
      const run = await f.execute({ source, requestId: `refusal-${index}` });
      assert.equal(run.status, 'failed');
      assert.equal(run.error, index === 0 ? 'research_notebook_hash_mismatch' : 'research_notebook_project_mismatch');
      assert.equal(JSON.parse(await f.read(run, 'log', 'resources.json')).outcome, 'not_dispatched');
    }
    await assert.rejects(f.service.start({ ...f.request, source: nb.source, inputPaths: ['roc-notebook/run.py'] }));
    await assert.rejects(f.service.start({ ...f.request, source: { ...nb.source, subsetVersion: 2 } }));
    await assert.rejects(f.service.start({ ...f.request, sourcePath: 'analysis.py' }));
    assert.equal(f.observed.filter(entry => entry.kind === 'compute').length, before);
  } finally { await f.cleanup(); }
});

test('host rehashed Notebook scripts cannot break provenance and disk reopen preserves frozen versions without dispatch', async () => {
  const f = await fixture();
  let reopened, agent, service;
  try {
    const nb = await importNotebook(f), request = { ...f.request, source: nb.source, requestId: 'notebook-durable' };
    const run = await f.execute(request); assert.equal(run.status, 'completed', run.error);
    const path = join(f.repository.experiments.root(f.project.id, run.id), 'input/roc-notebook/run.py');
    const original = await readFile(path), row = f.db.prepare('SELECT snapshot_json FROM research_experiment_executions WHERE run_id=?').pluck().get(run.id);
    const changed = Buffer.from('print("UNRELATED SCRIPT")\n'), snapshot = JSON.parse(row);
    const file = snapshot.files.find(file => file.area === 'input' && file.path === 'roc-notebook/run.py');
    file.sha256 = createHash('sha256').update(changed).digest('hex'); file.size = changed.length;
    await chmod(path, 0o600); await writeFile(path, changed); await chmod(path, 0o400);
    f.db.prepare('UPDATE research_experiment_executions SET snapshot_json=? WHERE run_id=?').run(JSON.stringify(snapshot), run.id);
    await assert.rejects(f.service.publish(f.project.id, run.id), /research_experiment_notebook_source_changed/u);
    await assert.rejects(f.service.start(request), /research_experiment_notebook_source_changed/u);
    await chmod(path, 0o600); await writeFile(path, original); await chmod(path, 0o400);
    f.db.prepare('UPDATE research_experiment_executions SET snapshot_json=? WHERE run_id=?').run(row, run.id);
    const published = await f.service.publish(f.project.id, run.id);
    const dbPath = join(f.path, 'notebook-research.db'), agentPath = join(f.path, 'notebook-agent.db');
    await f.db.backup(dbPath); await f.agentDb.backup(agentPath);
    await rm(join(f.workspace, 'analysis.ipynb')); await f.service.shutdown();
    reopened = new Database(dbPath); agent = new Database(agentPath);
    const repository = new api.ResearchRepository(reopened, new api.ResearchTaskRepository(agent));
    let dispatches = 0;
    service = new api.ResearchExperimentService(repository, { inspect: async () => { dispatches++; assert.fail('Historical Notebook must not inspect'); } },
      f.path, { error: (...args) => assert.fail(JSON.stringify(args)) }, async () => { dispatches++; assert.fail('Historical Notebook must not execute'); });
    service.recover();
    assert.deepEqual(await service.start(request), published);
    assert.deepEqual(await service.verifyPublication(f.project.id, published.artifactId), published);
    assert.equal(dispatches, 0);
    assert.equal((await service.read({ projectId: f.project.id, runId: run.id, area: 'input', path: 'roc-notebook/original.ipynb' })).content,
      nb.bytes.toString('utf8'));
  } finally { await service?.shutdown(); reopened?.close(); agent?.close(); await f.cleanup(); }
});
