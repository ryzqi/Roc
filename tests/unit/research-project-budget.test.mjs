import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createResearchFixture, loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

function setup() {
  const f = createResearchFixture(api, 'discovery');
  const other = f.tasks.linkStage({
    ...f.run, id: 'independent-stage', taskId: null, parentRunId: null, retryOfRunId: null, requestId: 'independent-stage'
  }, null);
  const limits = { ...api.createRunBudget({ contextBudgetTokens: 1000, maxOutputTokens: 250 }),
    maxCallTokens: 1400, maxTotalTokens: 10000, maxModelCalls: 20, maxConcurrentModelCalls: 5 };
  f.agentDb.prepare('UPDATE research_task_budgets SET limits_json=?').run(JSON.stringify(limits));
  const policy = (overrides = {}) => f.tasks.projectBudgets.save({
    projectId: f.project.id, expectedRevision: f.tasks.projectBudgets.status(f.project.id).revision,
    limits: { maxTotalTokens: 10000, maxModelCalls: 20, maxConcurrentModelCalls: 5, maxCostMicrousd: null, ...overrides }
  });
  return { ...f, other, limits, policy, ledger: new api.RunBudgetLedger(f.agentDb) };
}
const reserve = (id, overrides = {}) => ({
  id, kind: 'model', tokens: 100, inputHash: id, envelope: { providerId: 'fixture', modelId: 'fixture-model' },
  costMicrousd: null, pricingVersion: 'fixture', ...overrides
});

test('independent tasks compete for project headroom and duplicate calls cannot consume it twice', () => {
  const f = setup();
  try {
    f.policy({ maxTotalTokens: 180 });
    f.ledger.reserve(f.run.id, f.limits, reserve('one'));
    assert.throws(() => f.ledger.reserve('independent-stage', f.limits, reserve('two')), /research_project_token_budget_exhausted/);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_budget_calls').pluck().get(), 1);
    assert.equal(f.tasks.projectBudgets.status(f.project.id).stopReason, 'research_project_token_budget_exhausted');
    assert.equal(f.ledger.readTaskBudgetStatus(f.other.taskId, f.project.id).stopReason, 'research_project_token_budget_exhausted');
    f.ledger.settle(f.run.id, 'one', 80, 'settled');
    const changed = f.policy({ maxTotalTokens: 180 });
    assert.equal(changed.tokens.settled, 80);
    assert.equal(changed.tokens.remaining, 100);
    f.ledger.reserve('independent-stage', f.limits, reserve('two'));
    assert.throws(() => f.ledger.reserve('independent-stage', f.limits, reserve('two')), /run_budget_call_already_reserved/);
    const status = f.tasks.projectBudgets.status(f.project.id);
    assert.equal(status.models.total, 2);
    assert.equal(status.tokens.reserved, 100);
    assert.equal(status.tokens.remaining, 0);
    assert.notEqual(f.other.taskId, f.run.taskId);
    assert.deepEqual(f.agentDb.prepare('SELECT project_budget_revision FROM agent_budget_calls ORDER BY rowid').pluck().all(), [2, 3]);
  } finally { f.close(); }
});

test('unknown partial usage retains task and project reservation ceilings', () => {
  const f = setup();
  try {
    f.policy({ maxTotalTokens: 180, maxCostMicrousd: 100 });
    f.ledger.reserve(f.run.id, f.limits, reserve('partial', { costMicrousd: 80 }));
    f.ledger.settle(f.run.id, 'partial', 20, 'unknown', undefined, {}, 10);
    const task = f.ledger.readTaskBudgetStatus(f.run.taskId, f.project.id);
    const project = f.tasks.projectBudgets.status(f.project.id);
    assert.equal(task.tokens.unknown, 100);
    assert.equal(task.cost.reservedMicrousd, 80);
    assert.equal(project.tokens.unknown, 100);
    assert.equal(project.tokens.remaining, 80);
    assert.equal(project.cost.reservedMicrousd, 80);
    assert.throws(() => f.ledger.reserve('independent-stage', f.limits, reserve('next', { costMicrousd: 1 })),
      /research_project_token_budget_exhausted/);
  } finally { f.close(); }
});

