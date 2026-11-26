import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture, hash} from './fixtures/scientific-search-fixture.mjs';
import {unknownExperiment, withResearchTestWorker, createResearchTestRoleTools} from './fixtures/research-test-kit.mjs';
import {scientificWikiCandidates} from './fixtures/scientific-wiki-fixture.mjs';
let api, writing, query, relations, extraction;
before(async () => {
  const loaded = await Promise.allSettled([loadScientificSearchApi(), ...[
    'writing-context-service', 'scientific-query-orchestrator', 'evidence-relation-repository', 'scientific-extraction-service'
  ].map(name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {
    platform: 'node', tempDir: '.runtime/tmp', external:['@napi-rs/canvas']
  }))]);
  if (loaded[0].status === 'fulfilled') api = loaded[0].value;
  const failed = loaded.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  [api, writing, query, relations, extraction] = loaded.map(result => result.value);
});

test('current extracted facts stay unreviewed until existing human support gates and report later knowledge replacement', async () => {
  const f = await fixture();
  const extracted = new extraction.ScientificExtractionService(f.repository, {library:f.root,index:null}, async () => ({
    config:{extractorVersion:'roc-scientific-knowledge/1',promptVersion:'fixture/1',
      model:{provider:'fixture',modelId:'fixture',model:'fixture',revision:'1'},inputTokens:16000,batchTokens:8000},
    invoke:async () => {throw new Error('no model needed for source publication fixture');}
  }), () => 'fixture-model/1', {pollMs:60000});
  try {
    const job = await extracted.enqueue({projectId:f.project.id,documentId:f.document.id});
    f.repository.scientificExtraction.claim(job.id,f.project.id);
    const candidates = scientificWikiCandidates(f.ir);
    candidates.facts.push({...structuredClone(candidates.facts[1]),id:'limitation',factType:'limitation',
      predicate:'Original baseline is the only validated condition'});
    f.repository.scientificExtraction.publish(job.id,f.project.id,candidates,f.ir,()=>job.snapshot);
    f.dependencies.readKnowledge = extracted.read.bind(extracted);
    const initial = await f.service.prepare(f.request);
    assert.ok(initial.relevantFacts.some(fact => fact.includes('Reported F1')));
    assert.ok(initial.counterEvidence.some(fact => fact.includes('only validated')));
    assert.equal(initial.status,'incomplete');
    assert.ok(initial.knowledgeGaps.some(gap => gap.startsWith('facts_unreviewed:')));
    const tableEvidence = initial.originalEvidenceIds.map(id => f.repository.evidence.getEvidence(id,f.project.id))
      .find(evidence => evidence.excerpt === 'Original baseline 90 91');
    const claim = f.repository.evidence.createClaim({projectId:f.project.id,artifactId:f.artifact.id,subjectType:'paragraph',
      content:'Original baseline reports 90 and 91; this applies only to the reported conditions.',status:'supported',
      evidenceIds:[tableEvidence.id],experiment:{...unknownExperiment}});
    const source = f.repository.evidence.inspectEvidence(tableEvidence.id,f.project.id);
    const proposal = f.repository.evidence.relations.propose({projectId:f.project.id,claimId:claim.id,expectedClaimVersion:claim.version,
      evidenceId:tableEvidence.id,expectedSourceDigest:relations.relationSourceDigest(source),kind:'supports',condition:null,
      supersedesRelationId:null},{kind:'user',id:'fixture-human'});
    f.repository.evidence.relations.review({projectId:f.project.id,relationId:proposal.id,expectedVersion:proposal.version,
      expectedClaimVersion:claim.version,expectedSourceDigest:proposal.sourceDigest,decision:'confirm',note:'Fixture human scientific review'},
      {kind:'user',id:'fixture-human'});
    f.repository.manuscripts.saveManuscript({artifactId:f.artifact.id,sections:[{title:'Related Work',claimIds:[claim.id]}]});
    const reviewed = await f.service.prepare(f.request);
    assert.deepEqual(reviewed.supportingClaims,[claim.id]);
    assert.ok(!reviewed.knowledgeGaps.some(gap => gap.startsWith('facts_unreviewed:')));
    assert.equal(reviewed.status,'ready',JSON.stringify(reviewed.knowledgeGaps));
    assert.equal((await f.service.checkGrounding(f.readRequest(reviewed))).status,'ready');
    // Publication replacement keeps the original PDF unchanged but invalidates this receipt's fact basis.
    const replacement = f.repository.scientificExtraction.enqueue(job.snapshot,f.ir,true);
    f.repository.scientificExtraction.claim(replacement.id,f.project.id);
    f.repository.scientificExtraction.publish(replacement.id,f.project.id,candidates,f.ir,()=>job.snapshot);
    const impacts = await f.service.reviewImpact(f.readRequest(reviewed));
    assert.ok(impacts.impacts.some(impact => impact.kind === 'source' && impact.id === f.document.id && impact.claimIds.includes(claim.id)));
  } finally {await extracted.shutdown();await f.close();}
});
after(() => api?.dispose());
async function fixture() {
  const f = await scientificSearchFixture(api, {embedded: false});
  f.db.prepare("UPDATE research_projects SET current_stage='writing' WHERE id=?").run(f.project.id);
  f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='writing'").run(f.project.id);
  const artifact = f.repository.createArtifact({projectId:f.project.id, stage:'writing', kind:'manuscript', title:'Fixture manuscript', path:null});
  const orchestrator = new query.ScientificQueryOrchestrator(f.router, f.embeddings);
  const dependencies = {query: orchestrator.search.bind(orchestrator), assertCurrent: f.router.assertCurrent.bind(f.router),
    configIdentity: () => ({retrieval:'fixture', knowledge:'fixture'})};
  const service = new writing.WritingContextService(f.repository, dependencies, f.db);
  const request = {projectId:f.project.id, artifactId:artifact.id, sectionTitle:'Related Work',
    sectionGoal:'Original method Dataset C F1 Table 3', documentIds:[f.document.id]};
  const readRequest = result => ({projectId:f.project.id, artifactId:artifact.id, contextId:result.contextId});
  return {...f, artifact, dependencies, service, request, readRequest};
}

