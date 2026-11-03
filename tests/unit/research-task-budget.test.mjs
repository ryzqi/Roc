import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchFixture, loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

function setup(overrides = {}) {
  const f = createResearchFixture(api, 'discovery');
  const budget = {
    ...api.createRunBudget({ contextBudgetTokens: 1000, maxOutputTokens: 250 }),
    maxCallTokens: 1400, maxTotalTokens: 2800, maxModelCalls: 10, maxToolCalls: 20,
    maxConcurrentModelCalls: 2, ...overrides
  };
  f.agentDb.prepare('UPDATE research_task_budgets SET limits_json = ? WHERE task_id = ?')
    .run(JSON.stringify(budget), f.run.taskId);
  const child = { ...f.run, id: 'child-stage', parentRunId: f.run.id, retryOfRunId: null, role: 'reviewer' };
  f.tasks.linkStage(child, null);
  return { ...f, budget, child, ledger: new api.RunBudgetLedger(f.agentDb) };
}
function reservation(id, overrides = {}) {
  return { id, kind: 'model', tokens: 100, inputHash: `hash:${id}`, envelope: { providerId: 'fixture', modelId: 'fixture-model' },
    costMicrousd: null, pricingVersion: 'fixture-prices', ...overrides };
}

test('shared authority admits stage calls and enforces task-wide concurrency, tokens and costs atomically', () => {
  const f = setup({ maxTotalTokens: 180, maxConcurrentModelCalls: 1, maxCostMicrousd: 90 });
  try {
    f.ledger.reserve(f.run.id, f.budget, reservation('one', { costMicrousd: 60 }));
    assert.throws(() => f.ledger.reserve(f.child.id, f.budget, reservation('two', { costMicrousd: 40 })), /run_model_concurrency_exhausted/);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_budget_calls').pluck().get(), 1);
    f.ledger.settle(f.run.id, 'one', 80, 'settled', undefined, {}, 40);
    f.ledger.reserve(f.child.id, f.budget, reservation('two', { costMicrousd: 50 }));
    f.ledger.settle(f.child.id, 'two', 100, 'unknown');
    assert.throws(() => f.ledger.reserve(f.run.id, f.budget, reservation('three', { tokens: 1, costMicrousd: 1 })), /run_total_token_budget_exhausted/);
    const rows = f.agentDb.prepare('SELECT run_id,execution_kind,task_id FROM agent_budget_calls').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.execution_kind === 'stage' && row.task_id === f.run.taskId));
    assert.deepEqual(rows.map((row) => row.run_id).sort(), [f.child.id, f.run.id].sort());
    assert.throws(() => f.ledger.reserve('invented-run', f.budget, reservation('fake')), /run_budget_execution_unlinked/);
  } finally { f.close(); }
});

test('unknown consumption and restart retain task reservations; changing stage cannot bypass the cap', () => {
  const f = setup({ maxCostMicrousd: 100 });
  try {
    f.ledger.reserve(f.run.id, f.budget, reservation('one', { costMicrousd: 80 }));
    f.ledger.reconcileStartup();
    assert.equal(f.agentDb.prepare('SELECT state FROM agent_budget_calls').pluck().get(), 'unknown');
    assert.throws(() => f.ledger.reserve(f.child.id, f.budget, reservation('two', { costMicrousd: 21 })), /run_cost_budget_exhausted/);
    f.ledger.reserve(f.child.id, f.budget, reservation('two', { costMicrousd: 20 }));
    f.ledger.settle(f.child.id, 'two', null, 'unknown');
    assert.throws(() => f.ledger.reserve(f.run.id, f.budget, reservation('three', { costMicrousd: 1 })), /run_cost_budget_exhausted/);
    assert.equal(f.agentDb.prepare('SELECT SUM(reserved_cost_microusd) FROM agent_budget_calls').pluck().get(), 100);
  } finally { f.close(); }
});

