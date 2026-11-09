import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewFullTextFixture} from './fixtures/research-review-fulltext.mjs';
import {createReviewFullTextScreeningFixture,fullTextActor as actor,fullTextInclude as include,
  fullTextExclude as exclude,fullTextOrigin as origin} from './fixtures/research-review-fulltext-screening.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
async function scene({complete=true,...options}={}) {
  const f=await createReviewFullTextScreeningFixture(api,options);
  f.votes=[];
  if(complete) {
    for(const index of [0,2]) {
      await f.bind(index);
      for(const [reviewerIndex,reviewer] of f.reviewerIds.entries())f.votes.push(await f.fullScreening.save(
        f.vote(index,reviewer,`full-review-${index}-${reviewer}`,index===0&&reviewerIndex===1?exclude:include),actor));
    }
    const refs=f.fullScreening.getPhase(f.fullPhase).items[0].decisions.map(decision=>({id:decision.snapshot.id,expectedHash:decision.snapshotHash}));
    f.arbitration=await f.fullArbitration.save({...f.target(0,'resolve'),reviewerId:f.plan.snapshot.request.adjudicator.id,outcome:exclude,
      decisions:refs,parentArbitrationId:null,expectedParentHash:null,revisionReason:null},actor);
    for(const index of [3,4,5,6,7])await f.fulltexts.save(f.notRetrieved(index,`gap-${index}`),actor);
  }
  f.freezeInput=(requestId='freeze-full')=>({...f.fullPhase,requestId,expectedReviewHash:f.fullFreezing.getPhase(f.fullPhase).reviewHash,
    reviewNote:'Human confirms the complete fixed fulltext set and explicit unretrieved reports.'});
  return f;
}
const count=f=>f.db.prepare("SELECT count(*) FROM research_review_screening_freezes WHERE phase='full_text'").pluck().get();

test('fulltext freeze fixes real retrieval gaps, final human/source/arbitration refs and conserved counts independently of suggestions',async()=>{
  const f=await scene();
  try {
    const before=f.fullFreezing.getPhase(f.fullPhase),input=f.freezeInput(),title=f.freezing.getPhase(f.phase);
    const suggestion=await f.fullScreening.suggest({...f.target(2,'proposal'),outcome:include},origin);
    assert.equal(f.fullFreezing.getPhase(f.fullPhase).reviewHash,before.reviewHash);
    const result=await f.fullFreezing.freeze(input,actor);
    assert.equal(result.sourcesCurrent,true);assert.equal(result.freeze.reviewHash,input.expectedReviewHash);
    assert.equal(result.freezeHash,hash(JSON.stringify(result.freeze)));
    assert.deepEqual(result.freeze.actor,actor);assert.equal(result.freeze.authority.titleFreezeHash,f.title.freezeHash);
    assert.equal(result.freeze.authority.counts.reportsToSeek,7);assert.equal(result.freeze.authority.counts.not_retrieved,5);
    assert.equal(result.freeze.authority.counts.included,1);assert.equal(result.freeze.authority.counts.excluded,1);
    assert.deepEqual(result.freeze.authority.items[0].arbitration,{id:f.arbitration.snapshot.id,expectedHash:f.arbitration.snapshotHash});
    assert.equal(result.freeze.authority.items[0].primaryExclusionCriterionId,'no-outcome');
    assert.ok(!JSON.stringify(result.freeze.authority).includes(suggestion.snapshot.id));
    assert.deepEqual(f.freezing.getPhase(f.phase),title);
    const readonly=f.changes();assert.deepEqual(f.fullFreezing.requireFrozen(f.project.id,f.corpus.snapshot.id,result.freezeHash),result);
    assert.deepEqual(await f.fullFreezing.freeze(input,actor),result);assert.equal(f.changes(),readonly);
  }finally{await f.cleanup();}
});

