import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());

function scene() {
  const f = createResearchFixture(api, 'reading');
  f.repository.knowledge.upsertFromSource({id: 'relation-ipc-source', projectId: f.project.id,
    sourceType: 'experiment', sourceId: 'synthetic-ipc-measurement', title: 'Synthetic transport source',
    content: 'Synthetic sample mean is 2.', chunks: [{content: 'Synthetic sample mean is 2.', locator: 'sample.csv:row:1'}],
    embeddingPolicy: 'none'});
  f.evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'relation-ipc-source:chunk:0'});
  f.artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'reading', kind: 'reading_notes',
    title: 'Synthetic claim under review', path: null});
  f.claim = f.repository.evidence.createClaim({projectId: f.project.id, artifactId: f.artifact.id,
    subjectType: 'claim', content: 'A synthetic mean claim.', status: 'hypothesis', evidenceIds: [f.evidence.id]});
  f.registry = new api.CapabilityRegistry();
  for (const descriptor of api.researchEvidenceCapabilities) f.registry.declare('research', descriptor);
  api.registerResearchEvidenceCapabilities({pluginId: 'research', capabilities: f.registry}, f.repository.evidence);
  f.adapter = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => f.registry.invoke(name, input)});
  f.request = {projectId: f.project.id, claimId: f.claim.id, expectedClaimVersion: f.claim.version,
    evidenceId: f.evidence.id, expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(f.evidence.id, f.project.id)),
    kind: 'supports', condition: null, supersedesRelationId: null};
  f.reviewRequest = relation => ({projectId: f.project.id, relationId: relation.id, expectedVersion: relation.version,
    expectedClaimVersion: relation.claimVersion, expectedSourceDigest: relation.sourceDigest, decision: 'confirm', note: null});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  return f;
}

test('generated bridge binds human proposal and review to actual sender windows and keeps versioned source reads readonly', async () => {
  const f = scene();
  try {
    const before = f.changes();
    const source = await f.adapter.invoke('research.inspectEvidence', [{projectId: f.project.id, evidenceId: f.evidence.id}], 31);
    assert.equal(source.ok, true);
    assert.equal(source.data.source.evidence.excerpt, 'Synthetic sample mean is 2.');
    assert.equal(source.data.source.sourceLocator, null);
    assert.equal(source.data.sourceDigest, f.request.expectedSourceDigest);
    assert.equal(f.changes(), before);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:relations-propose', [f.request]), [f.request]);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:relations-propose', [f.request, 999]));
    const proposed = await f.adapter.invoke('research.proposeEvidenceRelation', [f.request], 31);
    assert.equal(proposed.ok, true);
    assert.deepEqual(proposed.data.proposer, {kind: 'user', id: 'window:31'});
    assert.equal(proposed.data.status, 'proposed');
    const reviewed = await f.adapter.invoke('research.reviewEvidenceRelation', [f.reviewRequest(proposed.data)], 42);
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.data.status, 'confirmed');
    assert.deepEqual(reviewed.data.reviewer, {kind: 'user', id: 'window:42'});
    assert.equal(f.repository.evidence.getClaim(f.claim.id).status, 'hypothesis');
    const after = f.changes();
    const listed = await f.adapter.invoke('research.listEvidenceRelations', [{projectId: f.project.id, claimId: f.claim.id}], 31);
    const history = await f.adapter.invoke('research.evidenceRelationHistory', [{projectId: f.project.id, relationId: proposed.data.id}], 31);
    assert.deepEqual(listed.data, [reviewed.data]);
    assert.deepEqual(history.data.map(row => [row.event, row.actor?.id]), [['proposed', 'window:31'], ['confirmed', 'window:42']]);
    assert.equal(f.changes(), after);
    assert.throws(() => api.requireResearchHuman('research.relations.review', f.project.id), /research_human_required/u);
  } finally {f.close();}
});

