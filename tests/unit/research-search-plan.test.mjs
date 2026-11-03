import assert from 'node:assert/strict';
import {captureResearchArtifactVersions} from './fixtures/research-test-kit.mjs';
import { after, before, test } from 'node:test';
import { createResearchFixture, loadResearchTestApi, researchSearchPlanFixture } from './fixtures/research-test-kit.mjs';
import { Annotation, Command, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api?.dispose());
const output = {title: 'Search proposal', markdown: 'Proposed research strategy', claims: [], sections: [], verdict: 'ready'};
const query = {query: 'frozen query', sources: ['crossref'], limit: 1, maxPages: 2, yearFrom: 2020, yearTo: 2026};

async function confirm(f) {
  const completed = f.repository.runs.complete(f.run.id, f.project.id,
    {...output, searchPlan: researchSearchPlanFixture(f.run.instruction, [query])});
  const gate = api.createResearchHumanGate({repository: f.repository});
  await gate.complete({projectId: f.project.id, expectedStage: 'discovery', action: 'complete'});
  assert.equal(f.repository.getWorkflow(f.project.id).currentStage, 'discovery');
  assert.equal(f.repository.getArtifact(completed.outputArtifactIds[0]).status, 'draft');
  await gate.approve({projectId: f.project.id, expectedStage: 'discovery', action: 'approve', expectedArtifactVersions:captureResearchArtifactVersions(f.repository,f.project.id),
    expectedSearchPlanHash: api.searchPlanApprovalHash(f.project.id, completed.outputArtifactIds[0],
      f.repository.runs.getArtifactContent(f.project.id, completed.outputArtifactIds[0]).output)});
  const queued = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'retrieval', instruction: 'Execute approved plan', requestId: 'retrieval'});
  const run = f.repository.runs.markRunning(queued.id, f.project.id, {providerId: 'fixture', modelId: 'fixture'});
  return {run, artifactId: completed.outputArtifactIds[0], context: f.repository.runs.getContext(run.id)};
}

function importer(f, fetchImpl) {
  const search = new api.LiteratureSearchService(fetchImpl);
  const service = new api.LiteratureImportService(f.db, f.repository.library, search, {},
    async () => { assert.fail('search cannot mutate the library'); });
  return {service, search};
}

test('discovery refuses an untyped search proposal before creating an artifact', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    assert.throws(() => f.repository.runs.complete(f.run.id, f.project.id, output), /research_search_plan_required/u);
    assert.deepEqual(f.repository.listArtifacts(f.project.id), []);
    assert.throws(() => f.repository.runs.complete(f.run.id, f.project.id,
      {...output, searchPlan: researchSearchPlanFixture(f.run.instruction, [query, {...query, limit: 30}, {...query, limit: 30}])}),
      /research_search_plan_candidate_budget_exceeded/u);
    assert.equal(f.repository.runs.get(f.run.id, f.project.id).status, 'running');
  } finally { f.close(); }
});

test('original research question cannot be replaced by the model or smuggled into another stage', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    assert.throws(() => f.repository.runs.complete(f.run.id, f.project.id,
      {...output, searchPlan: researchSearchPlanFixture('Changed original question')}), /research_search_question_changed/u);
    assert.deepEqual(f.repository.listArtifacts(f.project.id), []);
  } finally { f.close(); }
  const other = createResearchFixture(api, 'planning');
  try {
    assert.throws(() => other.repository.runs.complete(other.run.id, other.project.id,
      {...output, searchPlan: researchSearchPlanFixture(other.run.instruction)}), /research_search_plan_stage_invalid/u);
  } finally { other.close(); }
});

test('human approval freezes visible plan content and retrieval tools select only approved query indices', async () => {
  const f = createResearchFixture(api, 'discovery');
  const http = [];
  const {service, search} = importer(f, async url => {
    http.push(new URL(url));
    return Response.json({message: {'total-results': 2, items: [{DOI: `10.1234/plan-${http.length}`, title: ['Plan paper'], published: {'date-parts': [[2024]]}}]}});
  });
  try {
    const {run, artifactId, context} = await confirm(f);
    const artifact = f.repository.runs.getArtifactContent(f.project.id, artifactId);
    assert.match(artifact.output.markdown, /待确认检索计划/u);
    assert.match(artifact.output.markdown, /yearFrom/u);
    assert.equal(artifact.output.searchPlan.researchQuestion, f.run.instruction);
    const tools = api.createResearchRoleTools({run, context, repository: f.repository,
      capabilities: {invoke: (name, request) => {
        assert.equal(name, 'research.literature.search');
        return service.search(request);
      }}, signal: new AbortController().signal});
    const tool = tools.find(tool => tool.name === 'search_literature');
    assert.deepEqual(Object.keys(tool.schema.shape), ['queryIndex']);
    await assert.rejects(tool.invoke({queryIndex: 1}), /research_search_query_index_invalid/u);
    await assert.rejects(tool.invoke({queryIndex: 0, query: 'changed query'}));
    assert.equal(http.length, 0);
    const result = await tool.invoke({queryIndex: 0});
    assert.equal(http.length, 2);
    assert.ok(http.every(url => url.searchParams.get('query') === query.query));
    assert.deepEqual(http.map(url => url.searchParams.get('offset')), ['0', '1']);
    assert.deepEqual(result.strategy, {artifactId, contentHash: api.requireConfirmedSearchStrategy(f.repository, context).contentHash,
      approvedAt: f.repository.getArtifact(artifactId).updatedAt, researchQuestion: f.run.instruction, queryIndex: 0});
    const execution = JSON.parse(f.db.prepare('SELECT request_json FROM research_literature_search_executions WHERE id=?').pluck().get(result.executionId));
    assert.deepEqual(execution.strategy, result.strategy);
    assert.deepEqual(execution.request, {...query, projectId: f.project.id});
    assert.equal(f.repository.library.list({projectId: f.project.id, query: '', includeArchived: false, limit: 10}).length, 0);
  } finally { await search.shutdown(); f.close(); }
});

