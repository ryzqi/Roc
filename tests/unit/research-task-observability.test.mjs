import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {mkdtemp, readFile, stat, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {AIMessage, HumanMessage} from '@langchain/core/messages';
import {withResearchTestWorker, createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const unusedSource = {source: async () => {throw new Error('unused_resource_source');}};
const now = '2026-11-06T00:00:00.000Z';
const secret = 'PRIVATE_PROMPT_TOOL_PATH_ACTOR';
function scene() {
  const f = createResearchFixture(api, 'discovery');
  f.scope = {projectId: f.project.id, taskId: f.run.taskId};
  f.ledger = new api.RunBudgetLedger(f.agentDb);
  f.diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, f.ledger, null, unusedSource);
  f.request = {...f.scope, executionKind: 'stage', executionId: f.run.id, afterCallSequence: 0, afterEventSequence: 0, limit: 2};
  f.limits = {...api.createRunBudget({contextBudgetTokens: 1000}), maxCallTokens: 300, maxOutputTokens: 100, maxTotalTokens: 5000};
  f.agentDb.prepare('UPDATE research_task_budgets SET limits_json=? WHERE task_id=?')
    .run(JSON.stringify(f.limits), f.scope.taskId);
  f.reserve = (id, kind = 'model') => f.ledger.reserve(f.run.id, f.limits, {
    id, kind, tokens: 100, inputHash: id, costMicrousd: 60, envelope: {messages: [secret]}
  });
  return f;
}
function chat(f) {
  f.agentDb.prepare(`INSERT INTO agent_threads(id,kind,title,goal,status,research_project_id,created_at,updated_at)
    VALUES ('thread','chat','Fixture',?,'active',?,?,?)`).run(secret, f.project.id, now, now);
  f.agentDb.prepare(`INSERT INTO agent_runs(id,thread_id,run_number,user_input,status,started_at,ended_at,provider_id,model_id,enabled_capabilities_json,run_origin)
    VALUES ('chat','thread',1,?,'failed',?,?,'provider-private','model-private','{}','chat')`).run(secret, now, now);
  const association = {...f.tasks.requireExecution('stage', f.run.id, f.project.id), taskId: f.run.taskId, projectId: f.project.id, kind: 'chat', executionId: 'chat',
    parentKind: null, parentExecutionId: null, associationSource: 'direct', manifestHash: 'a'.repeat(64), createdAt: now};
  f.agentDb.prepare(`INSERT INTO research_task_executions(kind,execution_id,task_id,project_id,snapshot_json,created_at)
    VALUES ('chat','chat',?,?,?,?)`).run(f.run.taskId, f.project.id, JSON.stringify(association), now);
  return {...f.request, executionKind: 'chat', executionId: 'chat'};
}
const humanExport = (f, exporter) => api.withResearchHumanContext({
  capability: 'research.task.diagnostics.export', projectId: f.project.id, windowId: 71
}, () => exporter.export(f.scope));

test('actual model boundary persists success/failure timings and unknown spend, survives SQLite backup and refuses fabricated observations', async () => {
  const f = scene(), directory = await mkdtemp(join(tmpdir(), 'roc-task-observations-'));
  let reopened;
  try {
    const observer = new api.RunBudgetObserver(f.ledger, f.run.id, f.limits, 'revision');
    const invoke = operation => observer.invoke({messages: [new HumanMessage(secret)], purpose: 'agent',
      responseMessage: value => value, invoke: operation});
    await invoke(async () => new AIMessage({content: 'ok', usage_metadata: {input_tokens: 12, output_tokens: 8, total_tokens: 20}}));
    await assert.rejects(invoke(async () => {throw new Error('provider_failure');}), /provider_failure/);
    const result = await f.diagnostics.inspectExecution(f.request);
    assert.deepEqual(result.calls.calls.map(call => call.invocation.status), ['completed', 'failed']);
    for (const call of result.calls.calls) {
      assert.ok(call.invocation.durationMs >= 0);
      assert.ok(Number.isFinite(Date.parse(call.invocation.startedAt)));
      assert.equal(call.actualCostMicrousd, null);
    }
    assert.equal(result.calls.calls[1].state, 'unknown');
    assert.equal(result.calls.calls[1].actualTokens, null);
    const summary = f.diagnostics.get(f.scope);
    assert.equal(summary.budget.calls.models.total, 2);
    assert.equal(summary.budget.tokens.unknown, 300);
    const capped = new api.RunBudgetObserver(f.ledger, f.run.id, {...f.limits, maxModelCalls: 2}, 'revision');
    let dispatched = false;
    await assert.rejects(capped.invoke({messages: [], purpose: 'agent', responseMessage: value => value,
      invoke: async () => {dispatched = true; return new AIMessage('blocked');}}), /run_model_call_budget_exhausted/);
    assert.equal(dispatched, false);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_budget_call_observations').pluck().get(), 2);
    assert.equal(JSON.stringify(result).includes(secret), false);
    const callId = result.calls.calls[0].callId;
    assert.throws(() => f.ledger.recordModelObservation(f.run.id, callId, {startedAt: now, durationMs: 1, status: 'completed'}), /UNIQUE/);
    assert.throws(() => f.ledger.recordModelObservation(f.run.id, 'absent', {startedAt: now, durationMs: 1, status: 'failed'}), /run_model_observation_call_invalid/);
    assert.throws(() => f.agentDb.prepare('UPDATE agent_budget_call_observations SET duration_ms=0').run(), /immutable/);
    assert.throws(() => f.agentDb.prepare('INSERT INTO agent_budget_call_observations VALUES (?,?,?,?,?)')
      .run('absent', 'absent', now, 0, 'failed'), /FOREIGN KEY/);
    await f.agentDb.backup(join(directory, 'agent.db'));
    reopened = new Database(join(directory, 'agent.db'));
    const restored = new api.ResearchTaskRepository(reopened);
    assert.deepEqual(restored.observability.calls(f.request), result.calls);
    assert.deepEqual(reopened.pragma('foreign_key_check'), []);
  } finally {reopened?.close(); f.close(); await rm(directory, {recursive: true, force: true});}
});

test('call pages keep real IDs and strict execution/task ownership without re-counting fees', async () => {
  const f = scene();
  try {
    for (const id of ['one', 'two', 'three']) f.reserve(id);
    f.ledger.settle(f.run.id, 'one', 80, 'settled', undefined, {}, 40);
    f.ledger.settle(f.run.id, 'two', null, 'unknown');
    const first = await f.diagnostics.inspectExecution(f.request);
    assert.deepEqual(first.calls.calls.map(call => call.callId), ['one', 'two']);
    assert.ok(first.calls.calls.every(call => call.settledAt !== null));
    assert.equal(first.calls.hasMore, true);
    const second = await f.diagnostics.inspectExecution({...f.request, afterCallSequence: first.calls.nextSequence});
    assert.deepEqual(second.calls.calls.map(call => call.callId), ['three']);
    assert.equal(second.calls.hasMore, false);
    assert.equal(second.calls.calls[0].settledAt, null);
    assert.equal(f.diagnostics.get(f.scope).budget.cost.settledMicrousd, 40);
    assert.equal(f.diagnostics.get(f.scope).budget.cost.reservedMicrousd, 120);
    await assert.rejects(f.diagnostics.inspectExecution({...f.request, projectId: 'foreign'}), /research_task_project_mismatch/);
    await assert.rejects(f.diagnostics.inspectExecution({...f.request, executionId: 'absent'}), /research_task_execution/);
    const linked = f.tasks.linkOwned({projectId: f.project.id, kind: 'figure', executionId: 'other',
      ownerRunId: null, goal: 'Other', snapshot: {}});
    const other = f.tasks.get(linked.taskId, f.project.id);
    await assert.rejects(f.diagnostics.inspectExecution({...f.request, taskId: other.id}), /research_task_execution_mismatch/);
    f.agentDb.prepare('UPDATE agent_budget_calls SET task_id=? WHERE call_id=?').run(other.id, 'one');
    await assert.rejects(f.diagnostics.inspectExecution(f.request), /research_task_call_scope_corrupt/);
  } finally {f.close();}
});

test('real telemetry and replay expose tool failure, approval and queue measurements while omitting snapshots and payloads', async () => {
  const f = scene();
  try {
    const request = chat(f);
    const telemetry = new api.AgentRunTelemetryAccumulator({existing: null, run: {id: 'chat', threadId: 'thread'},
      snapshot: {runOrigin: 'chat', dispatchKey: null, capabilityManifest: {manifestHash: 'a'.repeat(64)},
        model: {providerId: 'provider-private', modelId: 'model-private'}}});
    const tool = phase => ({type: 'assistant_block', runId: 'chat', block: {kind: 'tool_call', callId: 'tool-private',
      blockId: 'block-private', name: secret, phase, input: {token: secret}, output: {content: secret}, error: {message: secret}}});
    telemetry.observeEvent(tool('start'), 10);
    telemetry.observeToolAdmission({toolCallId: 'tool-private', status: 'released', waitMs: 3, holdMs: 5,
      endOffsetMs: 20, resourceKinds: ['workspace'], conflictKinds: ['workspace']});
    telemetry.observeEvent(tool('error'), 30);
    telemetry.observeEvent({type: 'assistant_block', runId: 'chat', block: {kind: 'text', blockId: 'text', phase: 'delta', text: secret}}, 40);
    telemetry.observeEvent({type: 'run_interrupted', runId: 'chat', threadId: 'thread', interruptId: 'private-interrupt',
      payload: {kind: 'approval', actionRequests: [{name: secret, args: {secret}}]}}, 45);
    telemetry.observeEvent({type: 'run_resumed', runId: 'chat', threadId: 'thread', interruptId: 'private-interrupt'}, 60);
    f.tasks.observability.telemetry.save(telemetry.snapshot(), now);
    const log = new api.AgentRunEventLog(f.agentDb, {maxEvents: 2, maxPendingEvents: 1});
    log.recordRunEvent({type: 'run_started', runId: 'chat', mode: 'run', threadId: 'thread',
      providerId: 'provider-private', modelId: 'model-private', createdAt: now});
    log.recordRunEvent({type: 'assistant_block', runId: 'chat', block: {kind: 'text', blockId: 'text', phase: 'end', text: secret}});
    log.recordRunEvent(tool('start'));
    log.recordRunEvent(tool('error'));
    const result = await f.diagnostics.inspectExecution(request);
    assert.equal(result.telemetry.toolErrors, 1);
    assert.deepEqual(result.telemetry.admission, {acquisitions: 1, cancellations: 0, waitMs: 3, holdMs: 5});
    assert.equal(result.telemetry.firstOutputMs, 40);
    assert.ok(result.telemetry.trace.spans.some(span => span.operation === 'tool_admission'));
    assert.equal(result.telemetry.trace.spans.find(span => span.operation === 'approval_wait').durationMs, 15);
    assert.equal(result.replay.gap.throughSequence, 2);
    assert.equal(result.replay.gap.historyComplete, true);
    assert.equal(result.replay.events[1].failed, true);
    assert.equal(result.replay.events[1].toolCallId, 'tool-private');
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes('provider-private'), false);
    assert.equal('state' in result.replay.gap, false);
    const page = await f.diagnostics.inspectExecution({...request, limit: 1});
    assert.equal(page.replay.hasMore, true);
    assert.equal((await f.diagnostics.inspectExecution({...request, afterEventSequence: page.replay.nextSequence})).replay.events[0].failed, true);
  } finally {f.close();}
});