test('preparation captures original parsed chunks and persists a restart-readable unreviewed receipt', async () => {
  const f = await fixture();
  try {
    const artifactBefore = f.repository.getArtifact(f.artifact.id);
    const result = await f.service.prepare(f.request);
    assert.equal(result.status, 'incomplete');
    assert.ok(result.sourcePapers.length);
    assert.ok(result.originalEvidenceIds.length);
    assert.ok(!result.knowledgeGaps.some(gap => gap.startsWith('evidence_unbound:')));
    assert.deepEqual(result.supportingClaims, []);
    assert.ok(result.knowledgeGaps.some(gap => gap.startsWith('claims_unreviewed:')));
    assert.equal(f.repository.evidence.listClaims({projectId:f.project.id}).length, 0);
    assert.equal(f.repository.manuscripts.getManuscript(f.artifact.id), null);
    assert.deepEqual(f.repository.getArtifact(f.artifact.id), artifactBefore);
    for (const id of result.originalEvidenceIds) {
      const {evidence, sourceLocator} = f.repository.evidence.inspectEvidence(id, f.project.id);
      assert.equal(sourceLocator.parseId, f.ir.identity.parseId);
      assert.ok(f.db.prepare('SELECT id FROM research_knowledge_chunks WHERE id=?').get(evidence.chunkId));
      assert.ok(result.sourcePapers.some(ref => ref.locator.blockId === sourceLocator.blockId));
      assert.equal(evidence.excerpt, f.data.content.blocks.find(block => block.id === sourceLocator.blockId).text);
    }
    const caption = result.originalEvidenceIds.map(id => f.repository.evidence.inspectEvidence(id,f.project.id))
      .find(item => item.sourceLocator.blockId === 'figure-caption');
    assert.ok(caption,'caption following a textless figure retains the original indexed position');
    const annotation = f.repository.documentAnnotations.create({requestId:'caption-after-figure',issue:'note',note:'Verify caption.',
      target:{projectId:f.project.id,documentId:f.document.id,parseId:f.ir.identity.parseId,sourceHash:f.document.sourceHash,
        parseHash:hash(JSON.stringify(f.data.content)),parserFingerprint:f.data.content.parserFingerprint,
        page:1,blockId:'figure-caption',coordinateBasis:null,location:{kind:'page'}}},{kind:'user',id:'fixture-human'});
    const captured = f.repository.documentAnnotations.capture({projectId:f.project.id,annotationId:annotation.annotation.id,
      requestId:'capture-caption-after-figure',expectedAnnotationHash:annotation.annotationHash},{kind:'user',id:'fixture-human'});
    assert.equal(captured.capture.source.evidence.id,caption.evidence.id);
    const previous = caption.sourceLocator;
    const republished = await f.publish();
    const [migration] = f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:caption.evidence.id});
    assert.ok(migration.proposal.targets.some(target => target.block.id === 'figure-caption'));
    assert.equal(f.repository.evidence.inspectEvidence(caption.evidence.id,f.project.id).sourceLocator.parseId,previous.parseId);
    assert.notEqual(republished.ir.identity.parseId,previous.parseId);
    // Use the new source generation for the restart/current-read assertion below.
    const currentResult = await f.service.prepare(f.request);
    const restarted = new writing.WritingContextService(f.repository, f.dependencies, f.db);
    const impact = await restarted.reviewImpact(f.readRequest(currentResult));
    assert.equal(impact.status, 'current');
    assert.equal(impact.requiresHumanRevision, false);
    const check = await restarted.checkGrounding(f.readRequest(result));
    assert.equal(check.status, 'incomplete');
    assert.ok(check.issues.some(issue => issue.code === 'manuscript_missing'));
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.close();}
});

