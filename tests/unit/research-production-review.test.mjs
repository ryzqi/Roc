import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadResearchTestApi, captureResearchArtifactVersions} from './fixtures/research-test-kit.mjs';
import {createPublishedFigureFixture} from './fixtures/research-production-test-kit.mjs';

let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api.dispose());
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const changes=f=>f.db.prepare('SELECT total_changes()').pluck().get();
const review=f=>({projectId:f.project.id,artifactId:f.artifactId,
  expectedVersion:f.repository.inspectArtifact({projectId:f.project.id,artifactId:f.artifactId,expectedVersion:null}).snapshot.version});
function inputs(f,overrides={}) {
  const calls=[];
  const service=new api.ResearchProductionInputService(f.repository,{
    verifyPublication:async()=>assert.fail('figure must not verify an experiment'),
    read:async()=>assert.fail('figure must not read an experiment')
  },{
    verify:async(...args)=>{calls.push('verify');return overrides.verify?overrides.verify(...args):f.figureService.verify(...args);},
    read:async(...args)=>{calls.push('read');return overrides.read?overrides.read(...args):f.figureService.read(...args);}
  },{
    inspect:async()=>assert.fail('figure must not verify an export'),
    read:async()=>assert.fail('figure must not read an export')
  });
  return {service,calls};
}
const png=f=>f.productionRun.files.find(file=>file.area==='output'&&file.path==='figure.png');
const fileRequest=f=>({...review(f),area:'output',path:'figure.png',expectedFileHash:png(f).sha256});
const editBody=f=>f.db.prepare("UPDATE research_artifact_contents SET output_json=json_set(output_json,'$.markdown','Changed after capture') WHERE artifact_id=?").run(f.artifactId);

test('artifact versions cover actual saved figure publication, execution and file metadata without IO or writes',async()=>{
  const f=await createPublishedFigureFixture(api);
  try {
    const original=review(f),before=changes(f);
    const snapshot=f.repository.inspectArtifact(original).snapshot;
    assert.equal(snapshot.production.kind,'figure');
    assert.equal(snapshot.production.figure.id,f.figureId);
    assert.equal(snapshot.production.execution.id,f.productionRun.id);
    assert.deepEqual(snapshot.production.execution.files,f.productionRun.files);
    assert.equal(changes(f),before);
    const versions=captureResearchArtifactVersions(f.repository,f.project.id);
    const timestamp=f.repository.getArtifact(f.artifactId).updatedAt;
    f.db.prepare("UPDATE research_figure_runs SET snapshot_json=json_set(snapshot_json,'$.request.label','Changed source metadata') WHERE run_id=?")
      .run(f.productionRun.id);
    const start=changes(f);
    const stale=f.repository.inspectArtifact(original);
    assert.equal(stale.status,'stale');
    assert.equal(stale.snapshot.production.execution.request.label,'Changed source metadata');
    assert.equal(f.repository.getArtifact(f.artifactId).updatedAt,timestamp);
    assert.throws(()=>f.repository.assertArtifactReview({projectId:f.project.id,expectedStage:'figure',expectedArtifactVersions:versions}),
      /research_artifact_review_changed/u);
    assert.equal(changes(f),start);
  }finally{await f.dispose();}
});

test('a real waiting human gate reads actual PNG bytes but approved-only role endpoints still refuse',async()=>{
  const f=await createPublishedFigureFixture(api),{service,calls}=inputs(f);
  try {
    const request=review(f),before=changes(f);
    await assert.rejects(service.inspect(f.project.id,f.artifactId),/research_production_approval_required/u);
    await assert.rejects(service.read({projectId:f.project.id,artifactId:f.artifactId,area:'output',path:'figure.png'}),
      /research_production_approval_required/u);
    assert.deepEqual(calls,[]);
    const inspected=await service.inspectReview(request);
    assert.equal(inspected.source.kind,'figure');
    assert.equal(inspected.artifact.status,'draft');
    const read=await service.readReview(fileRequest(f));
    assert.equal(read.encoding,'base64');
    const bytes=Buffer.from(read.content,'base64');
    assert.equal(bytes.subarray(1,4).toString(),'PNG');
    assert.equal(digest(bytes),png(f).sha256);
    assert.equal(bytes.length,png(f).size);
    assert.equal(changes(f),before);
    assert.deepEqual(calls,['verify','read']);
    for(const stage of ['figure','writing','review','export']) {
      const profile=api.getResearchStageRoleProfile(stage);
      assert.ok(!profile.allowedCapabilities.includes('research.artifacts.inspectProductionReview'));
      assert.ok(!profile.allowedCapabilities.includes('research.artifacts.readProductionReviewFile'));
    }
  }finally{await service.shutdown();await f.dispose();}
});

