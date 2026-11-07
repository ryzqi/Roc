import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {mkdtempSync, rmSync, readFileSync, realpathSync, appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi, withResearchTestWorker, createResearchTestRoleTools} from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());
const output = {revision: 1, hash: 'b'.repeat(64), artifactIds: ['artifact'], schemaVersion: 1};
function addNode(f, id, retryOfRunId = null) {
  const run = {...structuredClone(f.run), id, parentRunId: retryOfRunId === null ? f.run.id : null, retryOfRunId,
    requestId: id, executionSnapshot: {...structuredClone(f.run.executionSnapshot), nodeBinding: {kind: 'none'}}};
  const execution = f.tasks.linkStage(run, null);
  f.tasks.confirmExecution('stage', id, f.project.id, execution.frozenInputs);
  return f.tasks.graph.get(execution.nodeBinding.nodeId, f.project.id);
}
function claim(tasks, node, workerId = 'worker') {
  return tasks.graph.claim({nodeId: node.id, projectId: node.projectId, workerId, expectedRevision: node.revision,
    ttlMs: 1000, concurrency: 2});
}

test('simultaneous SQLite claims from separate workers commit exactly one generation', async () => {
  const f = createResearchFixture(api, 'discovery');
  const dir = mkdtempSync(join(tmpdir(), 'roc-dag-race-'));
  const workers = [];
  try {
    const node = addNode(f, 'race-node');
    const databasePath = join(dir, 'agent.db');
    await f.agentDb.backup(databasePath);
    const barrier = new SharedArrayBuffer(4), ready = [], completed = [];
    for (const workerId of ['one', 'two']) {
      const worker = new Worker(new URL('./fixtures/research-claim-worker.mjs', import.meta.url), {workerData: {
        modulePath: api.modulePath, databasePath, now: f.run.createdAt, barrier, workerId,
        claim: {nodeId: node.id, projectId: node.projectId, expectedRevision: node.revision, ttlMs: 1000, concurrency: 2}
      }});
      workers.push(worker);
      ready.push(new Promise((resolve, reject) => {
        worker.on('message', message => {if (message.ready) resolve();}); worker.on('error', reject);
      }));
      completed.push(new Promise((resolve, reject) => {
        worker.on('message', message => {if ('lease' in message) resolve(message.lease);}); worker.on('error', reject);
      }));
    }
    await Promise.all(ready);
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    const leases = await Promise.all(completed);
    assert.equal(leases.filter(Boolean).length, 1);
    const db = new Database(databasePath);
    try {
      const saved = new api.ResearchTaskRepository(db, () => f.run.createdAt).graph.get(node.id, node.projectId);
      assert.equal(saved.generation, 1); assert.equal(saved.attempt, 1);
      assert.equal(saved.lease.workerId, leases.find(Boolean).workerId);
      assert.equal(db.prepare("SELECT COUNT(*) FROM research_task_events WHERE execution_id=? AND event_type='node_claimed'").pluck().get(node.executionId), 1);
    } finally {db.close();}
  } finally {await Promise.all(workers.map(worker => worker.terminate())); f.close(); rmSync(dir, {recursive: true, force: true});}
});

test('two SQLite connections cannot claim one node twice; dependencies and human review gate dispatch', async () => {
  const f = createResearchFixture(api, 'discovery');
  const dir = mkdtempSync(join(tmpdir(), 'roc-dag-'));
  let db1, db2;
  try {
    f.tasks.graph.stopExecution(f.run.id, f.project.id, 'interrupted', 'fixture');
    const a = addNode(f, 'worker-a'), b = addNode(f, 'worker-b');
    const graph = f.tasks.graph.read(f.run.taskId, f.project.id);
    f.tasks.graph.addDependencies(f.run.taskId, f.project.id, graph.revision, [{prerequisite: a.id, dependent: b.id}]);
    await f.agentDb.backup(join(dir, 'agent.db'));
    db1 = new Database(join(dir, 'agent.db')); db2 = new Database(join(dir, 'agent.db'));
    const first = new api.ResearchTaskRepository(db1, () => f.run.createdAt);
    const second = new api.ResearchTaskRepository(db2, () => f.run.createdAt);
    const lease = claim(first, a, 'first');
    assert.ok(lease);
    assert.equal(claim(second, a, 'second'), null);
    assert.equal(claim(second, b), null);
    first.graph.finish(lease, output, true);
    assert.equal(first.graph.get(a.id, a.projectId).lease, null);
    assert.equal(claim(second, b), null);
    assert.throws(() => first.graph.accept(a.id, a.projectId, {...output, hash: 'c'.repeat(64)}, true), /output_changed/);
    first.graph.accept(a.id, a.projectId, output, true);
    assert.ok(claim(second, b));
  } finally { db1?.close(); db2?.close(); f.close(); rmSync(dir, {recursive: true, force: true}); }
});

