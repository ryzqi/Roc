import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {reviewProtocolBodyFixture as body} from './fixtures/research-review-protocol.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, schemas;
before(async()=>{
  api=await loadResearchTestApi();
  schemas=await importTypeScriptModule('src/shared/schemas/research-systematic-review.ts',{
    platform:'node',external:['zod'],tempDir:'.runtime/tmp'});
});
after(()=>api?.dispose());
const actor={kind:'user',id:'synthetic-protocol-reviewer-1'};

const request=(projectId,requestId='save-protocol')=>({projectId,requestId,protocolId:null,
  expectedVersionId:null,expectedVersionHash:null,body:body(),deviationReason:null});
const freezing=(saved,requestId='freeze-protocol')=>({projectId:saved.version.projectId,requestId,
  versionId:saved.version.id,expectedVersionHash:saved.versionHash,reviewNote:'Synthetic human has reviewed the fixed scope and methods.'});
const revision=(saved,requestId='revise-protocol')=>({projectId:saved.version.projectId,requestId,
  protocolId:saved.version.protocolId,expectedVersionId:saved.version.id,expectedVersionHash:saved.versionHash,
  body:{...saved.version.body,question:'Revised controlled synthetic question.'},deviationReason:'Explicit scope change; earlier protocol remains available.'});
const changes=f=>f.db.prepare('SELECT total_changes()').pluck().get();

test('protocol schema requires explicit scope, queries, review policy, units and lineage without wire authority',()=>{
  const input=request('project');assert.deepEqual(schemas.researchReviewProtocolSaveRequestSchema.parse(input),input);
  for(const invalid of [{...input,actor},{...input,body:{...input.body,screening:undefined}},
    {...input,body:{...input.body,publicationYears:{from:2026,to:2020}}},
    {...input,body:{...input.body,exclusionCriteria:[{id:'controlled',text:'Duplicate criterion ID'}]}},
    {...input,body:{...input.body,databases:[input.body.databases[0],input.body.databases[0]]}},
    {...input,body:{...input.body,databases:[{...input.body.databases[0],queries:['same','same']}]}},
    {...input,body:{...input.body,extractionFields:[input.body.extractionFields[0],input.body.extractionFields[0]]}},
    {...input,body:{...input.body,pico:{population:'A'}}},
    {...input,protocolId:'old',expectedVersionId:'version',expectedVersionHash:'a'.repeat(64)},
    {...input,body:{...input.body,databases:[{...input.body.databases[0],source:'unsupported'}]}}]) {
    assert.equal(schemas.researchReviewProtocolSaveRequestSchema.safeParse(invalid).success,false);
  }
});

test('save and freeze persist immutable version bytes, separate human receipts and exact no-write replays',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const draft=f.repository.systematicReviews.save(request(f.project.id),actor);
    assert.equal(draft.version.version,1);assert.equal(draft.freeze,null);assert.equal(draft.isLatest,true);
    const frozen=f.repository.systematicReviews.freeze(freezing(draft),actor);
    assert.deepEqual(frozen.version,draft.version);assert.equal(frozen.versionHash,draft.versionHash);
    assert.equal(frozen.freeze.actor.id,actor.id);assert.ok(frozen.freezeHash);
    assert.deepEqual(f.repository.systematicReviews.requireFrozen(f.project.id,draft.version.id,frozen.freezeHash),frozen);
    const before=changes(f);
    assert.deepEqual(f.repository.systematicReviews.save(request(f.project.id),actor),frozen);
    assert.deepEqual(f.repository.systematicReviews.freeze(freezing(draft),actor),frozen);
    assert.deepEqual(f.repository.systematicReviews.list({projectId:f.project.id,limit:10}),[frozen]);
    assert.equal(changes(f),before);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_claims').pluck().get(),0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence_relations').pluck().get(),0);
  }finally{f.close();}
});