test('direct capability calls and forged request actors cannot acquire human approval authority or write relations', async () => {
  const f = scene();
  try {
    const before = f.changes();
    await assert.rejects(f.registry.invoke('research.relations.propose', f.request),
      error => error.code === 'research_human_required' && error.category === 'permission');
    for (const payload of [
      {...f.request, actor: {kind: 'user', id: 'forged'}},
      {...f.request, proposer: {kind: 'user', id: 'forged'}},
      {...f.request, reviewer: {kind: 'user', id: 'forged'}},
      {...f.request, windowId: 31}
    ]) {
      assert.throws(() => api.parseIpcRequestArgs('roc:research:relations-propose', [payload]));
      assert.equal((await f.adapter.invoke('research.proposeEvidenceRelation', [payload], 31)).ok, false);
    }
    const missingSender = await f.adapter.invoke('research.proposeEvidenceRelation', [f.request]);
    assert.equal(missingSender.error.code, 'research_sender_required');
    assert.equal(missingSender.error.category, 'permission');
    assert.equal((await f.adapter.invoke('research.proposeEvidenceRelation', [f.request], -1)).ok, false);
    await assert.rejects(api.withResearchHumanContext({capability: 'research.relations.review',
      projectId: f.project.id, windowId: 31}, () => f.registry.invoke('research.relations.propose', f.request)),
    error => error.code === 'research_human_required');
    await assert.rejects(api.withResearchHumanContext({capability: 'research.relations.propose',
      projectId: 'other-project', windowId: 31}, () => f.registry.invoke('research.relations.propose', f.request)),
    error => error.code === 'research_human_project_mismatch');
    assert.equal(f.changes(), before);
    const proposed = (await f.adapter.invoke('research.proposeEvidenceRelation', [f.request], 31)).data;
    const after = f.changes();
    const forgedReview = {...f.reviewRequest(proposed), reviewer: {kind: 'user', id: 'forged'}};
    assert.throws(() => api.parseIpcRequestArgs('roc:research:relations-review', [forgedReview]));
    assert.equal((await f.adapter.invoke('research.reviewEvidenceRelation', [forgedReview], 31)).ok, false);
    await assert.rejects(f.registry.invoke('research.relations.review', f.reviewRequest(proposed)),
      error => error.code === 'research_human_required');
    assert.equal(f.changes(), after);
    assert.equal(f.repository.evidence.relations.get(proposed.id, f.project.id).status, 'proposed');
  } finally {f.close();}
});

test('bridge exposes actionable stale source, version, endpoint and integrity errors without successful fallbacks', async () => {
  const f = scene();
  try {
    const proposed = (await f.adapter.invoke('research.proposeEvidenceRelation', [f.request], 31)).data;
    const before = f.changes();
    for (const [override, code] of [
      [{expectedVersion: 9}, 'research_relation_version_conflict'],
      [{expectedClaimVersion: 9}, 'research_relation_claim_changed'],
      [{expectedSourceDigest: 'a'.repeat(64)}, 'research_relation_source_changed'],
      [{relationId: 'missing-relation'}, 'research_relation_not_found']
    ]) {
      const result = await f.adapter.invoke('research.reviewEvidenceRelation', [{...f.reviewRequest(proposed), ...override}], 31);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, code);
      assert.equal(result.error.category, code.endsWith('not_found') ? 'not_found' : 'conflict');
    }
    assert.equal(f.changes(), before);
    const other = f.repository.createProject({title: 'Other synthetic project', description: '', workspacePath: '/tmp/relation-ipc-other'});
    const crossBefore = f.changes();
    const cross = await f.adapter.invoke('research.reviewEvidenceRelation', [{...f.reviewRequest(proposed), projectId: other.id}], 31);
    assert.equal(cross.error.category, 'permission');
    assert.equal(f.repository.evidence.relations.get(proposed.id, f.project.id).version, 1);
    assert.equal(f.changes(), crossBefore);
    f.repository.evidence.invalidateChunksOf('relation-ipc-source');
    const after = f.changes();
    const invalid = await f.adapter.invoke('research.reviewEvidenceRelation', [f.reviewRequest(proposed)], 31);
    assert.equal(invalid.error.code, 'research_relation_version_conflict');
    const source = await f.adapter.invoke('research.inspectEvidence', [{projectId: f.project.id, evidenceId: f.evidence.id}], 31);
    assert.equal(source.data.source.referenceStatus, 'superseded');
    assert.notEqual(source.data.sourceDigest, f.request.expectedSourceDigest);
    assert.equal(f.changes(), after);
    f.db.prepare("UPDATE research_evidence SET excerpt='changed at same version' WHERE id=?").run(f.evidence.id);
    const damaged = await f.adapter.invoke('research.inspectEvidence', [{projectId: f.project.id, evidenceId: f.evidence.id}], 31);
    assert.equal(damaged.error.category, 'degraded');
    assert.equal(damaged.error.code, 'research_evidence_integrity_invalid');
  } finally {f.close();}
});

test('concurrent main contexts preserve each window actor across asynchronous capability calls and clear after failure', async () => {
  const f = scene();
  try {
    const proposals = await Promise.all([61, 72].map(windowId =>
      api.withResearchHumanContext({capability: 'research.relations.propose', projectId: f.project.id, windowId}, async () => {
        await new Promise(resolve => setImmediate(resolve));
        return await f.registry.invoke('research.relations.propose', f.request);
      })));
    assert.deepEqual(proposals.map(row => row.proposer.id), ['window:61', 'window:72']);
    await assert.rejects(api.withResearchHumanContext({capability: 'research.relations.review',
      projectId: f.project.id, windowId: 61}, async () => {
      await new Promise(resolve => setImmediate(resolve));
      throw new Error('synthetic caller failure');
    }), /synthetic caller failure/u);
    await assert.rejects(f.registry.invoke('research.relations.review', f.reviewRequest(proposals[0])),
      error => error.code === 'research_human_required');
    assert.deepEqual(f.repository.evidence.relations.list({projectId: f.project.id, claimId: f.claim.id}).map(row => row.status),
      ['proposed', 'proposed']);
  } finally {f.close();}
});