test('project cost cap refuses unknown partial usage without a reservation', () => {
  const f = setup();
  try {
    f.policy();
    f.ledger.reserve(f.run.id, f.limits, reserve('unpriced'));
    f.ledger.settle(f.run.id, 'unpriced', 20, 'unknown', undefined, {}, 10);
    f.policy({ maxCostMicrousd: 100 });
    assert.throws(() => f.ledger.reserve('independent-stage', f.limits, reserve('next', { costMicrousd: 1 })),
      /research_project_cost_estimate_unavailable/);
  } finally { f.close(); }
});

test('project projection keeps settled calls with missing actual cost unknown', () => {
  const f = setup();
  try {
    f.policy({ maxCostMicrousd: 100 });
    f.ledger.reserve(f.run.id, f.limits, reserve('unpriced-result', { costMicrousd: 80 }));
    f.ledger.settle(f.run.id, 'unpriced-result', 20, 'settled');
    const status = f.tasks.projectBudgets.status(f.project.id);
    assert.equal(status.cost.state, 'unknown');
    assert.equal(status.cost.settledMicrousd, 0);
    assert.equal(status.cost.reservedMicrousd, 80);
  } finally { f.close(); }
});

test('two SQLite connections enforce project concurrency across different task roots and retain unknown ceilings on restart', async () => {
  const f = setup();
  const directory = await mkdtemp(join(tmpdir(), 'roc-project-budget-'));
  let leftDb, rightDb;
  try {
    f.policy({ maxConcurrentModelCalls: 1, maxCostMicrousd: 100 });
    const path = join(directory, 'agent.db');
    await f.agentDb.backup(path);
    leftDb = new Database(path); rightDb = new Database(path);
    leftDb.pragma('foreign_keys = ON'); rightDb.pragma('foreign_keys = ON');
    const left = new api.RunBudgetLedger(leftDb), right = new api.RunBudgetLedger(rightDb);
    left.reserve(f.run.id, f.limits, reserve('one', { costMicrousd: 80 }));
    assert.throws(() => right.reserve('independent-stage', f.limits, reserve('two', { costMicrousd: 20 })),
      /research_project_model_concurrency_exhausted/);
    const project = new api.ProjectBudgetLedger(rightDb);
    assert.equal(project.status(f.project.id).stopReason, null);
    right.reconcileStartup();
    assert.equal(project.status(f.project.id).tokens.unknown, 100);
    assert.equal(project.status(f.project.id).cost.reservedMicrousd, 80);
    right.reserve('independent-stage', f.limits, reserve('two', { costMicrousd: 20 }));
    right.settle('independent-stage', 'two', null, 'unknown');
    assert.equal(project.status(f.project.id).cost.state, 'unknown');
    assert.throws(() => right.reserve('independent-stage', f.limits, reserve('three', { costMicrousd: 1 })),
      /research_project_cost_budget_exhausted/);
    assert.equal(leftDb.prepare('SELECT COUNT(*) FROM agent_budget_calls').pluck().get(), 2);
  } finally { leftDb?.close(); rightDb?.close(); f.close(); await rm(directory, {recursive: true, force: true}); }
});

test('unconfigured and unpriced project policies refuse before the provider, while explicit revisions preserve prior spend', async () => {
  const f = setup();
  try {
    f.policy({ maxModelCalls: 1 });
    let attempts = 0;
    const execute = runId => new api.RunBudgetObserver(f.ledger, runId, f.limits, 'fixture', {
      providerId: 'fixture', modelId: 'fixture-model'
    }).invoke({
      messages: [new HumanMessage('fixture')], purpose: 'agent',
      responseMessage: result => result,
      invoke: async () => {
        attempts++;
        return new AIMessage({content: 'fixture', usage_metadata: {input_tokens: 15, output_tokens: 5, total_tokens: 20}});
      }
    });
    await execute(f.run.id);
    await assert.rejects(execute('independent-stage'), /research_project_model_call_budget_exhausted/);
    assert.equal(attempts, 1);
    assert.equal(f.tasks.projectBudgets.status(f.project.id).tokens.settled, 20);
    assert.equal(f.agentDb.prepare('SELECT stop_reason FROM research_task_budgets WHERE task_id=?').pluck().get(f.other.taskId), null);
    f.policy({ maxModelCalls: 2, maxCostMicrousd: 100 });
    await assert.rejects(execute('independent-stage'), /research_project_cost_estimate_unavailable/);
    assert.equal(attempts, 1);
    f.policy({ maxModelCalls: 2 });
    await execute('independent-stage');
    assert.equal(attempts, 2);
    assert.equal(f.tasks.projectBudgets.status(f.project.id).tokens.settled, 40);
    const policies = f.agentDb.prepare('SELECT limits_json FROM research_project_budget_policies WHERE project_id=? ORDER BY revision')
      .all(f.project.id);
    assert.equal(policies.length, 4);
    assert.throws(() => f.agentDb.prepare("UPDATE research_project_budget_policies SET limits_json='{}' WHERE project_id=?")
      .run(f.project.id), /research_project_budget_policy_immutable/);
    assert.throws(() => f.tasks.projectBudgets.save({projectId: f.project.id, expectedRevision: 1,
      limits: JSON.parse(policies[0].limits_json)}), /research_project_budget_revision_conflict/);
    assert.throws(() => f.agentDb.prepare('UPDATE agent_budget_calls SET project_id=?').run('foreign'),
      /research_project_budget_association_conflict/);
  } finally { f.close(); }
});