test('DAG revisions, root boundaries and cycles reject changes atomically', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const a = addNode(f, 'a'), b = addNode(f, 'b');
    const revision = f.tasks.graph.read(f.run.taskId, f.project.id).revision;
    assert.throws(() => f.tasks.graph.addDependencies(f.run.taskId, f.project.id, revision - 1, []), /revision_conflict/);
    assert.throws(() => f.tasks.graph.addDependencies(f.run.taskId, f.project.id, revision,
      [{prerequisite: a.id, dependent: b.id}, {prerequisite: b.id, dependent: a.id}]), /graph_cycle/);
    assert.equal(f.tasks.graph.read(f.run.taskId, f.project.id).revision, revision);
    assert.equal(f.tasks.graph.read(f.run.taskId, f.project.id).edges.length, 0);
    assert.throws(() => f.tasks.graph.get(a.id, 'another-project'), /project_mismatch/);
  } finally { f.close(); }
});

test('two roots in one project cannot hold simultaneous writer leases', () => {
  const f = createResearchFixture(api, 'writing');
  try {
    const run = {...structuredClone(f.run), id: 'second-writer', requestId: 'second-writer',
      executionSnapshot: {...structuredClone(f.run.executionSnapshot), nodeBinding: {kind: 'none'}}};
    const execution = f.tasks.linkStage(run, null);
    f.tasks.confirmExecution('stage', run.id, f.project.id, execution.frozenInputs);
    const node = f.tasks.graph.get(execution.nodeBinding.nodeId, f.project.id);
    assert.equal(node.readonly, false);
    assert.equal(claim(f.tasks, node), null);
    assert.equal(f.tasks.graph.get(node.id, f.project.id).reason, 'research_node_writer_pending');
    f.tasks.setStatus(f.run.taskId, f.project.id, 'paused', 'research_task_cleanup_pending', ['active']);
    f.tasks.graph.stopExecution(f.run.id, f.project.id, 'interrupted', 'cleanup_confirmed');
    assert.equal(claim(f.tasks, node), null, 'fencing a lease does not prove cleanup has finished');
    assert.equal(f.tasks.graph.get(node.id, f.project.id).reason, 'research_task_cleanup_pending');
    f.tasks.setStatus(f.run.taskId, f.project.id, 'paused', 'research_task_cleanup_failed', ['paused']);
    assert.equal(claim(f.tasks, node), null, 'failed cleanup continues to block the project');
    f.tasks.setStatus(f.run.taskId, f.project.id, 'paused', 'research_task_paused', ['paused']);
    assert.ok(claim(f.tasks, node));
    assert.throws(() => f.tasks.graph.finish(f.lease, output, false), /task_not_active/);
  } finally {f.close();}
});

test('expired worker cannot heartbeat or submit; cleanup and a new generation fence the old worker', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    let now = Date.parse(f.run.createdAt);
    const tasks = new api.ResearchTaskRepository(f.agentDb, () => new Date(now).toISOString());
    const a = addNode(f, 'a'), old = claim(tasks, a);
    now += 1001;
    assert.throws(() => tasks.graph.heartbeat(old, 1000), /lease_stale/);
    assert.throws(() => tasks.graph.finish(old, output, false), /lease_stale/);
    assert.throws(() => tasks.graph.expire(old, false, true), /cleanup_unconfirmed/);
    tasks.graph.expire(old, true, true);
    const next = addNode(f, 'retry-a', 'a');
    const lease = claim(tasks, next, 'replacement');
    assert.equal(next.operationKey, a.operationKey);
    assert.equal(next.revision, a.revision + 1);
    assert.equal(lease.generation, old.generation + 1);
    assert.throws(() => tasks.graph.finish(old, output, false), /lease_stale/);
    tasks.graph.finish(lease, output, false);
  } finally { f.close(); }
});

test('cancellation blocks completion and new claims, while failed dependencies remain blocked', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const a = addNode(f, 'a'), b = addNode(f, 'b');
    const revision = f.tasks.graph.read(f.run.taskId, f.project.id).revision;
    f.tasks.graph.addDependencies(f.run.taskId, f.project.id, revision, [{prerequisite: a.id, dependent: b.id}]);
    const lease = claim(f.tasks, a);
    f.tasks.graph.stopExecution('a', f.project.id, 'failed', 'fixture');
    assert.equal(claim(f.tasks, b), null);
    f.tasks.setStatus(f.run.taskId, f.project.id, 'cancelled', 'cancelled', ['active']);
    assert.throws(() => f.tasks.graph.finish(lease, output, false), /task_not_active/);
    assert.throws(() => claim(f.tasks, b), /task_not_active/);
  } finally { f.close(); }
});