test('source, configuration, membership and artifact changes during retrieval publish no evidence or context', async () => {
  for (const mode of ['source', 'config', 'membership', 'artifact', 'abort']) {
    const f = await fixture();
    try {
      const original = f.dependencies.query, abort = new AbortController();
      let calls = 0;
      f.dependencies.query = async (...args) => {
        const result = await original(...args);
        if (++calls === 2) {
          if (mode === 'source') await writeFile(f.source, Buffer.from('changed source bytes'));
          if (mode === 'config') f.dependencies.configIdentity = () => ({retrieval:'changed', knowledge:'fixture'});
          if (mode === 'membership') f.db.prepare('DELETE FROM research_library_projects WHERE project_id=?').run(f.project.id);
          if (mode === 'artifact') f.db.prepare("UPDATE research_artifacts SET title='Changed' WHERE id=?").run(f.artifact.id);
          if (mode === 'abort') abort.abort(new Error('fixture_abort'));
        }
        return result;
      };
      await assert.rejects(f.service.prepare(f.request, abort.signal), /changed|scope_invalid|fixture_abort/, mode);
      assert.equal(f.repository.evidence.list(f.project.id).length, 0, mode);
      assert.equal(f.repository.listProvenance({projectId:f.project.id}).length, 0, mode);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM research_workflow_events WHERE type='writing_context_prepared'").get().n, 0, mode);
    } finally {await f.close();}
  }
});

function savedClaim(f) {
  const row = f.db.prepare("SELECT id FROM research_knowledge_chunks WHERE document_id=? AND content='Original baseline 90 91'")
    .get(f.ir.identity.knowledgeDocumentId);
  const evidence = f.repository.evidence.capture({projectId:f.project.id, chunkId:row.id});
  const claim = f.repository.evidence.createClaim({projectId:f.project.id, artifactId:f.artifact.id,
    subjectType:'paragraph', content:'Our method improves to 99 and 91 ms; therefore proves universal performance.',
    status:'supported', evidenceIds:[evidence.id], experiment:{...unknownExperiment}});
  f.repository.manuscripts.saveManuscript({artifactId:f.artifact.id, sections:[{title:'Results',claimIds:[claim.id]}]});
  const source = f.repository.evidence.inspectEvidence(evidence.id, f.project.id);
  f.repository.evidence.relations.propose({projectId:f.project.id, claimId:claim.id, expectedClaimVersion:claim.version,
    evidenceId:evidence.id, expectedSourceDigest:relations.relationSourceDigest(source), kind:'contradicts',
    condition:null, supersedesRelationId:null}, {kind:'user', id:'fixture-human'});
  return {claim, evidence};
}

