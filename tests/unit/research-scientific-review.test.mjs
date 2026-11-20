import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {unknownExperiment, withResearchTestWorker, loadResearchTestApi, captureResearchArtifactVersions} from './fixtures/research-test-kit.mjs';

import {createScientificReviewFixture} from './fixtures/scientific-review.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const plain = {title: 'Review', markdown: 'Controlled engineering fixture.', claims: [], sections: [], verdict: 'uncertain'};
const scene = options => createScientificReviewFixture(api, options);

test('typed scientific output rejects unsupported causal, numerical, novelty and hypothesis success', () => {
  const f = scene();
  try {
    for (const kind of Object.keys(api.scientificCriteria)) {
      const value = f.output(f.children.find(child => child.role === 'evidence-reviewer'));
      value.suggestions[0].claimKind = kind;
      value.suggestions[0].verdict = 'supports';
      value.suggestions[0].conditions = api.scientificCriteria[kind].map(criterion => ({criterion, status: 'missing',
        rationale: 'No verified design.', references: []}));
      assert.equal(api.scientificReviewOutputSchema.safeParse(value).success, false, kind);
    }
    const value = f.output(f.children[1]);
    value.confidence = 0.99;
    assert.equal(api.scientificReviewOutputSchema.safeParse(value).success, false);
  } finally {f.close();}
});

test('search coverage correction identifies the exact claim and referenced evidence omitted from the examined list', () => {
  const f = scene();
  try {
    const child = f.children.find(child => child.role === 'evidence-reviewer');
    const output = f.output(child);
    output.suggestions[0].coverage.examinedEvidenceIds = [];
    output.suggestions[0].coverage.unexaminedReason = 'Other sources were not examined.';
    const before = f.repository.listArtifacts(f.project.id).length;
    assert.throws(() => f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, {...plain, scientificReview: output})), error => {
      assert.equal(error.message, 'research_scientific_search_coverage_required');
      assert.ok(error.correction.includes(f.claim.id));
      assert.ok(error.correction.includes(`missingReferencedEvidenceIds=${JSON.stringify([f.evidence.id])}`));
      return true;
    });
    assert.equal(f.repository.listArtifacts(f.project.id).length, before);
  } finally {f.close();}
});

test('frozen original locators, claim versions and read-only reviewer output are enforced before any artifact writes', () => {
  const f = scene();
  try {
    const child = f.children.find(child => child.role === 'evidence-reviewer');
    for (const mutate of [value => {value.inputHash = '0'.repeat(64);},
      value => {value.suggestions[0].claimVersion++;}, value => {value.suggestions[0].supporting[0].quote = 'Invented';},
      value => {value.suggestions[0].supporting[0].sourceDigest = '0'.repeat(64);},
      value => {value.suggestions[0].coverage.examinedEvidenceIds = [];}, value => {value.suggestions = [];}]) {
      const value = structuredClone(f.output(child)); mutate(value);
      const before = f.repository.listArtifacts(f.project.id).length;
      assert.throws(() => f.worker(child.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {...plain, scientificReview: value})));
      assert.equal(f.repository.listArtifacts(f.project.id).length, before);
    }
    assert.throws(() => f.worker(child.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {...plain, scientificReview: f.output(child),
      claims: [{experiment: {...unknownExperiment}, subjectType: 'paragraph', content: 'Unauthorized rewrite', status: 'pending', evidenceIds: []}]})), /reviewer_readonly/);
    f.complete();
    const reports = f.repository.scientificReviews.reportsForManuscript(f.project.id, f.artifactId);
    assert.equal(reports.length, 3);
    assert.ok(reports.every(report => report.status === 'current'));
    assert.equal(reports.find(report => report.output.kind === 'verifier').output.suggestions[0].negativeResults[0].quote, f.evidence.excerpt);
    assert.equal(f.repository.getWorkflow(f.project.id).currentStage, 'review');
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'approved');
  } finally {f.close();}
});