test('freeze rejects implicit gaps, pending or conflicting votes and physical source corruption without a receipt or marker',async()=>{
  const f=await scene({complete:false});
  try {
    await assert.rejects(f.fullFreezing.freeze(f.freezeInput(),actor),/research_review_screening_incomplete/);
    await f.bind(0);await f.fullScreening.save(f.vote(0,f.reviewerIds[0],'first'),actor);
    for(const index of [2,3,4,5,6,7])await f.fulltexts.save(f.notRetrieved(index,`gap-${index}`),actor);
    await assert.rejects(f.fullFreezing.freeze(f.freezeInput(),actor),/research_review_screening_incomplete/);
    await f.fullScreening.save(f.vote(0,f.reviewerIds[1],'conflict',exclude),actor);
    await assert.rejects(f.fullFreezing.freeze(f.freezeInput(),actor),/research_review_screening_incomplete/);
    assert.equal(count(f),0);assert.equal(f.db.prepare('SELECT full_freeze_hash FROM research_review_screening_plans').pluck().get(),null);
  }finally{await f.cleanup();}
  const ready=await scene();
  try {
    const input=ready.freezeInput(),before=ready.changes();await writeFile(ready.sourcePath,Buffer.from('corrupt original'));
    await assert.rejects(ready.fullFreezing.freeze(input,actor),/research_document_source_changed/);
    assert.equal(ready.changes(),before);assert.equal(count(ready),0);
  }finally{await ready.cleanup();}
});