test('grounding reads persisted paragraphs and locates numeric units conditions inferences and counterevidence gaps', async () => {
  const f = await fixture();
  try {
    const {claim, evidence} = savedClaim(f);
    const result = await f.service.prepare(f.request);
    const check = await f.service.checkGrounding(f.readRequest(result));
    assert.equal(check.status, 'incomplete');
    assert.deepEqual(check.checkedClaimIds, [claim.id]);
    for (const code of ['numeric_mismatch','unit_mismatch','conditions_missing','inference_as_fact','counterevidence_missing','human_review_required']) {
      const issue = check.issues.find(issue => issue.code === code && issue.claimId === claim.id);
      assert.ok(issue, code); assert.equal(issue.sectionIndex, 0); assert.equal(issue.sectionTitle, 'Results');
      assert.equal(issue.paragraphIndex, 0);
    }
    const numeric = check.issues.find(issue => issue.code === 'numeric_mismatch' && issue.span);
    assert.equal(claim.content.slice(numeric.span.start,numeric.span.end), '99');
    const unit = check.issues.find(issue => issue.code === 'unit_mismatch' && issue.span);
    assert.equal(claim.content.slice(unit.span.start,unit.span.end), '91 ms');
    assert.ok(check.issues.some(issue => issue.code === 'counterevidence_missing' && issue.evidenceId === evidence.id));
    assert.throws(() => f.repository.evidence.assertReviewedSupport(claim), /人工支持确认/);
  } finally {await f.close();}
});

test('impact inspection follows changed source to evidence claim and saved body without rewriting any row', async () => {
  const f = await fixture();
  try {
    const {claim} = savedClaim(f);
    const result = await f.service.prepare(f.request);
    await writeFile(f.source, Buffer.from('external source changed'));
    const before = f.db.prepare('SELECT total_changes() AS n').get().n;
    const impact = await f.service.reviewImpact(f.readRequest(result));
    assert.equal(impact.status, 'changed'); assert.equal(impact.requiresHumanRevision, true);
    const source = impact.impacts.find(item => item.kind === 'source');
    assert.equal(source.id, f.document.id); assert.deepEqual(source.claimIds, [claim.id]);
    assert.deepEqual(source.sectionIndexes, [0]);
    const check = await f.service.checkGrounding(f.readRequest(result));
    assert.ok(check.issues.some(issue => issue.code === 'source_stale' && issue.claimId === claim.id && issue.sectionIndex === 0));
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, before);
  } finally {await f.close();}
});

test('durable receipts reject tampering and revoked membership after preparation', async () => {
  const f = await fixture();
  try {
    const result = await f.service.prepare(f.request), request = f.readRequest(result);
    f.db.prepare('DELETE FROM research_library_projects WHERE project_id=?').run(f.project.id);
    await assert.rejects(f.service.checkGrounding(request), /scope_invalid/);
    f.db.prepare('INSERT INTO research_library_projects (item_id,project_id) VALUES (?,?)')
      .run(f.document.libraryItemId, f.project.id);
    const row = f.db.prepare('SELECT id,excerpt FROM research_provenance WHERE locator=?').get(result.contextId);
    const receipt = JSON.parse(row.excerpt); receipt.result.knowledgeGaps = [];
    f.db.prepare('UPDATE research_provenance SET excerpt=? WHERE id=?').run(JSON.stringify(receipt), row.id);
    await assert.rejects(f.service.reviewImpact(request), /receipt_invalid/);
  } finally {await f.close();}
});