test('review tools expose only frozen material and deny cross-claim, cross-report and global retrieval', async () => {
  const f = scene();
  try {
    const child = f.children[0], context = f.repository.runs.getContext(child.id), controller = new AbortController();
    assert.ok(context.inputs.every(entry => entry.output === null && entry.ideaCanvas === null));
    assert.deepEqual(context.reviewReports, []);
    const tools = f.worker(child.id, () => api.createResearchRoleTools({run: f.repository.runs.get(child.id, f.project.id), context, repository: f.repository,
      capabilities: {invoke: async () => assert.fail('No global retrieval allowed')}, signal: controller.signal}));
    const call = (name, args) => f.worker(child.id, () => tools.find(tool => tool.name === name).invoke(args));
    assert.ok(!tools.some(tool => ['read_review_report', 'capture_evidence', 'read_source_migrations', 'save_workspace_file'].includes(tool.name)));
    await assert.rejects(call('read_artifact', {artifactId: 'other-report', offset: 0, limit: 100}), /not_in_run_inputs/);
    await assert.rejects(call('inspect_evidence_source', {evidenceId: 'other-evidence', offset: 0, limit: 100}), /not_in_run_inputs/);
    await assert.rejects(call('list_evidence_relations', {claimId: 'other-claim', offset: 0, limit: 10}), /not_in_run_inputs/);
    const result = await call('search_knowledge', {query: 'negative', limit: 10});
    assert.equal(result.scope, 'frozen_review_evidence'); assert.equal(result.hits[0].evidenceId, f.evidence.id);
    const inputs = context.inputs;
    context.inputs = [];
    await assert.rejects(call('inspect_evidence_source', {evidenceId: 'other-evidence', offset: 0, limit: 100}), /research_role_tool_binding_invalid/);
    context.inputs = inputs;
    controller.abort(new Error('review_cancelled'));
    await assert.rejects(call('inspect_evidence_source', {evidenceId: 'other-evidence', offset: 0, limit: 100}), /review_cancelled/);
  } finally {f.close();}
});

test('human dispositions bind immutable findings, exact text and current reverification before acceptance', () => {
  const f = scene();
  try {
    f.complete();
    const reports = f.repository.scientificReviews.reportsForManuscript(f.project.id, f.artifactId);
    const verifier = reports.find(report => report.output.kind === 'verifier');
    const reviewers = reports.filter(report => report.output.kind === 'reviewer');
    assert.throws(() => f.repository.scientificReviews.requireFindingDispositions(f.project.id, f.artifactId), /findings_unhandled/);
    const inspect = () => f.repository.responseMatrix.inspect({projectId: f.project.id, artifactId: f.artifactId, expectedHash: null});
    assert.equal(inspect().report.canEdit, true);
    const request = {projectId: f.project.id, artifactId: f.artifactId, requestId: 'human-1', parent: null,
      rationale: 'Human explicitly addresses one opinion and declines the other.', expectedArtifactVersion: inspect().report.artifactVersion,
      rows: reviewers.map((report, index) => ({commentId: `row-${index}`, reviewer: report.producer.role,
        comment: report.output.findings[0].observation, status: index === 0 ? 'addressed' : 'declined',
        response: index === 0 ? 'Exact qualification was checked.' : 'Human retains this methodological limitation.',
        finding: {artifactId: report.artifactId, reportHash: report.reportHash, findingId: 'f1',
          reverification: index === 0 ? {artifactId: verifier.artifactId, reportHash: verifier.reportHash} : null},
        evidenceIds: [f.evidence.id], locations: index === 0 ? [{claimId: f.claim.id, claimHash: api.relationClaimHash(f.claim),
          start: 0, end: f.claim.content.length, text: f.claim.content}] : []}))};
    const save = value => api.withResearchHumanContext({capability: 'research.responseMatrix.save', projectId: f.project.id, windowId: 24},
      () => f.repository.responseMatrix.save(value));
    assert.throws(() => f.repository.responseMatrix.save(request), /human_required/);
    const forged = structuredClone(request); forged.rows[0].finding.reportHash = '0'.repeat(64);
    assert.throws(() => save(forged), /finding_invalid/);
    const receipt = save(request);
    f.repository.scientificReviews.requireFindingDispositions(f.project.id, f.artifactId);
    assert.equal(f.repository.getWorkflow(f.project.id).currentStage, 'review');
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'review', action: 'approve', reviewDecision: 'accept',
      expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)});
    assert.equal(f.repository.getWorkflow(f.project.id).currentStage, 'export');
    f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
    assert.equal(f.repository.scientificReviews.inspect(f.project.id, verifier.artifactId).status, 'stale');
    assert.deepEqual(f.repository.responseMatrix.history({projectId: f.project.id, artifactId: f.artifactId, offset: 0, limit: 10}).items, [receipt]);
  } finally {f.close();}
});


test('known counterevidence cannot be omitted and changes invalidate frozen scientific inputs', () => {
  const f = scene({contradiction: true});
  try {
    const child = f.children.find(child => child.role === 'evidence-reviewer');
    const value = f.output(child);
    assert.throws(() => f.worker(child.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {...plain, scientificReview: value})), /counterevidence_required/);
    value.suggestions[0].counterevidence = [f.reference];
    const completed = f.worker(child.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {...plain, scientificReview: value}));
    const report = f.repository.scientificReviews.inspect(f.project.id, completed.outputArtifactIds[0]);
    assert.equal(report.status, 'current');
    assert.ok(f.repository.scientificReviews.staleReasons({...f.input, rulesVersion: 'retired'}).includes('rules_changed'));
    const changedClaim = structuredClone(f.input); changedClaim.claims[0].content += 'changed';
    assert.ok(f.repository.scientificReviews.staleReasons(changedClaim).includes('manuscript_or_claim_changed'));
    f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
    assert.ok(f.repository.scientificReviews.inspect(f.project.id, report.artifactId).reasons.includes('evidence_or_source_changed'));
    assert.throws(() => f.worker(f.children[0].id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {...plain, scientificReview: f.output(f.children[0])})), /stale/);
  } finally {f.close();}
});

