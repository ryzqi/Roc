import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { createResearchFixture, figureRequest, loadResearchTestApi } from './fixtures/research-test-kit.mjs';
import {syntheticExportPublicationReview} from '../fixtures/research-export-publication.mjs';

let api;
let directory;
before(async () => {
  api = await loadResearchTestApi();
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'roc-task-identity-')));
});
after(() => { api.dispose(); rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const f = createResearchFixture(api, 'discovery', directory);
  const { project, agentDb } = f;
  const runId = 'chat-run';
  const threadId = 'chat-thread';
  const timestamp = '2026-11-03T00:00:00.000Z';
  const manifest = api.compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic', mcpServers: [],
    mode: 'chat', requestedCapabilities: { mcpServers: [], skills: [] }, selfConfigAvailable: false,
    shellAllowedCommands: undefined, trustedHostAvailable: false, skills: [], workflowHint: null,
    researchProjectId: project.id
  }).manifest;
  const snapshot = api.createRunExecutionSnapshot({
    runId, threadId, inputMessageId: 'message',
    snapshot: {
      schemaVersion: 11, submissionHash: 'f'.repeat(64),
      taskContract: { contractVersion: 1, objective: 'Research fixture', constraints: [], kind: 'reply',
        criteria: [{ id: 'response', description: 'Return findings', check: { kind: 'response' } }] },
      runOrigin: 'chat', model: { providerId: 'fixture', modelId: 'fixture-model' }, mode: 'run',
      workspace: { path: directory, hash: 'workspace-hash' }, capabilityManifest: manifest, workflowHint: null,
      explicitSkillIds: [], dispatchKey: null, researchProjectId: project.id,
      modelConfig: api.createRunModelConfig({ contextWindowTokens: null })
    }
  });
  agentDb.prepare(`INSERT INTO agent_threads
    (id,kind,title,goal,status,research_project_id,created_at,updated_at)
    VALUES (?,'chat','Fixture','Research','active',?,?,?)`).run(threadId, project.id, timestamp, timestamp);
  agentDb.prepare(`INSERT INTO agent_runs
    (id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,
      workspace_path,run_origin,snapshot_json,snapshot_version)
    VALUES (?,?,1,'Research','running',?,'{}',?,'chat',?,11)`)
    .run(runId, threadId, timestamp, directory, JSON.stringify(snapshot));
  let now = new Date(timestamp);
  const broker = new api.ExecutionGrantBroker(agentDb, () => now);
  const request = { projectId: project.id, expectedStage: 'discovery', instruction: 'Find research gap', requestId: 'dispatch-1' };
  const issue = (overrides = {}) => broker.issueResearchDispatch({ runId, threadId, manifest, request, ...overrides });
  return { ...f, broker, request, issue, runId, threadId, manifest, snapshot, setNow: (value) => { now = value; } };
}

function runtime(f) {
  let attempts = 0;
  const executor = {
    async prepare() {
      attempts += 1;
      const active = f.repository.getWorkflow(f.project.id).stages.find((stage) => stage.stage === 'discovery').activeRunId;
      const linked = f.repository.runs.get(active, f.project.id);
      assert.equal(f.tasks.requireExecution('stage', active, f.project.id).taskId, linked.taskId);
      throw new Error('research_fixture_model_failure');
    }
  };
  return { service: new api.ResearchStageRuntime(f.repository, {}, executor, { complete: async () => {} }, {cancelOwned: async () => {}}),
    attempts: () => attempts };
}

