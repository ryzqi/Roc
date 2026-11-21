import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';

let api, directory;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-workflow-tools-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'api.mjs');
  await build({stdin: {contents: `
    export * from './src/main/plugins/agent/research-workflow-tools';
    export { z } from 'zod';
  `, resolveDir: process.cwd()}, outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent'});
  api = await import(outfile);
});
after(() => rmSync(directory, {recursive: true, force: true}));

const H = 'a'.repeat(64), time = '2026-11-21T00:00:00.000Z';
const material = {manuscript: {artifactId: 'paper', projectId: 'project', sections: [], latex: 'Draft', contentHash: H,
  claimsHash: H, updatedAt: time}, claims: [], evidence: []};
const unavailable = {kind: 'unavailable', reason: 'This descriptive run did not estimate uncertainty.'};
function connect(respond, signal = new AbortController().signal) {
  const calls = [];
  const [tool] = api.createResearchWorkflowTools({projectId: 'project', signal,
    capabilities: {invoke: async (name, request, forwardedSignal) => {
      calls.push({name, request});
      assert.equal(forwardedSignal, signal);
      return await respond(name, request);
    }}});
  return {tool, calls};
}
function workflow(status = 'ready', projectStatus = 'active') {
  return {projectId: 'project', currentStage: 'writing', projectStatus, lastEvent: null, stages: [{
    stage: 'writing', status, activeRunId: null, artifactIds: ['paper'], enteredAt: time, completedAt: null,
    gateRequired: true, gateApproved: false, lastError: status === 'blocked' ? 'Missing source PDF' : null
  }]};
}
function journal() {
  return {status: 'current', reportHash: H, report: {projectId: 'project', artifactId: 'paper', artifactVersion: H,
    selection: null, material: null, materialHash: null, checks: [], review: null, reviewCurrent: false}};
}
function consistency() {
  return {status: 'current', reportHash: H, readAt: time,
    report: {schemaVersion: 1, projectId: 'project', artifactId: 'paper', artifactVersion: H, review: null, locations: [],
      unmappedClaimIds: ['claim'], unmappedLocations: [{claimId: 'claim', start: 5, end: 7, text: '42'}],
      counts: {mapped: 0, consistent: 0, inconsistent: 0, changed: 0, unmappedClaims: 1, unmappedValues: 1}}};
}
function resultReceipt() {
  return {snapshotHash: H, snapshot: {schemaVersion: 1, id: 'result', recordedAt: time, actor: {kind: 'user', id: 'window:1'},
    request: {projectId: 'project', requestId: 'review', runId: 'run', expectedInputHash: H, resultPath: 'metrics.json', expectedResultHash: H,
      definitions: [{id: 'mean', label: 'Mean', definition: 'Arithmetic mean of all samples', unit: 'ms', direction: 'lower'}],
      method: {name: 'Mean', rationale: 'Descriptive summary', assumptions: 'All observations retained', limitations: 'No inference'}},
    result: {schemaVersion: 1, metrics: [{id: 'mean', value: 4, unit: 'ms', sampleSize: 3, uncertainty: unavailable,
      confidenceInterval: unavailable, effect: unavailable}]},
    execution: {runId: 'run', inputHash: H, engine: 'typescript', environmentHash: H,
      source: {area: 'input', path: 'analysis.mts', sha256: H, size: 10},
      output: {area: 'output', path: 'metrics.json', sha256: H, size: 10}, inputs: [], parameters: {}, arguments: [], seed: null}}};
}

test('provider schema stays object rooted while runtime rejects project injection and mismatched kind fields before invoking', async () => {
  const c = connect(() => assert.fail('invalid input must not reach capabilities'));
  const schema = api.z.toJSONSchema(c.tool.schema, {io: 'input'});
  assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
  for (const args of [
    {kind: 'workflow', projectId: 'other'}, {kind: 'workflow', artifactId: 'paper'},
    {kind: 'consistency', artifactId: 'paper'}, {kind: 'experiment_result', resultId: 'result', expectedHash: null},
    {kind: 'journal_compliance', artifactId: 'paper', expectedHash: null, selection: {manualReviews: []}},
    {kind: 'idea_plans', artifactId: 'paper', offset: 0, limit: 51},
    {kind: 'response_matrix', artifactId: 'paper', expectedHash: null, actor: {kind: 'user', id: 'forged'}}
  ]) await assert.rejects(c.tool.invoke(args));
  assert.deepEqual(c.calls, []);
});

test('workflow binds project once and describes exact blocking state without running or approving it', async () => {
  const c = connect(() => workflow('blocked'));
  const result = await c.tool.invoke({kind: 'workflow'});
  assert.deepEqual(c.calls, [{name: 'research.workflow.get', request: {id: 'project'}}]);
  assert.equal(result.status, 'attention_required'); assert.equal(result.verification, 'workflow_state');
  assert.equal(result.findings[0].message, 'Missing source PDF');
  assert.equal(result.findings[0].severity, 'blocked');
  assert.match(result.limitations.join(' '), /不证明/);
});

