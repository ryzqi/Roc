import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Annotation, Command, END, MemorySaver, START, StateGraph} from '@langchain/langgraph';
import {captureResearchArtifactVersions, createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());

function scene(stage = 'reading', count = 1) {
  const f = createResearchFixture(api, stage);
  f.sources = [];
  for (let index = 0; index < count; index++) {
    const id = `semantic-source-${index}`;
    f.repository.knowledge.upsertFromSource({id, projectId: f.project.id, sourceType: 'file',
      sourceId: `synthetic-${index}.md`, title: `Synthetic publication source ${index}`,
      content: `Synthetic measured result ${index}.`, chunks: [{content: `Synthetic measured result ${index}.`, locator: `block:${index}`}],
      embeddingPolicy: 'none'});
    f.sources.push(f.repository.evidence.capture({projectId: f.project.id, chunkId: `${id}:chunk:0`}));
  }
  const completed = f.repository.runs.complete(f.run.id, f.project.id, {
    title: 'Synthetic publication claim', markdown: 'A model declares support but has not obtained human review.',
    claims: [{subjectType: stage === 'writing' ? 'paragraph' : 'claim', content: 'The synthetic result is supported.',
      status: 'supported', evidenceIds: f.sources.map(source => source.id)}],
    sections: stage === 'writing' ? [{title: 'Result', claimIndexes: [0]}] : [], verdict: 'ready'
  });
  f.artifactId = completed.outputArtifactIds[0];
  f.claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
  f.gate = api.createResearchHumanGate({repository: f.repository});
  f.complete = () => f.gate.complete({projectId: f.project.id, expectedStage: stage, action: 'complete'});
  f.approve = () => f.gate.approve({projectId: f.project.id, expectedStage: stage, action: 'approve',
    expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)});
  f.relations = () => f.repository.evidence.relations.list({projectId: f.project.id, claimId: f.claim.id});
  f.propose = (kind, source = f.sources[0], condition = null, supersedesRelationId = null) =>
    f.repository.evidence.relations.propose({projectId: f.project.id, claimId: f.claim.id,
      expectedClaimVersion: f.claim.version, evidenceId: source.id,
      expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(source.id, f.project.id)),
      kind, condition, supersedesRelationId}, {kind: 'user', id: 'synthetic-scientific-reviewer'});
  f.review = (relation, decision = 'confirm') => f.repository.evidence.relations.review({projectId: f.project.id, relationId: relation.id,
    expectedVersion: relation.version, expectedClaimVersion: relation.claimVersion,
    expectedSourceDigest: relation.sourceDigest, decision, note: 'Explicit synthetic publication review.'},
  {kind: 'user', id: 'synthetic-scientific-reviewer'});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  return f;
}

test('an exact artifact gate capture cannot approve a model supported claim whose sources have no human semantic confirmation', async () => {
  const f = scene();
  try {
    await f.complete();
    const before = f.changes();
    await assert.rejects(f.approve(), error => error.code === 'research_relation_review_required' && error.category === 'conflict');
    assert.equal(f.changes(), before);
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
    assert.equal(f.repository.getWorkflow(f.project.id).currentStage, 'reading');
    assert.equal(f.repository.getWorkflow(f.project.id).stages.find(stage => stage.stage === 'reading').status, 'waiting_approval');
  } finally {f.close();}
});

test('every declared source needs current human support, and old gate versions fail after those reviews', async () => {
  const f = scene('reading', 2);
  try {
    await f.complete();
    const original = captureResearchArtifactVersions(f.repository, f.project.id);
    const proposals = f.relations();
    assert.equal(proposals.length, 2);
    f.review(proposals[0]);
    const before = f.changes();
    await assert.rejects(f.approve(), error => error.code === 'research_relation_review_required' &&
      error.message.includes(f.sources[1].id));
    assert.equal(f.changes(), before);
    f.review(proposals[1]);
    const reviewed = f.changes();
    await assert.rejects(f.gate.approve({projectId: f.project.id, expectedStage: 'reading', action: 'approve',
      expectedArtifactVersions: original}), /research_artifact_review_changed/u);
    assert.equal(f.changes(), reviewed);
    await f.approve();
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'approved');
    assert.equal(f.repository.getWorkflow(f.project.id).currentStage, 'ideation');
  } finally {f.close();}
});

test('a confirmed contradiction blocks approval until explicitly superseded, even with confirmed support', async () => {
  const f = scene();
  try {
    await f.complete();
    f.review(f.relations()[0]);
    const contradiction = f.review(f.propose('contradicts'));
    const before = f.changes();
    await assert.rejects(f.approve(), error => error.code === 'research_relation_conflict');
    assert.equal(f.changes(), before);
    f.review(f.propose('supersedes', f.sources[0], 'The original contradiction was reviewed and replaced.', contradiction.id));
    await f.approve();
    const history = f.repository.evidence.relations.history(contradiction.id, f.project.id);
    assert.equal(history.at(-1).relation.invalidatedReason, 'superseded');
    assert.equal(history.at(-1).relation.reviewer.id, 'synthetic-scientific-reviewer');
  } finally {f.close();}
});