test('manual artifacts, missing human approval and changed plan contents cannot authorize retrieval', async () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const completed = f.repository.runs.complete(f.run.id, f.project.id,
      {...output, searchPlan: researchSearchPlanFixture(f.run.instruction, [query])});
    const gate = api.createResearchHumanGate({repository: f.repository});
    await gate.complete({projectId: f.project.id, expectedStage: 'discovery', action: 'complete'});
    const artifactId = completed.outputArtifactIds[0];
    const frozen = {project: f.project, inputs: [{artifact: {...f.repository.getArtifact(artifactId), status: 'approved'},
      output: f.repository.runs.getArtifactContent(f.project.id, artifactId).output}]};
    assert.throws(() => api.requireConfirmedSearchStrategy(f.repository, frozen), /research_confirmed_search_plan_required/u);
    await gate.approve({projectId: f.project.id, expectedStage: 'discovery', action: 'approve', expectedArtifactVersions:captureResearchArtifactVersions(f.repository,f.project.id),
      expectedSearchPlanHash: api.searchPlanApprovalHash(f.project.id, artifactId, frozen.inputs[0].output)});
    const queued = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'retrieval', instruction: 'Retrieve', requestId: 'plan-stale'});
    const context = f.repository.runs.getContext(queued.id);
    const strategy = api.requireConfirmedSearchStrategy(f.repository, context);
    f.db.prepare(`UPDATE research_artifact_contents SET output_json=json_set(output_json,'$.searchPlan.queries[0].query','changed') WHERE artifact_id=?`).run(artifactId);
    assert.throws(() => strategy.assertCurrent(), /research_search_plan_review_missing/u);
    assert.throws(() => f.repository.runs.begin({projectId: f.project.id, expectedStage: 'retrieval', instruction: 'Retrieve', requestId: 'other'}), /research_stage_run_active/u);
  } finally { f.close(); }
  const manual = createResearchFixture(api, 'discovery');
  try {
    manual.repository.createArtifact({projectId: manual.project.id, stage: 'discovery', kind: 'search_strategy', title: 'Manual placeholder', path: null});
    manual.repository.runs.terminate(manual.run.id, manual.project.id, 'failed', 'fixture');
    manual.db.prepare("UPDATE research_stage_states SET status='running' WHERE project_id=? AND stage='discovery'").run(manual.project.id);
    await assert.rejects(api.createResearchHumanGate({repository: manual.repository}).complete({projectId: manual.project.id, expectedStage: 'discovery', action: 'complete'}), /research_search_plan_required/u);
  } finally { manual.close(); }
});

test('import boundary rejects parameter drift and missing query identity before dispatch', async () => {
  const f = createResearchFixture(api, 'discovery');
  let calls = 0;
  const {service, search} = importer(f, async () => { calls++; return Response.json({message: {items: []}}); });
  try {
    const {context, run} = await confirm(f);
    const scope = {owner: `stage:${run.id}`, projectId: f.project.id, runId: run.id,
      searchStrategy: api.requireConfirmedSearchStrategy(f.repository, context)};
    for (const parameters of [{...query, query: 'changed'}, {...query, sources: ['openalex']},
      {...query, yearFrom: 2021}, {...query, maxPages: 3}, {...query, limit: 2}]) {
      await assert.rejects(api.withLiteratureContext({...scope, queryIndex: 0}, () => service.search(parameters)), /research_search_query_changed/u);
    }
    await assert.rejects(api.withLiteratureContext(scope, () => service.search(query)), /research_search_query_index_required/u);
    assert.equal(calls, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_search_executions').pluck().get(), 0);
  } finally { await search.shutdown(); f.close(); }
});

test('superseded plan between pages stops the next HTTP request and retains the original audit identity', async () => {
  const f = createResearchFixture(api, 'discovery');
  let calls = 0, artifactId;
  const {service, search} = importer(f, async () => {
    calls++;
    f.db.prepare("UPDATE research_artifacts SET status='superseded' WHERE id=?").run(artifactId);
    return Response.json({message: {'total-results': 2, items: [{DOI: '10.1234/stale-plan', title: ['Stale plan'] }]}});
  });
  try {
    const confirmed = await confirm(f);
    artifactId = confirmed.artifactId;
    const scope = {owner: `stage:${confirmed.run.id}`, projectId: f.project.id, runId: confirmed.run.id,
      searchStrategy: api.requireConfirmedSearchStrategy(f.repository, confirmed.context), queryIndex: 0};
    await assert.rejects(api.withLiteratureContext(scope, () => service.search(query)), /literature_request_audit_failed/u);
    assert.equal(calls, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_searches').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_request_receipts').pluck().get(), 1);
    const request = JSON.parse(f.db.prepare('SELECT request_json FROM research_literature_search_executions').pluck().get());
    assert.equal(request.strategy.artifactId, artifactId);
    assert.equal(request.strategy.researchQuestion, f.run.instruction);
    assert.equal(f.db.prepare('SELECT status FROM research_literature_search_executions').pluck().get(), 'failed');
  } finally { await search.shutdown(); f.close(); }
});

