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

function setup(overrides = {}, includeChild = true) {
  const f = createResearchFixture(api, 'discovery');
  const modelConfig = {
    ...api.createRunModelConfig({ contextWindowTokens: 1000, maxOutputTokens: 250 }),
       
     ...overrides
  };
  const child = { ...f.run, executionSnapshot: {...f.run.executionSnapshot, nodeBinding: {kind: 'none'}}, id: 'child-stage', parentRunId: f.run.id, retryOfRunId: null, role: 'reviewer' };
  if (includeChild) f.tasks.linkStage(child, null);
  return { ...f, modelConfig, child, ledger: new api.RunUsageLedger(f.agentDb) };
}
function reservation(id, overrides = {}) {
  return { id, kind: 'model', tokens: 100, inputHash: `hash:${id}`, envelope: { providerId: 'fixture', modelId: 'fixture-model' },
      ...overrides };
}

test('stage and child usage exceed all legacy task quotas without stopping', () => {
  const f = setup();
  try {
    f.ledger.reserve(f.run.id, f.modelConfig, reservation('one', { }));
    f.ledger.reserve(f.child.id, f.modelConfig, reservation('two', { }));
    f.ledger.settle(f.run.id, 'one', 80, 'settled');
    f.ledger.settle(f.child.id, 'two', 100, 'unknown');
    f.ledger.reserve(f.run.id, f.modelConfig, reservation('three', { tokens: 1, }));
    const rows = f.agentDb.prepare('SELECT run_id,execution_kind,task_id FROM agent_calls').all();
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.execution_kind === 'stage' && row.task_id === f.run.taskId));
    assert.throws(() => f.ledger.reserve('invented-run', f.modelConfig, reservation('fake')), /run_call_execution_unlinked/);
  } finally { f.close(); }
});