test('receipt persistence failure rolls back captured Evidence and workflow events in the same transaction', async () => {
  const f = await fixture();
  try {
    const original = f.repository.addProvenance.bind(f.repository);
    f.repository.addProvenance = () => {throw new Error('fixture_receipt_failure');};
    await assert.rejects(f.service.prepare(f.request), /fixture_receipt_failure/);
    assert.equal(f.repository.evidence.list(f.project.id).length,0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM research_workflow_events WHERE type='writing_context_prepared'").get().n,0);
    f.repository.addProvenance = original;
    assert.ok((await f.service.prepare(f.request)).originalEvidenceIds.length);
  } finally {await f.close();}
});

test('approved upstream material anchors first writing and later manuscript checks without editing the input', async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE research_artifacts SET stage='reading',kind='reading_notes',status='approved' WHERE id=?").run(f.artifact.id);
    f.db.prepare("UPDATE research_stage_states SET artifact_ids_json=? WHERE project_id=? AND stage='reading'")
      .run(JSON.stringify([f.artifact.id]),f.project.id);
    f.db.prepare("UPDATE research_stage_states SET artifact_ids_json='[]' WHERE project_id=? AND stage='writing'").run(f.project.id);
    const upstream = f.repository.getArtifact(f.artifact.id);
    const context = await f.service.prepare(f.request);
    assert.equal(context.artifactId,upstream.id);
    assert.deepEqual(f.repository.getArtifact(upstream.id),upstream);
    assert.equal(f.repository.evidence.listClaims({projectId:f.project.id}).length,0);
    f.artifact = f.repository.createArtifact({projectId:f.project.id,stage:'writing',kind:'manuscript',title:'First saved draft',path:null});
    const {claim} = savedClaim(f);
    const request = {projectId:f.project.id,artifactId:f.artifact.id,contextId:context.contextId};
    const checked = await f.service.checkGrounding(request);
    assert.equal(checked.artifactId,f.artifact.id);
    assert.deepEqual(checked.checkedClaimIds,[claim.id]);
    assert.ok(!checked.issues.some(issue=>issue.code==='context_changed'));
    f.db.prepare("UPDATE research_projects SET description='Different research goal' WHERE id=?").run(f.project.id);
    assert.ok((await f.service.checkGrounding(request)).issues.some(issue=>issue.code==='context_changed'&&issue.message.includes('研究目标')));
    f.db.prepare("UPDATE research_artifacts SET title='Changed upstream input' WHERE id=?").run(upstream.id);
    assert.ok((await f.service.checkGrounding(request)).issues.some(issue=>issue.code==='context_changed'&&issue.message.includes('锚点')));
    const foreign = f.repository.createProject({title:'Other project',description:'',workspacePath:'/tmp/other-writing-project'});
    await assert.rejects(f.service.prepare({...f.request,projectId:foreign.id}),/project_mismatch/);
    await assert.rejects(f.service.checkGrounding({...request,projectId:foreign.id}),/project_mismatch/);
    f.db.prepare("UPDATE research_stage_states SET artifact_ids_json='[]' WHERE project_id=? AND stage='reading'").run(f.project.id);
    await assert.rejects(f.service.checkGrounding(request),/anchor_stale/);
    await assert.rejects(f.service.prepare(f.request),/anchor_stale/);
  } finally {await f.close();}
});

test('receipt cannot be relinked to another artifact even when its event and digest remain valid', async () => {
  const f = await fixture();
  try {
    const context = await f.service.prepare(f.request);
    const other = f.repository.createArtifact({projectId:f.project.id,stage:'writing',kind:'manuscript',title:'Other',path:null});
    f.db.prepare('UPDATE research_provenance SET artifact_id=?,subject_id=? WHERE locator=?').run(other.id,other.id,context.contextId);
    await assert.rejects(f.service.checkGrounding(f.readRequest(context)),/receipt_invalid/);
  } finally {await f.close();}
});

