import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewFullTextScreeningFixture,fullTextActor as actor,fullTextInclude as include,
  fullTextExclude as exclude,fullTextUncertain as uncertain,fullTextOrigin as origin} from './fixtures/research-review-fulltext-screening.mjs';
import {reviewProtocolBodyFixture} from './fixtures/research-review-protocol.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
const scene=options=>createReviewFullTextScreeningFixture(api,options);
const fulltextRows=f=>f.db.prepare("SELECT count(*) FROM research_review_screening_decisions WHERE phase='full_text'").pluck().get();

test('title-frozen included hits have separate fulltext retrieval/pending/conflict/uncertain/final counts and exact source provenance',async()=>{
  const f=await scene();
  try {
    const title=f.freezing.getPhase(f.phase),library=f.db.prepare('SELECT * FROM research_library').all();
    const initial=f.fullScreening.getPhase(f.fullPhase);assert.equal(initial.counts.reportsToSeek,7);assert.equal(initial.counts.retrieval_pending,7);
    assert.deepEqual(initial.items.map(item=>item.hit.id),title.freeze.authority.items.filter(item=>item.status==='included').map(item=>item.hit.id));
    await f.bind(0);await f.bind(2);await f.bind(3);await f.bind(4);
    await f.fulltexts.save(f.notRetrieved(5,'not-obtained'),actor);
    const first=await f.fullScreening.save(f.vote(0,f.reviewerIds[0],'a0'),actor);
    assert.equal(f.fullScreening.getPhase(f.fullPhase).items[0].status,'pending');
    await f.fullScreening.save(f.vote(0,f.reviewerIds[1],'b0',exclude),actor);
    for(const reviewer of f.reviewerIds)await f.fullScreening.save(f.vote(2,reviewer,`include-${reviewer}`),actor);
    for(const reviewer of f.reviewerIds)await f.fullScreening.save(f.vote(3,reviewer,`exclude-${reviewer}`,exclude),actor);
    await f.fullScreening.save(f.vote(4,f.reviewerIds[0],'uncertain',uncertain),actor);
    await f.fullScreening.save(f.vote(4,f.reviewerIds[1],'other'),actor);
    const phase=f.fullScreening.getPhase(f.fullPhase);
    assert.deepEqual(phase.counts,{reportsToSeek:7,retrieval_pending:2,not_retrieved:1,source_changed:0,pending:0,uncertain:1,conflict:1,included:1,excluded:1});
    assert.deepEqual(first.snapshot.material,{hit:f.corpus.snapshot.hits[0],binding:{id:f.bound.get(0).snapshot.id,expectedHash:f.bound.get(0).snapshotHash}});
    assert.deepEqual(first.snapshot.reviewer,f.plan.snapshot.request.fullTextReviewers[0]);assert.deepEqual(first.snapshot.actor,actor);
    assert.equal(first.sourceCurrent,true);assert.deepEqual(f.freezing.getPhase(f.phase),title);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(),library);assert.equal(f.repository.evidence.list(f.project.id).length,0);
  }finally{await f.cleanup();}
});

test('different fulltext primary exclusion reasons remain conflict and single-reviewer phase follows its declared count',async()=>{
  const body=reviewProtocolBodyFixture();body.exclusionCriteria.push({id:'wrong-population',text:'Population outside the declared scope.'});
  const f=await scene({protocolBody:body});
  try {
    await f.bind();
    await f.fullScreening.save(f.vote(0,f.reviewerIds[0],'a',exclude),actor);
    await f.fullScreening.save(f.vote(0,f.reviewerIds[1],'b',{...exclude,exclusionCriterionId:'wrong-population'}),actor);
    assert.equal(f.fullScreening.getPhase(f.fullPhase).items[0].status,'conflict');
  }finally{await f.cleanup();}
  const single=await scene({screening:{titleAbstractReviewers:2,fullTextReviewers:1,conflictResolution:'human_adjudication'}});
  try {
    await single.bind(0,{...single.selection,parseId:null,parseHash:null});
    await single.fullScreening.save(single.vote(0,single.reviewerIds[0],'single'),actor);
    assert.equal(single.fullScreening.getPhase(single.fullPhase).items[0].status,'included');
    assert.equal(single.fullScreening.getPhase(single.fullPhase).items[0].binding.snapshot.source.parse,null);
  }finally{await single.cleanup();}
});

