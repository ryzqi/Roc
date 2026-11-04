import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {reviewProtocolBodyFixture} from './fixtures/research-review-protocol.mjs';

let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
function scene() {
  const f=createResearchFixture(api,'reading');
  f.registry=new api.CapabilityRegistry();
  for(const descriptor of api.researchSystematicReviewCapabilities)f.registry.declare('research',descriptor);
  api.registerResearchSystematicReviewCapabilities({pluginId:'research',capabilities:f.registry},f.repository.systematicReviews);
  f.adapter=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>f.registry.invoke(name,input)});
  f.request={projectId:f.project.id,requestId:'save-protocol',protocolId:null,expectedVersionId:null,
    expectedVersionHash:null,body:reviewProtocolBodyFixture(),deviationReason:null};
  f.freeze=saved=>({projectId:f.project.id,requestId:'freeze-protocol',versionId:saved.version.id,
    expectedVersionHash:saved.versionHash,reviewNote:'Explicit synthetic window reviewer confirmation.'});
  f.changes=()=>f.db.prepare('SELECT total_changes()').pluck().get();
  return f;
}

test('generated protocol bridge binds save/freeze to actual sender and keeps fixed reads and replays readonly',async()=>{
  const f=scene();
  try {
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:review-protocol-save',[f.request]),[f.request]);
    const saved=await f.adapter.invoke('research.saveReviewProtocol',[f.request],17);
    assert.equal(saved.ok,true,JSON.stringify(saved));assert.deepEqual(saved.data.version.actor,{kind:'user',id:'window:17'});
    assert.equal(saved.data.freeze,null);
    const frozen=await f.adapter.invoke('research.freezeReviewProtocol',[f.freeze(saved.data)],23);
    assert.equal(frozen.ok,true,JSON.stringify(frozen));
    assert.deepEqual(frozen.data.freeze.actor,{kind:'user',id:'window:23'});
    assert.deepEqual(frozen.data.version,saved.data.version);
    const before=f.changes();
    const read=await f.adapter.invoke('research.getReviewProtocol',[{projectId:f.project.id,versionId:saved.data.version.id}],17);
    const history=await f.adapter.invoke('research.getReviewProtocolHistory',[{projectId:f.project.id,protocolId:saved.data.version.protocolId}],17);
    const list=await f.adapter.invoke('research.listReviewProtocols',[{projectId:f.project.id,limit:10}],17);
    const replay=await f.adapter.invoke('research.freezeReviewProtocol',[f.freeze(saved.data)],23);
    for(const result of [read,history,list,replay])assert.equal(result.ok,true,JSON.stringify(result));
    assert.deepEqual(read.data,frozen.data);assert.deepEqual(history.data,[frozen.data]);assert.deepEqual(list.data,[frozen.data]);
    assert.deepEqual(replay.data,frozen.data);assert.equal(f.changes(),before);
    assert.throws(()=>api.requireResearchHuman('research.reviewProtocol.freeze',f.project.id),/research_human_required/);
  }finally{f.close();}
});

test('tool calls, absent sender and wire actor cannot save or freeze a review protocol',async()=>{
  const f=scene();
  try {
    const before=f.changes();
    await assert.rejects(f.registry.invoke('research.reviewProtocol.save',f.request),error=>error.code==='research_human_required');
    const noSender=await f.adapter.invoke('research.saveReviewProtocol',[f.request]);
    assert.equal(noSender.ok,false);assert.equal(noSender.error.code,'research_sender_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-protocol-save',[f.request,17]));
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-protocol-save',[{...f.request,actor:{kind:'user',id:'wire-user'}}]));
    const forged=await f.adapter.invoke('research.saveReviewProtocol',[{...f.request,actor:{kind:'user',id:'wire-user'}}],17);
    assert.equal(forged.ok,false);assert.equal(f.changes(),before);
    const saved=await f.adapter.invoke('research.saveReviewProtocol',[f.request],17);assert.equal(saved.ok,true);
    const pending=f.changes();
    await assert.rejects(f.registry.invoke('research.reviewProtocol.freeze',f.freeze(saved.data)),error=>error.code==='research_human_required');
    const freeze=await f.adapter.invoke('research.freezeReviewProtocol',[{...f.freeze(saved.data),reviewer:'model-approved'}],17);
    assert.equal(freeze.ok,false);assert.equal(f.changes(),pending);
  }finally{f.close();}
});