test('complete freeze rejects every new binding/vote/proposal/arbitration while exact original requests replay readonly',async()=>{
  const f=await scene();
  try {
    const proposal=await f.fullScreening.suggest({...f.target(2,'proposal'),outcome:include},origin);
    await f.fullFreezing.freeze(f.freezeInput(),actor);
    const before=f.changes(),bound=f.bound.get(0),vote=f.votes[0];
    const binding={...f.notRetrieved(0,'new-binding'),parentBindingId:bound.snapshot.id,expectedParentHash:bound.snapshotHash,revisionReason:'Attempt after final review.'};
    const revision=f.vote(0,f.reviewerIds[0],'new-vote',include,{parentDecisionId:vote.snapshot.id,expectedParentHash:vote.snapshotHash,revisionReason:'Attempt after freeze.'});
    const arbitration={...f.arbitration.snapshot.request,requestId:'new-arbitration',parentArbitrationId:f.arbitration.snapshot.id,
      expectedParentHash:f.arbitration.snapshotHash,revisionReason:'Attempt after freeze.'};
    for(const run of [()=>f.fulltexts.save(binding,actor),()=>f.fullScreening.save(revision,actor),
      ()=>f.fullScreening.suggest({...f.target(2,'new-proposal'),outcome:exclude},origin),()=>f.fullArbitration.save(arbitration,actor)]) {
      await assert.rejects(run(),/research_review_screening_already_frozen/);
    }
    assert.deepEqual(await f.fulltexts.save(bound.snapshot.request,actor),bound);
    assert.deepEqual(await f.fullScreening.save(vote.snapshot.request,actor),vote);
    assert.deepEqual(await f.fullScreening.suggest(proposal.snapshot.request,origin),proposal);
    assert.deepEqual(await f.fullArbitration.save(f.arbitration.snapshot.request,actor),f.arbitration);
    assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('missing or canonically modified freeze receipt cannot reopen review or acknowledge a different fixed authority',async()=>{
  const f=await scene();
  try {
    const result=await f.fullFreezing.freeze(f.freezeInput(),actor);
    const row=f.db.prepare("SELECT * FROM research_review_screening_freezes WHERE phase='full_text'").get();
    f.db.prepare("DELETE FROM research_review_screening_freezes WHERE phase='full_text'").run();
    const before=f.changes();assert.throws(()=>f.fullFreezing.getPhase(f.fullPhase),/research_review_screening_snapshot_invalid/);
    await assert.rejects(f.fulltexts.save(f.notRetrieved(0,'lost-receipt-new'),actor),/research_review_screening_snapshot_invalid/);
    assert.equal(f.changes(),before);
    f.db.prepare(`INSERT INTO research_review_screening_freezes
      (project_id,corpus_id,phase,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(row.project_id,row.corpus_id,row.phase,row.request_id,row.snapshot_json,row.snapshot_hash,row.created_at);
    const changed=structuredClone(result.freeze);changed.authority.items[0].decisions[0].expectedHash='a'.repeat(64);
    changed.reviewHash=hash(JSON.stringify(changed.authority));changed.request.expectedReviewHash=changed.reviewHash;
    changed.requestHash=hash(JSON.stringify(changed.request));const json=JSON.stringify(changed),digest=hash(json);
    f.db.prepare("UPDATE research_review_screening_freezes SET snapshot_json=?,snapshot_hash=? WHERE phase='full_text'").run(json,digest);
    f.db.prepare('UPDATE research_review_screening_plans SET full_freeze_hash=?').run(digest);
    assert.throws(()=>f.fullFreezing.getPhase(f.fullPhase),/research_review_screening_snapshot_invalid/);
  }finally{await f.cleanup();}
});

test('valid new reviewer version or current source drift during freeze insertion rolls back receipt, marker and drift',async()=>{
  const f=await scene();
  try {
    const input=f.freezeInput(),parent=f.votes[3],request=api.researchReviewFullTextDecisionSaveSchema.parse(
      f.vote(2,parent.snapshot.reviewer.id,'late-valid-vote',include,{parentDecisionId:parent.snapshot.id,
        expectedParentHash:parent.snapshotHash,revisionReason:'Valid reviewer revision during freeze storage.'}));
    const snapshot=api.researchReviewFullTextDecisionSnapshotSchema.parse({...parent.snapshot,id:'late-full-freeze-vote',
      version:2,request,requestHash:hash(JSON.stringify(request))});
    const json=JSON.stringify(snapshot),quote=value=>`'${value.replaceAll("'","''")}'`;
    f.db.exec(`CREATE TRIGGER drift_full_freeze AFTER INSERT ON research_review_screening_freezes WHEN NEW.phase='full_text' BEGIN
      INSERT INTO research_review_screening_decisions
      (id,project_id,corpus_id,phase,hit_id,reviewer_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
      VALUES (${[snapshot.id,request.projectId,request.corpusId,request.phase,request.hitId,request.reviewerId].map(quote).join(',')},2,
        ${[request.parentDecisionId,request.requestId,json,hash(json),snapshot.recordedAt].map(quote).join(',')}); END;`);
    await assert.rejects(f.fullFreezing.freeze(input,actor),/research_review_screening_snapshot_invalid/);
    assert.equal(count(f),0);assert.equal(f.db.prepare('SELECT full_freeze_hash FROM research_review_screening_plans').pluck().get(),null);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_decisions WHERE id=?').pluck().get(snapshot.id),0);
    f.db.exec('DROP TRIGGER drift_full_freeze');
    f.db.exec("CREATE TRIGGER full_freeze_source AFTER INSERT ON research_review_screening_freezes WHEN NEW.phase='full_text' BEGIN UPDATE research_documents SET current_parse_id=NULL; END;");
    await assert.rejects(f.fullFreezing.freeze(input,actor),/research_review_screening_version_conflict/);
    assert.equal(count(f),0);assert.equal(f.db.prepare('SELECT full_freeze_hash FROM research_review_screening_plans').pluck().get(),null);
    assert.equal(f.repository.documents.get(f.document.id).currentParseId,f.selection.parseId);
  }finally{await f.cleanup();}
});

test('source binding revised after real async preview preserves independent revision but refuses the old displayed freeze hash',async()=>{
  const f=await scene();
  try {
    const input=f.freezeInput(),binding=f.bound.get(2),preview=f.service.preview.bind(f.service);let revised=false;
    f.service.preview=async request=>{
      const result=await preview(request);
      if(!revised) {
        revised=true;await f.fulltexts.save({...f.notRetrieved(2,'independent-gap'),parentBindingId:binding.snapshot.id,
          expectedParentHash:binding.snapshotHash,revisionReason:'Independent human revision while source was checked.'},actor);
      }
      return result;
    };
    await assert.rejects(f.fullFreezing.freeze(input,actor),/research_review_fulltext_version_conflict/);
    assert.equal(count(f),0);assert.equal(f.fulltexts.history({...f.get,hitId:binding.snapshot.request.hitId}).length,2);
    assert.equal(f.fullFreezing.getPhase(f.fullPhase).counts.not_retrieved,6);
  }finally{await f.cleanup();}
});

test('later document reparse preserves frozen human conclusions and receipt while exposing live stale source and refusing downstream scientific use',async()=>{
  const f=await scene();
  try {
    const input=f.freezeInput(),result=await f.fullFreezing.freeze(input,actor);
    f.reparse();const changed=f.fullFreezing.getPhase(f.fullPhase),before=f.changes();
    assert.deepEqual(changed.freeze,result.freeze);assert.equal(changed.reviewHash,result.reviewHash);assert.equal(changed.freezeHash,result.freezeHash);
    assert.equal(changed.sourcesCurrent,false);assert.equal(changed.counts.source_changed,2);
    assert.equal(changed.freeze.authority.counts.included,1);assert.equal(changed.freeze.authority.counts.excluded,1);
    assert.equal(changed.freeze.authority.counts.not_retrieved,5);assert.equal(changed.items[0].arbitration.currentDecisionSet,false);
    assert.throws(()=>f.fullFreezing.requireFrozen(f.project.id,f.corpus.snapshot.id,result.freezeHash),/research_review_screening_version_conflict/);
    assert.deepEqual(await f.fullFreezing.freeze(input,actor),changed);assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('historical protocol, archive and actual main sender preserve exact freeze receipt and readonly history',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewFullTextScreeningCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewFullTextScreeningCapabilities({pluginId:'research',capabilities:registry},f.fullScreening,f.fullArbitration,f.fullFreezing);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)}),input=f.freezeInput(),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewFullTextScreening.freeze',input),error=>error.code==='research_human_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-fulltext-freeze',[{...input,actor}]));
    const missing=await bridge.invoke('research.freezeReviewFullTextScreening',[input]);assert.equal(missing.ok,false);
    assert.equal(missing.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const saved=await bridge.invoke('research.freezeReviewFullTextScreening',[input],141);
    assert.equal(saved.ok,true,JSON.stringify(saved));assert.deepEqual(saved.data.freeze.actor,{kind:'user',id:'window:141'});
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'new-protocol',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later protocol.'},actor);
    const history=await bridge.invoke('research.getReviewFullTextScreeningPhase',[f.fullPhase],141);
    assert.equal(history.ok,true);assert.equal(history.data.plan.currentProtocol,false);assert.deepEqual(history.data.freeze,saved.data.freeze);
    assert.throws(()=>f.fullFreezing.requireFrozen(f.project.id,f.corpus.snapshot.id,saved.data.freezeHash),/research_review_screening_version_conflict/);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.deepEqual(f.fullFreezing.getPhase(f.fullPhase),history.data);
    await assert.rejects(f.fullFreezing.freeze({...input,requestId:'archive'},actor),/research_project_archived/);
  }finally{await f.cleanup();}
});

test('actual SQLite reopen and failed zero-hit corpus keep whole-fulltext freeze without retrieval, import or new writes',async()=>{
  const f=await scene();let db,reviews,service;
  try {
    const result=await f.fullFreezing.freeze(f.freezeInput(),actor),path=join(f.root,'fulltext-freeze-reopen.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>{},()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time),dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const plans=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time),titleVotes=new api.ResearchReviewScreeningDecisions(db,repository,corpora,dedup,plans,()=>f.time);
    const titleArbitration=new api.ResearchReviewScreeningArbitration(db,repository,titleVotes,()=>f.time),titles=new api.ResearchReviewScreeningFreeze(db,repository,titleArbitration,()=>f.time);
    service=new api.ResearchDocumentService(repository,{},f.root);
    const bindings=new api.ResearchReviewFullTextRepository(db,repository,corpora,titles,service,()=>f.time);
    const votes=new api.ResearchReviewFullTextScreening(db,repository,titles,bindings,()=>f.time),arbitration=new api.ResearchReviewFullTextArbitration(db,repository,votes,bindings,()=>f.time);
    const freezing=new api.ResearchReviewFullTextFreeze(db,repository,arbitration,bindings,()=>f.time),before=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(freezing.getPhase(f.fullPhase),result);assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);
    assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await service?.shutdown();await reviews?.shutdown();db?.close();await f.cleanup();}
  const empty=await scene({complete:false,document:false,fetch:async()=>new Response('actual offline failure',{status:500})});
  try {
    const result=await empty.fullFreezing.freeze(empty.freezeInput(),actor);
    assert.equal(result.freeze.authority.counts.reportsToSeek,0);assert.deepEqual(result.freeze.authority.items,[]);
    assert.equal(empty.corpus.searchCoverageComplete,false);
  }finally{await empty.cleanup();}
});
