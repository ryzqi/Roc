import {unknownExperiment, withResearchTestWorker, createResearchFixture, captureResearchArtifactVersions} from './research-test-kit.mjs';

const plain = {title: 'Review', markdown: 'Controlled engineering fixture.', claims: [], sections: [], verdict: 'uncertain'};
export function createScientificReviewFixture(api, {contradiction = false, verifierVerdict = 'qualifies',
  sourceText = 'A negative result with uncertainty.', claimContents = ['A negative result with uncertainty.']} = {}) {
  const f = createResearchFixture(api, 'writing');
  f.repository.knowledge.upsertFromSource({id: 'scientific-source', projectId: f.project.id, sourceType: 'file',
    sourceId: 'negative.md', title: 'Negative result', content: sourceText,
    chunks: [{content: sourceText, locator: 'block:0'}], embeddingPolicy: 'none'});
  f.evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'scientific-source:chunk:0'});
  f.artifactId = withResearchTestWorker(api, f.repository, f.run.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {...plain,
    claims: claimContents.map(content => ({experiment: {...unknownExperiment}, subjectType: 'paragraph', content, status: 'supported', evidenceIds: [f.evidence.id]})),
    sections: [{title: 'Results', claimIndexes: claimContents.map((_, index) => index)}]})).outputArtifactIds[0];
  f.claims = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId});
  f.claim = f.claims[0];
  for (const claim of f.claims) {
    const relation = f.repository.evidence.relations.list({projectId: f.project.id, claimId: claim.id})[0];
    f.repository.evidence.relations.review({projectId: f.project.id, relationId: relation.id, expectedVersion: relation.version,
      expectedClaimVersion: claim.version, expectedSourceDigest: relation.sourceDigest, decision: 'confirm', note: 'Human fixture judgment.'},
      {kind: 'user', id: 'window:24'});
    if (contradiction) f.repository.evidence.relations.propose({projectId: f.project.id, claimId: claim.id,
      expectedClaimVersion: claim.version, evidenceId: f.evidence.id, expectedSourceDigest: relation.sourceDigest,
      kind: 'contradicts', condition: null, supersedesRelationId: null}, {kind: 'user', id: 'window:24'});
  }
  f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'writing', action: 'complete'});
  f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'writing', action: 'approve',
    expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)});
  const queued = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'review', instruction: 'Review current manuscript', requestId: 'review-1'});
  f.parent = queued;
  f.children = f.repository.runs.createReviewChildren(f.parent.id, f.project.id);
  f.worker = (id, work) => withResearchTestWorker(api, f.repository, id, f.project.id, workerRunId => {
    if (f.repository.runs.get(workerRunId, f.project.id).status === 'queued') {
      f.repository.runs.markRunning(workerRunId, f.project.id, {providerId: 'fixture', modelId: 'fixture'});
    }
    return work(workerRunId);
  });
  f.bindReviewDependencies = () => {
    const graph = f.tasks.graph.read(f.parent.taskId, f.project.id);
    const parent = f.tasks.requireExecution('stage', f.parent.id, f.project.id).nodeBinding;
    f.tasks.graph.addDependencies(f.parent.taskId, f.project.id, graph.revision, f.children.map(child => ({
      prerequisite: f.tasks.requireExecution('stage', child.id, f.project.id).nodeBinding.nodeId,
      dependent: parent.nodeId
    })));
  };
  f.bindReviewDependencies();
  f.input = f.repository.runs.getContext(f.parent.id).scientificInput;
  f.reference = {evidenceId: f.evidence.id, sourceDigest: api.relationSourceDigest(f.input.evidence[0]),
    start: 0, end: f.evidence.excerpt.length, quote: f.evidence.excerpt};
  f.output = child => child.role === 'evidence-reviewer' ? {
    kind: 'verifier', inputHash: api.scientificReviewHash(f.input), suggestions: f.input.claims.map(claim => ({
      claimId: claim.id, claimVersion: claim.version, claimHash: api.relationClaimHash(claim),
      claimKind: 'factual', researchType: 'experiment', verdict: 'qualifies', rationale: 'Limited controlled evidence.',
      supporting: [f.reference], counterevidence: [], negativeResults: [f.reference],
      alternativeExplanations: [{explanation: 'Sampling variation remains possible.', references: [f.reference]}],
      conditions: [{criterion: 'direct_source', status: 'met', rationale: 'Exact source text.', references: [f.reference]}],
      limitations: ['No population inference.'], coverage: {examinedEvidenceIds: [f.evidence.id], unexaminedReason: null,
        conclusion: 'absence_is_not_evidence_of_absence'}
    }))
  } : {kind: 'reviewer', inputHash: api.scientificReviewHash(f.input), coveredClaimIds: f.input.claims.map(claim => claim.id),
    findings: [{id: 'f1', severity: 'major', category: 'method_fit', claimIds: [f.claim.id], references: [f.reference],
      observation: 'State the uncertainty limit.', action: 'Retain uncertainty in Results.', acceptance: 'Exact qualifying text remains.'}],
    noFindingsRationale: null};
  if (verifierVerdict === 'unrelated' || verifierVerdict === 'unable_to_verify') {
    const output = f.output;
    f.output = child => {
      const value = output(child);
      if (value.kind !== 'verifier') return value;
      const suggestion = value.suggestions[0];
      suggestion.verdict = verifierVerdict;
      suggestion.rationale = verifierVerdict === 'unrelated'
        ? 'The examined material does not address this claim.' : 'The required source could not be examined.';
      suggestion.supporting = []; suggestion.negativeResults = []; suggestion.alternativeExplanations = [];
      suggestion.conditions = [{criterion: 'direct_source', status: 'missing', rationale: suggestion.rationale, references: []}];
      suggestion.limitations = [suggestion.rationale];
      if (verifierVerdict === 'unable_to_verify') {
        suggestion.coverage.examinedEvidenceIds = [];
        suggestion.coverage.unexaminedReason = 'Required source inspection was unavailable.';
      }
      return value;
    };
  }
  f.complete = () => {
    const completed = f.children.map(child => f.worker(child.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {...plain, scientificReview: f.output(child)})));
    f.worker(f.parent.id, workerRunId => f.repository.runs.setReviewReports(workerRunId, f.project.id, completed));
    f.worker(f.parent.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, plain));
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'review', action: 'complete'});
    return completed;
  };
  return f;
}
