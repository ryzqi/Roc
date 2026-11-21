import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {unknownExperiment,createResearchFixture,loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api.dispose());
const empty=()=>({experiment:{...unknownExperiment},subjectType:'paragraph',status:'supported'});
function scene() {
  const f=createResearchFixture(api,'writing'), projectId=f.project.id;
  const evidence=id=>{
    f.repository.knowledge.upsertFromSource({id,projectId,sourceType:'file',sourceId:`${id}.md`,title:id,content:`${id} original`,
      chunks:[{content:`${id} original`,locator:'block:0'}],embeddingPolicy:'none'});
    return f.repository.evidence.capture({projectId,chunkId:`${id}:chunk:0`});
  };
  const source=evidence('source'), unrelated=evidence('unrelated');
  const manuscript=(title,record)=>{
    const artifact=f.repository.createArtifact({projectId,stage:'writing',kind:'manuscript',title,path:null});
    const claim=f.repository.evidence.createClaim({projectId,artifactId:artifact.id,...empty(),content:`${title} claim`,evidenceIds:[record.id]});
    f.repository.manuscripts.saveManuscript({artifactId:artifact.id,sections:[{title:'Results',claimIds:[claim.id]}]});
    return {artifact,claim};
  };
  const direct=manuscript('Direct',source), retained=manuscript('Retained',unrelated);
  const inspect=(id=source.id,expectedSourceDigest=api.relationSourceDigest(f.repository.evidence.inspectEvidence(id,projectId)))=>
    f.repository.impact.inspect({projectId,source:{kind:'evidence',evidenceId:id,expectedSourceDigest}});
  return {...f,source,unrelated,direct,retained,inspect};
}

test('fixed-point graph preserves context ancestry through semantic edges and cycles; direct paths retain strength',()=>{
  const artifacts=['seed','context','tail','direct','unrelated'].map(id=>({id,stage:'writing',title:id}));
  const edges=[
    ['seed','context','run_context'],['context','tail','numeric_mapping'],['tail','context','export_source'],
    ['seed','direct','claim_evidence'],['direct','seed','export_source']
  ].map(([from,to,kind])=>({from:`artifact:${from}`,to:`artifact:${to}`,reason:{kind,subjectId:`${from}:${to}`,detail:'Actual recorded edge'}}));
  const result=api.deriveResearchImpact(artifacts,'artifact:seed',edges);
  assert.deepEqual(result.preservedArtifactIds,['unrelated']);
  assert.ok(result.affected.find(item=>item.artifactId==='tail').reasons.every(reason=>reason.kind==='run_context'));
  assert.ok(result.affected.find(item=>item.artifactId==='direct').reasons.some(reason=>reason.kind==='claim_evidence'));
  const mixed=api.deriveResearchImpact(artifacts,'artifact:seed',[...edges,{from:'artifact:direct',to:'artifact:context',
    reason:{kind:'response_evidence',subjectId:'independent',detail:'Independent direct path'}}]);
  assert.ok(mixed.affected.find(item=>item.artifactId==='tail').reasons.some(reason=>reason.kind==='numeric_mapping'));
});

test('recorded claim and response dependencies stay read-only, preserve unrelated artifacts and bind latest review versions',()=>{
  const f=scene();
  try {
    const before=f.db.prepare('SELECT total_changes()').pluck().get(), first=f.inspect();
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
    assert.equal(first.coverage,'recorded_relationships'); assert.equal(first.stale,false);
    assert.deepEqual(first.affected.map(item=>item.artifactId),[f.direct.artifact.id]);
    assert.deepEqual(first.preservedArtifactIds,[f.retained.artifact.id]);
    assert.ok(first.affected[0].reasons.some(reason=>reason.kind==='claim_evidence'&&reason.subjectId===f.direct.claim.id));
    assert.deepEqual(f.inspect(),first);
    const review=f.repository.inspectArtifact({projectId:f.project.id,artifactId:f.retained.artifact.id,expectedVersion:null});
    api.withResearchHumanContext({capability:'research.responseMatrix.save',projectId:f.project.id,windowId:81},()=>
      f.repository.responseMatrix.save({projectId:f.project.id,artifactId:f.retained.artifact.id,requestId:'response',
        expectedArtifactVersion:review.snapshot.version,parent:null,rationale:'Original transcribed comment',rows:[{
          commentId:'r1',reviewer:'Reviewer',comment:'Please inspect the additional source',status:'open',response:'',locations:[],evidenceIds:[f.source.id]
        }]}));
    const second=f.inspect();
    assert.notEqual(second.reportHash,first.reportHash);
    assert.equal(second.affected.length,2);
    assert.ok(second.affected.find(item=>item.artifactId===f.retained.artifact.id).reasons.some(reason=>reason.kind==='response_evidence'));
  } finally {f.close();}
});

test('expected source and artifact versions report stale; missing or cross-project sources fail explicitly',()=>{
  const f=scene();
  try {
    const sourceDigest=api.relationSourceDigest(f.repository.evidence.inspectEvidence(f.source.id,f.project.id));
    f.db.prepare('UPDATE research_evidence SET invalidated_at=? WHERE id=?').run('2026-11-21T00:00:00.000Z',f.source.id);
    assert.equal(f.inspect(f.source.id,sourceDigest).stale,true);
    const source=f.repository.inspectArtifact({projectId:f.project.id,artifactId:f.direct.artifact.id,expectedVersion:null});
    const request={projectId:f.project.id,source:{kind:'artifact',artifactId:f.direct.artifact.id,expectedVersion:source.snapshot.version}};
    assert.equal(f.repository.impact.inspect(request).stale,false);
    f.db.prepare('UPDATE research_artifacts SET title=? WHERE id=?').run('Changed in same timestamp',f.direct.artifact.id);
    assert.equal(f.repository.impact.inspect(request).stale,true);
    assert.throws(()=>f.inspect('missing'),/evidence_not_found/u);
    assert.throws(()=>f.repository.impact.inspect({projectId:f.project.id,source:{kind:'result',resultId:'missing',expectedHash:'a'.repeat(64)}}),/result_not_found/u);
    const other=f.repository.createProject({title:'Other',description:'',workspacePath:'/tmp/impact-other'});
    assert.throws(()=>f.repository.impact.inspect({...request,projectId:other.id}),/project_mismatch/u);
    assert.throws(()=>f.repository.impact.inspect({...request,source:{...request.source,artifactId:'missing'}}),/artifact_not_found/u);
  } finally {f.close();}
});

test('capability and IPC expose the same source-bound report without mutating reviews',async()=>{
  const f=scene();
  try {
    const handlers=new Map();
    api.registerResearchImpactCapabilities({pluginId:'fixture',capabilities:{register(_id,descriptor,handler){handlers.set(descriptor.name,handler);}}},f.repository.impact,f.repository.repairs);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>handlers.get(name)(input)});
    const expected=f.inspect(), before=f.db.prepare('SELECT total_changes()').pluck().get();
    const result=await bridge.invoke('research.inspectResearchImpact',[{projectId:expected.projectId,source:expected.source}],81);
    assert.equal(result.ok,true); assert.deepEqual(result.data,expected);
    const invalid=await bridge.invoke('research.inspectResearchImpact',[{projectId:expected.projectId,source:{...expected.source,actor:'forged'}}],81);
    assert.equal(invalid.ok,false);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  } finally {f.close();}
});