test('real role preparation preserves approved input identity and can complete while ordinary provenance remains fenced', async () => {
  const f = await scientificSearchFixture(api,{embedded:false});
  const plain = {title:'Reading input',markdown:'Original material.',claims:[],sections:[],verdict:'uncertain'};
  try {
    const completed = withResearchTestWorker(api,f.repository,f.run.id,f.project.id,id=>f.repository.runs.complete(id,f.project.id,plain));
    const artifactId = completed.outputArtifactIds[0];
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(artifactId);
    f.db.prepare("UPDATE research_projects SET current_stage='writing' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='writing'").run(f.project.id);
    const queued = f.repository.runs.begin({projectId:f.project.id,expectedStage:'writing',instruction:'Prepare first draft',requestId:'first-draft'});
    const run = withResearchTestWorker(api,f.repository,queued.id,f.project.id,id=>f.repository.runs.markRunning(id,f.project.id,{providerId:'fixture',modelId:'fixture'}));
    const orchestrator = new query.ScientificQueryOrchestrator(f.router,f.embeddings);
    const service = new writing.WritingContextService(f.repository,{query:orchestrator.search.bind(orchestrator),assertCurrent:f.router.assertCurrent.bind(f.router)},f.db);
    let calls=0;
    const tools = createResearchTestRoleTools(api,{run,context:f.repository.runs.getContext(run.id),repository:f.repository,
      capabilities:{invoke:async(name,request,signal)=>{calls++;assert.equal(name,'research.writing.prepareContext');
        assert.equal(request.projectId,f.project.id);return service.prepare(request,signal);}},signal:new AbortController().signal});
    const prepare = tools.find(tool=>tool.name==='prepare_writing_context');
    const request={artifactId,sectionTitle:'Related Work',sectionGoal:'Dataset C F1 results',documentIds:[]};
    await assert.rejects(prepare.invoke({...request,artifactId:'not-an-input'}),/not_in_run_inputs/);
    assert.equal(calls,0);
    await assert.rejects(tools.find(tool=>tool.name==='check_draft_grounding').invoke({artifactId,contextId:'context'}),/manuscript_artifact_required/);
    const context = await prepare.invoke(request);
    assert.equal(context.artifactId,artifactId);
    assert.ok(context.sourcePapers.some(source=>source.documentId===f.document.id));
    assert.equal((await prepare.invoke(request)).contextId,context.contextId);
    assert.equal(calls,1,'valid replay reuses the effect result');
    f.db.prepare('DELETE FROM research_library_projects WHERE project_id=?').run(f.project.id);
    await assert.rejects(prepare.invoke(request),/scope_invalid/,'replay checks returned sources even with no documentIds filter');
    assert.equal(calls,1,'revoked replay never invokes preparation again');
    f.db.prepare('INSERT INTO research_library_projects (item_id,project_id) VALUES (?,?)').run(f.document.libraryItemId,f.project.id);
    assert.ok((await tools.find(tool=>tool.name==='read_artifact').invoke({artifactId,offset:0,limit:100})).content);
    const row = f.db.prepare('SELECT * FROM research_provenance WHERE locator=?').get(context.contextId);
    // A lookalike with a prefix, real event and the wrong anchor is ordinary provenance, not a valid derived receipt.
    const receipt=JSON.parse(row.excerpt);receipt.request.artifactId='wrong-anchor';
    f.db.prepare('UPDATE research_provenance SET excerpt=? WHERE id=?').run(JSON.stringify(receipt),row.id);
    await assert.rejects(tools.find(tool=>tool.name==='read_artifact').invoke({artifactId,offset:0,limit:100}),/inputs_stale/);
    f.db.prepare('UPDATE research_provenance SET excerpt=? WHERE id=?').run(row.excerpt,row.id);
    f.db.prepare(`INSERT INTO research_provenance
      (id,project_id,artifact_id,subject_type,subject_id,source_type,source_id,locator,excerpt,created_at)
      VALUES ('ordinary',?,?,'artifact',?,'workflow_event',?,'writing-context:ordinary','unrelated material',?)`)
      .run(f.project.id,artifactId,artifactId,row.source_id,row.created_at);
    await assert.rejects(tools.find(tool=>tool.name==='read_artifact').invoke({artifactId,offset:0,limit:100}),/inputs_stale/);
    f.db.prepare("DELETE FROM research_provenance WHERE id='ordinary'").run();
    const evidenceId=context.originalEvidenceIds[0], excerpt=f.repository.evidence.getEvidence(evidenceId,f.project.id).excerpt;
    const finished = withResearchTestWorker(api,f.repository,run.id,f.project.id,id=>f.repository.runs.complete(id,f.project.id,
      {...plain,title:'First manuscript',claims:[{subjectType:'paragraph',content:excerpt,status:'supported',
        evidenceIds:[evidenceId],experiment:{...unknownExperiment}}],sections:[{title:'Related Work',claimIndexes:[0]}]}));
    assert.equal(finished.status,'completed');
    const checked = await service.checkGrounding({projectId:f.project.id,artifactId:finished.outputArtifactIds[0],contextId:context.contextId});
    assert.equal(checked.artifactId,finished.outputArtifactIds[0]);
  } finally {await f.close();}
});