test('revision lineage retains old findings and requires a verifier bound to the new manuscript', () => {
  const f = scene();
  try {
    f.complete();
    const oldReports = f.repository.scientificReviews.reportsForManuscript(f.project.id, f.artifactId);
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'review', action: 'approve', reviewDecision: 'revise',
      expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)});
    const revision = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'revision', instruction: 'Qualify results', requestId: 'revision-1'});
    withResearchTestWorker(api, f.repository, revision.id, f.project.id, workerRunId => f.repository.runs.markRunning(workerRunId, f.project.id, {providerId: 'fixture', modelId: 'fixture'}));
    const revisedId = withResearchTestWorker(api, f.repository, revision.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {...plain, title: 'Revised manuscript',
      claims: [{experiment: {...unknownExperiment}, subjectType: 'paragraph', content: 'A limited negative result with uncertainty.', status: 'supported', evidenceIds: [f.evidence.id]}],
      sections: [{title: 'Results', claimIndexes: [0]}]})).outputArtifactIds[0];
    const claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: revisedId})[0];
    const relation = f.repository.evidence.relations.list({projectId: f.project.id, claimId: claim.id})[0];
    f.repository.evidence.relations.review({projectId: f.project.id, relationId: relation.id, expectedVersion: relation.version,
      expectedClaimVersion: claim.version, expectedSourceDigest: relation.sourceDigest, decision: 'confirm', note: 'Human revision judgment.'},
      {kind: 'user', id: 'window:24'});
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'revision', action: 'complete'});
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'revision', action: 'approve',
      expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)});
    const inherited = f.repository.scientificReviews.reportsForManuscript(f.project.id, revisedId);
    assert.equal(inherited.length, 3);
    assert.ok(inherited.every(report => report.status === 'stale' && report.reasons.includes('manuscript_replaced')));
    f.parent = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'review',
      instruction: 'Review revised manuscript', requestId: 'review-2'});
    f.children = f.repository.runs.createReviewChildren(f.parent.id, f.project.id);
    f.bindReviewDependencies();
    f.claim = claim; f.input = f.repository.runs.getContext(f.parent.id).scientificInput; f.complete();
    const reports = f.repository.scientificReviews.reportsForManuscript(f.project.id, revisedId);
    assert.equal(reports.length, 6);
    const verifier = reports.find(report => report.status === 'current' && report.output.kind === 'verifier');
    const rows = reports.filter(report => report.output.kind === 'reviewer').map((report, i) => ({
      commentId: `revision-row-${i}`, reviewer: report.producer.role, comment: report.output.findings[0].observation,
      status: 'addressed', response: 'Human checked the revised qualification.', evidenceIds: [f.evidence.id],
      locations: [{claimId: claim.id, claimHash: api.relationClaimHash(claim), start: 0, end: claim.content.length, text: claim.content}],
      finding: {artifactId: report.artifactId, reportHash: report.reportHash, findingId: 'f1',
        reverification: {artifactId: verifier.artifactId, reportHash: verifier.reportHash}}
    }));
    const forged = structuredClone(rows), oldVerifier = oldReports.find(report => report.output.kind === 'verifier');
    forged[0].finding.reverification = {artifactId: oldVerifier.artifactId, reportHash: oldVerifier.reportHash};
    assert.equal(f.repository.scientificReviews.findingRowsIssue(f.project.id, revisedId, forged), 'research_response_reverification_required');
    const save = value => api.withResearchHumanContext({capability: 'research.responseMatrix.save', projectId: f.project.id, windowId: 24},
      () => f.repository.responseMatrix.save(value));
    const request = {projectId: f.project.id, artifactId: revisedId, requestId: 'revision-matrix', parent: null, rationale: 'Address every review round.', rows,
      expectedArtifactVersion: f.repository.responseMatrix.inspect({projectId: f.project.id, artifactId: revisedId, expectedHash: null}).report.artifactVersion};
    save(request);
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'review', action: 'approve', reviewDecision: 'accept',
      expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)});
    assert.equal(f.repository.getWorkflow(f.project.id).currentStage, 'export');
    assert.equal(f.repository.scientificReviews.inspect(f.project.id, oldReports[0].artifactId).reportHash, oldReports[0].reportHash);
  } finally {f.close();}
});
