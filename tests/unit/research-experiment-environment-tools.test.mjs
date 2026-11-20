import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import {createResearchTestRoleTools,  loadResearchTestApi, createResearchFixture } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function selection(f, index) {
  const request = { projectId: f.project.id, requestId: `selection-${index}` };
  return f.repository.pythonEnvironments.save({
    schemaVersion: 1, id: `python-${index}`, request, requestHash: hash(request),
    actor: { kind: 'user', id: 'window:72' }, workspacePath: f.project.workspacePath,
    selectedExecutable: '/python/bin/python3', executable: '/python/bin/python3.14',
    prefix: '/python', basePrefix: '/python', version: '3.14.7', platform: 'darwin', architecture: 'arm64',
    metadataHash: 'a'.repeat(64), codeHash: 'b'.repeat(64),
    lockFile: { path: 'roc-python.lock.json', size: 42, sha256: 'c'.repeat(64) },
    recordedAt: '2026-11-03T00:00:00.000Z'
  });
}

function tools(f, capabilities = {}, signal = new AbortController().signal) {
  return Object.fromEntries(createResearchTestRoleTools(api, {
    run: f.run, context: f.repository.runs.getContext(f.run.id), repository: f.repository,
    capabilities, signal
  }).map(tool => [tool.name, tool]));
}

test('experiment role reads only its project selections in bounded pages without native picker authority', async () => {
  const f = createResearchFixture(api, 'experiment');
  const other = createResearchFixture(api, 'figure', '/tmp/foreign-environment-tools');
  try {
    const entries = tools(f);
    assert.deepEqual(await entries.list_python_environments.invoke({ offset: 0, limit: 10 }), { total: 0, items: [] });
    for (let index = 0; index < 12; index++) selection(f, index);
    const first = await entries.list_python_environments.invoke({ offset: 0, limit: 10 });
    assert.equal(first.total, 12); assert.equal(first.items.length, 10);
    assert.deepEqual(first.items[0].runtime, { kind: 'python', selectionId: 'python-0',
      expectedHash: f.repository.pythonEnvironments.list({ projectId: f.project.id })[0].snapshotHash });
    assert.equal(Object.hasOwn(first.items[0], 'actor'), false);
    assert.equal(Object.hasOwn(first.items[0], 'selectedExecutable'), false);
    assert.equal((await entries.list_python_environments.invoke({ offset: 10, limit: 10 })).items.length, 2);
    await assert.rejects(entries.list_python_environments.invoke({ offset: 0, limit: 11 }));
    await assert.rejects(entries.list_python_environments.invoke({ offset: 0, limit: 1, projectId: 'foreign' }));
    assert.equal(tools(other).list_python_environments, undefined);
    assert.equal(Object.keys(entries).some(name => name.includes('select_python')), false);
  } finally { f.close(); other.close(); }
});

test('environment preview binds project, validates actual output and returns hash plus bounded report', async () => {
  const f = createResearchFixture(api, 'experiment');
  try {
    const selected = selection(f, 0), runtime = { kind: 'python', selectionId: selected.snapshot.id, expectedHash: selected.snapshotHash };
    const environment = { runtime, executable: '/python/bin/python3', prefix: '/python', basePrefix: '/python',
      version: '3.14.7', platform: 'darwin', architecture: 'arm64', toolchainHash: 'd'.repeat(64),
      metadataHash: 'a'.repeat(64), hash: 'e'.repeat(64),
      packages: Array.from({ length: 200 }, (_, index) => ({ name: `package-${index}`, version: '1.0' })),
      lockFiles: [selected.snapshot.lockFile] };
    const calls = [];
    const entries = tools(f, { async invoke(name, request) { calls.push({ name, request }); return environment; } });
    const preview = await entries.inspect_experiment_environment.invoke({ runtime, offset: 0, limit: 100 });
    assert.equal(preview.expectedEnvironmentHash, environment.hash); assert.equal(preview.content.length, 100);
    assert.ok(preview.totalChars > 100); assert.equal(preview.nextOffset, 100);
    assert.equal(calls.length, 1); assert.equal(calls[0].name, 'research.experiment.environment');
    assert.equal(calls[0].request.projectId, f.project.id);
    assert.deepEqual(preview.runtime, runtime);
    await assert.rejects(entries.inspect_experiment_environment.invoke({
      runtime: { ...runtime, executable: '/arbitrary/python' }, offset: 0, limit: 100
    }));
    const bad = tools(f, { async invoke() { return { ...environment, runtime: { kind: 'bundled-node' } }; } });
    await assert.rejects(bad.inspect_experiment_environment.invoke({ runtime, offset: 0, limit: 100 }), /research_experiment_runtime_mismatch/u);
    const failed = tools(f, { async invoke() { throw new Error('research_python_selection_environment_changed'); } });
    await assert.rejects(failed.inspect_experiment_environment.invoke({ runtime, offset: 0, limit: 100 }),
      /research_python_selection_environment_changed/u);
    assert.equal(f.repository.experiments.list(f.project.id, 20).length, 0);
  } finally { f.close(); }
});

test('cancelled stage and aborted caller reject environment reads and late preview results', async () => {
  const f = createResearchFixture(api, 'experiment');
  try {
    const controller = new AbortController(), entries = tools(f, {}, controller.signal);
    controller.abort(new Error('fixture_abort'));
    await assert.rejects(entries.list_python_environments.invoke({ offset: 0, limit: 1 }), /fixture_abort/u);
    const pending = tools(f, { async invoke() {
      f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture_cancelled');
      return { runtime: { kind: 'bundled-node' }, executable: '/node', prefix: '/node', basePrefix: '/node',
        version: '26', platform: 'darwin', architecture: 'arm64', toolchainHash: 'a'.repeat(64),
        metadataHash: 'b'.repeat(64), hash: 'c'.repeat(64), packages: [], lockFiles: [] };
    } });
    await assert.rejects(pending.inspect_experiment_environment.invoke({
      runtime: { kind: 'bundled-node' }, offset: 0, limit: 100
    }), /research_run_not_current/u);
    await assert.rejects(pending.list_python_environments.invoke({ offset: 0, limit: 1 }), /research_run_not_current/u);
  } finally { f.close(); }
});