test('revisions append exact parent/hash/deviation history; stale writes and unconfirmed current execution refuse',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const first=f.repository.systematicReviews.save(request(f.project.id),actor);
    const frozen=f.repository.systematicReviews.freeze(freezing(first),actor);
    const second=f.repository.systematicReviews.save(revision(first),actor);
    assert.equal(second.version.version,2);assert.equal(second.version.parentVersionHash,first.versionHash);
    assert.deepEqual(f.repository.systematicReviews.history({projectId:f.project.id,protocolId:first.version.protocolId}),
      [{...frozen,isLatest:false},second]);
    const before=changes(f);
    assert.throws(()=>f.repository.systematicReviews.save(revision(first,'stale-save'),actor),/research_review_version_conflict/);
    assert.throws(()=>f.repository.systematicReviews.freeze(freezing(first,'stale-freeze'),actor),/research_review_version_conflict/);
    assert.throws(()=>f.repository.systematicReviews.requireFrozen(f.project.id,first.version.id,frozen.freezeHash),/research_review_version_conflict/);
    assert.throws(()=>f.repository.systematicReviews.requireFrozen(f.project.id,second.version.id,first.versionHash),/research_review_protocol_not_frozen/);
    assert.equal(changes(f),before);
    assert.deepEqual(f.repository.systematicReviews.freeze(freezing(first),actor),{...frozen,isLatest:false});
    const next=f.repository.systematicReviews.freeze(freezing(second,'freeze-v2'),actor);
    assert.notEqual(next.freezeHash,frozen.freezeHash);
    assert.throws(()=>f.repository.systematicReviews.requireFrozen(f.project.id,second.version.id,frozen.freezeHash),/research_review_version_conflict/);
  }finally{f.close();}
});

test('request content or reviewer drift and duplicate confirmation refuse without replacing receipts',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const input=request(f.project.id),draft=f.repository.systematicReviews.save(input,actor);
    const freezeRequest=freezing(draft),frozen=f.repository.systematicReviews.freeze(freezeRequest,actor);
    const before=changes(f);
    assert.throws(()=>f.repository.systematicReviews.save({...input,body:{...input.body,question:'Drift'}},actor),/research_review_request_conflict/);
    assert.throws(()=>f.repository.systematicReviews.save(input,{kind:'user',id:'different-user'}),/research_review_request_conflict/);
    assert.throws(()=>f.repository.systematicReviews.freeze({...freezeRequest,reviewNote:'Drift'},actor),/research_review_request_conflict/);
    assert.throws(()=>f.repository.systematicReviews.freeze(freezeRequest,{kind:'user',id:'different-user'}),/research_review_request_conflict/);
    assert.throws(()=>f.repository.systematicReviews.freeze(freezing(draft,'different-request'),actor),/research_review_already_frozen/);
    assert.throws(()=>f.repository.systematicReviews.save({...input,requestId:'agent'},{kind:'agent',id:'model'}));
    assert.equal(changes(f),before);
    assert.deepEqual(f.repository.systematicReviews.get({projectId:f.project.id,versionId:draft.version.id}),frozen);
  }finally{f.close();}
});

test('cross-project access and archived writes refuse; archived protocol history stays readable',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const draft=f.repository.systematicReviews.save(request(f.project.id),actor);
    const other=f.repository.createProject({title:'Other project',description:'Synthetic scope',workspacePath:'/tmp/other-review-protocol'});
    const before=changes(f);
    assert.throws(()=>f.repository.systematicReviews.get({projectId:other.id,versionId:draft.version.id}),/research_review_project_mismatch/);
    assert.throws(()=>f.repository.systematicReviews.history({projectId:other.id,protocolId:draft.version.protocolId}),/research_review_project_mismatch/);
    assert.throws(()=>f.repository.systematicReviews.save({...revision(draft),projectId:other.id},actor),/research_review_project_mismatch/);
    assert.equal(changes(f),before);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const archived=changes(f);
    assert.throws(()=>f.repository.systematicReviews.save(revision(draft),actor),/research_project_archived/);
    assert.throws(()=>f.repository.systematicReviews.freeze(freezing(draft),actor),/research_project_archived/);
    assert.deepEqual(f.repository.systematicReviews.get({projectId:f.project.id,versionId:draft.version.id}),draft);
    assert.equal(changes(f),archived);
  }finally{f.close();}
});