test('node retry replays a recorded effect and an unresolved effect blocks continuation', async () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    let writes = 0;
    const work = () => f.tasks.workerEffects.execute('save_workspace_file', {path: 'a', content: 'v1'}, 'workspace_mutation', async () => ({writes: ++writes}));
    assert.deepEqual(await f.withWorker(work), {writes: 1});
    f.tasks.graph.stopExecution(f.run.id, f.project.id, 'failed', 'fixture');
    const node = addNode(f, 'retry-root', f.run.id), lease = claim(f.tasks, node);
    assert.deepEqual(await api.withResearchWorker(lease, work), {writes: 1});
    assert.equal(writes, 1);
    await assert.rejects(api.withResearchWorker(lease, () => f.tasks.workerEffects.execute('save_workspace_file',
      {path: 'b'}, 'workspace_mutation', async () => {throw new Error('lost-response');})), /lost-response/);
    assert.equal(f.tasks.hasUnresolvedEffects(f.run.taskId, f.project.id), true);
    f.tasks.setStatus(f.run.taskId, f.project.id, 'failed', 'lost-response', ['active']);
    assert.throws(() => f.tasks.continueWith(f.run.taskId, f.project.id, () => {}), /effect_unresolved/);
  } finally { f.close(); }
});

test('attempt request IDs cannot duplicate a frozen operation while changed business inputs remain distinct', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roc-node-request-'));
  const f = createResearchFixture(api, 'discovery');
  try {
    const names = ['start_experiment', 'start_figure', 'prepare_export'];
    const run = (toolName, requestId, seed = 1) => f.tasks.workerEffects.execute(toolName,
      {requestId, seed, source: {path: 'input'}}, 'host_execution', async () => {
        appendFileSync(join(directory, toolName), 'effect\n');
        return {requestId, seed};
      });
    const first = [];
    for (const name of names) first.push(await f.withWorker(() => run(name, 'attempt-one')));
    f.tasks.graph.stopExecution(f.run.id, f.project.id, 'failed', 'fixture');
    const next = addNode(f, 'request-retry', f.run.id), lease = claim(f.tasks, next);
    for (const [index, name] of names.entries()) {
      assert.deepEqual(await api.withResearchWorker(lease, () => run(name, 'attempt-two')), first[index]);
      assert.equal(readFileSync(join(directory, name), 'utf8'), 'effect\n');
      await api.withResearchWorker(lease, () => run(name, 'changed-input', 2));
      assert.equal(readFileSync(join(directory, name), 'utf8'), 'effect\neffect\n');
    }
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_tool_effects').pluck().get(), 6);
  } finally {f.close(); rmSync(directory, {recursive: true, force: true});}
});

test('a committed research output survives an agent transaction crash and reopens into human review without executing a model', async () => {
  const f = createResearchFixture(api, 'planning');
  const dir = mkdtempSync(join(tmpdir(), 'roc-dag-receipt-'));
  let researchDb, agentDb;
  try {
    const finish = f.tasks.graph.finish;
    f.tasks.graph.finish = () => {throw new Error('fixture_crash_after_research_commit');};
    assert.throws(() => f.withWorker(() => f.repository.runs.complete(f.run.id, f.project.id,
      {title: 'Durable plan', markdown: 'Saved once', claims: [], sections: [], verdict: 'ready'})), /fixture_crash/);
    f.tasks.graph.finish = finish;
    assert.equal(f.repository.runs.get(f.run.id, f.project.id).status, 'completed');
    assert.equal(f.tasks.graph.get(f.lease.nodeId, f.project.id).status, 'running');
    await f.db.backup(join(dir, 'research.db')); await f.agentDb.backup(join(dir, 'agent.db'));
    f.close();
    researchDb = new Database(join(dir, 'research.db')); agentDb = new Database(join(dir, 'agent.db'));
    api.applyResearchDatabaseSchema(researchDb, () => f.run.createdAt);
    api.applyDatabaseMigrations(agentDb, {dbName: 'agent', migrations: api.agentMigrations});
    const tasks = new api.ResearchTaskRepository(agentDb);
    const repository = new api.ResearchRepository(researchDb, tasks);
    repository.runs.reconcileTaskLinks();
    repository.runs.reconcileTaskLinks();
    repository.runs.recoverInterrupted();
    const gate = api.createResearchHumanGate({repository});
    const runtime = new api.ResearchStageRuntime(repository, {}, {prepare: async () => assert.fail('saved output must not regenerate')},
      gate, {cancelOwned: async () => {}});
    await runtime.recoverPendingOutputs();
    assert.equal(tasks.get(f.run.taskId, f.project.id).status, 'waiting_approval');
    const node = tasks.graph.get(f.lease.nodeId, f.project.id);
    assert.equal(node.status, 'pending_review'); assert.equal(node.lease, null);
    assert.equal(repository.listArtifacts(f.project.id).length, 1);
    assert.equal(repository.listArtifacts(f.project.id)[0].status, 'draft');
    assert.equal(agentDb.prepare("SELECT COUNT(*) FROM research_task_events WHERE event_type='node_output'").pluck().get(), 1);
    await runtime.shutdown();
  } finally {
    if (f.db.open) f.close(); researchDb?.close(); agentDb?.close(); rmSync(dir, {recursive: true, force: true});
  }
});

