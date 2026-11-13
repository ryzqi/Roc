import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi, unknownExperiment} from './fixtures/research-test-kit.mjs';
let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());

test('different conditions and missing facts cannot confirm conflict; opposing comparable findings remain candidates', () => {
  const f = createResearchFixture(api, 'reading');
  try {
    const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'reading', kind: 'reading_notes', title: 'Comparison', path: null});
    const experiment = {method: 'Method A', dataset: 'Dataset X', metric: 'F1', value: 91.2,
      unit: '%', baseline: 'Baseline B', conditions: 'Full training set; equal inference budget', finding: 'improves'};
    const create = (id, values) => {
      f.repository.knowledge.upsertFromSource({id, projectId: f.project.id, sourceType: 'experiment', sourceId: id,
        title: id, content: 'Synthetic original result', chunks: [{content: 'Synthetic original result', locator: 'table:1'}], embeddingPolicy: 'none'});
      const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: `${id}:chunk:0`});
      return f.repository.evidence.createClaim({projectId: f.project.id, artifactId: artifact.id, subjectType: 'claim',
        content: `Synthetic ${id}`, status: 'hypothesis', evidenceIds: [evidence.id], experiment: values});
    };
    const left = create('paper-A', experiment), right = create('paper-B', {...experiment, value: 93, dataset: 'Dataset Y', finding: 'worsens'});
    const compare = () => f.repository.evidence.compare({projectId: f.project.id, leftClaimId: left.id, rightClaimId: right.id,
      expectedLeftVersion: left.version, expectedRightVersion: right.version});
    assert.equal(compare().outcome, 'condition_difference');
    const update = values => Object.assign(right, f.repository.evidence.updateClaim({id: right.id, expectedVersion: right.version,
      content: right.content, status: right.status, evidenceIds: right.evidenceIds, experiment: values}));
    update(unknownExperiment);
    assert.equal(compare().outcome, 'undetermined');
    update({...experiment, value: 90.8, finding: 'worsens'});
    const result = compare();
    assert.equal(result.outcome, 'conflict_candidate');
    assert.equal(result.reviewStatus, 'unreviewed');
    assert.equal(result.suggestedRelation, 'contradicts');
    assert.equal(f.db.prepare("SELECT count(*) FROM research_evidence_relations WHERE status='confirmed'").pluck().get(), 0);
    const source = f.repository.evidence.inspectEvidence(right.evidenceIds[0], f.project.id);
    const relation = f.repository.evidence.relations.propose({projectId: f.project.id, claimId: right.id, expectedClaimVersion: right.version,
      evidenceId: right.evidenceIds[0], expectedSourceDigest: api.relationSourceDigest(source), kind: 'contradicts', condition: 'Synthetic comparable conditions',
      supersedesRelationId: null}, {kind: 'agent', id: f.run.id});
    update({...experiment, conditions: 'Low resource setting'});
    assert.equal(f.repository.evidence.relations.get(relation.id, f.project.id).status, 'invalidated');
    assert.deepEqual(f.repository.evidence.claimHistory(right.id)[1].experiment, result.right.experiment);
    assert.throws(() => f.repository.evidence.compare({projectId: f.project.id, leftClaimId: left.id, rightClaimId: right.id,
      expectedLeftVersion: left.version, expectedRightVersion: 1}), /version_conflict/u);
  } finally {f.close();}
});
