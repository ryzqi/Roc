import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {loadResearchTestApi} from '../tests/unit/fixtures/research-test-kit.mjs';
import {createScientificReviewFixture} from '../tests/unit/fixtures/scientific-review.mjs';

// A scheduling experiment with controlled outputs, not independent scientific tasks.
const protocol = {version: 1, kind: 'synthetic_engineering', scenarios: 30, repetitions: 3,
  concurrency: [1, 2], model: 'controlled-fixture', realModelCost: null,
  adoption: 'requires_independent_quality_and_cost_evidence'};
const plain = {title: 'Review', markdown: 'Controlled engineering fixture.', claims: [], sections: [], verdict: 'uncertain'};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const target = resolve(process.argv[2] ?? '.artifacts/research-scheduler/report.json');
const api = await loadResearchTestApi();
const rows = [];
async function sample(scenario, repetition, concurrency) {
  const f = createScientificReviewFixture(api);
  const limits = f.tasks.budgetForExecution('stage', f.parent.id, f.project.id);
  f.agentDb.prepare('UPDATE research_task_budgets SET limits_json=? WHERE task_id=?')
    .run(JSON.stringify({...limits, deadlineAt: new Date(Date.now() + 60_000).toISOString(), maxConcurrentModelCalls: 2}), f.parent.taskId);
  const ledger = new api.RunBudgetLedger(f.agentDb);
  let active = 0, peak = 0;
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {async prepare(_model, budget) {
    return {providerId: 'fixture', modelId: 'fixture', async execute({run, context}) {
      if (run.parentRunId === null) assert.equal(context.reviewReports.length, 3);
      else assert.equal(context.reviewReports.length, 0);
      ledger.reserve(run.id, budget, {id: 'model-call', kind: 'model', tokens: 100,
        inputHash: digest({scenario, role: run.role}), envelope: {scenario, role: run.role}, costMicrousd: null});
      active += 1; peak = Math.max(peak, active);
      try {
        await delay(4 + scenario % 5);
        ledger.settle(run.id, 'model-call', 80, 'settled');
        return {modelVersion: null, output: run.parentRunId === null ? plain : {...plain, scientificReview: f.output(run)}};
      } finally {active -= 1;}
    }};
  }}, api.createResearchHumanGate({repository: f.repository}), {cancelOwned: async () => {}}, undefined, concurrency);
  const row = {scenario, repetition, concurrency, status: 'failed'};
  try {
    await runtime.stopTask(f.parent.taskId, f.project.id, 'interrupted', 'benchmark_setup');
    const start = performance.now();
    const run = runtime.retry({projectId: f.project.id, runId: f.parent.id, requestId: 'benchmark'});
    await runtime.waitForIdle();
    row.elapsedMs = performance.now() - start;
    assert.equal(f.repository.runs.get(run.id, f.project.id).status, 'completed', f.tasks.get(run.taskId, f.project.id).statusReason);
    assert.equal(f.tasks.get(run.taskId, f.project.id).status, 'waiting_approval');
    const graph = f.tasks.graph.read(run.taskId, f.project.id);
    const reducer = graph.nodes.find(node => node.executionId === run.id);
    const children = graph.edges.filter(edge => edge.dependent === reducer.id).map(edge => graph.nodes.find(node => node.id === edge.prerequisite));
    assert.equal(children.length, 3);
    assert.ok(children.every(node => node.status === 'done' && node.output !== null && node.lease === null));
    assert.equal(reducer.status, 'pending_review'); assert.equal(reducer.lease, null);
    assert.equal(peak, concurrency);
    const budget = f.agentDb.prepare('SELECT COUNT(*) calls, SUM(actual_tokens) tokens, SUM(state = ?) settled FROM agent_budget_calls').get('settled');
    assert.deepEqual(budget, {calls: 4, tokens: 320, settled: 4});
    const effects = f.agentDb.prepare('SELECT COUNT(*) FROM agent_tool_effects').pluck().get();
    assert.equal(effects, 0);
    const output = [reducer, ...children].map(node => {
      const saved = JSON.parse(f.db.prepare('SELECT output_json FROM research_artifact_contents WHERE artifact_id=?').pluck().get(node.output.artifactIds[0]));
      return {role: node.role, status: node.status, title: saved.title, markdown: saved.markdown, verdict: saved.verdict,
        reviewKind: saved.scientificReview?.kind ?? null,
        observations: saved.scientificReview?.findings?.map(finding => finding.observation) ?? [],
        suggestions: saved.scientificReview?.suggestions?.map(suggestion => ({verdict: suggestion.verdict, rationale: suggestion.rationale})) ?? []};
    }).sort((a, b) => a.role.localeCompare(b.role));
    Object.assign(row, {status: 'passed', peak, budget, effects, projectionHash: digest(output),
      resultHashes: [reducer, ...children].map(node => node.output.hash), realCostMicrousd: null});
  } catch (error) {row.error = error instanceof Error ? error.message : String(error);}
  finally {await runtime.shutdown(); f.close();}
  return row;
}
try {
  for (let scenario = 0; scenario < protocol.scenarios; scenario++) {
    for (let repetition = 0; repetition < protocol.repetitions; repetition++) {
      const order = (scenario + repetition) % 2 === 0 ? [1, 2] : [2, 1];
      const pair = [];
      for (const concurrency of order) pair.push(await sample(scenario, repetition, concurrency));
      const equivalent = pair.every(row => row.status === 'passed') && pair[0].projectionHash === pair[1].projectionHash;
      rows.push(...pair.map(row => ({...row, pairedEquivalent: equivalent})));
    }
  }
} finally {api.dispose();}
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? null;
const summary = protocol.concurrency.map(concurrency => {
  const selected = rows.filter(row => row.concurrency === concurrency);
  return {concurrency, count: selected.length, failed: selected.filter(row => row.status !== 'passed').length,
    p50Ms: percentile(selected.map(row => row.elapsedMs).filter(Number.isFinite), .5),
    p95Ms: percentile(selected.map(row => row.elapsedMs).filter(Number.isFinite), .95)};
});
const report = {protocol, protocolHash: digest(protocol), status: rows.length === 180 && rows.every(row => row.pairedEquivalent) ? 'passed' : 'failed',
  independentScientificTasks: 0, realProviderDispatches: 0, summary, rows};
await mkdir(dirname(target), {recursive: true}); await writeFile(target, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({status: report.status, summary, target}));
process.exitCode = report.status === 'passed' ? 0 : 1;