test('corrupt protocol bytes and missing frozen receipt are errors rather than a new draft',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const draft=f.repository.systematicReviews.save(request(f.project.id),actor);
    const original=f.db.prepare('SELECT snapshot_json FROM research_review_protocol_versions WHERE id=?').pluck().get(draft.version.id);
    const changed=JSON.parse(original);changed.body.question='Altered stored question';
    f.db.prepare('UPDATE research_review_protocol_versions SET snapshot_json=? WHERE id=?').run(JSON.stringify(changed),draft.version.id);
    const before=changes(f);
    assert.throws(()=>f.repository.systematicReviews.get({projectId:f.project.id,versionId:draft.version.id}),/research_review_snapshot_invalid/);
    assert.equal(changes(f),before);
    f.db.prepare('UPDATE research_review_protocol_versions SET snapshot_json=? WHERE id=?').run(original,draft.version.id);
    f.repository.systematicReviews.freeze(freezing(draft),actor);
    f.db.prepare('DELETE FROM research_review_protocol_freezes WHERE version_id=?').run(draft.version.id);
    const deleted=changes(f);
    assert.throws(()=>f.repository.systematicReviews.get({projectId:f.project.id,versionId:draft.version.id}),/research_review_snapshot_invalid/);
    assert.equal(changes(f),deleted);
  }finally{f.close();}
});

test('freeze receipt and version marker roll back together on storage failure',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const draft=f.repository.systematicReviews.save(request(f.project.id),actor);
    f.db.exec("CREATE TRIGGER fail_protocol_marker BEFORE UPDATE OF freeze_hash ON research_review_protocol_versions BEGIN SELECT RAISE(ABORT,'synthetic_marker_failure'); END;");
    assert.throws(()=>f.repository.systematicReviews.freeze(freezing(draft),actor),/synthetic_marker_failure/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_protocol_freezes').pluck().get(),0);
    assert.deepEqual(f.repository.systematicReviews.get({projectId:f.project.id,versionId:draft.version.id}),draft);
    f.db.exec('DROP TRIGGER fail_protocol_marker');
    assert.ok(f.repository.systematicReviews.freeze(freezing(draft),actor).freezeHash);
  }finally{f.close();}
});

test('real database reopen retains frozen protocol and later revision without rerunning user decisions',async()=>{
  const f=createResearchFixture(api,'reading'),directory=await mkdtemp(join(tmpdir(),'roc-review-protocol-'));
  let reopened;
  try {
    const first=f.repository.systematicReviews.save(request(f.project.id),actor);
    const frozen=f.repository.systematicReviews.freeze(freezing(first),actor);
    const next=f.repository.systematicReviews.save(revision(first),actor);
    const path=join(directory,'research.sqlite');await f.db.backup(path);
    reopened=new Database(path);reopened.pragma('foreign_keys = ON');
    const repository=new api.ResearchRepository(reopened,f.tasks,()=>new Date().toISOString());
    assert.deepEqual(repository.systematicReviews.history({projectId:f.project.id,protocolId:first.version.protocolId}),
      [{...frozen,isLatest:false},next]);
    const before=reopened.prepare('SELECT total_changes()').pluck().get();
    repository.systematicReviews.list({projectId:f.project.id,limit:10});
    assert.equal(reopened.prepare('SELECT total_changes()').pluck().get(),before);
  }finally{reopened?.close();f.close();await rm(directory,{recursive:true,force:true});}
});
