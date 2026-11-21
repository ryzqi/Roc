import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {createResearchFixture,loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {proposalChat} from './fixtures/research-proposal-origin.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api.dispose());
const profile=()=>({journal:'Synthetic engineering journal',articleType:'Article',submissionStage:'initial',version:'example-1',
  revisionDate:'2026-11-22',dateAuthority:'human_transcription',retrievedAt:'2026-11-22T00:00:00.000Z',rules:[{
    id:'refs',label:'Reference limit',sourceUrl:'https://example.org/synthetic-author-guide',excerpt:'Synthetic fixture rule; not a real journal rule.',
    authority:'required',kind:'reference_count',maximum:100
  }]});
const requirements=()=>({maximumPages:10,anonymous:false,requiredDeclarations:['Data availability'],minimumEditableTables:0,supplementPaths:[]});
function scene(){
  const f=createResearchFixture(api,'writing');
  const request=(overrides={})=>({projectId:f.project.id,requestId:'profile-1',profileId:null,parent:null,profile:profile(),requirements:requirements(),...overrides});
  const save=input=>api.withResearchHumanContext({projectId:f.project.id,windowId:73,capability:'research.submissionProfiles.save'},()=>f.repository.submissionProfiles.save(input));
  return {...f,request,save};
}
test('profile revisions freeze official rule sources and requirements, compare exact changes and retain old versions',()=>{
  const f=scene();
  try{
    assert.throws(()=>f.repository.submissionProfiles.save(f.request()),/research_human_required/u);
    const first=f.save(f.request()), old=JSON.stringify(first), service=f.repository.submissionProfiles;
    const next=f.request({requestId:'profile-2',profileId:first.snapshot.profileId,parent:{versionId:first.snapshot.id,versionHash:first.snapshotHash},
      profile:{...profile(),rules:[{...profile().rules[0],maximum:30},{...profile().rules[0],id:'manual',kind:'manual',area:'structure',maximum:undefined}]},
      requirements:{...requirements(),maximumPages:5,anonymous:true}});
    delete next.profile.rules[1].maximum;
    const second=f.save(next);
    assert.equal(JSON.stringify(first),old);
    assert.deepEqual(service.get({projectId:f.project.id,versionId:first.snapshot.id,expectedHash:first.snapshotHash}),first);
    assert.deepEqual(service.compare({projectId:f.project.id,left:{versionId:first.snapshot.id,expectedHash:first.snapshotHash},
      right:{versionId:second.snapshot.id,expectedHash:second.snapshotHash}}),{addedRuleIds:['manual'],removedRuleIds:[],changedRuleIds:['refs'],changedRequirementKeys:['maximumPages','anonymous']});
    assert.deepEqual(service.list({projectId:f.project.id,offset:0,limit:1}),{items:[second],total:1});
    const changes=f.db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(f.save(next),second);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),changes);
    assert.throws(()=>f.save({...next,requestId:'old-parent'}),/parent_changed/u);
    assert.throws(()=>f.save({...next,requirements:{...next.requirements,privateIdentityTokens:['private-value']}}));
    assert.throws(()=>service.get({projectId:f.project.id,versionId:first.snapshot.id,expectedHash:'f'.repeat(64)}),/hash_mismatch/u);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.throws(()=>f.save(f.request({requestId:'archived'})),/archived/u);
    assert.deepEqual(service.get({projectId:f.project.id,versionId:first.snapshot.id,expectedHash:first.snapshotHash}),first);
  }finally{f.close();}
});

test('Agent profile proposals carry versioned rules and original run identity without writing human profile records',()=>{
  const f=scene();
  try{
    const artifact=f.repository.createArtifact({projectId:f.project.id,stage:'writing',kind:'manuscript',title:'Submission source',path:null});
    const {projectId,requestId:_request,...payload}=f.request();
    const request={projectId,artifactId:artifact.id,expectedArtifactVersion:f.repository.inspectArtifact({projectId,artifactId:artifact.id,expectedVersion:null}).snapshot.version,
      rationale:'Proposed submission policy from the official rules',basis:[],proposal:{kind:'submission_profile',payload}};
    const chat=proposalChat(api,f), operation=chat.operation(request);
    const result=api.runWithCapabilityOperationContext(operation,()=>f.repository.proposals.create({...request,requestId:operation.idempotencyKey}));
    assert.equal(result.snapshot.origin.runId,chat.runId);
    assert.equal(f.repository.submissionProfiles.list({projectId,offset:0,limit:10}).total,0);
    const saved=f.save(f.request());
    const other=f.repository.createProject({title:'Other',description:'',workspacePath:'/tmp/submission-profile-other'});
    assert.throws(()=>f.repository.submissionProfiles.get({projectId:other.id,versionId:saved.snapshot.id,expectedHash:saved.snapshotHash}),/project_mismatch/u);
  }finally{f.close();}
});