test('ready workflow allows next stage, while archived project never suggests executing it', async () => {
  const ready = await connect(() => workflow()).tool.invoke({kind: 'workflow'});
  assert.equal(ready.status, 'no_findings'); assert.equal(ready.nextActions[0].code, 'stage_ready');
  const archived = await connect(() => workflow('ready', 'archived')).tool.invoke({kind: 'workflow'});
  assert.equal(archived.status, 'attention_required');
  assert.equal(archived.nextActions.some(item => item.code === 'stage_ready'), false);
  const waiting = await connect(() => workflow('waiting_approval')).tool.invoke({kind: 'workflow'});
  assert.equal(waiting.nextActions[0].actor, 'human');
});

test('missing journal selection is explicitly unchecked and cannot be replaced with model manual judgments', async () => {
  const c = connect(() => journal());
  const result = await c.tool.invoke({kind: 'journal_compliance', artifactId: 'paper', expectedHash: null});
  assert.deepEqual(c.calls, [{name: 'research.journalCompliance.inspect',
    request: {projectId: 'project', artifactId: 'paper', expectedHash: null, selection: null}}]);
  assert.equal(result.status, 'attention_required'); assert.equal(result.findings[0].code, 'journal_rules_missing');
  assert.equal(result.data.report.selection, null); assert.deepEqual(result.data.report.checks, []);
});

test('unmapped and unreviewed numbers survive projection with exact positions and next actions', async () => {
  const c = connect(() => consistency());
  const result = await c.tool.invoke({kind: 'consistency', artifactId: 'paper', expectedHash: null});
  assert.deepEqual(result.data.report.unmappedLocations, consistency().report.unmappedLocations);
  assert.deepEqual(result.findings.map(item => item.code), ['consistency_unmapped', 'consistency_not_reviewed']);
  assert.equal(result.nextActions.at(-1).actor, 'human');
  assert.equal(result.data.reportHash, H);
});

test('empty response matrix remains missing and stale report remains stale', async () => {
  const data = {status: 'stale', reportHash: H, report: {schemaVersion: 1, projectId: 'project', artifactId: 'paper', artifactVersion: H,
    material, canEdit: false, review: null, reviewCurrent: false, openCommentIds: [], addressedCommentIds: [], declinedCommentIds: [], scientificReviews: []}};
  const result = await connect(() => data).tool.invoke({kind: 'response_matrix', artifactId: 'paper', expectedHash: 'b'.repeat(64)});
  assert.deepEqual(result.findings.map(item => item.code), ['inspection_changed', 'response_matrix_missing', 'response_matrix_read_only']);
  assert.equal(result.status, 'attention_required'); assert.equal(result.data.status, 'stale');
});

test('empty plan and result histories report missing state, and pagination never claims current source verification', async () => {
  for (const args of [{kind: 'idea_plans', artifactId: 'idea', offset: 0, limit: 10},
    {kind: 'experiment_results', runId: 'run', offset: 0, limit: 10}]) {
    const result = await connect(() => ({items: [], total: 0})).tool.invoke(args);
    assert.equal(result.status, 'attention_required'); assert.equal(result.verification, 'stored_receipt');
    assert.equal(result.data.nextOffset, null);
  }
  const receipt = resultReceipt();
  const page = await connect(() => ({items: [receipt], total: 2})).tool.invoke({kind: 'experiment_results', runId: 'run', offset: 0, limit: 1});
  assert.equal(page.verification, 'stored_receipt'); assert.equal(page.data.nextOffset, 1);
  assert.equal(page.data.items[0].snapshotHash, H);
});

test('current experiment result preserves unavailable statistics and never asserts scientific approval', async () => {
  const receipt = resultReceipt(), c = connect(() => receipt);
  const result = await c.tool.invoke({kind: 'experiment_result', resultId: 'result', expectedHash: H});
  assert.deepEqual(c.calls, [{name: 'research.experimentResults.get', request: {projectId: 'project', resultId: 'result', expectedHash: H}}]);
  assert.equal(result.verification, 'current_sources'); assert.equal(result.status, 'attention_required');
  assert.equal(result.findings.length, 3); assert.equal(result.data.snapshot.result.metrics[0].uncertainty.kind, 'unavailable');
  assert.match(result.limitations.join(' '), /独立复现/);
});

test('SDK ToolCall serialization preserves structured findings and exact source reports', async () => {
  const c = connect(() => consistency()), args = {kind: 'consistency', artifactId: 'paper', expectedHash: null};
  const direct = await c.tool.invoke(args);
  const message = await c.tool.invoke({type: 'tool_call', id: 'read-1', name: c.tool.name, args});
  assert.equal(message.tool_call_id, 'read-1'); assert.deepEqual(JSON.parse(message.content), direct);
});

test('source errors, cancellation and malformed outputs fail rather than becoming empty successful inspections', async () => {
  const drift = new Error('research_result_output_changed');
  const c = connect(() => {throw drift;});
  await assert.rejects(c.tool.invoke({kind: 'experiment_result', resultId: 'result', expectedHash: H}), error => error === drift);
  const controller = new AbortController();
  const cancelled = connect(() => {controller.abort(new Error('cancelled-inspection')); return journal();}, controller.signal);
  await assert.rejects(cancelled.tool.invoke({kind: 'journal_compliance', artifactId: 'paper', expectedHash: null}), /cancelled-inspection/);
  const invalid = connect(() => ({status: 'current', report: {checks: []}}));
  await assert.rejects(invalid.tool.invoke({kind: 'journal_compliance', artifactId: 'paper', expectedHash: null}));
});