test('artifact observations use current inspector version and explicitly report deletion', () => {
  const f = createResearchFixture(api, 'planning');
  try {
    f.scope = {projectId: f.project.id, taskId: f.run.taskId};
    f.diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, new api.RunBudgetLedger(f.agentDb), null, unusedSource);
    const completed = withResearchTestWorker(api, f.repository, f.run.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {
      title: 'Plan', markdown: 'Source v1', claims: [], sections: [], verdict: 'ready'}));
    const id = completed.outputArtifactIds[0];
    const first = f.diagnostics.get(f.scope).executions[0].artifacts[0];
    assert.equal(first.id, id); assert.equal(first.versionSource, 'current_inspector');
    f.repository.updateArtifact({id, title: 'Source v2'});
    const changed = f.diagnostics.get(f.scope).executions[0].artifacts[0];
    assert.notEqual(changed.version, first.version);
    f.db.prepare('DELETE FROM research_artifacts WHERE id=?').run(id);
    assert.deepEqual(f.diagnostics.get(f.scope).executions[0].artifacts[0], {
      id, version: null, versionSource: 'current_inspector', state: 'missing'});
  } finally {f.close();}
});

test('main human IPC exports local redacted bytes with real hash, permissions and bounded coverage; forged identity is rejected', async () => {
  const f = scene(), directory = await mkdtemp(join(tmpdir(), 'roc-task-export-'));
  try {
    chat(f);
    f.reserve('private-call');
    f.ledger.recordStopReason(f.run.id, secret);
    const exporter = new api.ResearchTaskDiagnosticsExporter(f.diagnostics, f.tasks, directory);
    await assert.rejects(exporter.export(f.scope), /research_human_required/);
    await assert.rejects(api.withResearchHumanContext({capability: 'research.task.diagnostics.export', projectId: 'foreign', windowId: 71},
      () => exporter.export(f.scope)), /research_human_project_mismatch/);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:task-diagnostics-export', [{...f.scope, actor: 'fake', approved: true}]));
    const registry = new api.CapabilityRegistry();
    for (const descriptor of api.researchTaskCapabilities) registry.declare('research', descriptor);
    api.registerResearchTaskCapabilities({pluginId: 'research', capabilities: registry, eventBus: {publish: async () => {}},
      logger: {warn: () => {}}}, f.tasks, {}, f.diagnostics, exporter);
    const adapter = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
    assert.equal((await adapter.invoke('research.exportTaskDiagnostics', [f.scope])).ok, false);
    const response = await adapter.invoke('research.exportTaskDiagnostics', [f.scope], 71);
    assert.equal(response.ok, true);
    const receipt = response.data, bytes = await readFile(receipt.path);
    assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(receipt.size, bytes.length);
    assert.equal((await stat(receipt.path)).mode & 0o777, 0o600);
    const content = bytes.toString(), payload = JSON.parse(content);
    for (const marker of [secret, 'provider-private', 'model-private', 'private-call', f.project.id, f.run.taskId, f.run.id])
      assert.equal(content.includes(marker), false, marker);
    assert.equal(payload.externalTrace, 'not_exported');
    assert.equal(payload.budget.stopReason, null);
    assert.equal(payload.executions[0].calls.calls.length, 1);
    assert.equal(payload.executions[0].executionId, payload.executions[0].calls.calls[0].runId);
    assert.match(payload.coverage, /hasMore_and_gap/);
    assert.equal((await readdir(directory)).length, 1);
  } finally {f.close(); await rm(directory, {recursive: true, force: true});}
});