test('invalid, foreign, stale and out-of-gate reviewer requests fail before any production reader',async()=>{
  const f=await createPublishedFigureFixture(api),{service,calls}=inputs(f);
  try {
    const original=fileRequest(f), originalReview=review(f);
    for(const bad of [{...original,expectedVersion:null},{...original,expectedVersion:'old timestamp'},
      {...original,expectedFileHash:'old timestamp'},{...original,path:'/arbitrary/file'},
      {...original,path:'../outside'},{...original,area:'unknown'}]) await assert.rejects(service.readReview(bad));
    await assert.rejects(service.readReview({...original,expectedFileHash:'a'.repeat(64)}),/research_production_snapshot_changed/u);
    await assert.rejects(service.readReview({...original,path:'not-in-manifest.png'}),/research_production_file_not_found/u);
    const other=f.repository.createProject({title:'Foreign',description:'Other scope',workspacePath:'/tmp/foreign-review'});
    await assert.rejects(service.readReview({...original,projectId:other.id}),/research_artifact_project_mismatch/u);
    editBody(f);
    await assert.rejects(service.inspectReview(originalReview),/research_production_review_changed/u);
    await assert.rejects(service.readReview(original),/research_production_review_changed/u);
    f.db.prepare("UPDATE research_stage_states SET status='running' WHERE project_id=? AND stage='figure'").run(f.project.id);
    await assert.rejects(service.inspectReview(review(f)),/research_production_review_unavailable/u);
    f.db.prepare("UPDATE research_stage_states SET status='waiting_approval' WHERE project_id=? AND stage='figure'").run(f.project.id);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await assert.rejects(service.inspectReview(review(f)),/research_project_archived/u);
    f.db.prepare("UPDATE research_projects SET status='active' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_artifacts SET status='superseded' WHERE id=?").run(f.artifactId);
    await assert.rejects(service.inspectReview(review(f)),/research_production_artifact_superseded/u);
    assert.deepEqual(calls,[]);
  }finally{await service.shutdown();await f.dispose();}
});

test('reviewed snapshot changes during actual verify or read cannot publish a successful result',async()=>{
  for(const operation of ['verify','read']) {
    const f=await createPublishedFigureFixture(api);
    const {service,calls}=inputs(f,{[operation]:async(...args)=>{
      const value=await f.figureService[operation](...args);
      editBody(f);
      return value;
    }});
    try {
      const request=operation==='verify'?review(f):fileRequest(f);
      await assert.rejects(operation==='verify'?service.inspectReview(request):service.readReview(request),
        /research_production_review_changed/u);
      assert.deepEqual(calls,[operation]);
      assert.equal(f.repository.getArtifact(f.artifactId).status,'draft');
      assert.equal(f.repository.getWorkflow(f.project.id).currentStage,'figure');
    }finally{await service.shutdown();await f.dispose();}
  }
});

test('actual generated reviewer bridge carries strict version and file hash contracts',async()=>{
  const f=await createPublishedFigureFixture(api),{service}=inputs(f);
  try {
    const handlers=new Map();
    api.registerResearchProductionInputCapabilities({pluginId:'fixture',capabilities:{register(_id,descriptor,handler){
      handlers.set(descriptor.name,handler);
    }}},service);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability(name,input){return handlers.get(name)(input);}});
    const request=review(f),file=fileRequest(f),before=changes(f);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:production-review-inspect',[request]),[request]);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:production-review-read',[file]),[file]);
    const inspected=await bridge.invoke('research.inspectProductionReview',[request],21);
    assert.equal(inspected.ok,true);
    assert.equal(inspected.data.source.figure.id,f.figureId);
    const read=await bridge.invoke('research.readProductionReviewFile',[file],21);
    assert.equal(read.ok,true);
    assert.equal(digest(Buffer.from(read.data.content,'base64')),png(f).sha256);
    for(const bad of [{...file,expectedVersion:undefined},{...file,expectedFileHash:undefined},{...file,path:'../outside'}]) {
      assert.throws(()=>api.parseIpcRequestArgs('roc:research:production-review-read',[bad]));
      const refused=await bridge.invoke('research.readProductionReviewFile',[bad],21);
      assert.equal(refused.ok,false);
      assert.equal(refused.error.category,'validation');
    }
    assert.equal(changes(f),before);
    const mismatch=await bridge.invoke('research.readProductionReviewFile',[{...file,expectedFileHash:'a'.repeat(64)}],21);
    assert.equal(mismatch.error.category,'conflict');
    assert.equal(mismatch.error.code,'research_production_snapshot_changed');
    const missing=await bridge.invoke('research.inspectProductionReview',[{...request,artifactId:'missing'}],21);
    assert.equal(missing.error.category,'not_found');
    const other=f.repository.createProject({title:'Other',description:'Foreign',workspacePath:'/tmp/other-production'});
    const foreign=await bridge.invoke('research.inspectProductionReview',[{...request,projectId:other.id}],21);
    assert.equal(foreign.error.category,'permission');
    assert.equal(foreign.error.code,'research_artifact_project_mismatch');
    await service.shutdown();
    await assert.rejects(service.inspectReview(request),/research_production_input_closed/u);
  }finally{await service.shutdown();await f.dispose();}
});