test('frozen root chat scope is charged before research task linkage and missing configuration is explicit', () => {
  const f = setup();
  try {
    const timestamp = new Date().toISOString();
    const manifest = api.compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic', mcpServers: [],
      mode: 'chat', requestedCapabilities: {mcpServers: [], skills: []}, selfConfigAvailable: false,
      shellAllowedCommands: undefined, trustedHostAvailable: false, skills: [], workflowHint: null, researchProjectId: f.project.id
    }).manifest;
    const snapshot = api.createRunExecutionSnapshot({runId: 'chat', threadId: 'thread', inputMessageId: 'message', snapshot: {
      schemaVersion: 10, submissionHash: 'a'.repeat(64),
      taskContract: {contractVersion: 1, objective: 'Research', constraints: [], kind: 'reply',
        criteria: [{id: 'response', description: 'Research', check: {kind: 'response'}}]},
      runOrigin: 'chat', model: {providerId: 'fixture', modelId: 'fixture-model'}, mode: 'run', workspace: null,
      capabilityManifest: manifest, workflowHint: null, explicitSkillIds: [], dispatchKey: null,
      researchProjectId: f.project.id, budget: f.limits
    }});
    f.agentDb.prepare(`INSERT INTO agent_threads(id,kind,title,goal,status,research_project_id,created_at,updated_at)
      VALUES ('thread','chat','Research','Research','active',?,?,?)`).run(f.project.id, timestamp, timestamp);
    f.agentDb.prepare(`INSERT INTO agent_runs(id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin,snapshot_json,snapshot_version)
      VALUES ('chat','thread',1,'Research','running',?,'{}','chat',?,10)`).run(timestamp, JSON.stringify(snapshot));
    f.ledger.reserve('chat', f.limits, reserve('root'));
    const call = f.agentDb.prepare("SELECT project_id,task_id FROM agent_budget_calls WHERE call_id='root'").get();
    assert.deepEqual(call, {project_id: f.project.id, task_id: null});
    assert.equal(f.tasks.projectBudgets.status(f.project.id).models.total, 1);
    const otherProject = f.repository.createProject({
      title: 'Unconfigured', description: '', workspacePath: join(tmpdir(), 'roc-project-budget-unconfigured')
    });
    const unconfigured = f.tasks.linkStage({...f.run, id: 'unconfigured', projectId: otherProject.id, taskId: null}, null);
    f.agentDb.prepare('UPDATE research_task_budgets SET limits_json=? WHERE task_id=?').run(JSON.stringify(f.limits), unconfigured.taskId);
    assert.throws(() => f.ledger.reserve('unconfigured', f.limits, reserve('missing')), /research_project_budget_missing/);
    assert.equal(f.tasks.projectBudgets.status(otherProject.id), null);
    assert.equal(f.agentDb.prepare("SELECT COUNT(*) FROM agent_budget_calls WHERE call_id='missing'").pluck().get(), 0);
    assert.equal(f.tasks.projectBudgets.status(f.project.id).models.total, 1);
    f.agentDb.prepare("UPDATE agent_runs SET snapshot_json=NULL WHERE id='chat'").run();
    assert.throws(() => f.ledger.reserve('chat', f.limits, reserve('no-snapshot')), /run_budget_project_snapshot_missing/);
  } finally { f.close(); }
});

