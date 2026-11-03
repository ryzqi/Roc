import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());

function scene() {
  const f = createResearchFixture(api, 'reading');
  f.repository.knowledge.upsertFromSource({id: 'model-relation-source', projectId: f.project.id,
    sourceType: 'experiment', sourceId: 'synthetic-measurement', title: 'Synthetic producer source',
    content: 'A recorded synthetic measurement.', chunks: [{content: 'A recorded synthetic measurement.', locator: 'synthetic.csv:row:1'}],
    embeddingPolicy: 'none'});
  f.evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'model-relation-source:chunk:0'});
  f.output = {title: 'Synthetic model interpretation', markdown: 'The model proposes a supported statement.',
    claims: ['supported', 'hypothesis', 'pending'].map(status => ({subjectType: 'claim',
      content: `A synthetic ${status} statement.`, status, evidenceIds: [f.evidence.id]})),
    sections: [], verdict: 'uncertain'};
  f.proposeInput = claim => ({projectId: f.project.id, claimId: claim.id, expectedClaimVersion: claim.version,
    evidenceId: f.evidence.id, expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(f.evidence.id, f.project.id)),
    kind: 'supports', condition: null, supersedesRelationId: null});
  return f;
}

test('actual stage completion records model supported associations as proposed with real producer identity and no fabricated reviews', () => {
  const f = scene();
  try {
    const completed = f.repository.runs.complete(f.run.id, f.project.id, f.output);
    const artifactId = completed.outputArtifactIds[0];
    const claims = f.repository.evidence.listClaims({projectId: f.project.id, artifactId});
    const supported = claims.find(claim => claim.status === 'supported');
    const relations = f.repository.evidence.relations.list({projectId: f.project.id, claimId: null});
    assert.equal(relations.length, 1);
    const relation = relations[0];
    assert.equal(relation.claimId, supported.id);
    assert.equal(relation.kind, 'supports'); assert.equal(relation.status, 'proposed');
    assert.deepEqual(relation.proposer, {kind: 'agent', id: completed.id});
    assert.equal(relation.claimVersion, supported.version);
    assert.equal(relation.claimHash, api.relationClaimHash(supported));
    assert.equal(relation.sourceDigest, f.proposeInput(supported).expectedSourceDigest);
    assert.equal(relation.source.evidence.excerpt, 'A recorded synthetic measurement.');
    assert.equal(relation.reviewer, null); assert.equal(relation.reviewedAt, null);
    assert.equal(relation.decisionNote, null);
    assert.deepEqual(f.repository.evidence.relations.history(relation.id, f.project.id).map(row => row.event), ['proposed']);
    assert.deepEqual(f.repository.runs.getArtifactContent(f.project.id, artifactId).output, f.output);
    assert.equal(claims.find(claim => claim.status === 'hypothesis').status, 'hypothesis');
    assert.throws(() => f.repository.evidence.relations.propose(f.proposeInput(supported), {kind: 'agent', id: completed.id}),
      /research_relation_proposer_invalid/u);
    assert.throws(() => f.repository.runs.complete(f.run.id, f.project.id, f.output), /research_run_not_current/u);
    assert.equal(f.repository.evidence.relations.list({projectId: f.project.id, claimId: null}).length, 1);
  } finally {f.close();}
});

test('model relation history failure rolls back output artifact, claims, content and producer completion together', () => {
  const f = scene();
  try {
    const counts = () => ['research_artifacts', 'research_claims', 'research_artifact_contents',
      'research_evidence_relations', 'research_evidence_relation_revisions', 'research_provenance']
      .map(table => f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get());
    const before = counts();
    f.db.exec("CREATE TRIGGER fail_model_relation_history BEFORE INSERT ON research_evidence_relation_revisions BEGIN SELECT RAISE(ABORT,'synthetic_relation_history_failure'); END");
    assert.throws(() => f.repository.runs.complete(f.run.id, f.project.id, f.output), /synthetic_relation_history_failure/u);
    assert.deepEqual(counts(), before);
    assert.equal(f.repository.runs.get(f.run.id, f.project.id).status, 'running');
    assert.deepEqual(f.repository.runs.get(f.run.id, f.project.id).outputArtifactIds, []);
    f.db.exec('DROP TRIGGER fail_model_relation_history');
    const completed = f.repository.runs.complete(f.run.id, f.project.id, f.output);
    assert.equal(completed.status, 'completed');
    assert.equal(f.repository.evidence.relations.list({projectId: f.project.id, claimId: null}).length, 1);
  } finally {f.close();}
});

test('role tools expose paginated fixed source and relation facts with bound project and active run, never human review authority', async () => {
  const f = scene(), controller = new AbortController();
  try {
    const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'reading', kind: 'reading_notes',
      title: 'Synthetic draft target', path: null});
    const claim = f.repository.evidence.createClaim({projectId: f.project.id, artifactId: artifact.id, subjectType: 'claim',
      content: 'A pending synthetic relation.', status: 'hypothesis', evidenceIds: [f.evidence.id]});
    const proposed = f.repository.evidence.relations.propose(f.proposeInput(claim), {kind: 'agent', id: f.run.id});
    const tools = api.createResearchRoleTools({run: f.run, context: f.repository.runs.getContext(f.run.id),
      repository: f.repository, capabilities: {invoke: () => assert.fail('readonly role relation facts use the bound repository')}, signal: controller.signal});
    const inspect = tools.find(tool => tool.name === 'inspect_evidence_source');
    const list = tools.find(tool => tool.name === 'list_evidence_relations');
    assert.ok(inspect); assert.ok(list);
    assert.equal(tools.some(tool => /review.*relation|confirm.*relation/u.test(tool.name)), false);
    const before = f.db.prepare('SELECT total_changes()').pluck().get();
    const first = await inspect.invoke({evidenceId: f.evidence.id, offset: 0, limit: 30});
    assert.equal(first.sourceDigest, proposed.sourceDigest);
    assert.equal(first.referenceStatus, 'recorded'); assert.equal(first.content.length, 30);
    const rest = await inspect.invoke({evidenceId: f.evidence.id, offset: 30, limit: 8000});
    const source = JSON.parse(first.content + rest.content);
    assert.equal(source.evidence.excerpt, proposed.source.evidence.excerpt);
    const records = await list.invoke({claimId: claim.id, offset: 0, limit: 20});
    assert.equal(records.total, 1); assert.equal(records.items[0].status, 'proposed');
    assert.deepEqual(records.items[0].proposer, {kind: 'agent', id: f.run.id});
    assert.equal(records.items[0].reviewer, null);
    assert.deepEqual((await list.invoke({claimId: null, offset: 1, limit: 20})).items, []);
    await assert.rejects(inspect.invoke({evidenceId: f.evidence.id, offset: 0, limit: 30, projectId: 'forged'}));
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), before);
    f.repository.evidence.invalidateChunksOf('model-relation-source');
    const changed = await inspect.invoke({evidenceId: f.evidence.id, offset: 0, limit: 8000});
    assert.equal(changed.referenceStatus, 'superseded');
    assert.notEqual(changed.sourceDigest, proposed.sourceDigest);
    assert.equal((await list.invoke({claimId: claim.id, offset: 0, limit: 20})).items[0].status, 'invalidated');
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'synthetic_cancelled');
    await assert.rejects(inspect.invoke({evidenceId: f.evidence.id, offset: 0, limit: 30}), /research_run_not_current/u);
  } finally {f.close();}
});