test('qualifying support preserves its explicit condition and permits publication after human confirmation', async () => {
  const f = scene();
  try {
    await f.complete();
    f.review(f.relations()[0], 'reject');
    const qualified = f.review(f.propose('qualifies', f.sources[0], 'Only for the fixed synthetic measurement.'));
    await f.approve();
    assert.equal(qualified.condition, 'Only for the fixed synthetic measurement.');
    assert.equal(f.repository.evidence.relations.requireReviewedSupport(f.claim)[0].id, qualified.id);
  } finally {f.close();}
});

test('rejected support and confirmed dependency cannot serve as scientific support', async () => {
  const f = scene();
  try {
    await f.complete();
    f.review(f.relations()[0], 'reject');
    f.review(f.propose('depends_on'));
    const before = f.changes();
    await assert.rejects(f.approve(), error => error.code === 'research_relation_review_required');
    assert.equal(f.changes(), before);
  } finally {f.close();}
});

test('editing a claim revokes its old review while draft inspection remains available', async () => {
  const f = scene();
  try {
    const confirmed = f.review(f.relations()[0]);
    f.claim = f.repository.evidence.updateClaim({id: f.claim.id, expectedVersion: f.claim.version,
      content: 'A changed synthetic claim.', status: 'supported', evidenceIds: f.claim.evidenceIds});
    assert.equal(f.repository.evidence.relations.get(confirmed.id, f.project.id).status, 'invalidated');
    const before = f.changes();
    assert.throws(() => f.repository.evidence.assertReviewedSupport(f.claim),
      error => error.code === 'research_relation_review_required');
    const inspection = f.repository.inspectArtifact({projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null});
    assert.equal(inspection.snapshot.claims[0].content, f.claim.content);
    assert.equal(f.changes(), before);
  } finally {f.close();}
});

test('draft manuscript inspection permits proposed support but current export requires human review', async () => {
  const f = scene('writing');
  try {
    const request = {projectId: f.project.id, artifactId: f.artifactId};
    assert.equal(f.repository.manuscripts.inspectBundle(request).claims[0].id, f.claim.id);
    await f.complete();
    await assert.rejects(f.approve(), error => error.code === 'research_relation_review_required');
    f.review(f.relations()[0]);
    await f.approve();
    assert.equal(f.repository.manuscripts.exportBundle(request).claims[0].id, f.claim.id);
    f.repository.evidence.invalidateChunksOf(f.sources[0].documentId);
    const before = f.changes();
    assert.throws(() => f.repository.manuscripts.exportBundle(request), /research_evidence_reference_superseded/u);
    const inspection = f.repository.inspectArtifact({...request, expectedVersion: null});
    assert.equal(inspection.snapshot.evidence[0].referenceStatus, 'superseded');
    assert.equal(inspection.snapshot.relations[0].status, 'invalidated');
    assert.equal(inspection.snapshot.relations[0].reviewer.id, 'synthetic-scientific-reviewer');
    assert.equal(f.changes(), before);
  } finally {f.close();}
});

test('real gate graph preserves semantic refusal as a new interrupt and accepts explicitly reread human confirmation', async () => {
  for (const conflict of [false, true]) {
    const f = scene();
    try {
      await f.complete();
      let contradiction;
      if (conflict) {
        f.review(f.relations()[0]);
        contradiction = f.review(f.propose('contradicts'));
      }
      const tools = api.createResearchTools({projectId: f.project.id, signal: new AbortController().signal,
        dispatchReviewQuery: async () => assert.fail('unexpected owned query dispatch'), dispatchStage: async () => assert.fail('human gate cannot dispatch a model'),
        capabilities: {invoke: async (name, input) => {
          if (name === 'research.workflow.get') return f.repository.getWorkflow(f.project.id);
          if (name === 'research.workflow.gateReview') return f.repository.readGateReviewContext(input);
          if (name === 'research.workflow.transition') return f.repository.transitionWorkflow(input);
          assert.fail(name);
        }}});
      const tool = tools.find(tool => tool.name === 'research_approve_gate');
      const graph = new StateGraph(Annotation.Root({done: Annotation()})).addNode('gate', async () => {
        await tool.invoke({}); return {done: true};
      }).addEdge(START, 'gate').addEdge('gate', END).compile({checkpointer: new MemorySaver()});
      const config = {configurable: {thread_id: `semantic-${conflict}`}};
      const pending = await graph.invoke({done: false}, config);
      const before = f.changes();
      const refused = await graph.invoke(new Command({resume: {decisions: [{
        type: 'approve', reviewedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)
      }]}}), config);
      assert.equal(refused.done, false);
      assert.notEqual(refused.__interrupt__[0].id, pending.__interrupt__[0].id);
      assert.match(refused.__interrupt__[0].value.request.actionRequests[0].args.reviewError,
        conflict ? /反对关系/u : /人工支持确认/u);
      assert.equal(f.changes(), before);
      if (conflict) f.review(f.propose('supersedes', f.sources[0], 'Explicitly resolved conflict.', contradiction.id));
      else f.review(f.relations()[0]);
      const context = f.repository.readGateReviewContext({projectId: f.project.id, expectedStage: 'reading', artifactId: f.artifactId});
      const reviewedArtifactVersions = context.artifactLinks.map(link => ({artifactId: link.artifactId, version: link.expectedVersion}));
      assert.equal((await graph.invoke(new Command({resume: {decisions: [{type: 'approve', reviewedArtifactVersions}]}}), config)).done, true);
      assert.equal(f.repository.getArtifact(f.artifactId).status, 'approved');
    } finally {f.close();}
  }
});

