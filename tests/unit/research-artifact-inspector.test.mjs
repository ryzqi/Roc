import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const digest=value=>createHash('sha256').update(value).digest('hex');
const readInput=(f,artifact,expectedVersion=null)=>({projectId:f.project.id,artifactId:artifact.id,expectedVersion});
function manual(f) {
  return f.repository.createArtifact({projectId:f.project.id,stage:'reading',kind:'reading_notes',title:'Synthetic notes',path:null});
}
function evidence(f,id='synthetic-evidence') {
  const excerpt='A retained synthetic excerpt.';
  f.db.prepare(`INSERT INTO research_evidence
    (id,project_id,document_id,chunk_id,source_type,source_id,source_version,title,locator,excerpt,content_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,f.project.id,'synthetic-document','synthetic-document:chunk:0','file',
      'synthetic-source','parse-1','Synthetic source','page:2',excerpt,digest(excerpt),'2026-11-03T00:00:00.000Z');
  return id;
}
function totalChanges(f) {return f.db.prepare('SELECT total_changes() AS count').get().count;}

test('owned artifact inspection retains actual empty content, origin and scoped sources without database writes',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const empty=manual(f),before=totalChanges(f);
    const first=f.repository.inspectArtifact(readInput(f,empty));
    assert.equal(first.status,'current');
    assert.equal(first.snapshot.content,null);
    assert.equal(first.snapshot.origin,null);
    assert.deepEqual(first.snapshot.availableActions,[]);
    assert.deepEqual(first.snapshot.claims,[]);
    assert.match(first.snapshot.version,/^[a-f0-9]{64}$/u);
    assert.deepEqual(f.repository.inspectArtifact(readInput(f,empty,first.snapshot.version)),first);
    assert.equal(totalChanges(f),before);
    const completed=f.repository.runs.complete(f.run.id,f.project.id,{title:'Recorded notes',markdown:'Actual saved markdown',
      claims:[{subjectType:'claim',content:'Synthetic working hypothesis',status:'hypothesis',evidenceIds:[]}],
      sections:[],verdict:'uncertain'});
    const artifact=f.repository.getArtifact(completed.outputArtifactIds[0]);
    f.repository.addProvenance({projectId:f.project.id,artifactId:artifact.id,subjectType:'artifact',subjectId:artifact.id,
      sourceType:'file',sourceId:'synthetic-input',locator:'page:2',excerpt:'Original source location.'});
    f.repository.addProvenance({projectId:f.project.id,artifactId:empty.id,subjectType:'artifact',subjectId:empty.id,
      sourceType:'file',sourceId:'other-input',locator:null,excerpt:null});
    const start=totalChanges(f),result=f.repository.inspectArtifact(readInput(f,artifact));
    assert.equal(result.snapshot.content.output.markdown,'Actual saved markdown');
    assert.equal(result.snapshot.origin.id,f.run.id);
    assert.equal(result.snapshot.origin.taskId,completed.taskId);
    assert.equal(result.snapshot.origin.status,'completed');
    assert.equal(result.snapshot.origin.providerId,'fixture-provider');
    assert.deepEqual(result.snapshot.availableActions,['return_to_task']);
    assert.equal(result.snapshot.claims[0].status,'hypothesis');
    assert.ok(result.snapshot.provenance.some(row=>row.sourceId==='synthetic-input'));
    assert.ok(result.snapshot.provenance.every(row=>row.artifactId===artifact.id));
    assert.equal(totalChanges(f),start);
  } finally {f.close();}
});

test('content and source changes at the same clock produce stale inspection versions rather than timestamp aliases',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const artifact=manual(f),first=f.repository.inspectArtifact(readInput(f,artifact));
    const updated=f.repository.updateArtifact({id:artifact.id,title:'Revised notes'});
    assert.equal(updated.updatedAt,artifact.updatedAt);
    const stale=f.repository.inspectArtifact(readInput(f,artifact,first.snapshot.version));
    assert.equal(stale.status,'stale');
    assert.notEqual(stale.snapshot.version,first.snapshot.version);
    assert.equal(stale.snapshot.artifact.title,'Revised notes');
    const claim=f.repository.evidence.createClaim({projectId:f.project.id,artifactId:artifact.id,subjectType:'claim',
      content:'A hypothesis without semantic review',status:'hypothesis',evidenceIds:[]});
    const withClaim=f.repository.inspectArtifact(readInput(f,artifact,stale.snapshot.version));
    assert.equal(withClaim.status,'stale');
    f.repository.evidence.updateClaim({id:claim.id,expectedVersion:claim.version,content:'Changed hypothesis',status:'pending',evidenceIds:[]});
    const changed=f.repository.inspectArtifact(readInput(f,artifact,withClaim.snapshot.version));
    assert.equal(changed.status,'stale');
    assert.equal(changed.snapshot.claims[0].status,'pending');
    assert.equal(changed.snapshot.claims[0].version,2);
    f.db.prepare("UPDATE research_stage_states SET status='paused' WHERE project_id=? AND stage='reading'").run(f.project.id);
    const paused=f.repository.inspectArtifact(readInput(f,artifact,changed.snapshot.version));
    assert.equal(paused.status,'stale');
    assert.equal(paused.snapshot.stage.status,'paused');
  } finally {f.close();}
});

test('superseded evidence remains inspectable with its original excerpt while publication getters and integrity failures refuse',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const artifact=manual(f),id=evidence(f);
    f.repository.evidence.createClaim({projectId:f.project.id,artifactId:artifact.id,subjectType:'claim',
      content:'A retained source association',status:'pending',evidenceIds:[id]});
    const first=f.repository.inspectArtifact(readInput(f,artifact));
    assert.equal(first.snapshot.evidence[0].referenceStatus,'recorded');
    assert.equal(first.snapshot.evidence[0].invalidatedAt,null);
    f.repository.evidence.invalidateChunksOf('synthetic-document');
    const before=totalChanges(f),invalid=f.repository.inspectArtifact(readInput(f,artifact,first.snapshot.version));
    assert.equal(invalid.status,'stale');
    assert.equal(invalid.snapshot.evidence[0].referenceStatus,'superseded');
    assert.equal(invalid.snapshot.evidence[0].invalidatedAt,'2026-11-03T00:00:00.000Z');
    assert.deepEqual(invalid.snapshot.evidence[0].evidence,first.snapshot.evidence[0].evidence);
    assert.equal(totalChanges(f),before);
    assert.throws(()=>f.repository.evidence.getEvidence(id,f.project.id),/research_evidence_reference_superseded/u);
    f.db.prepare('UPDATE research_evidence SET excerpt=? WHERE id=?').run('Corrupted excerpt',id);
    assert.throws(()=>f.repository.inspectArtifact(readInput(f,artifact)),/research_evidence_integrity_invalid/u);
    f.db.prepare('DELETE FROM research_evidence WHERE id=?').run(id);
    assert.throws(()=>f.repository.inspectArtifact(readInput(f,artifact)),/research_evidence_not_found/u);
  } finally {f.close();}
});

test('actual artifact inspection bridge enforces explicit project and version contracts and reports cross-project refusal',async()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const artifact=manual(f),handlers=new Map();
    api.registerResearchArtifactInspectorCapability({pluginId:'fixture',capabilities:{register(pluginId,descriptor,handler){
      assert.equal(descriptor.name,'research.artifacts.inspect');handlers.set(descriptor.name,handler);
    }}},f.repository);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability(name,input){return handlers.get(name)(input);}});
    const input=readInput(f,artifact);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:artifact-inspect',[input]),[input]);
    const first=await bridge.invoke('research.inspectArtifact',[input],21);
    assert.equal(first.ok,true);
    assert.equal(first.data.snapshot.artifact.id,artifact.id);
    const other=f.repository.createProject({title:'Other project',description:'Isolation fixture',workspacePath:'/tmp/other-inspection'});
    const refused=await bridge.invoke('research.inspectArtifact',[{...input,projectId:other.id}],21);
    assert.equal(refused.ok,false);
    assert.equal(refused.error.code,'research_artifact_project_mismatch');
    assert.equal(refused.error.retryable,false);
    for(const bad of [{projectId:input.projectId,artifactId:input.artifactId},{...input,expectedVersion:'old timestamp'},
      {...input,path:'/arbitrary/file'}, {...input,projectId:null}]) {
      assert.throws(()=>api.parseIpcRequestArgs('roc:research:artifact-inspect',[bad]));
      assert.equal((await bridge.invoke('research.inspectArtifact',[bad],21)).ok,false);
    }
    const missing=await bridge.invoke('research.inspectArtifact',[{...input,artifactId:'missing'}],21);
    assert.equal(missing.ok,false);
    assert.equal(missing.error.code,'research_artifact_not_found');
    assert.equal(missing.error.category,'not_found');
    const missingProject=await bridge.invoke('research.inspectArtifact',[{...input,projectId:'missing-project'}],21);
    assert.equal(missingProject.error.code,'research_project_not_found');
    assert.equal(missingProject.error.category,'not_found');
    const id=evidence(f);
    f.repository.evidence.createClaim({projectId:f.project.id,artifactId:artifact.id,subjectType:'claim',
      content:'Synthetic source',status:'pending',evidenceIds:[id]});
    f.db.prepare('UPDATE research_evidence SET project_id=? WHERE id=?').run(other.id,id);
    const badSource=await bridge.invoke('research.inspectArtifact',[input],21);
    assert.equal(badSource.ok,false);
    assert.equal(badSource.error.code,'research_evidence_project_mismatch');
    assert.equal(badSource.error.retryable,false);
  } finally {f.close();}
});
