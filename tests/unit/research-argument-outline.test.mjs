import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {createResearchFixture,loadResearchTestApi,unknownExperiment} from './fixtures/research-test-kit.mjs';
import {proposalChat} from './fixtures/research-proposal-origin.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api.dispose());
function scene() {
  const f=createResearchFixture(api,'reading'), projectId=f.project.id;
  const artifact=f.repository.createArtifact({projectId,stage:'reading',kind:'reading_notes',title:'Original reading notes',path:null});
  const evidence=text=>{
    const id=`source-${text}`;
    f.repository.knowledge.upsertFromSource({id,projectId,sourceType:'file',sourceId:`${id}.md`,title:id,content:text,
      chunks:[{content:text,locator:'block:0'}],embeddingPolicy:'none'});
    return f.repository.evidence.capture({projectId,chunkId:`${id}:chunk:0`});
  };
  const source=evidence('Measured improvement'), counter=evidence('Boundary condition');
  const claim=f.repository.evidence.createClaim({projectId,artifactId:artifact.id,subjectType:'paragraph',content:'The method improved in the recorded setting.',
    status:'supported',evidenceIds:[source.id],experiment:{...unknownExperiment}});
  const propose=(kind,record=source,condition=null)=>f.repository.evidence.relations.propose({projectId,claimId:claim.id,
    expectedClaimVersion:claim.version,evidenceId:record.id,expectedSourceDigest:api.relationSourceDigest(f.repository.evidence.inspectEvidence(record.id,projectId)),
    kind,condition,supersedesRelationId:null},{kind:'agent',id:f.run.id});
  const confirm=relation=>f.repository.evidence.relations.review({projectId,relationId:relation.id,expectedVersion:relation.version,
    expectedClaimVersion:claim.version,expectedSourceDigest:relation.sourceDigest,decision:'confirm',note:'Human inspected original source'}, {kind:'user',id:'window:73'});
  confirm(propose('supports')); confirm(propose('qualifies',counter,'Only for the documented population.'));
  const read=()=>f.repository.argumentOutlines.inspect({projectId,artifactId:artifact.id});
  const request=(overrides={})=>{
    const inspected=read();
    return {projectId,artifactId:artifact.id,expectedArtifactVersion:inspected.artifactVersion,expectedMatrixHash:inspected.matrixHash,
      requestId:'outline-1',parent:null,rationale:'Organize original evidence',sections:[{id:'results',title:'Results',question:'What does the evidence show?',
        claimIds:[claim.id],conditions:['Only the documented population'],gaps:['Independent replication not yet recorded.']}],...overrides};
  };
  const human=(capability,action)=>api.withResearchHumanContext({projectId,capability,windowId:73},action);
  const save=input=>human('research.argumentOutlines.save',()=>f.repository.argumentOutlines.save(input??request()));
  const materialize=input=>human('research.argumentOutlines.materialize',()=>f.repository.argumentOutlines.materialize(input));
  return {...f,artifact,source,counter,claim,propose,read,request,human,save,materialize};
}

test('matrix preserves real human support, qualifications, proposed findings and source digests without scientific approval',()=>{
  const f=scene();
  try {
    f.propose('contradicts',f.counter);
    const before=f.db.prepare('SELECT total_changes()').pluck().get(), inspected=f.read();
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
    assert.deepEqual(inspected.matrix[0].relations.map(relation=>[relation.kind,relation.status,relation.current]),
      [['supports','confirmed',true],['qualifies','confirmed',true],['contradicts','proposed',true]]);
    assert.equal(inspected.matrix[0].relations[1].condition,'Only for the documented population.');
    assert.equal(inspected.matrix[0].claimHash,api.relationClaimHash(f.claim));
    assert.deepEqual(inspected.matrix[0].gaps,[]);
    assert.equal(inspected.latest,null);
    assert.throws(()=>f.repository.argumentOutlines.save(f.request()),/research_human_required/u);
    const saved=f.save();
    assert.equal(saved.snapshot.actor.id,'window:73');
    assert.deepEqual(saved.snapshot.claims,[{claimId:f.claim.id,expectedClaimHash:api.relationClaimHash(f.claim)}]);
    assert.equal(f.read().latestCurrent,true);
    assert.deepEqual(f.save(),saved);
    assert.equal(f.repository.manuscripts.getManuscript(f.artifact.id),null);
    assert.equal(f.repository.getArtifact(f.artifact.id).status,'draft');
  } finally {f.close();}
});