test('fulltext revisions require exact parent and retain old decisions and readonly replays without changing the source',async()=>{
  const f=await scene({screening:{titleAbstractReviewers:2,fullTextReviewers:1,conflictResolution:'human_adjudication'}});
  try {
    await f.bind();const first=await f.fullScreening.save(f.vote(0,f.reviewerIds[0],'first',uncertain),actor);
    const revision=f.vote(0,f.reviewerIds[0],'revision',exclude,{parentDecisionId:first.snapshot.id,expectedParentHash:first.snapshotHash,revisionReason:'Human re-examined the same original.'});
    const second=await f.fullScreening.save(revision,actor),before=f.changes();
    assert.equal(second.snapshot.version,2);assert.equal(f.fullScreening.getPhase(f.fullPhase).items[0].status,'excluded');
    assert.deepEqual(f.fullScreening.history({...f.get,decisionId:first.snapshot.id}),[{...first,isLatest:false},second]);
    assert.deepEqual(await f.fullScreening.save(first.snapshot.request,actor),{...first,isLatest:false});
    assert.deepEqual(await f.fullScreening.save(revision,actor),second);
    await assert.rejects(f.fullScreening.save({...revision,requestId:'stale'},actor),/research_review_screening_version_conflict/);
    await assert.rejects(f.fullScreening.save(revision,{kind:'user',id:'other'}),/research_review_request_conflict/);
    await assert.rejects(f.fullScreening.save({...revision,outcome:include},actor),/research_review_request_conflict/);
    assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('fulltext agent suggestions retain source/actual operation and never count as human votes or force an agreeing verdict',async()=>{
  const f=await scene();
  try {
    await f.bind();
    const proposal=await f.fullScreening.suggest({...f.target(0,'proposal'),outcome:include},origin);
    assert.deepEqual(proposal.snapshot.origin,origin);assert.equal(proposal.sourceCurrent,true);
    assert.equal(f.fullScreening.getPhase(f.fullPhase).items[0].suggestionCount,1);
    assert.equal(fulltextRows(f),0);assert.equal(f.fullScreening.getPhase(f.fullPhase).counts.included,0);
    const human=await f.fullScreening.save(f.vote(0,f.reviewerIds[0],'human',exclude,{
      consideredSuggestion:{id:proposal.snapshot.id,expectedHash:proposal.snapshotHash}}),actor);
    assert.deepEqual(human.snapshot.request.outcome,exclude);
    const before=f.changes();assert.deepEqual(await f.fullScreening.suggest(proposal.snapshot.request,{...origin,attemptId:'retry'}),proposal);
    await assert.rejects(f.fullScreening.suggest(proposal.snapshot.request,{...origin,capabilityVersion:'2'}),/research_review_request_conflict/);
    assert.deepEqual(f.fullScreening.listSuggestions({...f.fullPhase,hitId:proposal.snapshot.request.hitId,offset:0,limit:5}),[proposal]);
    assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('source reparse and human binding revision retain old votes/proposals but require all reviewers to examine the new exact source',async()=>{
  const f=await scene();
  try {
    const original=await f.bind();const proposal=await f.fullScreening.suggest({...f.target(0,'proposal'),outcome:include},origin);
    const votes=[];
    for(const reviewer of f.reviewerIds)votes.push(await f.fullScreening.save(f.vote(0,reviewer,`old-${reviewer}`),actor));
    f.reparse();assert.equal(f.fullScreening.getPhase(f.fullPhase).items[0].status,'source_changed');
    assert.deepEqual(f.fullScreening.history({...f.get,decisionId:votes[0].snapshot.id}),[{...votes[0],sourceCurrent:false}]);
    const next=await f.fulltexts.save({...f.retrieved(0,'new-source',{...f.selection,parseId:'fulltext-reparse'}),
      parentBindingId:original.snapshot.id,expectedParentHash:original.snapshotHash,revisionReason:'Human selects the newly parsed source.'},actor);
    f.bound.set(0,next);
    await assert.rejects(f.fullScreening.save(f.vote(0,f.reviewerIds[0],'old-proposal',include,{
      parentDecisionId:votes[0].snapshot.id,expectedParentHash:votes[0].snapshotHash,revisionReason:'New source examined.',
      consideredSuggestion:{id:proposal.snapshot.id,expectedHash:proposal.snapshotHash}}),actor),/research_review_screening_version_conflict/);
    const replacements=[];
    for(const [index,reviewer] of f.reviewerIds.entries()) {
      replacements.push(await f.fullScreening.save(f.vote(0,reviewer,`new-${reviewer}`,include,{
        parentDecisionId:votes[index].snapshot.id,expectedParentHash:votes[index].snapshotHash,revisionReason:'Human examined the new fixed source.'}),actor));
      if(index===0)assert.equal(f.fullScreening.getPhase(f.fullPhase).items[0].status,'source_changed');
    }
    assert.equal(f.fullScreening.getPhase(f.fullPhase).items[0].status,'included');
    assert.deepEqual(f.fullScreening.history({...f.get,decisionId:votes[0].snapshot.id}),[{...votes[0],isLatest:false,sourceCurrent:false},replacements[0]]);
    assert.deepEqual(f.fullScreening.listSuggestions({...f.fullPhase,hitId:proposal.snapshot.request.hitId,offset:0,limit:5}),[{...proposal,sourceCurrent:false}]);
  }finally{await f.cleanup();}
});

test('unretrieved/excluded/foreign sources and wrong plan/title/binding/reviewer/criterion/strict inputs create no fulltext vote',async()=>{
  const f=await scene();
  try {
    await f.bind();const gap=await f.fulltexts.save(f.notRetrieved(2,'gap'),actor);
    const other=f.repository.createProject({title:'Other review',description:'Synthetic',workspacePath:'/tmp/fulltext-other-review'});
    const valid=f.vote(0,f.reviewerIds[0],'valid'),before=f.changes();
    for(const [request,error] of [
      [{...valid,projectId:other.id},/research_review_project_mismatch/],
      [{...valid,expectedPlanHash:'a'.repeat(64)},/research_review_screening_version_conflict/],
      [{...valid,expectedTitleFreezeHash:'a'.repeat(64)},/research_review_screening_version_conflict/],
      [{...valid,expectedBindingHash:'a'.repeat(64)},/research_review_fulltext_version_conflict/],
      [{...valid,hitId:f.corpus.snapshot.hits[1].id},/research_review_fulltext_version_conflict/],
      [{...valid,reviewerId:'undeclared'},/research_review_screening_reviewer_not_declared/],
      [{...valid,outcome:{...exclude,exclusionCriterionId:'guessed'}},/research_review_screening_criterion_not_declared/],
      [{...valid,...f.target(2,'unretrieved',gap)},/research_review_fulltext_not_retrieved/]
    ])await assert.rejects(f.fullScreening.save(request,actor),error);
    for(const request of [{...valid,actor},{...valid,phase:'title_abstract'},{...valid,expectedParentHash:'a'.repeat(64)},
      {...valid,bindingId:undefined}])await assert.rejects(f.fullScreening.save(request,actor));
    const titleVote=f.db.prepare("SELECT id FROM research_review_screening_decisions WHERE phase='title_abstract' LIMIT 1").get();
    assert.throws(()=>f.fullScreening.history({...f.get,decisionId:titleVote.id}),/research_review_screening_decision_not_found/);
    await assert.rejects(f.fullScreening.save({...valid,requestId:'title-0-declared-researcher-a'},actor),/research_review_request_conflict/);
    assert.equal(fulltextRows(f),0);assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('actual original-byte corruption and source revision during asynchronous verification refuse both human and agent scientific writes',async()=>{
  const f=await scene();
  try {
    await f.bind();const before=f.changes();
    await writeFile(f.sourcePath,Buffer.from('original file changed'));
    await assert.rejects(f.fullScreening.save(f.vote(0,f.reviewerIds[0],'human'),actor),/research_document_source_changed/);
    await assert.rejects(f.fullScreening.suggest({...f.target(0,'proposal'),outcome:include},origin),/research_document_source_changed/);
    assert.equal(f.changes(),before);await writeFile(f.sourcePath,f.original);
    const preview=f.service.preview.bind(f.service);
    f.service.preview=async request=>{const read=await preview(request);f.reparse();return read;};
    await assert.rejects(f.fullScreening.save(f.vote(0,f.reviewerIds[0],'during-reparse'),actor),/research_review_fulltext_version_conflict/);
    assert.equal(fulltextRows(f),0);
  }finally{await f.cleanup();}
});

test('postinsert current source drift, corrupted reviewer row and deleted suggestion roll back instead of acknowledging stale records',async()=>{
  const f=await scene();
  try {
    await f.bind();
    f.db.exec("CREATE TRIGGER fulltext_source_drift AFTER INSERT ON research_review_screening_decisions WHEN NEW.phase='full_text' BEGIN UPDATE research_documents SET current_parse_id=NULL; END;");
    await assert.rejects(f.fullScreening.save(f.vote(0,f.reviewerIds[0],'drift'),actor),/research_review_fulltext_version_conflict/);
    assert.equal(fulltextRows(f),0);assert.equal(f.repository.documents.get(f.document.id).currentParseId,f.selection.parseId);
    f.db.exec('DROP TRIGGER fulltext_source_drift');
    const first=await f.fullScreening.save(f.vote(0,f.reviewerIds[0],'first'),actor);
    const next=f.vote(0,f.reviewerIds[0],'next',exclude,{parentDecisionId:first.snapshot.id,expectedParentHash:first.snapshotHash,revisionReason:'Human revisited source.'});
    f.db.exec("CREATE TRIGGER corrupt_fulltext AFTER INSERT ON research_review_screening_decisions WHEN NEW.phase='full_text' BEGIN UPDATE research_review_screening_decisions SET snapshot_hash='changed' WHERE id=NEW.id; END;");
    await assert.rejects(f.fullScreening.save(next,actor),/research_review_screening_snapshot_invalid/);
    assert.equal(fulltextRows(f),1);
    f.db.exec('DROP TRIGGER corrupt_fulltext');
    f.db.exec("CREATE TRIGGER lose_fulltext_proposal AFTER INSERT ON research_review_screening_suggestions WHEN NEW.phase='full_text' BEGIN DELETE FROM research_review_screening_suggestions WHERE id=NEW.id; END;");
    await assert.rejects(f.fullScreening.suggest({...f.target(0,'lost-proposal'),outcome:include},origin),/research_review_screening_snapshot_invalid/);
    assert.equal(f.db.prepare("SELECT count(*) FROM research_review_screening_suggestions WHERE phase='full_text'").pluck().get(),0);
  }finally{await f.cleanup();}
});

test('sealed material, ancestor and proposal corruption surface read failures while title freeze and source history remain fixed',async()=>{
  const f=await scene();
  try {
    await f.bind();const first=await f.fullScreening.save(f.vote(0,f.reviewerIds[0],'first'),actor);
    await f.fullScreening.save(f.vote(0,f.reviewerIds[0],'revision',uncertain,{
      parentDecisionId:first.snapshot.id,expectedParentHash:first.snapshotHash,revisionReason:'Human cannot determine.'}),actor);
    const row=f.db.prepare('SELECT * FROM research_review_screening_decisions WHERE id=?').get(first.snapshot.id);
    const changed=JSON.parse(row.snapshot_json);changed.material.hit.recordHash='a'.repeat(64);const json=JSON.stringify(changed);
    f.db.prepare('UPDATE research_review_screening_decisions SET snapshot_json=?,snapshot_hash=? WHERE id=?').run(json,hash(json),first.snapshot.id);
    assert.throws(()=>f.fullScreening.getPhase(f.fullPhase),/research_review_screening_snapshot_invalid/);
    f.db.prepare('UPDATE research_review_screening_decisions SET snapshot_json=?,snapshot_hash=? WHERE id=?').run(row.snapshot_json,row.snapshot_hash,first.snapshot.id);
    const proposal=await f.fullScreening.suggest({...f.target(0,'proposal'),outcome:include},origin);
    f.db.prepare('UPDATE research_review_screening_suggestions SET snapshot_hash=? WHERE id=?').run('changed',proposal.snapshot.id);
    const before=f.changes();assert.throws(()=>f.fullScreening.getPhase(f.fullPhase),/research_review_screening_snapshot_invalid/);
    assert.equal(f.changes(),before);assert.equal(f.freezing.getPhase(f.phase).counts.included,7);
  }finally{await f.cleanup();}
});

test('historical protocol and archived project retain source-bound fulltext history but cannot authorize new decisions',async()=>{
  const f=await scene();
  try {
    await f.bind();const vote=await f.fullScreening.save(f.vote(0,f.reviewerIds[0],'first'),actor),phase=f.fullScreening.getPhase(f.fullPhase);
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'later',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later protocol.'},actor);
    const historical=f.fullScreening.getPhase(f.fullPhase);
    assert.deepEqual(historical,{...phase,plan:{...phase.plan,currentProtocol:false},
      items:phase.items.map(item=>({...item,binding:item.binding===null?null:{...item.binding,currentProtocol:false}}))});
    const before=f.changes();assert.deepEqual(f.fullScreening.history({...f.get,decisionId:vote.snapshot.id}),[vote]);
    await assert.rejects(f.fullScreening.save(f.vote(0,f.reviewerIds[1],'later'),actor),/research_review_screening_version_conflict/);
    await assert.rejects(f.fullScreening.suggest({...f.target(0,'later-proposal'),outcome:include},origin),/research_review_screening_version_conflict/);
    assert.equal(f.changes(),before);f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.deepEqual(f.fullScreening.getPhase(f.fullPhase),historical);
    await assert.rejects(f.fullScreening.save(f.vote(0,f.reviewerIds[1],'archive'),actor),/research_project_archived/);
  }finally{await f.cleanup();}
});

test('actual main window binds human save across file awaits and actual capability operation supplies independent suggestion provenance',async()=>{
  const f=await scene();
  try {
    await f.bind();const registry=new api.CapabilityRegistry(),receipts=[];
    for(const descriptor of api.researchReviewFullTextScreeningCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewFullTextScreeningCapabilities({pluginId:'research',capabilities:registry},f.fullScreening,f.fullArbitration,f.fullFreezing);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)});
    const suggestionInput={...f.target(0,'proposal'),outcome:include},voteInput=f.vote(0,f.reviewerIds[0],'human',uncertain),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewFullTextScreening.save',voteInput),error=>error.code==='research_human_required');
    await assert.rejects(registry.invoke('research.reviewFullTextScreening.suggest',suggestionInput),error=>error.code==='research_review_screening_tool_context_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-fulltext-decision-save',[{...voteInput,actor}]));
    const missing=await bridge.invoke('research.saveReviewFullTextDecision',[voteInput]);assert.equal(missing.ok,false);
    assert.equal(missing.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const operation=api.createCapabilityOperationContext({...origin,toolName:'fulltext-proposal',leaseGeneration:1,recordReceipt:value=>receipts.push(value)});
    const suggestion=await api.runWithCapabilityOperationContext(operation,()=>registry.invoke('research.reviewFullTextScreening.suggest',suggestionInput));
    assert.deepEqual(suggestion.snapshot.origin,origin);assert.equal(receipts[0].capabilityName,'research.reviewFullTextScreening.suggest');
    const saved=await bridge.invoke('research.saveReviewFullTextDecision',[voteInput],121);
    assert.equal(saved.ok,true,JSON.stringify(saved));assert.deepEqual(saved.data.snapshot.actor,{kind:'user',id:'window:121'});
    const readonly=f.changes(),phase=await bridge.invoke('research.getReviewFullTextScreeningPhase',[f.fullPhase],121);
    const history=await bridge.invoke('research.getReviewFullTextDecisionHistory',[{...f.get,decisionId:saved.data.snapshot.id}],121);
    const proposals=await bridge.invoke('research.listReviewFullTextSuggestions',[{...f.fullPhase,hitId:suggestionInput.hitId,offset:0,limit:5}],121);
    assert.equal(phase.ok,true,JSON.stringify(phase));assert.equal(history.ok,true);assert.equal(proposals.ok,true);
    assert.deepEqual(history.data,[saved.data]);assert.deepEqual(proposals.data,[suggestion]);assert.equal(f.changes(),readonly);
  }finally{await f.cleanup();}
});

test('DB35 existing title/source rows stay exact and SQLite reopening preserves fulltext decisions without new import, retrieval or proposal',async()=>{
  const f=await scene(),directory=await mkdtemp(join(tmpdir(),'roc-fulltext-screening-reopen-'));
  let db,reviews,service;
  try {
    await f.bind();const tables=['research_review_screening_plans','research_review_screening_freezes','research_review_fulltext_bindings','research_documents'];
    const previous=tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all());
    const vote=await f.fullScreening.save(f.vote(0,f.reviewerIds[0],'human'),actor);
    const proposal=await f.fullScreening.suggest({...f.target(0,'proposal'),outcome:uncertain},origin);
    tables.forEach((table,index)=>assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(),previous[index]));
    const phase=f.fullScreening.getPhase(f.fullPhase),path=join(directory,'research.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>{},()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time),dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const plans=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time),decisions=new api.ResearchReviewScreeningDecisions(db,repository,corpora,dedup,plans,()=>f.time);
    const arbitration=new api.ResearchReviewScreeningArbitration(db,repository,decisions,()=>f.time),titles=new api.ResearchReviewScreeningFreeze(db,repository,arbitration,()=>f.time);
    service=new api.ResearchDocumentService(repository,{},f.root);
    const bindings=new api.ResearchReviewFullTextRepository(db,repository,corpora,titles,service,()=>f.time);
    const fullScreening=new api.ResearchReviewFullTextScreening(db,repository,titles,bindings,()=>f.time),before=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(fullScreening.getPhase(f.fullPhase),phase);assert.deepEqual(fullScreening.history({...f.get,decisionId:vote.snapshot.id}),[vote]);
    assert.deepEqual(fullScreening.listSuggestions({...f.fullPhase,hitId:proposal.snapshot.request.hitId,offset:0,limit:5}),[proposal]);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await service?.shutdown();await reviews?.shutdown();db?.close();await f.cleanup();await rm(directory,{recursive:true,force:true});}
});