test('real v14 migration attributes prior calls without guessing a project policy or fabricating task events', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    api.applyDatabaseMigrations(db, {dbName: 'agent', migrations: api.agentMigrations.filter(migration => migration.version <= 14)});
    const timestamp = '2026-11-03T00:00:00.000Z';
    const task = {schemaVersion: 2, id: 'task', projectId: 'project', goal: 'Research', rootAgentRunId: null,
      status: 'active', statusReason: null, deadlineClock: 'continuous', budgetPolicyVersion: 1, createdAt: timestamp, updatedAt: timestamp};
    db.prepare('INSERT INTO research_tasks(id,project_id,status,snapshot_json,created_at) VALUES (?,?,?,?,?)')
      .run(task.id, task.projectId, task.status, JSON.stringify(task), timestamp);
    db.prepare(`INSERT INTO agent_budget_calls(run_id,call_id,execution_kind,task_id,kind,input_hash,reserved_tokens,state,envelope_json,created_at)
      VALUES ('stage','prior','stage','task','model','hash',100,'unknown','{}',?)`).run(timestamp);
    const eventCount = db.prepare('SELECT COUNT(*) FROM research_task_events').pluck().get();
    api.applyDatabaseMigrations(db, {dbName: 'agent', migrations: api.agentMigrations, allowOffline: true});
    assert.equal(db.prepare('SELECT project_id FROM agent_budget_calls').pluck().get(), 'project');
    assert.equal(db.prepare('SELECT project_budget_revision FROM agent_budget_calls').pluck().get(), null);
    assert.equal(db.prepare('SELECT COUNT(*) FROM research_task_events').pluck().get(), eventCount);
    const projects = new api.ProjectBudgetLedger(db);
    assert.equal(projects.status('project'), null);
    const status = projects.save({projectId: 'project', expectedRevision: 0,
      limits: {maxTotalTokens: 200, maxModelCalls: 3, maxConcurrentModelCalls: 1, maxCostMicrousd: null}});
    assert.equal(status.tokens.unknown, 100);
    assert.equal(status.tokens.remaining, 100);
    assert.equal(status.cost.state, 'unknown');
  } finally { db.close(); }
});

test('a delayed refusal from an earlier policy revision cannot block a newly configured revision', () => {
  const f = setup();
  try {
    f.policy({maxTotalTokens: 50});
    let refusal;
    try { f.tasks.projectBudgets.assertReservation(f.project.id, {tokens: 100, costMicrousd: null}); }
    catch (error) { refusal = error; }
    assert.equal(refusal.message, 'research_project_token_budget_exhausted');
    const next = f.policy({maxTotalTokens: 1000});
    f.tasks.projectBudgets.recordRefusal(refusal.projectId, refusal.message, refusal.revision);
    assert.equal(f.tasks.projectBudgets.status(f.project.id).revision, next.revision);
    assert.equal(f.tasks.projectBudgets.status(f.project.id).stopReason, null);
    f.ledger.reserve(f.run.id, f.limits, reserve('new-policy'));
    assert.equal(f.tasks.projectBudgets.status(f.project.id).models.total, 1);
  } finally { f.close(); }
});

test('project budget capabilities validate project ownership and exact revision before publishing changes', async () => {
  const f = setup();
  const handlers = new Map(), notifications = [];
  try {
    api.registerResearchProjectBudgetCapabilities({
      pluginId: 'fixture', capabilities: {register(_plugin, descriptor, handler) {handlers.set(descriptor.name, handler);}},
      eventBus: {publish: async event => {notifications.push(event);}}, logger: {warn: () => {}}
    }, f.repository);
    const status = f.tasks.projectBudgets.status(f.project.id);
    const request = {projectId: f.project.id, expectedRevision: status.revision,
      limits: {maxTotalTokens: 2000, maxModelCalls: 10, maxConcurrentModelCalls: 1, maxCostMicrousd: null}};
    await assert.rejects(handlers.get('research.projectBudget.save')({...request, projectId: 'foreign'}), /research_project_not_found/);
    assert.deepEqual(notifications, []);
    const saved = await handlers.get('research.projectBudget.save')(request);
    assert.equal(saved.revision, request.expectedRevision + 1);
    assert.deepEqual(notifications[0].payload, {projectId: f.project.id});
    await assert.rejects(handlers.get('research.projectBudget.save')(request), /research_project_budget_revision_conflict/);
    assert.equal(notifications.length, 1);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:project-budget-save', [request]), [request]);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:project-budget-save', [{...request, limits: {...request.limits, maxTotalTokens: 1.5}}]));
    assert.throws(() => api.parseIpcRequestArgs('roc:research:project-budget-save', [{...request, resetSpend: true}]));
  } finally { f.close(); }
});