test('export refuses changed sources and excessive output before creating files', async () => {
  const f = scene(), directory = await mkdtemp(join(tmpdir(), 'roc-task-export-bounds-'));
  try {
    const get = f.diagnostics.get.bind(f.diagnostics), inspect = f.diagnostics.inspectExecution.bind(f.diagnostics);
    f.diagnostics.inspectExecution = async request => {
      const result = await inspect(request);
      f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'changed while reading');
      return result;
    };
    let exporter = new api.ResearchTaskDiagnosticsExporter(f.diagnostics, f.tasks, directory);
    await assert.rejects(humanExport(f, exporter), /research_task_diagnostics_source_changed/);
    assert.deepEqual(await readdir(directory), []);
    const summary = get(f.scope);
    const huge = {...summary, executions: Array.from({length: 501}, () => summary.executions[0])};
    exporter = new api.ResearchTaskDiagnosticsExporter({get: () => huge}, f.tasks, directory);
    await assert.rejects(humanExport(f, exporter), /research_task_diagnostics_execution_limit/);
    const bloated = {...summary, executions: Array.from({length: 120}, (_, i) => ({...summary.executions[0],
      association: {...summary.executions[0].association, executionId: `run-${i}`}}))};
    const calls = Array.from({length: 100}, (_, i) => ({sequence: i + 1, runId: f.run.id,
      callId: `${'c'.repeat(240)}-${i}`, kind: 'model', state: 'reserved', reservedTokens: 100, actualTokens: null,
      reservedCostMicrousd: null, actualCostMicrousd: null, pricingVersion: null, createdAt: now,
      settledAt: null, invocation: null}));
    exporter = new api.ResearchTaskDiagnosticsExporter({get: () => bloated, inspectExecution: async () => ({
      calls: {calls, nextSequence: 100, hasMore: true}, replay: null, resources: null, telemetry: null
    })}, f.tasks, directory);
    await assert.rejects(humanExport(f, exporter), /research_task_diagnostics_export_size_limit/);
    assert.deepEqual(await readdir(directory), []);
  } finally {f.close(); await rm(directory, {recursive: true, force: true});}
});
