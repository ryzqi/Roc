import {createResearchFixture, captureResearchArtifactVersions} from './research-test-kit.mjs';

const plain = {title: 'Review', markdown: 'Controlled engineering fixture.', claims: [], sections: [], verdict: 'uncertain'};
export function createScientificReviewFixture(api, {contradiction = false} = {}) {
  const f = createResearchFixture(api, 'writing');
  f.repository.knowledge.upsertFromSource({id: 'scientific-source', projectId: f.project.id, sourceType: 'file',
    sourceId: 'negative.md', title: 'Negative result', content: 'A negative result with uncertainty.',
    chunks: [{content: 'A negative result with uncertainty.', locator: 'block:0'}], embeddingPolicy: 'none'});
  f.evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'scientific-source:chunk:0'});
  f.artifactId = f.repository.runs.complete(f.run.id, f.project.id, {...plain,
    claims: [{subjectType: 'paragraph', content: 'A negative result with uncertainty.', status: 'supported', evidenceIds: [f.evidence.id]}],
    sections: [{title: 'Results', claimIndexes: [0]}]}).outputArtifactIds[0];
  f.claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
  const relation = f.repository.evidence.relations.list({projectId: f.project.id, claimId: f.claim.id})[0];
  f.repository.evidence.relations.review({projectId: f.project.id, relationId: relation.id, expectedVersion: relation.version,
    expectedClaimVersion: f.claim.version, expectedSourceDigest: relation.sourceDigest, decision: 'confirm', note: 'Human fixture judgment.'},
    {kind: 'user', id: 'window:24'});
  if (contradiction) f.repository.evidence.relations.propose({projectId: f.project.id, claimId: f.claim.id,
    expectedClaimVersion: f.claim.version, evidenceId: f.evidence.id, expectedSourceDigest: relation.sourceDigest,
    kind: 'contradicts', condition: null, supersedesRelationId: null}, {kind: 'user', id: 'window:24'});
  f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'writing', action: 'complete'});
  f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'writing', action: 'approve',
    expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)});
  const queued = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'review', instruction: 'Review current manuscript', requestId: 'review-1'});
  f.parent = f.repository.runs.markRunning(queued.id, f.project.id, {providerId: 'fixture', modelId: 'fixture'});
  f.children = f.repository.runs.createReviewChildren(f.parent.id, f.project.id)
    .map(child => f.repository.runs.markRunning(child.id, f.project.id, {providerId: 'fixture', modelId: 'fixture'}));
  f.input = f.repository.runs.getContext(f.parent.id).scientificInput;
  f.reference = {evidenceId: f.evidence.id, sourceDigest: api.relationSourceDigest(f.input.evidence[0]),
    start: 0, end: f.evidence.excerpt.length, quote: f.evidence.excerpt};
  f.output = child => child.role === 'evidence-reviewer' ? {
    kind: 'verifier', inputHash: api.scientificReviewHash(f.input), suggestions: [{
      claimId: f.claim.id, claimVersion: f.claim.version, claimHash: api.relationClaimHash(f.claim),
      claimKind: 'factual', researchType: 'experiment', verdict: 'qualifies', rationale: 'Limited controlled evidence.',
      supporting: [f.reference], counterevidence: [], negativeResults: [f.reference],
      alternativeExplanations: [{explanation: 'Sampling variation remains possible.', references: [f.reference]}],
      conditions: [{criterion: 'direct_source', status: 'met', rationale: 'Exact source text.', references: [f.reference]}],
      limitations: ['No population inference.'], coverage: {examinedEvidenceIds: [f.evidence.id], unexaminedReason: null,
        conclusion: 'absence_is_not_evidence_of_absence'}
    }]
  } : {kind: 'reviewer', inputHash: api.scientificReviewHash(f.input), coveredClaimIds: [f.claim.id],
    findings: [{id: 'f1', severity: 'major', category: 'method_fit', claimIds: [f.claim.id], references: [f.reference],
      observation: 'State the uncertainty limit.', action: 'Retain uncertainty in Results.', acceptance: 'Exact qualifying text remains.'}],
    noFindingsRationale: null};
  f.complete = () => {
    const completed = f.children.map(child => f.repository.runs.complete(child.id, f.project.id, {...plain, scientificReview: f.output(child)}));
    f.repository.runs.setReviewReports(f.parent.id, f.project.id, completed);
    f.repository.runs.complete(f.parent.id, f.project.id, plain);
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'review', action: 'complete'});
    return completed;
  };
  return f;
}