test('completed output acceptance fences content drift and keeps a repeated rejection from approving a rejected result', () => {
  const f = createResearchFixture(api, 'planning');
  try {
    const run = f.withWorker(() => f.repository.runs.complete(f.run.id, f.project.id,
      {title: 'Plan', markdown: 'Frozen output', claims: [], sections: [], verdict: 'ready'}));
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'planning', action: 'complete'});
    const versions = () => run.outputArtifactIds.map(artifactId => ({artifactId,
      version: f.repository.inspectArtifact({projectId: f.project.id, artifactId, expectedVersion: null}).snapshot.version}));
    const original = f.db.prepare('SELECT output_json FROM research_artifact_contents WHERE artifact_id=?').pluck().get(run.outputArtifactIds[0]);
    f.db.prepare("UPDATE research_artifact_contents SET output_json=json_set(output_json,'$.markdown','changed') WHERE artifact_id=?").run(run.outputArtifactIds[0]);
    assert.throws(() => f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'planning', action: 'approve',
      expectedArtifactVersions: versions()}), /research_node_output_changed/);
    f.db.prepare('UPDATE research_artifact_contents SET output_json=? WHERE artifact_id=?').run(original, run.outputArtifactIds[0]);
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'planning', action: 'reject', expectedArtifactVersions: versions()});
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'planning', action: 'complete'});
    assert.throws(() => f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'planning', action: 'approve',
      expectedArtifactVersions: versions()}), /research_node_output_changed/);
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'planning', action: 'reject', expectedArtifactVersions: versions()});
    assert.equal(f.tasks.graph.get(f.lease.nodeId, f.project.id).status, 'blocked');
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_node_decision_receipts').pluck().get(), 1);
  } finally {f.close();}
});


test('a retried worker replays one real workspace write without creating a second revision', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'roc-node-file-')));
  const f = createResearchFixture(api, 'experiment', directory);
  try {
    const files = new api.ResearchWorkspaceFileService(f.db, f.repository, () => f.run.createdAt);
    const effects = new api.ResearchProductionEffectService(f.repository, files);
    const toolsFor = run => createResearchTestRoleTools(api, {repository: f.repository, run,
      context: f.repository.runs.getContext(run.id), capabilities: {}, effects, signal: new AbortController().signal});
    const request = {path: 'once.py', content: 'print(42)', expectedHash: null};
    const first = await toolsFor(f.run).find(tool => tool.name === 'save_workspace_file').invoke(request);
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'retry_fixture');
    const next = f.repository.runs.retry({projectId: f.project.id, runId: f.run.id, requestId: 'second-attempt'});
    const running = withResearchTestWorker(api, f.repository, next.id, f.project.id, id =>
      f.repository.runs.markRunning(id, f.project.id, {providerId: 'fixture', modelId: 'fixture'}));
    const replay = await toolsFor(running).find(tool => tool.name === 'save_workspace_file').invoke(request);
    assert.deepEqual(replay, first);
    assert.equal(readFileSync(join(directory, 'once.py'), 'utf8'), 'print(42)');
    assert.equal(f.db.prepare('SELECT revision FROM research_workspace_files WHERE path=?').pluck().get(request.path), 1);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_tool_effects').pluck().get(), 1);
    await assert.rejects(f.withWorker(() => effects.saveWorkspaceFile(f.run.id, f.project.id,
      {...request, path: 'late.py'})), /research_run_not_current/);
  } finally {f.close(); rmSync(directory, {recursive: true, force: true});}
});
