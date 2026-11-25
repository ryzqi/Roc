import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {mkdtemp, realpath, readdir, rm, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createResearchFixture, createResearchTestRoleTools, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const active = new Set(['queued', 'validating', 'downloading_runtime', 'creating_venv', 'resolving', 'syncing', 'verifying']);
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

function inspected(workspace) {
  return {
    controls: {selectedExecutable: join(workspace, '.venv/bin/python'), executable: '/managed/bin/python3.14',
      prefix: join(workspace, '.venv'), basePrefix: '/managed'},
    report: {version: '3.14.10', platform: 'darwin', architecture: 'arm64'},
    metadataHash: 'a'.repeat(64), code: {hash: 'b'.repeat(64)},
    lockFiles: ['pyproject.toml', '.python-version', 'uv.lock'].map(path => ({path, size: 30, sha256: 'c'.repeat(64)}))
  };
}
function prepared(workspace) {
  return {inspected: inspected(workspace), runtime: {version: '3.14.10', pythonKey: 'cpython-3.14.10-darwin-aarch64-none',
    uvHash: 'd'.repeat(64), receiptHash: 'e'.repeat(64)}};
}
async function fixture(options = {}) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'roc-python-lifecycle-')));
  const f = createResearchFixture(api, 'experiment', workspace);
  let calls = 0;
  const service = new api.ResearchPythonEnvironmentService(f.repository, join(workspace, 'managed'), {
    prepare: async input => {calls++; return await (options.prepare ?? (async input => prepared(input.workspace)))(input);},
    inspect: async input => inspected(input.workspace)
  });
  const human = work => api.withResearchHumanContext({capability: 'research.pythonEnvironments.prepare', projectId: f.project.id, windowId: 72}, work);
  return {...f, workspace, service, calls: () => calls,
    prepare: requestId => human(() => service.prepare({projectId: f.project.id, requestId})),
    async settled(projectId = f.project.id) {
      for (let i = 0; i < 400; i++) {
        const status = service.status({projectId});
        if (status.operation !== null && !active.has(status.operation.phase)) return status;
        await pause();
      }
      throw new Error('preparation did not settle');
    },
    async dispose() {await service.shutdown(); await f.close(); await rm(workspace, {recursive: true, force: true});}
  };
}

test('status and history are pure reads; prepare is authorized, idempotent and atomically publishes ready', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.service.status({projectId: f.project.id}), {operation: null, environment: null});
    assert.deepEqual(f.service.list({projectId: f.project.id}), []);
    assert.deepEqual(await readdir(f.workspace), []); assert.equal(f.calls(), 0);
    assert.throws(() => f.service.prepare({projectId: f.project.id, requestId: 'unbound'}), /research_human/u);
    const operation = await f.prepare('one');
    const status = await f.settled();
    assert.equal(status.operation.phase, 'ready'); assert.equal(f.calls(), 1);
    assert.deepEqual(status.operation.environmentRef, {projectId: f.project.id,
      environmentId: status.environment.snapshot.id, expectedHash: status.environment.snapshotHash});
    assert.equal((await f.prepare('one')).id, operation.id); assert.equal(f.calls(), 1);
    assert.equal(f.repository.pythonEnvironments.list({projectId: f.project.id}).length, 1);
    assert.throws(() => f.repository.pythonEnvironments.saveOperation({...status.operation, phase: 'failed',
      environmentRef: null, errorCode: 'late failure'}), /research_python_operation_terminal/u);
    assert.throws(() => f.repository.pythonEnvironments.saveOperation({...status.operation, workspacePath: '/elsewhere'}),
      /research_python_operation_identity_changed/u);
  } finally {await f.dispose();}
});

test('owner cancellation waits for preparation exit and forbids a late ready receipt', async () => {
  const started = deferred(), stopped = deferred();
  const f = await fixture({prepare: async input => {
    input.onPhase('syncing'); started.resolve();
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, {once: true}));
    await stopped.promise;
    return prepared(input.workspace);
  }});
  try {
    const owner = new AbortController();
    const operation = await f.withWorker(() => f.service.prepareOwned({projectId: f.project.id, requestId: 'owned'}, f.run.id, owner.signal));
    await started.promise;
    await assert.rejects(f.service.cancelOwned({projectId: f.project.id, operationId: operation.id}, 'other-run'), /owner_mismatch/u);
    let returned = false;
    const cancel = f.service.cancelOwned({projectId: f.project.id, operationId: operation.id}, f.run.id).then(() => {returned = true;});
    await pause(); assert.equal(returned, false);
    stopped.resolve(); await cancel;
    assert.equal((await f.settled()).operation.phase, 'cancelled');
    assert.deepEqual(f.service.list({projectId: f.project.id}), []);
  } finally {stopped.resolve(); await f.dispose();}
});