test('export review seal captures exact source, conditions and user history, and changes on an independent relation decision', async () => {
  const f = scene('writing');
  try {
    f.review(f.relations()[0], 'reject');
    f.review(f.propose('qualifies', f.sources[0], 'Only for the fixed synthetic source.'));
    await f.complete();
    await f.approve();
    const bundle = f.repository.manuscripts.exportBundle({projectId: f.project.id, artifactId: f.artifactId});
    const sources = {project: f.project, manuscriptArtifact: f.repository.getArtifact(f.artifactId),
      figures: [], claims: bundle.claims, evidence: bundle.evidence, experimentResults: [], ideaOutcomes: []};
    const before = f.changes();
    const snapshot = api.captureExportScientificReview(f.repository, sources);
    assert.equal(snapshot.schemaVersion, 5);
    assert.deepEqual(snapshot.citationReviews, []);
    assert.deepEqual(snapshot.consistencyReviews, []);
    assert.deepEqual(snapshot.figureConsistencyReviews, []);
    assert.deepEqual(snapshot.responseMatrices, []);
    assert.deepEqual(snapshot.journalCompliance, []);
    const privateBytes = api.serializeExportScientificReview(snapshot);
    const bytes = api.serializePublicExportScientificReview(snapshot);
    const file = {path: api.exportScientificReviewPath, size: Buffer.byteLength(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex')};
    const record = {sources, sourceHash: snapshot.sourceHash, files: [file]};
    assert.equal(snapshot.relations.find(relation => relation.kind === 'qualifies').condition, 'Only for the fixed synthetic source.');
    assert.equal(snapshot.history.at(-1).revisions.at(-1).relation.reviewer.id, 'synthetic-scientific-reviewer');
    assert.deepEqual(snapshot.evidence[0].evidence, f.sources[0]);
    api.assertCurrentExportScientificReview(f.repository, record);
    assert.equal(f.changes(), before);
    assert.throws(() => api.assertCurrentExportScientificReview(f.repository, {...record, sourceHash: '0'.repeat(64)}),
      /research_export_sources_changed/u);
    assert.throws(() => api.assertCurrentExportScientificReview(f.repository, {...record, files: []}),
      error => error.code === 'research_export_semantic_snapshot_required');
    assert.equal(f.changes(), before);
    // An independent relation never enters claim.evidenceIds, yet its review must still revoke the seal.
    f.db.prepare("UPDATE research_artifacts SET status='draft' WHERE id=?").run(f.artifactId);
    f.db.prepare("UPDATE research_projects SET current_stage='writing' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_stage_states SET status='waiting_approval' WHERE project_id=? AND stage='writing'").run(f.project.id);
    const source = f.repository.knowledge.upsertFromSource({id: 'independent-export-source', projectId: f.project.id,
      sourceType: 'file', sourceId: 'independent-synthetic.md', title: 'Independent synthetic source',
      content: 'An independent dependency.', chunks: [{content: 'An independent dependency.', locator: 'block:0'}],
      embeddingPolicy: 'none'});
    const independentSource = f.repository.evidence.capture({projectId: f.project.id, chunkId: `${source.id}:chunk:0`});
    const independent = f.review(f.propose('depends_on', independentSource));
    const changed = f.changes();
    assert.throws(() => api.assertCurrentExportScientificReview(f.repository, record),
      error => error.code === 'research_export_semantic_snapshot_changed');
    assert.equal(f.changes(), changed);
    assert.equal(snapshot.relations.some(relation => relation.id === independent.id), false);
    assert.equal(f.claim.evidenceIds.includes(independentSource.id), false);
    assert.equal(api.serializeExportScientificReview(snapshot), privateBytes);
  } finally {f.close();}
});
