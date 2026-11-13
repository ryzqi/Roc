import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {Annotation, Command, END, MemorySaver, START, StateGraph} from '@langchain/langgraph';
import {unknownExperiment, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createScientificReviewFixture} from './fixtures/scientific-review.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

function waitingReviewWithUnreviewedSummary() {
  const f = createScientificReviewFixture(api);
  const reports = f.children.map(child => f.worker(child.id, id => f.repository.runs.complete(id, f.project.id, {
    title: child.role, markdown: 'Independent review.', claims: [], sections: [], verdict: 'uncertain',
    scientificReview: f.output(child)
  })));
  f.worker(f.parent.id, id => f.repository.runs.setReviewReports(id, f.project.id, reports));
  f.worker(f.parent.id, id => f.repository.runs.complete(id, f.project.id, {
    title: 'Summary requiring correction', markdown: 'The summary source has not been confirmed.',
    claims: [{experiment: {...unknownExperiment}, subjectType: 'paragraph', content: 'Unreviewed summary assertion.', status: 'supported',
      evidenceIds: [f.evidence.id]}], sections: [], verdict: 'uncertain'
  }));
  f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'review', action: 'complete'});
  const matrix = f.repository.responseMatrix.inspect({projectId: f.project.id, artifactId: f.artifactId, expectedHash: null});
  api.withResearchHumanContext({capability: 'research.responseMatrix.save', projectId: f.project.id, windowId: 24}, () =>
    f.repository.responseMatrix.save({
      projectId: f.project.id, artifactId: f.artifactId, requestId: 'retain-review-findings',
      expectedArtifactVersion: matrix.report.artifactVersion, parent: null, rationale: 'Retain the unresolved finding.',
      rows: [{commentId: 'c1', reviewer: 'Human', comment: 'Retain uncertainty.', status: 'open',
        response: 'Still requires revision.', locations: [], evidenceIds: []}]
    }));
  return f;
}

async function gateGraph(f) {
  const transitions = [];
  const tools = api.createResearchTools({
    projectId: f.project.id, signal: new AbortController().signal,
    dispatchStage: async () => assert.fail('a human decision cannot dispatch a model'),
    dispatchReviewQuery: async () => assert.fail('unexpected search'),
    capabilities: {invoke: async (name, input) => {
      if (name === 'research.workflow.get') return f.repository.getWorkflow(f.project.id);
      if (name === 'research.workflow.gateReview') return f.repository.readGateReviewContext(input);
      if (name === 'research.workflow.transition') {
        transitions.push(input);
        return f.repository.transitionWorkflow(input);
      }
      assert.fail(name);
    }}
  });
  const gate = tools.find(tool => tool.name === 'research_approve_gate');
  const graph = new StateGraph(Annotation.Root({done: Annotation()})).addNode('gate', async () => {
    await gate.invoke({});
    return {done: true};
  }).addEdge(START, 'gate').addEdge('gate', END).compile({checkpointer: new MemorySaver()});
  const config = {configurable: {thread_id: f.project.id}};
  const pending = await graph.invoke({done: false}, config);
  const versions = pending.__interrupt__[0].value.request.actionRequests[0].args.artifactLinks
    .map(link => ({artifactId: link.artifactId, version: link.expectedVersion}));
  return {transitions, graph, config, versions};
}

test('rejecting the actual review gate permits correction without approving unreviewed summary claims or losing findings', async () => {
  const f = waitingReviewWithUnreviewedSummary();
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {
    prepare: async () => assert.fail('saved review must not dispatch a model')
  }, api.createResearchHumanGate({repository: f.repository}), {cancelOwned: async () => {}});
  try {
    await runtime.recoverPendingOutputs();
    const failed = f.tasks.get(f.parent.taskId, f.project.id);
    assert.equal(failed.statusReason, 'research_stage_inputs_stale');
    const cycle = f.repository.reviews.get(f.project.id);
    const history = f.repository.responseMatrix.history({projectId: f.project.id, artifactId: f.artifactId, offset: 0, limit: 10});
    const gate = await gateGraph(f);
    const result = await gate.graph.invoke(new Command({resume: {decisions: [{
      type: 'reject', reviewedArtifactVersions: gate.versions, message: 'Correct the summary source mismatch.'
    }]}}), gate.config);
    assert.equal(result.done, true, 'reject must finish instead of requesting support confirmation');
    assert.equal(gate.transitions[0].action, 'reject');
    assert.equal(gate.transitions[0].reviewDecision, undefined);
    const workflow = f.repository.getWorkflow(f.project.id);
    assert.equal(workflow.currentStage, 'review');
    assert.equal(workflow.stages.find(stage => stage.stage === 'review').status, 'running');
    assert.equal(workflow.stages.find(stage => stage.stage === 'review').gateApproved, false);
    assert.deepEqual(f.repository.reviews.get(f.project.id), cycle);
    assert.deepEqual(f.tasks.get(f.parent.taskId, f.project.id), failed);
    assert.deepEqual(f.repository.responseMatrix.history({
      projectId: f.project.id, artifactId: f.artifactId, offset: 0, limit: 10
    }), history);
    assert.equal(f.repository.listArtifacts(f.project.id, 'review')
      .some(artifact => artifact.status === 'approved'), false);
    const replacement = f.repository.runs.begin({
      projectId: f.project.id, expectedStage: 'review', instruction: 'Correct the rejected summary.', requestId: 'correct-review'
    });
    assert.notEqual(replacement.id, f.parent.id);
    assert.deepEqual(f.repository.responseMatrix.history({
      projectId: f.project.id, artifactId: f.artifactId, offset: 0, limit: 10
    }), history);
  } finally { await runtime.shutdown(); f.close(); }
});

for (const type of ['approve', 'revise']) {
  test(`${type} still requires support confirmation for review summary claims`, async () => {
    const f = waitingReviewWithUnreviewedSummary();
    try {
      const before = f.repository.getWorkflow(f.project.id);
      const gate = await gateGraph(f);
      const result = await gate.graph.invoke(new Command({resume: {decisions: [{
        type, reviewedArtifactVersions: gate.versions
      }]}}), gate.config);
      assert.equal(result.done, false);
      assert.equal(result.__interrupt__.length, 1);
      assert.equal(gate.transitions[0].action, 'approve');
      assert.equal(gate.transitions[0].reviewDecision, type === 'revise' ? 'revise' : 'accept');
      assert.deepEqual(f.repository.getWorkflow(f.project.id), before);
    } finally { f.close(); }
  });
}
