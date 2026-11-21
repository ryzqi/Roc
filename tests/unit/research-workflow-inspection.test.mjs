import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {createResearchFixture, loadResearchTestApi, unknownExperiment, withResearchTestWorker} from './fixtures/research-test-kit.mjs';
import {ideaCanvasContentFixture, ideaPlanBodyFixture} from './fixtures/research-idea-plan.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());

function connect(f) {
  const calls = [], registry = new api.CapabilityRegistry();
  const context = {pluginId: 'research', capabilities: {register(owner, descriptor, handler) {
    registry.declare(owner, descriptor); registry.register(owner, descriptor, handler);
  }}};
  api.registerResearchCitationCoverageCapability(context, new api.ResearchCitationCoverageService(f.repository));
  api.registerResearchConsistencyCapabilities(context, new api.ResearchConsistencyService(f.repository,
    {evidence: async () => assert.fail('No result mappings are stored')}), f.repository.consistency);
  api.registerResearchResponseMatrixCapabilities(context, f.repository.responseMatrix);
  const journal = new api.ResearchJournalComplianceService(f.repository, {verify: async () => assert.fail('No figure selection')});
  api.registerResearchJournalComplianceCapabilities(context, journal, f.repository.journalCompliance);
  api.registerResearchIdeaPlanCapabilities(context, f.repository.ideaPlans);
  const tool = api.createResearchTools({projectId: f.project.id, signal: new AbortController().signal,
    dispatchReviewQuery: async () => assert.fail('Read only'), dispatchStage: async () => assert.fail('Read only'),
    capabilities: {invoke: async (name, request, signal) => {
      calls.push(name); return await registry.invoke(name, request, signal);
    }}}).find(item => item.name === 'research_inspect_workflow');
  return {tool, calls, journal};
}

async function manuscriptScene() {
  const f = createResearchFixture(api, 'writing');
  f.repository.knowledge.upsertFromSource({id: 'workflow-source', projectId: f.project.id, sourceType: 'file',
    sourceId: 'observations.md', title: 'Observed measurements', content: 'Mean 42 ms.',
    chunks: [{content: 'Mean 42 ms.', locator: 'block:0'}], embeddingPolicy: 'none'});
  f.source = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'workflow-source:chunk:0'});
  f.artifactId = withResearchTestWorker(api, f.repository, f.run.id, f.project.id, workerRunId =>
    f.repository.runs.complete(workerRunId, f.project.id, {title: 'Measured result', markdown: 'Observed result',
      claims: [{experiment: {...unknownExperiment}, subjectType: 'paragraph', content: 'Mean 42 ms.', status: 'supported', evidenceIds: [f.source.id]}],
      sections: [{title: 'Results', claimIndexes: [0]}], verdict: 'ready'})).outputArtifactIds[0];
  f.claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
  await f.idle();
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  return f;
}

test('assembled main assistant checks actual manuscript sources without writing reviews or approving artifacts', async () => {
  const f = await manuscriptScene();
  try {
    const c = connect(f), before = f.changes(), request = {artifactId: f.artifactId, expectedHash: null};
    const coverage = await c.tool.invoke({kind: 'citation_coverage', ...request});
    assert.equal(coverage.data.report.paragraphs[0].claim.id, f.claim.id);
    assert.equal(coverage.data.report.sources[0].source.evidence.excerpt, f.source.excerpt);
    assert.ok(coverage.findings.some(item => item.code === 'citation_unreviewed_directness'));
    const consistency = await c.tool.invoke({kind: 'consistency', ...request});
    assert.equal(consistency.data.report.unmappedLocations[0].text, '42');
    assert.equal(consistency.status, 'attention_required');
    const response = await c.tool.invoke({kind: 'response_matrix', ...request});
    assert.equal(response.data.report.review, null); assert.equal(response.findings[0].code, 'response_matrix_missing');
    const journal = await c.tool.invoke({kind: 'journal_compliance', ...request});
    assert.equal(journal.data.report.selection, null); assert.equal(journal.findings[0].code, 'journal_rules_missing');
    assert.equal(f.changes(), before);
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
    assert.deepEqual(c.calls, ['research.manuscript.citationCoverage', 'research.consistency.inspect',
      'research.responseMatrix.inspect', 'research.journalCompliance.inspect']);

    const other = f.repository.createProject({title: 'Other project', description: 'Isolated project', workspacePath: '/tmp/roc-workflow-other'});
    f.db.prepare("UPDATE research_projects SET current_stage = 'writing' WHERE id = ?").run(other.id);
    f.db.prepare("UPDATE research_stage_states SET status = 'ready' WHERE project_id = ? AND stage = 'writing'").run(other.id);
    const artifact = f.repository.createArtifact({projectId: other.id, stage: 'writing', kind: 'manuscript', title: 'Other draft', path: null});
    const beforeDenied = f.changes();
    await assert.rejects(c.tool.invoke({kind: 'citation_coverage', artifactId: artifact.id, expectedHash: null}),
      error => error.code === 'research_manuscript_project_mismatch');
    assert.equal(f.changes(), beforeDenied);
  } finally {await f.close();}
});