test('actual gate interrupt carries the visible plan and requires its original hash across resume', async () => {
  for (const change of ['none', 'valid_content', 'missing_hash']) {
    const f = createResearchFixture(api, 'discovery');
    try {
      const completed = f.repository.runs.complete(f.run.id, f.project.id,
        {...output, searchPlan: researchSearchPlanFixture(f.run.instruction, [query])});
      const artifactId = completed.outputArtifactIds[0];
      const gate = api.createResearchHumanGate({repository: f.repository});
      await gate.complete({projectId: f.project.id, expectedStage: 'discovery', action: 'complete'});
      const tools = api.createResearchTools({projectId: f.project.id, signal: new AbortController().signal,
        dispatchStage: async () => assert.fail('gate cannot dispatch a model'),
        capabilities: {invoke: async (name, request) => {
          if (name === 'research.workflow.get') return f.repository.getWorkflow(f.project.id);
          if (name === 'research.artifacts.list') return f.repository.listArtifacts(f.project.id);
          if (name === 'research.workflow.gateReview') return f.repository.readGateReviewContext(request);
          if (name === 'research.artifacts.content') return f.repository.runs.getArtifactContent(f.project.id, request.artifactId);
          if (name === 'research.workflow.transition') return gate.approve(request);
          assert.fail(name);
        }}});
      const gateTool = tools.find(tool => tool.name === 'research_approve_gate');
      const state = Annotation.Root({done: Annotation()});
      const graph = new StateGraph(state).addNode('gate', async () => { await gateTool.invoke({}); return {done: true}; })
        .addEdge(START, 'gate').addEdge('gate', END).compile({checkpointer: new MemorySaver()});
      const config = {configurable: {thread_id: `gate-${change}`}};
      const pending = await graph.invoke({done: false}, config);
      const args = pending.__interrupt__[0].value.request.actionRequests[0].args;
      assert.deepEqual(args.searchPlan.queries, [query]);
      assert.equal(args.searchPlan.researchQuestion, f.run.instruction);
      assert.match(args.searchPlanHash, /^[a-f0-9]{64}$/u);
      assert.equal(args.artifactLinks.length,1);
      assert.equal(args.artifactLinks[0].artifactId,artifactId);
      assert.equal(args.artifactLinks[0].projectId,f.project.id);
      assert.match(args.artifactLinks[0].expectedVersion,/^[a-f0-9]{64}$/u);
      assert.equal(args.artifactTitles,undefined);
      if (change === 'valid_content') {
        const stored = f.repository.runs.getArtifactContent(f.project.id, artifactId).output;
        stored.title = 'Changed title after review';
        f.db.prepare('UPDATE research_artifact_contents SET output_json=? WHERE artifact_id=?').run(JSON.stringify(stored), artifactId);
      }
      const decision = {type: 'approve', reviewedArtifactVersions:args.artifactLinks.map(link=>({artifactId:link.artifactId,version:link.expectedVersion})), ...(change === 'missing_hash' ? {} : {reviewedSearchPlanHash: args.searchPlanHash})};
      const resume = graph.invoke(new Command({resume: {decisions: [decision]}}), config);
      if (change === 'none') {
        assert.equal((await resume).done, true);
        assert.equal(f.repository.getWorkflow(f.project.id).currentStage, 'retrieval');
        assert.equal(f.repository.getArtifact(artifactId).status, 'approved');
      } else {
        const retry=await resume;
        assert.equal(retry.done,false);
        assert.equal(retry.__interrupt__[0].value.request.actionRequests[0].args.reviewError,'research_search_plan_approval_changed');
        assert.equal(f.repository.getWorkflow(f.project.id).currentStage, 'discovery');
        assert.equal(f.repository.getArtifact(artifactId).status, 'draft');
      }
    } finally { f.close(); }
  }
});