test('prepare derives the latest code pin only from the same workspace and rejects caller injection', async () => {
  const inputs = [];
  const f = await fixture({prepare: async input => {
    inputs.push(input);
    const result = prepared(input.workspace);
    result.inspected.code.hash = String(inputs.length).repeat(64);
    return result;
  }});
  const secondWorkspace = await realpath(await mkdtemp(join(tmpdir(), 'roc-python-lifecycle-switch-')));
  try {
    await assert.rejects(api.withResearchHumanContext({capability: 'research.pythonEnvironments.prepare',
      projectId: f.project.id, windowId: 72}, () => f.service.prepare({projectId: f.project.id,
      requestId: 'injected-pin', previousCodeHash: 'f'.repeat(64)})), /Unrecognized key/u);
    assert.equal(f.service.status({projectId: f.project.id}).operation, null);
    await f.prepare('first'); assert.equal((await f.settled()).operation.phase, 'ready');
    assert.equal(Object.hasOwn(inputs[0], 'previousCodeHash'), false);
    await f.prepare('second'); assert.equal((await f.settled()).operation.phase, 'ready');
    assert.equal(inputs[1].previousCodeHash, '1'.repeat(64));
    f.repository.updateProject({id: f.project.id, workspacePath: secondWorkspace});
    await f.prepare('other-workspace'); assert.equal((await f.settled()).operation.phase, 'ready');
    assert.equal(Object.hasOwn(inputs[2], 'previousCodeHash'), false);
    f.repository.updateProject({id: f.project.id, workspacePath: f.workspace});
    await f.prepare('original-workspace'); assert.equal((await f.settled()).operation.phase, 'ready');
    assert.equal(inputs[3].previousCodeHash, '2'.repeat(64));
  } finally {await f.dispose(); await rm(secondWorkspace, {recursive: true, force: true});}
});

test('runtime read lease covers verification and cancellation of a waiting prepare does not affect it', async () => {
  const f = await fixture();
  let lease;
  try {
    await f.prepare('initial'); const status = await f.settled();
    lease = await f.service.acquireRuntime(status.operation.environmentRef, f.workspace, new AbortController().signal,
      {projectId: f.project.id, priority: 'user'}, () => undefined);
    const waiting = await f.prepare('next'); await pause();
    assert.equal(f.calls(), 1); assert.equal(f.service.status({projectId: f.project.id}).operation.phase, 'queued');
    await lease.verify(() => undefined);
    await api.withResearchHumanContext({capability: 'research.pythonEnvironments.cancel', projectId: f.project.id, windowId: 72},
      () => f.service.cancel({projectId: f.project.id, operationId: waiting.id}));
    assert.equal((await f.settled()).operation.phase, 'cancelled'); assert.equal(f.calls(), 1);
    await lease.verify(() => undefined); lease.release(); lease = undefined;
    await f.prepare('retry'); assert.equal((await f.settled()).operation.phase, 'ready'); assert.equal(f.calls(), 2);
  } finally {lease?.release(); await f.dispose();}
});

test('project aliases share a realpath write lock and a cancelled waiter never mutates the environment', async () => {
  const firstStarted = deferred(), finishFirst = deferred();
  const f = await fixture({prepare: async input => {firstStarted.resolve(); await finishFirst.promise; return prepared(input.workspace);}});
  try {
    const alias = `${f.workspace}-alias`; await symlink(f.workspace, alias);
    try {
      const other = f.repository.createProject({title: 'Alias project', description: '', workspacePath: alias});
      await f.prepare('first'); await firstStarted.promise;
      const pending = await f.service.prepareAutomatic(other.id);
      await pause(); assert.equal(f.calls(), 1);
      assert.equal(pending.workspacePath, f.workspace);
      await f.service.releaseProject(other.id);
      assert.equal(f.service.status({projectId: other.id}).operation.phase, 'cancelled');
      finishFirst.resolve(); assert.equal((await f.settled()).operation.phase, 'ready');
      assert.equal(f.calls(), 1);
    } finally {await rm(alias, {force: true});}
  } finally {finishFirst.resolve(); await f.dispose();}
});

