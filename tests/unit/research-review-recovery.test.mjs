import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createScientificReviewFixture} from './fixtures/scientific-review.mjs';

const api = await loadResearchTestApi();
after(() => api.dispose());
const plain = {title: 'Panel', markdown: 'Retain uncertainty.', claims: [], sections: [], verdict: 'revise'};

for (const failures of [0, 1]) {
  test(`synthesis retry preserves three current independent reports after ${failures + 1} failures`, async () => {
    const f = createScientificReviewFixture(api);
    const completed = f.children.map(child => f.worker(child.id, id =>
      f.repository.runs.complete(id, f.project.id, {...plain, scientificReview: f.output(child)})));
    f.worker(f.parent.id, id => f.repository.runs.setReviewReports(id, f.project.id, completed));
    f.repository.runs.terminate(f.parent.id, f.project.id, 'failed', 'research_role_execution_failed');
    let calls = 0;
    const runtime = new api.ResearchStageRuntime(f.repository, {}, {async prepare() {
      return {providerId: 'fixture', modelId: 'fixture', async execute({run, context}) {
        calls += 1;
        assert.equal(run.parentRunId, null, 'completed reviewers must not be dispatched again');
        assert.deepEqual(context.reviewReports.map(report => report.runId), completed.map(child => child.id));
        if (calls <= failures) throw new Error('research_role_execution_failed');
        return {modelVersion: null, output: plain};
      }};
    }}, api.createResearchHumanGate({repository: f.repository}), {cancelOwned: async () => {}});
    try {
      let previous = f.parent;
      for (let index = 0; index <= failures; index += 1) {
        previous = runtime.retry({projectId: f.project.id, runId: previous.id, requestId: `panel-retry-${index}`});
        await runtime.waitForIdle();
      }
      assert.equal(calls, failures + 1);
      const saved = f.repository.runs.get(previous.id, f.project.id);
      assert.equal(saved.status, 'completed');
      const reports = completed.map(child => child.outputArtifactIds[0]);
      f.repository.runs.requireReviewPanel(f.project.id, [...reports, ...saved.outputArtifactIds]);
      for (const id of reports) {
        assert.equal(f.repository.getArtifact(id).status, 'draft');
        assert.equal(f.repository.scientificReviews.inspect(f.project.id, id).status, 'current');
      }
      const graph = f.tasks.graph.read(saved.taskId, f.project.id);
      const binding = f.tasks.requireExecution('stage', saved.id, f.project.id).nodeBinding;
      const dependencies = graph.edges.filter(edge => edge.dependent === binding.nodeId);
      assert.equal(dependencies.length, 3);
      assert.deepEqual(new Set(dependencies.map(edge => graph.nodes.find(node => node.id === edge.prerequisite).executionId)),
        new Set(completed.map(child => child.id)));
      assert.equal(f.tasks.get(saved.taskId, f.project.id).status, 'waiting_approval');
      assert.equal(f.repository.getWorkflow(f.project.id).stages.find(stage => stage.stage === 'review').gateApproved, false);
    } finally {await runtime.shutdown(); f.close();}
  });
}

test('synthesis retry refuses changed scientific inputs before reusing reports', () => {
  const f = createScientificReviewFixture(api);
  try {
    const completed = f.children.map(child => f.worker(child.id, id =>
      f.repository.runs.complete(id, f.project.id, {...plain, scientificReview: f.output(child)})));
    f.worker(f.parent.id, id => f.repository.runs.setReviewReports(id, f.project.id, completed));
    f.repository.runs.terminate(f.parent.id, f.project.id, 'failed', 'research_role_execution_failed');
    f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
    assert.throws(() => f.repository.runs.retry({projectId: f.project.id, runId: f.parent.id,
      requestId: 'stale-panel-retry'}), /research_evidence_reference_superseded/);
    assert.equal(f.repository.runs.list({projectId: f.project.id, limit: 100})
      .filter(run => run.retryOfRunId === f.parent.id).length, 0);
  } finally {f.close();}
});

for (const [label, mutate] of [
  ['incomplete set', context => context.reviewReports.pop()],
  ['duplicate role', context => {context.reviewReports[1] = context.reviewReports[0];}],
  ['changed saved report', context => {context.reviewReports[0].output.markdown += ' Altered.';}]
]) {
  test(`synthesis retry rejects ${label} without superseding valid reports`, () => {
    const f = createScientificReviewFixture(api);
    try {
      const completed = f.children.map(child => f.worker(child.id, id =>
        f.repository.runs.complete(id, f.project.id, {...plain, scientificReview: f.output(child)})));
      f.worker(f.parent.id, id => f.repository.runs.setReviewReports(id, f.project.id, completed));
      f.repository.runs.terminate(f.parent.id, f.project.id, 'failed', 'research_role_execution_failed');
      const context = f.repository.runs.getContext(f.parent.id);
      mutate(context);
      f.db.prepare('UPDATE research_stage_runs SET context_json=? WHERE id=?').run(JSON.stringify(context), f.parent.id);
      assert.throws(() => f.repository.runs.retry({projectId: f.project.id, runId: f.parent.id,
        requestId: `invalid-${label}`}), /research_review_panel_incomplete|research_review_report_changed/);
      assert.equal(f.repository.runs.list({projectId: f.project.id, limit: 100})
        .filter(run => run.retryOfRunId === f.parent.id).length, 0);
      for (const child of completed) assert.equal(f.repository.getArtifact(child.outputArtifactIds[0]).status, 'draft');
    } finally {f.close();}
  });
}

test('synthesis read progress counts contiguous pages and tells the model when all reports are read', async () => {
  const f = createScientificReviewFixture(api);
  try {
    const completed = f.children.map(child => f.worker(child.id, id =>
      f.repository.runs.complete(id, f.project.id, {...plain, scientificReview: f.output(child)})));
    f.worker(f.parent.id, id => f.repository.runs.setReviewReports(id, f.project.id, completed));
    const context = f.repository.runs.getContext(f.parent.id);
    const tool = f.worker(f.parent.id, () => api.createResearchRoleTools({
      run: f.repository.runs.get(f.parent.id, f.project.id), context, repository: f.repository,
      capabilities: {}, signal: new AbortController().signal
    })).find(entry => entry.name === 'read_review_report');
    const read = (artifactId, offset, limit) => f.worker(f.parent.id, () => tool.invoke({artifactId, offset, limit}));
    const firstId = context.reviewReports[0].artifactId;
    const tail = await read(firstId, 100, 8000);
    assert.equal(tail.nextOffset, null);
    assert.equal(tail.readProgress.reports[0].complete, false, 'a terminal page with a gap is not a complete read');
    assert.equal(tail.readProgress.reports[0].nextUnreadOffset, 0);
    const head = await read(firstId, 0, 100);
    assert.equal(head.readProgress.reports[0].complete, true);
    let result;
    for (const report of context.reviewReports.slice(1)) result = await read(report.artifactId, 0, 8000);
    assert.equal(result.readProgress.allReportsRead, true);
    assert.match(result.readProgress.nextAction, /submit the structured synthesis now/);
    const reread = await read(firstId, 0, 100);
    assert.deepEqual(reread.readProgress, result.readProgress, 'rereading must not fabricate new progress to evade the loop guard');
  } finally {f.close();}
});