test('reading role requests scoped deep knowledge asynchronously and fences later membership or run changes', async () => {
  const f=await scientificSearchFixture(api,{embedded:false}),controller=new AbortController();
  const service=new extraction.ScientificExtractionService(f.repository,{library:f.root,index:null},async()=>({
    config:{extractorVersion:'roc-scientific-knowledge/1',promptVersion:'fixture/1',
      model:{provider:'fixture',modelId:'fixture',model:'fixture',revision:'1'},inputTokens:16000,batchTokens:8000},
    invoke:async()=>{throw new Error('fixture_job_not_a_model_quality_run');}
  }),()=> 'fixture-model/1',{pollMs:60000});
  try {
    let calls=0, mutate=()=>{};
    const tools=createResearchTestRoleTools(api,{run:f.run,context:f.repository.runs.getContext(f.run.id),repository:f.repository,
      signal:controller.signal,capabilities:{invoke:async(name,request,signal)=>{
        calls++;assert.equal(request.projectId,f.project.id);
        const result=await (name==='research.knowledge.deepRequest'?service.requestDeep(request,signal):service.readDeep(request,signal));
        return mutate(result)??result;
      }}});
    const read=tools.find(tool=>tool.name==='read_paper_deep_knowledge'),request=tools.find(tool=>tool.name==='request_paper_deep_knowledge');
    await assert.rejects(read.invoke({documentId:'foreign-document',generationId:null}),/scope_invalid|not_found/);
    assert.equal(calls,0);
    const deepRequest={documentId:f.document.id,purpose:'reading',question:'Explain the method assumptions',
      dimensions:['method'],sectionIds:[],objectIds:[]};
    const result=await request.invoke(deepRequest);
    assert.ok(['queued','running'].includes(result.status));
    assert.equal(result.snapshot.deepRequest.question,'Explain the method assumptions');
    assert.ok(result.id);
    assert.equal((await request.invoke(deepRequest)).id,result.id);
    assert.equal(calls,1);
    f.db.prepare('DELETE FROM research_library_projects WHERE project_id=?').run(f.project.id);
    await assert.rejects(request.invoke(deepRequest),/scope_invalid/,'cached effect cannot bypass revoked document authority');
    assert.equal(calls,1);
    f.db.prepare('INSERT INTO research_library_projects (item_id,project_id) VALUES (?,?)').run(f.document.libraryItemId,f.project.id);
    const current=await read.invoke({documentId:f.document.id,generationId:null});
    assert.equal(current.documentId,f.document.id);assert.equal(current.scientificApproval,'unreviewed');
    mutate=result=>({...result,documentId:'foreign-document'});
    await assert.rejects(read.invoke({documentId:f.document.id,generationId:null}),/tool_binding_invalid/);
    mutate=()=>{f.db.prepare('DELETE FROM research_library_projects WHERE project_id=?').run(f.project.id);};
    await assert.rejects(read.invoke({documentId:f.document.id,generationId:null}),/scope_invalid/);
    f.db.prepare('INSERT INTO research_library_projects (item_id,project_id) VALUES (?,?)').run(f.document.libraryItemId,f.project.id);
    mutate=()=>{controller.abort(new Error('deep_role_cancelled'));};
    await assert.rejects(read.invoke({documentId:f.document.id,generationId:null}),/deep_role_cancelled/);
  } finally {await service.shutdown();await f.close();}
});

test('preparing a draft then saving paragraphs with an advancing clock preserves its writing context',async()=>{
  const f=await fixture();
  let clock='2026-11-26T10:00:00.000Z';
  const writer=new api.ResearchRepository(f.db,f.tasks,()=>clock);
  try {
    const context=await f.service.prepare(f.request),before=f.repository.getArtifact(f.artifact.id);
    clock='2026-11-26T10:01:00.000Z';
    const evidenceId=context.originalEvidenceIds[0],content=writer.evidence.getEvidence(evidenceId,f.project.id).excerpt;
    const claim=writer.evidence.createClaim({projectId:f.project.id,artifactId:f.artifact.id,subjectType:'paragraph',
      content,status:'supported',evidenceIds:[evidenceId],experiment:{...unknownExperiment}});
    clock='2026-11-26T10:02:00.000Z';
    writer.manuscripts.saveManuscript({artifactId:f.artifact.id,sections:[{title:'Related Work',claimIds:[claim.id]}]});
    assert.notEqual(writer.getArtifact(f.artifact.id).updatedAt,before.updatedAt);
    const result=await f.service.checkGrounding(f.readRequest(context));
    assert.deepEqual(result.checkedClaimIds,[claim.id]);
    assert.ok(!result.issues.some(issue=>['context_changed','source_stale'].includes(issue.code)),JSON.stringify(result.issues));
    const impacts=await f.service.reviewImpact(f.readRequest(context));
    assert.ok(impacts.impacts.some(impact=>impact.kind==='paragraph'));
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifact.id);
    assert.ok((await f.service.checkGrounding(f.readRequest(context))).issues.some(issue=>issue.code==='context_changed'));
  }finally{
    await Promise.all([writer.knowledgeJobs.shutdown(),writer.paperCards.shutdown(),writer.wiki.shutdown()]);
    await f.close();
  }
});