test('actual saved journal rules preserve failed requirements and missing human judgments', async () => {
  const f = await manuscriptScene();
  try {
    const c = connect(f), selection = {profile: {journal: 'Fixture Journal', articleType: 'Article', submissionStage: 'Review',
      version: 'fixture-1', revisionDate: '2026-11-21', dateAuthority: 'human_transcription', retrievedAt: '2026-11-21T00:00:00.000Z', rules: [
        {id: 'methods', label: 'Methods section', sourceUrl: 'https://example.test/instructions', excerpt: 'Include Methods.', authority: 'required',
          kind: 'sections', titles: ['Methods']},
        {id: 'scope', label: 'Scope', sourceUrl: 'https://example.test/instructions', excerpt: 'Check scope.', authority: 'guidance', kind: 'manual', area: 'structure'}
      ]}, figureIds: [], supplementPaths: [], manualReviews: []};
    const preview = await c.journal.inspect({projectId: f.project.id, artifactId: f.artifactId, expectedHash: null, selection});
    await api.withResearchHumanContext({capability: 'research.journalCompliance.save', projectId: f.project.id, windowId: 33},
      () => c.journal.save({projectId: f.project.id, artifactId: f.artifactId, requestId: 'journal-review',
        expectedArtifactVersion: preview.report.artifactVersion, expectedMaterialHash: preview.report.materialHash,
        parent: null, rationale: 'Human selected source rules', selection}));
    await f.idle();
    const before = f.changes();
    const result = await c.tool.invoke({kind: 'journal_compliance', artifactId: f.artifactId, expectedHash: null});
    assert.deepEqual(result.data.report.selection, selection);
    assert.equal(result.data.report.review.snapshot.actor.id, 'window:33');
    assert.ok(result.findings.some(item => item.code === 'journal_rule_failed' && item.subjectIds.includes('methods')));
    assert.ok(result.nextActions.some(item => item.code === 'journal_manual_review' && item.actor === 'human'));
    assert.equal(f.changes(), before);
  } finally {await f.close();}
});

test('method plan reads retain exact human freeze state and refuse guessed version hashes', async () => {
  const f = createResearchFixture(api, 'ideation');
  try {
    const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'ideation', kind: 'idea_canvas', title: 'Testable idea', path: null});
    const canvas = f.repository.ideas.save({artifactId: artifact.id, expectedVersion: null, ...ideaCanvasContentFixture()});
    const c = connect(f), empty = await c.tool.invoke({kind: 'idea_plans', artifactId: artifact.id, offset: 0, limit: 10});
    assert.equal(empty.findings[0].code, 'idea_plan_missing');
    const saved = api.withResearchHumanContext({capability: 'research.ideaPlans.save', projectId: f.project.id, windowId: 33},
      () => f.repository.ideaPlans.save({projectId: f.project.id, artifactId: artifact.id, requestId: 'method-plan',
        canvas: {version: canvas.version, contentHash: canvas.contentHash}, parent: null, revisionReason: null, body: ideaPlanBodyFixture()}));
    await f.idle();
    const before = f.db.prepare('SELECT total_changes()').pluck().get();
    const page = await c.tool.invoke({kind: 'idea_plans', artifactId: artifact.id, offset: 0, limit: 10});
    const exact = {kind: 'idea_plan', artifactId: artifact.id, versionId: page.data.items[0].version.id, expectedHash: page.data.items[0].versionHash};
    const result = await c.tool.invoke(exact);
    assert.equal(result.data.versionHash, saved.versionHash); assert.equal(result.data.freeze, null);
    assert.equal(result.verification, 'stored_receipt');
    assert.ok(result.nextActions.some(item => item.code === 'idea_plan_not_frozen' && item.actor === 'human'));
    await assert.rejects(c.tool.invoke({...exact, expectedHash: 'f'.repeat(64)}), error => error.code === 'research_idea_plan_version_conflict');
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), before);
  } finally {await f.close();}
});