test('human context binds capability and project; concurrency cannot confirm a superseded version',async()=>{
  const f=scene();
  try {
    const other=f.repository.createProject({title:'Other review',description:'Scope fixture',workspacePath:'/tmp/other-protocol-ipc'});
    const before=f.changes();
    await assert.rejects(api.withResearchHumanContext({capability:'research.reviewProtocol.freeze',projectId:f.project.id,windowId:17},
      ()=>f.registry.invoke('research.reviewProtocol.save',f.request)),error=>error.code==='research_human_required');
    await assert.rejects(api.withResearchHumanContext({capability:'research.reviewProtocol.save',projectId:other.id,windowId:17},
      ()=>f.registry.invoke('research.reviewProtocol.save',f.request)),error=>error.code==='research_human_project_mismatch');
    assert.equal(f.changes(),before);
    const saved=await f.adapter.invoke('research.saveReviewProtocol',[f.request],17);assert.equal(saved.ok,true);
    const base={...f.request,protocolId:saved.data.version.protocolId,expectedVersionId:saved.data.version.id,
      expectedVersionHash:saved.data.versionHash,deviationReason:'Explicit concurrent scope revision.'};
    const attempts=await Promise.all(['a','b'].map(requestId=>f.adapter.invoke('research.saveReviewProtocol',[{...base,requestId}],17)));
    assert.equal(attempts.filter(result=>result.ok).length,1);
    assert.equal(attempts.find(result=>!result.ok).error.code,'research_review_version_conflict');
    const stale=f.changes();
    const freeze=await f.adapter.invoke('research.freezeReviewProtocol',[f.freeze(saved.data)],17);
    assert.equal(freeze.ok,false);assert.equal(freeze.error.code,'research_review_version_conflict');
    assert.equal(f.changes(),stale);
  }finally{f.close();}
});

test('cross-project, corrupt receipt and archive errors keep their main-process failure categories',async()=>{
  const f=scene();
  try {
    const saved=await f.adapter.invoke('research.saveReviewProtocol',[f.request],17);assert.equal(saved.ok,true);
    const other=f.repository.createProject({title:'Other protocol owner',description:'Scope fixture',workspacePath:'/tmp/other-protocol-owner'});
    const crossed=await f.adapter.invoke('research.getReviewProtocol',[{projectId:other.id,versionId:saved.data.version.id}],17);
    assert.equal(crossed.ok,false);assert.equal(crossed.error.category,'permission');
    const frozen=await f.adapter.invoke('research.freezeReviewProtocol',[f.freeze(saved.data)],17);assert.equal(frozen.ok,true);
    f.db.prepare('DELETE FROM research_review_protocol_freezes WHERE version_id=?').run(saved.data.version.id);
    const before=f.changes();
    const corrupt=await f.adapter.invoke('research.getReviewProtocol',[{projectId:f.project.id,versionId:saved.data.version.id}],17);
    assert.equal(corrupt.ok,false);assert.equal(corrupt.error.code,'research_review_snapshot_invalid');assert.equal(corrupt.error.category,'degraded');
    assert.equal(f.changes(),before);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const archived=await f.adapter.invoke('research.saveReviewProtocol',[{...f.request,requestId:'archived-save'}],17);
    assert.equal(archived.ok,false);assert.equal(archived.error.code,'research_project_archived');assert.equal(archived.error.category,'permission');
  }finally{f.close();}
});