test('reopened execution and task identities reject mismatched indexed columns', async () => {
  const f = fixture();
  const path = join(directory, 'identity-corruption.db');
  try {
    await f.agentDb.backup(path);
    const db = new Database(path);
    try {
      const tasks = new api.ResearchTaskRepository(db);
      const id = f.run.taskId;
      const execution = tasks.requireExecution('stage', f.run.id, f.project.id);
      db.prepare("UPDATE research_task_executions SET snapshot_json = json_set(snapshot_json, '$.taskId', 'different-task') WHERE kind = 'stage' AND execution_id = ?").run(f.run.id);
      assert.throws(() => tasks.requireExecution('stage', f.run.id, f.project.id), /research_task_execution_identity_corrupt/);
      assert.throws(() => tasks.executions(id, f.project.id), /research_task_execution_identity_corrupt/);
      db.prepare("UPDATE research_task_executions SET snapshot_json = ? WHERE kind = 'stage' AND execution_id = ?")
        .run(JSON.stringify(execution), f.run.id);
      db.prepare("UPDATE research_tasks SET status = 'paused' WHERE id = ?").run(id);
      assert.throws(() => tasks.get(id, f.project.id), /research_task_identity_corrupt/);
      assert.throws(() => tasks.list({ projectId: f.project.id, afterTaskId: null, limit: 100 }), /research_task_identity_corrupt/);
    } finally { db.close(); }
  } finally { f.close(); }
});

test('reopened stage associations reject corrupt rows and conflicting agent links', async () => {
  const f = fixture();
  const researchPath = join(directory, 'research-association.db');
  const agentPath = join(directory, 'agent-association.db');
  try {
    await f.db.backup(researchPath);
    await f.agentDb.backup(agentPath);
    const researchDb = new Database(researchPath);
    const agentDb = new Database(agentPath);
    try {
      const tasks = new api.ResearchTaskRepository(agentDb);
      const repository = new api.ResearchRepository(researchDb, tasks, () => '2026-11-03T00:00:00.000Z');
      repository.runs.reconcileTaskLinks();
      researchDb.prepare("UPDATE research_stage_runs SET status = 'failed' WHERE id = ?").run(f.run.id);
      assert.throws(() => repository.runs.get(f.run.id, f.project.id), /research_stage_run_identity_corrupt/);
      assert.throws(() => repository.runs.reconcileTaskLinks(), /research_stage_run_identity_corrupt/);
      researchDb.prepare("UPDATE research_stage_runs SET status = ?, task_id = 'other-task', snapshot_json = json_set(snapshot_json, '$.taskId', 'other-task') WHERE id = ?")
        .run(f.run.status, f.run.id);
      assert.throws(() => repository.runs.reconcileTaskLinks(), /research_task_execution_conflict/);
    } finally { researchDb.close(); agentDb.close(); }
  } finally { f.close(); }
});

test('chat dispatch binds trusted parent while direct start, retry and replay preserve their own task roots', async () => {
  const f = fixture();
  const r = runtime(f);
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture');
    const dispatched = r.service.start(f.request, f.broker.consumeResearchDispatch(f.issue(), f.request));
    assert.equal(dispatched.parentRunId, null);
    const execution = f.tasks.requireExecution('stage', dispatched.id, f.project.id);
    assert.equal(execution.parentKind, 'chat');
    assert.equal(execution.parentExecutionId, f.runId);
    assert.equal(f.tasks.get(dispatched.taskId, f.project.id).rootAgentRunId, f.runId);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM research_tasks').pluck().get(), 2);
    const replay = r.service.start(f.request, f.broker.consumeResearchDispatch(f.issue(), f.request));
    assert.equal(replay.id, dispatched.id);
    await r.service.waitForIdle();
    assert.equal(r.attempts(), 1);
    const retry = r.service.retry({ projectId: f.project.id, runId: dispatched.id, requestId: 'retry-1' });
    assert.equal(retry.taskId, dispatched.taskId);
    assert.equal(retry.parentRunId, null);
    assert.equal(retry.retryOfRunId, dispatched.id);
    assert.equal(f.tasks.requireExecution('stage', retry.id, f.project.id).associationSource, 'retry');
    await r.service.waitForIdle();
    const direct = f.repository.runs.begin({ ...f.request, requestId: 'direct-1' });
    assert.notEqual(direct.taskId, dispatched.taskId);
    assert.equal(f.tasks.get(direct.taskId, f.project.id).rootAgentRunId, null);
    assert.equal(f.tasks.requireExecution('stage', direct.id, f.project.id).parentKind, null);
    await r.service.waitForIdle();
    assert.equal(r.attempts(), 2);
    assert.equal(f.db.prepare('SELECT task_id FROM research_stage_runs WHERE id = ?').pluck().get(direct.id), direct.taskId);
  } finally { await r.service.shutdown(); f.close(); }
});