test('recovery marks durable unfinished operations interrupted without starting preparation', async () => {
  const f = await fixture();
  try {
    const timestamp = new Date().toISOString();
    f.repository.pythonEnvironments.saveOperation({schemaVersion: 1, id: 'crashed-operation',
      request: {projectId: f.project.id, requestId: 'before-crash'}, actor: {kind: 'system', id: 'roc-python-environment'},
      workspacePath: f.workspace, ownerRunId: null, phase: 'syncing', errorCode: null, environmentRef: null,
      startedAt: timestamp, updatedAt: timestamp});
    await f.service.shutdown();
    const restarted = new api.ResearchPythonEnvironmentService(f.repository, join(f.workspace, 'managed'), {
      prepare: async () => {throw new Error('recovery must not prepare');}
    });
    try {
      const status = restarted.status({projectId: f.project.id});
      assert.equal(status.operation.phase, 'interrupted'); assert.equal(status.environment, null);
      assert.deepEqual(await readdir(f.workspace), []);
    } finally {await restarted.shutdown();}
  } finally {await f.dispose();}
});

test('workspace replacement during preparation rejects the old receipt and preserves the failure state', async () => {
  const started = deferred(), finish = deferred();
  const f = await fixture({prepare: async input => {started.resolve(); await finish.promise; return prepared(input.workspace);}});
  try {
    await f.prepare('before-switch'); await started.promise;
    f.repository.updateProject({id: f.project.id, workspacePath: '/private/tmp/new-project-workspace'});
    finish.resolve();
    const status = await f.settled();
    assert.equal(status.operation.phase, 'failed');
    assert.equal(status.operation.errorCode, 'research_python_environment_workspace_changed');
    assert.equal(status.environment, null);
  } finally {finish.resolve(); await f.dispose();}
});

test('Agent preparation tools are owner fenced and stage cleanup cancels only its own operation', async () => {
  const f = await fixture({prepare: async input => {
    input.signal.throwIfAborted();
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, {once: true}));
    input.signal.throwIfAborted();
  }});
  try {
    const effects = new api.ResearchProductionEffectService(f.repository, undefined, undefined, undefined,
      {abortOwned() {}}, undefined, f.service);
    const tools = Object.fromEntries(createResearchTestRoleTools(api, {run: f.run,
      context: f.repository.runs.getContext(f.run.id), repository: f.repository, effects,
      signal: new AbortController().signal, capabilities: {async invoke(name, input) {
        assert.equal(name, 'research.pythonEnvironments.status'); return f.service.status(input);
      }}}).map(tool => [tool.name, tool]));
    const automatic = await f.service.prepareAutomatic(f.project.id);
    await assert.rejects(tools.cancel_python_environment.invoke({operationId: automatic.id}), /owner_mismatch/u);
    await effects.cancelOwned(f.project.id, f.run.id);
    assert.equal(active.has(f.service.status({projectId: f.project.id}).operation.phase), true);
    await f.service.releaseProject(f.project.id);
    const owned = await tools.prepare_python_environment.invoke({requestId: 'agent-prepare'});
    assert.equal(owned.ownerRunId, f.run.id);
    assert.equal((await tools.get_python_environment_status.invoke({})).operation.id, owned.id);
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture-cancelled');
    await effects.cancelOwned(f.project.id, f.run.id);
    assert.equal((await f.settled()).operation.phase, 'cancelled');
    await assert.rejects(tools.prepare_python_environment.invoke({requestId: 'late-prepare'}), /research_run_not_current/u);
    await assert.rejects(tools.get_python_environment_status.invoke({}), /research_run_not_current/u);
    assert.equal(f.service.list({projectId: f.project.id}).length, 0);
  } finally {await f.dispose();}
});

test('shutdown fences a preparation already awaiting workspace resolution', async () => {
  const f = await fixture();
  try {
    const pending = f.prepare('shutdown-race');
    const rejected = assert.rejects(pending, /research_python_environment_service_closed/u);
    await f.service.shutdown(); await rejected;
    assert.equal(f.calls(), 0); assert.equal(f.service.status({projectId: f.project.id}).operation, null);
  } finally {await f.dispose();}
});