test('two SQLite connections retain usage and admit more calls after restart', async () => {
  const f = setup();
  const directory = await mkdtemp(join(tmpdir(), 'roc-task-usage-db-'));
  let first, second;
  try {
    const path = join(directory, 'agent.db');
    await f.agentDb.backup(path);
    first = new Database(path);
    second = new Database(path);
    const left = new api.RunUsageLedger(first), right = new api.RunUsageLedger(second);
    left.reserve(f.run.id, f.modelConfig, reservation('first', { }));
    right.reserve(f.child.id, f.modelConfig, reservation('second', { }));
    right.reconcileStartup();
    right.reserve(f.child.id, f.modelConfig, reservation('after-restart', { }));
    assert.equal(second.prepare("SELECT COUNT(*) FROM agent_calls WHERE state='unknown'").pluck().get(), 2);
    assert.equal(right.readTaskUsageStatus(f.run.taskId, f.project.id).tokens.unknown, 200);
  } finally { first?.close(); second?.close(); f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('dispatch attaches already recorded chat calls once and shares usage with its stage', () => {
  const f = setup();
  try {
    const createdAt = new Date().toISOString();
    const runId = 'chat-modelConfig-parent';
    const threadId = 'chat-modelConfig-thread';
    const manifest = api.compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic', mcpServers: [],
      mode: 'chat', requestedCapabilities: { mcpServers: [], skills: [] }, selfConfigAvailable: false,
      shellAllowedCommands: undefined, trustedHostAvailable: false, skills: [], workflowHint: null, researchProjectId: f.project.id
    }).manifest;
    const modelConfig = { ...f.modelConfig, };
    const snapshot = api.createRunExecutionSnapshot({ runId, threadId, inputMessageId: 'message', snapshot: {
      schemaVersion: 11, submissionHash: 'a'.repeat(64),
      taskContract: { contractVersion: 1, objective: 'Research', constraints: [], kind: 'reply',
        criteria: [{ id: 'response', description: 'Findings', check: { kind: 'response' } }] },
      runOrigin: 'chat', model: { providerId: 'fixture', modelId: 'fixture' }, mode: 'run', workspace: null,
      capabilityManifest: manifest, workflowHint: null, explicitSkillIds: [], dispatchKey: null, researchProjectId: f.project.id, modelConfig
    } });
    f.agentDb.prepare(`INSERT INTO agent_threads
      (id,kind,title,goal,status,research_project_id,created_at,updated_at)
      VALUES (?,'chat','Research','Research','active',?,?,?)`).run(threadId, f.project.id, createdAt, createdAt);
    f.agentDb.prepare(`INSERT INTO agent_runs
      (id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin,snapshot_json,snapshot_version)
      VALUES (?,?,1,'Research','running',?,'{}','chat',?,11)`).run(runId, threadId, createdAt, JSON.stringify(snapshot));
    f.ledger.reserve(runId, modelConfig, reservation('chat-call', { }));
    f.ledger.settle(runId, 'chat-call', 50, 'settled');
    assert.equal(f.agentDb.prepare('SELECT task_id FROM agent_calls').pluck().get(), null);
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture');
    const request = { projectId: f.project.id, expectedStage: 'discovery', instruction: 'Research', requestId: 'chat-stage' };
    const broker = new api.ExecutionGrantBroker(f.agentDb);
    const grant = broker.consumeResearchDispatch(broker.issueResearchDispatch({ runId, threadId, manifest, request }), request);
    const queued = f.repository.runs.begin(request, undefined, grant);
    const execution = f.tasks.linkStage(queued, grant);
    assert.equal(f.agentDb.prepare('SELECT task_id FROM agent_calls').pluck().get(), execution.taskId);
    assert.equal(f.agentDb.prepare("SELECT COUNT(*) FROM agent_calls WHERE kind='model'").pluck().get(), 1);
    assert.equal(f.ledger.readTaskUsageStatus(execution.taskId, f.project.id).tokens.settled, 50);
    assert.deepEqual(f.tasks.modelConfigForExecution('stage', queued.id, f.project.id), modelConfig);
    f.ledger.reserve(queued.id, modelConfig, reservation('stage-call', { }));
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_calls WHERE task_id = ?').pluck().get(execution.taskId), 2);
    const linkedEvents = f.tasks.events({ taskId: execution.taskId, projectId: f.project.id, afterSequence: 0, limit: 200 }).events;
    assert.deepEqual(linkedEvents.filter(event => event.eventType === 'call_linked')
      .map(event => [event.payload.executionId, event.payload.callId, event.payload.state]), [[runId, 'chat-call', 'settled']]);
  } finally { f.close(); }
});

test('invalid usage, duplicate calls and missing model configuration fail explicitly', () => {
  const f = setup();
  try {
    assert.throws(() => f.ledger.reserve(f.run.id, f.modelConfig, reservation('fraction', { tokens: 1.5 })), /run_call_reservation_invalid/);
    assert.throws(() => f.ledger.reserve(f.run.id, f.modelConfig, reservation('overflow', {tokens: Number.MAX_SAFE_INTEGER + 1})), /run_call_reservation_invalid/);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_calls').pluck().get(), 0);
    f.ledger.reserve(f.run.id, f.modelConfig, reservation('valid', { }));
    assert.throws(() => f.ledger.reserve(f.run.id, f.modelConfig, reservation('valid', { })), /run_call_call_already_reserved/);
    assert.throws(() => f.ledger.settle(f.run.id, 'valid', -1, 'settled'), /run_call_settlement_invalid/);
    assert.throws(() => f.ledger.settle(f.run.id, 'valid', 1.2, 'settled'), /run_call_settlement_invalid/);
    assert.doesNotThrow(() => f.ledger.reserve(f.child.id, f.modelConfig, reservation('missing')));
  } finally { f.close(); }
});

test('legacy task stop reasons and deadlines do not block active task calls', () => {
  const f = setup();
  try {
    f.ledger.reserve(f.run.id, f.modelConfig, reservation('one'));
    f.ledger.settle(f.run.id, 'one', 10, 'settled');
    f.ledger.reserve(f.child.id, f.modelConfig, reservation('two'));
    assert.equal(f.ledger.readTaskUsageStatus(f.run.taskId, f.project.id).calls.models.total, 2);
    f.tasks.setStatus(f.run.taskId, f.project.id, 'cancelled', 'user_cancelled', ['active']);
    assert.throws(() => f.ledger.reserve(f.child.id, f.modelConfig, reservation('cancelled')), /research_task_not_active/);
  } finally { f.close(); }
});

test('actual stage createAgent accounts repeated provider attempts beyond legacy model quota', async () => {
  const f = setup({ }, false);
  let requests = 0;
  class Model extends BaseChatModel {
    _llmType() { return 'modelConfig-fixture'; }
    bindTools() { return this; }
    async _generate() {
      requests += 1;
      assert.equal(f.agentDb.prepare("SELECT COUNT(*) FROM agent_calls WHERE state = 'reserved'").pluck().get(), 1);
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
    const prepared = await executor.prepare({ kind: 'app_default' }, f.modelConfig);
    const execute = () => prepared.execute({ run: f.run, context: f.repository.runs.getContext(f.run.id),
      loadTaskContext: () => ({task: f.tasks.get(f.run.taskId, f.project.id), facts: new api.ResearchTaskFactsService(f.repository).get({taskId: f.run.taskId, projectId: f.project.id})}),
      tools: [], signal: new AbortController().signal });
    await assert.rejects(execute(), /fixture_provider_failure/);
    assert.equal(requests, 1);
    assert.equal(outputCap, 250);
    const call = f.agentDb.prepare('SELECT execution_kind,task_id,state,actual_tokens FROM agent_calls').get();
    assert.deepEqual(call, { execution_kind: 'stage', task_id: f.run.taskId, state: 'unknown', actual_tokens: null });
    await assert.rejects(execute(), /fixture_provider_failure/);
    assert.equal(requests, 2);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_calls').pluck().get(), 2);
    const events = f.tasks.events({ taskId: f.run.taskId, projectId: f.project.id, afterSequence: 0, limit: 200 }).events;
    assert.equal(events.filter(event => event.eventType === 'call_reserved').length, 2);
    assert.equal(events.filter(event => event.eventType === 'call_unknown').length, 2);
  } finally { f.close(); }
});

test('actual stage createAgent settles successful usage without requiring a chat run', async () => {
  const f = setup();
  const output = { title: 'Verified fixture', markdown: 'Fixture output', claims: [], sections: [], verdict: 'ready' };
  let responseToolName;
  class Model extends BaseChatModel {
    _llmType() { return 'successful-modelConfig-fixture'; }
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
    const prepared = await executor.prepare({ kind: 'app_default' }, f.modelConfig);
    const result = await prepared.execute({
      run: f.run, context: f.repository.runs.getContext(f.run.id), tools: [], signal: new AbortController().signal,
      loadTaskContext: () => ({task: f.tasks.get(f.run.taskId, f.project.id), facts: new api.ResearchTaskFactsService(f.repository).get({taskId: f.run.taskId, projectId: f.project.id})})
    });
    assert.deepEqual(result.output, output);
    const call = f.agentDb.prepare("SELECT * FROM agent_calls WHERE kind = 'model'").get();
    assert.equal(call.state, 'settled');
    assert.equal(call.actual_tokens, 20);
    assert.equal(JSON.parse(call.envelope_json).providerId, 'fixture-provider');
    assert.equal(JSON.parse(call.envelope_json).modelId, 'fixture-model');
    assert.equal(f.ledger.readUsageStatus(f.run.id).tokens.settled, 20);
    const events = f.tasks.events({ taskId: f.run.taskId, projectId: f.project.id, afterSequence: 0, limit: 200 }).events;
    assert.equal(events.filter(event => event.eventType === 'call_reserved').length, 1);
    assert.equal(events.filter(event => event.eventType === 'call_settled').length, 1);
    assert.throws(() => f.ledger.settle(f.run.id, call.call_id, 1, 'settled'), /run_call_settlement_invalid/);
  } finally { f.close(); }
});