test('outline revisions use current matrix and parent hashes and agent proposals never write a human outline',()=>{
  const f=scene();
  try {
    const request=f.request(), chat=proposalChat(api,f), {projectId,requestId:_id,...payload}=request;
    const proposed={projectId,artifactId:f.artifact.id,expectedArtifactVersion:payload.expectedArtifactVersion,rationale:'Draft argument organization',
      basis:[],proposal:{kind:'argument_outline',payload}};
    const operation=chat.operation(proposed);
    const result=api.runWithCapabilityOperationContext(operation,()=>f.repository.proposals.create({...proposed,requestId:operation.idempotencyKey}));
    assert.equal(result.status,'pending');
    assert.equal(f.read().latest,null);
    const saved=f.save(request);
    assert.equal(f.repository.proposals.get({projectId,proposalId:result.snapshot.id}).freshness,'stale');
    assert.throws(()=>f.save({...f.request(),requestId:'no-parent'}),/parent_changed/u);
    const next=f.save(f.request({requestId:'outline-2',parent:{outlineId:saved.snapshot.id,outlineHash:saved.snapshotHash},
      sections:[{...request.sections[0],title:'Discussion'}]}));
    const history=f.repository.argumentOutlines.history({projectId,artifactId:f.artifact.id,offset:0,limit:1});
    assert.equal(history.total,2); assert.deepEqual(history.items,[next]);
    assert.throws(()=>f.save({...f.request(),requestId:'stale',expectedMatrixHash:'f'.repeat(64)}),/source_changed/u);
  } finally {f.close();}
});

test('materializing reading claims uses canonical manuscript storage, replays once and never inherits semantic approvals',()=>{
  const f=scene();
  try {
    const saved=f.save(), projectId=f.project.id;
    f.db.prepare("UPDATE research_stage_states SET active_run_id=NULL,status='completed' WHERE project_id=? AND stage='reading'").run(projectId);
    f.db.prepare("UPDATE research_projects SET current_stage='writing' WHERE id=?").run(projectId);
    f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='writing'").run(projectId);
    const request={projectId,outlineId:saved.snapshot.id,expectedOutlineHash:saved.snapshotHash,expectedMatrixHash:f.read().matrixHash,
      requestId:'materialize-1',target:{kind:'new',title:'Evidence-grounded draft'}};
    assert.throws(()=>f.repository.argumentOutlines.materialize(request),/research_human_required/u);
    const result=f.materialize(request), before=f.db.prepare('SELECT total_changes()').pluck().get();
    assert.notEqual(result.claims[0].claimId,f.claim.id);
    assert.equal(f.repository.getArtifact(result.artifactId).status,'draft');
    assert.equal(f.repository.manuscripts.getManuscript(result.artifactId).contentHash,result.manuscriptHash);
    assert.deepEqual(f.repository.evidence.relations.forArtifact(result.artifactId,projectId),[]);
    assert.deepEqual(f.materialize(request),result);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
    assert.equal(f.read().latestCurrent,true);
    assert.throws(()=>f.materialize({...request,target:{kind:'new',title:'Changed retry'}}),/request_conflict/u);
    const source=f.repository.evidence.getClaim(f.claim.id);
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifact.id);
    f.db.prepare('UPDATE research_claims SET content=?,version=? WHERE id=?').run('Changed after outline',source.version+1,source.id);
    assert.equal(f.read().latestCurrent,false);
    assert.throws(()=>f.materialize({...request,requestId:'new-materialization',expectedMatrixHash:f.read().matrixHash}),/source_changed/u);
  } finally {f.close();}
});