test('two SQLite connections share one concurrency reservation and retained unknown cost', async () => {
  const f = setup({ maxConcurrentModelCalls: 1, maxCostMicrousd: 100 });
  const directory = await mkdtemp(join(tmpdir(), 'roc-task-budget-db-'));
  let first;
  let second;
  try {
    const path = join(directory, 'agent.db');
    await f.agentDb.backup(path);
    first = new Database(path);
    second = new Database(path);
    first.pragma('foreign_keys = ON');
    second.pragma('foreign_keys = ON');
    const left = new api.RunBudgetLedger(first);
    const right = new api.RunBudgetLedger(second);
    left.reserve(f.run.id, f.budget, reservation('first', { costMicrousd: 80 }));
    assert.throws(() => right.reserve(f.child.id, f.budget, reservation('second', { costMicrousd: 20 })), /run_model_concurrency_exhausted/);
    right.reconcileStartup();
    right.reserve(f.child.id, f.budget, reservation('second', { costMicrousd: 20 }));
    assert.equal(first.prepare('SELECT SUM(reserved_cost_microusd) FROM agent_budget_calls').pluck().get(), 100);
    assert.equal(second.prepare('SELECT COUNT(*) FROM agent_budget_calls').pluck().get(), 2);
  } finally { first?.close(); second?.close(); f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('dispatch attaches already billed chat calls once and shares remaining cap with its stage', () => {
  const f = setup();
  try {
    const createdAt = new Date().toISOString();
    const runId = 'chat-budget-parent';
    const threadId = 'chat-budget-thread';
    const manifest = api.compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic', mcpServers: [],
      mode: 'chat', requestedCapabilities: { mcpServers: [], skills: [] }, selfConfigAvailable: false,
      shellAllowedCommands: undefined, trustedHostAvailable: false, skills: [], workflowHint: null, researchProjectId: f.project.id
    }).manifest;
    const budget = { ...f.budget, maxCostMicrousd: 100 };
    const snapshot = api.createRunExecutionSnapshot({ runId, threadId, inputMessageId: 'message', snapshot: {
      schemaVersion: 9, submissionHash: 'a'.repeat(64),
      taskContract: { contractVersion: 1, objective: 'Research', constraints: [], kind: 'reply',
        criteria: [{ id: 'response', description: 'Findings', check: { kind: 'response' } }] },
      runOrigin: 'chat', model: { providerId: 'fixture', modelId: 'fixture' }, mode: 'run', workspace: null,
      capabilityManifest: manifest, workflowHint: null, explicitSkillIds: [], dispatchKey: null, researchProjectId: f.project.id, budget
    } });
    f.agentDb.prepare(`INSERT INTO agent_threads
      (id,kind,title,goal,status,research_project_id,created_at,updated_at)
      VALUES (?,'chat','Research','Research','active',?,?,?)`).run(threadId, f.project.id, createdAt, createdAt);
    f.agentDb.prepare(`INSERT INTO agent_runs
      (id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin,snapshot_json,snapshot_version)
      VALUES (?,?,1,'Research','running',?,'{}','chat',?,9)`).run(runId, threadId, createdAt, JSON.stringify(snapshot));
    f.ledger.reserve(runId, budget, reservation('chat-call', { costMicrousd: 60 }));
    f.ledger.settle(runId, 'chat-call', 50, 'settled', undefined, {}, 40);
    assert.equal(f.agentDb.prepare('SELECT task_id FROM agent_budget_calls').pluck().get(), null);
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture');
    const request = { projectId: f.project.id, expectedStage: 'discovery', instruction: 'Research', requestId: 'chat-stage' };
    const queued = f.repository.runs.begin(request);
    const broker = new api.ExecutionGrantBroker(f.agentDb);
    const grant = broker.consumeResearchDispatch(broker.issueResearchDispatch({ runId, threadId, manifest, request }), request);
    const execution = f.tasks.linkStage(queued, grant);
    assert.equal(f.agentDb.prepare('SELECT task_id FROM agent_budget_calls').pluck().get(), execution.taskId);
    assert.deepEqual(f.tasks.budgetForExecution('stage', queued.id, f.project.id), budget);
    assert.throws(() => f.ledger.reserve(queued.id, budget, reservation('stage-over', { costMicrousd: 61 })), /run_cost_budget_exhausted/);
    f.ledger.reserve(queued.id, budget, reservation('stage-call', { costMicrousd: 60 }));
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_budget_calls WHERE task_id = ?').pluck().get(execution.taskId), 2);
    assert.equal(f.agentDb.prepare('SELECT SUM(COALESCE(actual_cost_microusd,reserved_cost_microusd)) FROM agent_budget_calls WHERE task_id = ?')
      .pluck().get(execution.taskId), 100);
    const linkedEvents = f.tasks.events({ taskId: execution.taskId, projectId: f.project.id, afterSequence: 0, limit: 200 }).events;
    assert.deepEqual(linkedEvents.filter(event => event.eventType === 'call_linked')
      .map(event => [event.executionId, event.callId, event.state]), [[runId, 'chat-call', 'settled']]);
  } finally { f.close(); }
});

test('missing prices, invalid usage, duplicate calls and missing frozen policies fail explicitly', () => {
  const f = setup({ maxCostMicrousd: 100 });
  try {
    assert.throws(() => f.ledger.reserve(f.run.id, f.budget, reservation('unknown-price')), /run_cost_estimate_unavailable/);
    assert.throws(() => f.ledger.reserve(f.run.id, f.budget, reservation('fraction', { tokens: 1.5 })), /run_budget_reservation_invalid/);
    assert.throws(() => f.ledger.reserve(f.run.id, f.budget, reservation('overflow', { costMicrousd: Number.MAX_SAFE_INTEGER + 1 })), /run_budget_reservation_invalid/);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_budget_calls').pluck().get(), 0);
    f.ledger.reserve(f.run.id, f.budget, reservation('valid', { costMicrousd: 5 }));
    assert.throws(() => f.ledger.reserve(f.run.id, f.budget, reservation('valid', { costMicrousd: 5 })), /run_budget_call_already_reserved/);
    assert.throws(() => f.ledger.settle(f.run.id, 'valid', -1, 'settled'), /run_budget_settlement_invalid/);
    assert.throws(() => f.ledger.settle(f.run.id, 'valid', 1.2, 'settled'), /run_budget_settlement_invalid/);
    assert.throws(() => f.ledger.settle(f.run.id, 'valid', 1, 'settled', undefined, {}, Number.NaN), /run_budget_settlement_invalid/);
    f.agentDb.prepare('DELETE FROM research_task_budgets WHERE task_id = ?').run(f.run.taskId);
    assert.throws(() => f.tasks.budgetForExecution('stage', f.run.id, f.project.id), /research_task_budget_missing/);
    assert.throws(() => f.ledger.reserve(f.child.id, f.budget, reservation('missing')), /research_task_budget_missing/);
  } finally { f.close(); }
});

test('temporary concurrency denial does not erase budget; permanent task stop survives stages and retries', () => {
  const f = setup();
  try {
    f.ledger.recordStopReason(f.run.id, 'run_model_concurrency_exhausted');
    assert.equal(f.agentDb.prepare('SELECT stop_reason FROM research_task_budgets').pluck().get(), null);
    f.ledger.reserve(f.run.id, f.budget, reservation('one'));
    f.ledger.settle(f.run.id, 'one', 10, 'settled');
    f.ledger.recordStopReason(f.child.id, 'run_total_token_budget_exhausted');
    f.ledger.recordStopReason(f.run.id, 'run_cost_budget_exhausted');
    assert.equal(f.agentDb.prepare('SELECT stop_reason FROM research_task_budgets').pluck().get(), 'run_total_token_budget_exhausted');
    assert.throws(() => f.ledger.reserve(f.run.id, f.budget, reservation('two')), /run_total_token_budget_exhausted/);
  } finally { f.close(); }
});

test('actual stage createAgent accounts provider attempt and refuses the next call before model execution', async () => {
  const f = setup({ maxModelCalls: 1 });
  let requests = 0;
  class Model extends BaseChatModel {
    _llmType() { return 'budget-fixture'; }
    bindTools() { return this; }
    async _generate() {
      requests += 1;
      assert.equal(f.agentDb.prepare("SELECT COUNT(*) FROM agent_budget_calls WHERE state = 'reserved'").pluck().get(), 1);
      throw new Error('fixture_provider_failure');
    }
  }
  const model = new Model({ maxRetries: 0 });
  let outputCap = null;
  const factory = { async createDefaultModelHandle(options) {
    outputCap = options.maxOutputTokens;
    return { providerId: 'fixture-provider', modelId: 'fixture-model', langChainHandle: { model } };
  }, async createModelHandleByProviderAndModel(options) {
    assert.equal(options.providerId, 'fixture-provider');
    assert.equal(options.modelId, 'fixture-model');
    outputCap = options.maxOutputTokens;
    return { providerId: 'fixture-provider', modelId: 'fixture-model', langChainHandle: { model } };
  } };
  try {
    const executor = api.createResearchRoleExecutor(factory, f.ledger);
    const prepared = await executor.prepare({ kind: 'app_default' }, f.budget);
    const execute = () => prepared.execute({ run: f.run, context: f.repository.runs.getContext(f.run.id),
      tools: [], signal: new AbortController().signal });
    await assert.rejects(execute(), /fixture_provider_failure/);
    assert.equal(requests, 1);
    assert.equal(outputCap, 250);
    const call = f.agentDb.prepare('SELECT execution_kind,task_id,state,actual_tokens FROM agent_budget_calls').get();
    assert.deepEqual(call, { execution_kind: 'stage', task_id: f.run.taskId, state: 'unknown', actual_tokens: null });
    await assert.rejects(execute(), /run_model_call_budget_exhausted/);
    assert.equal(requests, 1);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_budget_calls').pluck().get(), 1);
    assert.equal(f.agentDb.prepare('SELECT stop_reason FROM research_task_budgets').pluck().get(), 'run_model_call_budget_exhausted');
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture_provider_failure');
    const runtime = new api.ResearchStageRuntime(f.repository, {}, executor, { complete: async () => {} });
    const retried = runtime.retry({ projectId: f.project.id, runId: f.run.id, requestId: 'budget-retry' });
    await runtime.waitForIdle();
    assert.equal(f.repository.runs.get(retried.id, f.project.id).error, 'run_model_call_budget_exhausted');
    assert.equal(retried.taskId, f.run.taskId);
    assert.equal(requests, 1);
    const events = f.tasks.events({ taskId: f.run.taskId, projectId: f.project.id, afterSequence: 0, limit: 200 }).events;
    assert.equal(events.filter(event => event.eventType === 'call_reserved').length, 1);
    assert.equal(events.filter(event => event.eventType === 'call_unknown').length, 1);
    await runtime.shutdown();
  } finally { f.close(); }
});

test('actual stage createAgent settles successful usage without requiring a chat run', async () => {
  const f = setup();
  const output = { title: 'Verified fixture', markdown: 'Fixture output', claims: [], sections: [], verdict: 'ready' };
  let responseToolName;
  class Model extends BaseChatModel {
    _llmType() { return 'successful-budget-fixture'; }
    bindTools(tools) {
      responseToolName = tools[0].function?.name ?? tools[0].name;
      return this;
    }
    async _generate() {
      return { generations: [{ text: '', message: new AIMessage({
        content: '', tool_calls: [{ id: 'output-1', name: responseToolName, args: output, type: 'tool_call' }],
        usage_metadata: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }
      }) }] };
    }
  }
  try {
    const model = new Model({ maxRetries: 0 });
    const executor = api.createResearchRoleExecutor({
      async createDefaultModelHandle() {
        return { providerId: 'fixture-provider', modelId: 'fixture-model', langChainHandle: { model } };
      }
    }, f.ledger);
    const prepared = await executor.prepare({ kind: 'app_default' }, f.budget);
    const result = await prepared.execute({
      run: f.run, context: f.repository.runs.getContext(f.run.id), tools: [], signal: new AbortController().signal
    });
    assert.deepEqual(result.output, output);
    const call = f.agentDb.prepare("SELECT * FROM agent_budget_calls WHERE kind = 'model'").get();
    assert.equal(call.state, 'settled');
    assert.equal(call.actual_tokens, 20);
    assert.equal(JSON.parse(call.envelope_json).providerId, 'fixture-provider');
    assert.equal(JSON.parse(call.envelope_json).modelId, 'fixture-model');
    assert.equal(f.ledger.readBudgetStatus(f.run.id, f.budget, false).tokens.settled, 20);
    const events = f.tasks.events({ taskId: f.run.taskId, projectId: f.project.id, afterSequence: 0, limit: 200 }).events;
    assert.equal(events.filter(event => event.eventType === 'call_reserved').length, 1);
    assert.equal(events.filter(event => event.eventType === 'call_settled').length, 1);
    assert.throws(() => f.ledger.settle(f.run.id, call.call_id, 1, 'settled'), /run_budget_settlement_invalid/);
  } finally { f.close(); }
});