test('archiving a queued project prevents replay dispatch and model preparation', async () => {
  const f = fixture();
  let preparations = 0;
  const service = new api.ResearchStageRuntime(f.repository, {}, {
    async prepare() { preparations += 1; throw new Error('model_must_not_prepare'); }
  }, { complete: async () => {} }, {cancelOwned: async () => {}});
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture');
    const request = { ...f.request, requestId: 'archive-before-dispatch' };
    const run = service.start(request, f.broker.consumeResearchDispatch(f.issue({request}),request));
    const replayGrant = f.broker.consumeResearchDispatch(f.issue({request}),request);
    f.db.prepare("UPDATE research_projects SET status = 'archived' WHERE id = ?").run(f.project.id);
    assert.throws(() => service.start(request,replayGrant), /research_run_not_current/);
    await service.waitForIdle();
    assert.equal(preparations, 0);
    assert.equal(f.repository.runs.get(run.id, f.project.id).status, 'failed');
    assert.equal(f.repository.getProject(f.project.id).status, 'archived');
  } finally { await service.shutdown(); f.close(); }
});

test('dispatch rejects unknown, copied, reused, changed and cross-project credentials before scheduling', async () => {
  const f = fixture();
  const r = runtime(f);
  try {
    assert.throws(() => f.broker.consumeResearchDispatch('invented', f.request), /research_dispatch_grant_unavailable/);
    const reference = f.issue();
    assert.throws(() => f.broker.consumeResearchDispatch(reference, { ...f.request, instruction: 'Changed' }), /research_dispatch_request_mismatch/);
    assert.throws(() => f.broker.consumeResearchDispatch(reference, { ...f.request, projectId: 'other-project' }), /research_dispatch_request_mismatch/);
    const grant = f.broker.consumeResearchDispatch(reference, f.request);
    assert.throws(() => f.broker.consumeResearchDispatch(reference, f.request), /research_dispatch_grant_unavailable/);
    assert.throws(() => r.service.start(f.request, { ...grant }), /research_dispatch_grant_untrusted/);
    assert.throws(() => r.service.start({ ...f.request, requestId: 'changed' }, grant), /research_dispatch_request_mismatch/);
    assert.throws(() => f.tasks.linkStage({ ...f.run, instruction: f.request.instruction }, grant), /research_dispatch_request_mismatch/);
    assert.equal(r.attempts(), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_stage_runs').pluck().get(), 1);
  } finally { await r.service.shutdown(); f.close(); }
});

test('dispatch expires, revokes on cancellation and restart, and verifies stored parent project and manifest', () => {
  for (const condition of ['expired', 'revoked', 'restart', 'terminal', 'project', 'manifest', 'thread', 'missing-tool']) {
    const f = fixture();
    try {
      const reference = f.issue();
      if (condition === 'expired') f.setNow(new Date('2026-11-03T00:00:30.000Z'));
      if (condition === 'revoked') f.broker.revokeRun(f.runId);
      if (condition === 'restart') api.openExecutionGrantBroker(f.agentDb);
      if (condition === 'terminal') f.agentDb.prepare("UPDATE agent_runs SET status = 'completed' WHERE id = ?").run(f.runId);
      if (condition === 'project') f.agentDb.prepare("UPDATE agent_threads SET research_project_id = 'other' WHERE id = ?").run(f.threadId);
      if (condition === 'manifest') {
        const changed = structuredClone(f.snapshot);
        changed.capabilityManifest.tools = [];
        f.agentDb.prepare('UPDATE agent_runs SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(changed), f.runId);
      }
      if (condition === 'thread') assert.throws(() => f.issue({ threadId: 'invented' }), /research_dispatch_parent_not_active/);
      else if (condition === 'missing-tool') assert.throws(() => f.issue({ manifest: { ...f.manifest, tools: [] } }), /research_dispatch_capability_denied/);
      else assert.throws(() => f.broker.consumeResearchDispatch(reference, f.request), /research_dispatch_/);
      if (condition === 'expired') assert.equal(f.agentDb.prepare('SELECT state FROM agent_research_dispatch_grants WHERE id = ?').pluck().get(reference), 'expired');
      if (condition === 'restart' || condition === 'revoked') {
        assert.equal(f.agentDb.prepare('SELECT state FROM agent_research_dispatch_grants WHERE id = ?').pluck().get(reference), 'revoked');
      }
    } finally { f.close(); }
  }
});

test('owned executions and three review roles retain stage parentage, deny reassignment and cross-project access', () => {
  const f = fixture();
  try {
    for (const kind of ['experiment', 'figure', 'export']) {
      const input = { kind, executionId: `${kind}-1`, projectId: f.project.id, ownerRunId: f.run.id,
        goal: kind, snapshot: { environment: 'frozen' } };
      const first = f.tasks.linkOwned(input);
      assert.equal(first.taskId, f.run.taskId);
      assert.equal(first.parentKind, 'stage');
      assert.equal(first.parentExecutionId, f.run.id);
      assert.deepEqual(f.tasks.linkOwned(input), first);
      assert.throws(() => f.tasks.linkOwned({ ...input, ownerRunId: null }), /research_task_execution_conflict/);
      assert.throws(() => f.tasks.linkOwned({ ...input, snapshot: { environment: 'changed' } }), /research_task_execution_conflict/);
      assert.throws(() => f.tasks.requireExecution(kind, first.executionId, 'other'), /research_task_project_mismatch/);
    }
    for (const role of ['methods-reviewer', 'evidence-reviewer', 'writing-reviewer']) {
      const child = { ...f.run, id: role, parentRunId: f.run.id, retryOfRunId: null, role };
      const execution = f.tasks.linkStage({...child, executionSnapshot: {...child.executionSnapshot, nodeBinding: {kind: 'none'}}}, null);
      assert.equal(execution.taskId, f.run.taskId);
      assert.equal(execution.parentKind, 'stage');
      assert.equal(execution.parentExecutionId, f.run.id);
      assert.equal(execution.associationSource, 'review');
    }
    const direct = f.tasks.linkOwned({ kind: 'figure', executionId: 'direct', projectId: f.project.id,
      ownerRunId: null, goal: 'Standalone', snapshot: {} });
    assert.equal(direct.parentKind, null);
    assert.notEqual(direct.taskId, f.run.taskId);
    assert.throws(() => f.tasks.linkStage({ ...f.run, executionSnapshot: {...f.run.executionSnapshot, nodeBinding: {kind: 'none'}}, id: 'orphan', parentRunId: 'missing' }, null), /research_task_execution_unlinked/);
    assert.throws(() => f.tasks.linkStage({ ...f.run, executionSnapshot: {...f.run.executionSnapshot, nodeBinding: {kind: 'none'}}, id: 'orphan-retry', parentRunId: null, retryOfRunId: 'missing' }, null), /research_task_execution_unlinked/);
    assert.equal(f.tasks.executions(f.run.taskId, f.project.id).length, 7);
  } finally { f.close(); }
});

test('terminal tasks allow identical owned association replay while denying new links and identity changes', () => {
  for (const state of ['interrupted', 'cancelled']) {
    const f = fixture();
    try {
      const inputs = ['experiment', 'figure', 'export'].map(kind => ({
        kind, executionId: `${state}-${kind}`, projectId: f.project.id, ownerRunId: f.run.id,
        goal: kind, snapshot: { sourceVersion: 1 }
      }));
      const linked = inputs.map(input => f.tasks.linkOwned(input));
      if (state === 'cancelled') f.tasks.setStatus(f.run.taskId, f.project.id, 'cancelled', 'fixture', ['active']);
      else f.repository.runs.recoverInterrupted();
      const task = f.tasks.get(f.run.taskId, f.project.id);
      assert.equal(task.status, state);
      const rows = f.tasks.executions(f.run.taskId, f.project.id);
      for (const [index, input] of inputs.entries()) {
        assert.deepEqual(f.tasks.linkOwned(input), linked[index]);
        assert.throws(() => f.tasks.linkOwned({ ...input, snapshot: { sourceVersion: 2 } }),
          /research_task_execution_conflict/u);
        assert.throws(() => f.tasks.linkOwned({ ...input, ownerRunId: null }),
          /research_task_execution_conflict/u);
        assert.throws(() => f.tasks.linkOwned({ ...input, executionId: `${input.executionId}-new` }),
          /research_task_not_active/u);
      }
      assert.deepEqual(f.tasks.get(task.id, f.project.id), task);
      assert.deepEqual(f.tasks.executions(task.id, f.project.id), rows);
    } finally { f.close(); }
  }
});

test('cross-database association failure blocks model execution; startup repairs only authoritative links', async () => {
  const f = fixture();
  const r = runtime(f);
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture');
    f.agentDb.exec(`CREATE TRIGGER reject_stage_link BEFORE INSERT ON research_task_executions
      WHEN NEW.kind = 'stage' BEGIN SELECT RAISE(ABORT, 'fixture_link_failed'); END`);
    assert.throws(() => r.service.start(f.request, f.broker.consumeResearchDispatch(f.issue(),f.request)), /fixture_link_failed/);
    assert.equal(r.attempts(), 0);
    assert.equal(f.repository.runs.list({ projectId: f.project.id, limit: 20 })[0].status, 'cancelled');
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM research_tasks').pluck().get(), 1);
    f.agentDb.exec('DROP TRIGGER reject_stage_link');
    // Fail after the durable Agent intent but before the Research row commits.
    f.db.exec("CREATE TRIGGER fail_stage BEFORE INSERT ON research_stage_runs BEGIN SELECT RAISE(ABORT,'fixture_crash'); END");
    assert.throws(()=>f.repository.runs.begin({...f.request,requestId:'orphan-intent'}), /fixture_crash/);
    f.db.exec('DROP TRIGGER fail_stage');
    const orphan = f.agentDb.prepare("SELECT execution_id,task_id FROM research_task_executions WHERE json_extract(snapshot_json,'$.associationState')='pending'").get();
    const agentPath=join(directory,'intent-agent.db');const researchPath=join(directory,'intent-research.db');
    await f.agentDb.backup(agentPath);await f.db.backup(researchPath);
    const agentDb=new Database(agentPath);const researchDb=new Database(researchPath);
    try {
      const tasks=new api.ResearchTaskRepository(agentDb);
      const repo=new api.ResearchRepository(researchDb,tasks,()=> '2026-11-03T00:00:00.000Z');
      repo.runs.reconcileTaskLinks();
      assert.equal(tasks.requireExecution('stage',orphan.execution_id,f.project.id).associationState,'failed');
      assert.equal(tasks.get(orphan.task_id,f.project.id).statusReason,'research_execution_intent_uncommitted');
      assert.equal(repo.runs.list({projectId:f.project.id,limit:20}).length,1);
    } finally {agentDb.close();researchDb.close();}
    // Fail after Research commit but before confirmation; startup confirms the same intent.
    const confirm=f.tasks.confirmExecution;
    f.tasks.confirmExecution=()=>{throw new Error('fixture_confirm_crash');};
    assert.throws(()=>f.repository.runs.begin({...f.request,requestId:'interrupted-link'}), /fixture_confirm_crash/);
    f.tasks.confirmExecution=confirm;
    f.repository.runs.reconcileTaskLinks();
    const queued=f.repository.runs.list({projectId:f.project.id,limit:20}).find(run=>run.requestId==='interrupted-link');
    assert.equal(f.tasks.requireExecution('stage',queued.id,f.project.id).associationState,'confirmed');
    f.repository.runs.recoverInterrupted();
    assert.equal(f.repository.runs.get(queued.id,f.project.id).status,'interrupted');
  } finally { await r.service.shutdown(); f.close(); }
});

test('migration preserves old stage snapshots as explicitly unlinked without inventing tasks', () => {
  const f = fixture();
  const old = new Database(':memory:');
  try {
    api.applyDatabaseMigrations(old, { dbName: 'research', migrations: api.researchMigrations.filter(entry => entry.version < 6) });
    const projectRow = f.db.prepare('SELECT * FROM research_projects WHERE id = ?').get(f.project.id);
    const columns = Object.keys(projectRow);
    old.prepare(`INSERT INTO research_projects (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...Object.values(projectRow));
    const snapshot = { ...f.run };
    delete snapshot.taskId;
    old.prepare(`INSERT INTO research_stage_runs
      (id,project_id,stage,request_id,parent_run_id,status,snapshot_json,context_json)
      VALUES (?,?,'discovery','old',NULL,'completed',?,'{}')`).run('old-run', f.project.id, JSON.stringify(snapshot));
    api.applyDatabaseMigrations(old, { dbName: 'research', migrations: api.researchMigrations, allowOffline: true });
    const saved = old.prepare('SELECT task_id, snapshot_json FROM research_stage_runs WHERE id = ?').get('old-run');
    assert.equal(saved.task_id, null);
    assert.equal(JSON.parse(saved.snapshot_json).taskId, null);
    assert.equal(JSON.parse(saved.snapshot_json).id, snapshot.id);
  } finally { old.close(); f.close(); }
});

test('capability dispatch consumes only its own asynchronous main-process context', async () => {
  const f = fixture();
  const r = runtime(f);
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture');
    const handlers = new Map();
    api.registerResearchRunCapabilities({ pluginId: 'research', capabilities: {
      register(_plugin, descriptor, handler) { handlers.set(descriptor.name, handler); }
    } }, f.repository.runs, r.service, f.repository.reviews, f.broker);
    const start = handlers.get('research.workflow.startRun');
    const linked = await api.withResearchDispatchReference(f.issue(), async () => {
      await Promise.resolve();
      return start(f.request);
    });
    assert.equal(f.tasks.requireExecution('stage', linked.id, f.project.id).parentKind, 'chat');
    await r.service.waitForIdle();
    await assert.rejects(start({ ...f.request, requestId: 'outside-context' }), /research_dispatch_grant_required/);
  } finally { await r.service.shutdown(); f.close(); }
});

test('public stage and production contracts reject model or renderer supplied parent identity', async () => {
  const handlers = new Map();
  const context = { pluginId: '@roc/plugin-research', capabilities: {
    register(_plugin, descriptor, handler) { handlers.set(descriptor.name, handler); }
  } };
  let calls = 0;
  const service = { start: async () => { calls += 1; }, prepare: async () => { calls += 1; } };
  api.registerResearchRunCapabilities(context, {}, service, {}, {});
  api.registerResearchFigureCapabilities(context, {}, service);
  api.registerResearchExperimentCapabilities(context, {}, service);
  api.registerResearchExportCapabilities(context, {}, service);
  const { projectId, ownerRunId, ...figure } = figureRequest('project', 'forged');
  const requests = [
    ['research.workflow.startRun', { projectId, expectedStage: 'discovery', instruction: 'Research', requestId: '1', parentRunId: 'forged' }],
    ['research.figure.start', { projectId, ownerRunId, ...figure }],
    ['research.experiment.start', { projectId, ownerRunId, requestId: '1', label: 'Experiment', sourcePath: 'experiment.mts',
      inputPaths: [], parameters: {}, timeoutMs: 1000, network: 'disabled', engine: 'typescript', runtime: { kind: 'bundled-node' }, sourceVersion: 1 }],
    ['research.export.prepare', { projectId, ownerRunId, requestId: '1', title: 'Export', manuscriptArtifactId: 'manuscript',
      figureIds: [], template: { kind: 'default', language: 'en' },
      publicationReview: syntheticExportPublicationReview({sourceHash: '0'.repeat(64), resources: [], references: []}) }]
  ];
  const channels = [
    'roc:research:stage-run-start',
    'roc:research:figure-start',
    'roc:research:experiment-start',
    'roc:research:export-prepare'
  ];
  for (const [index, [name, request]] of requests.entries()) {
    await assert.rejects(handlers.get(name)(request));
    if (index > 0) {
      assert.throws(() => api.parseIpcRequestArgs(channels[index], [request]));
      const { ownerRunId: _owner, ...valid } = request;
      assert.deepEqual(api.parseIpcRequestArgs(channels[index], [valid]), [valid]);
    }
  }
  assert.equal(calls, 0);
});
