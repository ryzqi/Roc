import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hash } from '../lib/common.mjs';
import { applicationManifest } from '../lib/application-manifest.mjs';
import { applicationContract, applicationSessionContract, applicationTurns } from '../lib/application-verifier.mjs';
import { assertBenchmarkApplicationContracts, assertBenchmarkTaskSelection, benchmarkApplicationContracts,
  benchmarkTaskInput, benchmarkTaskSelection, selectTasks } from '../lib/runner.mjs';
import { summarize } from '../lib/report.mjs';
import { capabilityInput, capabilityTaskContentHash } from '../adapters/capability/run.mjs';

const suite = 'roc-capability';
function task(id, session = false) {
  const prompt = 'Read the supplied records and return a JSON answer.';
  return { id, family: 'file-report', difficulty: 'hard', clusterId: `label-${id}`, split: 'fixture',
    visible: { prompt, files: { 'records.json': '[{"value":7}]' }, outputContract: '{"total":number}' },
    expected: { checks: [{ id: 'answer', kind: 'json-value', path: ['total'], value: 7 }] },
    environment: { tools: ['read_file', 'write_file', 'run_shell_command'],
      ...(session ? { session: { schemaVersion: 1, turns: [
        { id: 'first', prompt, thread: 'new' },
        { id: 'second', prompt: 'Use the previous records and return the answer.', thread: 'continue' }
      ] } } : {}) } };
}
function manifest(tasks, names = ['read_file']) {
  return { suite, selection: tasks.map(item => ({ id: item.id })),
    taskApplicationContracts: benchmarkApplicationContracts(suite, tasks),
    taskToolManifests: tasks.map(item => ({ taskId: item.id, manifest: {
      tools: names.map(modelVisibleName => ({ modelVisibleName }))
    } })) };
}

test('mixed single-turn and session tasks freeze their actual contracts before experiment admission', () => {
  const tasks = [task('single'), task('session', true)];
  const frozen = manifest(tasks);
  assert.deepEqual(frozen.taskApplicationContracts, [
    { taskId: 'single', contract: applicationContract, contractHash: hash(applicationContract) },
    { taskId: 'session', contract: applicationSessionContract, contractHash: hash(applicationSessionContract) }
  ]);
  assert.doesNotThrow(() => assertBenchmarkApplicationContracts(frozen, [...tasks].reverse()));
  assert.equal(applicationTurns(benchmarkTaskInput(suite, tasks[0], frozen)), null);
  assert.equal(applicationTurns(benchmarkTaskInput(suite, tasks[1], frozen)).length, 2);
  assert.throws(() => benchmarkApplicationContracts(suite, [tasks[0], tasks[0]]), /capability_application_task_ids_invalid/);
  assert.equal(benchmarkApplicationContracts('qasper', tasks), undefined);
});

for (const names of [['read_file'], []]) {
  test(`a frozen ${names.length ? 'subset' : 'empty tool set'} preserves original public turns, permissions and task mode`, () => {
    const selected = task('session', true), frozen = manifest([selected], names);
    const original = capabilityInput(suite, selected), input = benchmarkTaskInput(suite, selected, frozen);
    assert.deepEqual(input.toolNames, names);
    for (const key of ['prompt', 'session', 'runMode', 'readOnly', 'files', 'difficulty']) {
      assert.deepEqual(input[key], original[key], key);
    }
    assert.equal(input.runMode, 'task');
    assert.equal(input.readOnly, false);
    assert.equal(input.prompt.includes('Run exactly "python solution.py"'), true);
    for (const hidden of ['expected', 'checks', 'source', 'clusterId', 'split']) {
      assert.equal(Object.hasOwn(input, hidden), false, hidden);
    }
  });
}

test('dispatch refuses missing, duplicate, forged or wrong per-task application contracts', () => {
  const selected = task('session', true), original = manifest([selected]);
  const mutations = [
    frozen => { delete frozen.taskApplicationContracts; },
    frozen => { frozen.taskApplicationContracts = {}; },
    frozen => { frozen.taskApplicationContracts.push(structuredClone(frozen.taskApplicationContracts[0])); },
    frozen => { frozen.taskApplicationContracts[0].contractHash = hash(applicationContract); },
    frozen => { frozen.taskApplicationContracts[0].contract = applicationContract; },
    frozen => { delete frozen.taskApplicationContracts[0].contract; },
    frozen => { frozen.taskApplicationContracts[0].contract.verification = 'worker-self-reported'; }
  ];
  for (const mutate of mutations) {
    const frozen = structuredClone(original); mutate(frozen);
    assert.throws(() => benchmarkTaskInput(suite, selected, frozen), /capability_frozen_application_contract_required/);
  }
  for (const mutate of [
    frozen => { delete frozen.taskToolManifests; },
    frozen => { frozen.taskToolManifests[0].taskId = 'other'; },
    frozen => { frozen.taskToolManifests.push(structuredClone(frozen.taskToolManifests[0])); }
  ]) {
    const frozen = structuredClone(original); mutate(frozen);
    assert.throws(() => benchmarkTaskInput(suite, selected, frozen), /capability_frozen_task_tools_required/);
  }
});

test('recovery validates all selected task contracts even before their first dispatch', () => {
  const tasks = [task('single'), task('session', true)], original = manifest(tasks);
  for (const mutate of [
    frozen => { frozen.taskApplicationContracts.pop(); },
    frozen => { frozen.taskApplicationContracts.push({ taskId: 'unselected', contract: applicationContract,
      contractHash: hash(applicationContract) }); },
    frozen => { frozen.taskApplicationContracts[1] = structuredClone(frozen.taskApplicationContracts[0]); },
    frozen => { frozen.taskApplicationContracts[1].contractHash = hash(applicationContract); }
  ]) {
    const frozen = structuredClone(original); mutate(frozen);
    assert.throws(() => assertBenchmarkApplicationContracts(frozen, tasks), /capability_frozen_application_contracts_changed/);
  }
  const missing = structuredClone(original); missing.selection[1].id = 'unknown';
  assert.throws(() => assertBenchmarkApplicationContracts(missing, tasks), /capability_application_task_missing/);
});

test('a task manifest binds its original run mode and MCP environment as well as visible tool names', () => {
  const selected = task('mcp');
  selected.environment.mcp = { schemaVersion: 1, mode: 'local-records-v1', sourceFile: 'mcp-records.json' };
  const input = capabilityInput(suite, selected, { toolNames: [] });
  const frozen = { taskManifests: [{ taskId: selected.id, toolNames: [], runMode: input.runMode,
    mcp: input.mcp, manifest: { tools: [] } }] };
  assert.deepEqual(applicationManifest(frozen, input), { tools: [] });
  assert.throws(() => applicationManifest(frozen, { ...input, runMode: 'chat' }), /application_task_run_mode_mismatch/);
  assert.throws(() => applicationManifest(frozen, { ...input, mcp: undefined }), /application_task_mcp_mismatch/);
  assert.throws(() => applicationManifest(frozen, { ...input, mcp: { ...input.mcp, sourceFile: 'other.json' } }),
    /application_task_mcp_mismatch/);
  assert.throws(() => applicationManifest(frozen, { ...input, toolNames: ['read_file'] }), /application_task_manifest_mismatch/);
});

function qualification(tasks, rootFor = () => 'source-connected:shared') {
  return { schemaVersion: 2, tasks: tasks.map(item => ({
    id: item.id, clusterId: item.clusterId, contentHash: capabilityTaskContentHash(item),
    sourceConnectedRoot: rootFor(item)
  })) };
}

test('sampling and frozen selection use actual connected sources while retaining original labels', () => {
  const tasks = Array.from({ length: 4 }, (_, index) => task(`source-${index}`))
    .sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
  const audit = qualification(tasks, item => item.id === tasks[3].id ? 'source-connected:independent' : 'source-connected:shared');
  const selection = benchmarkTaskSelection(suite, tasks, audit);
  const clusters = new Map(selection.map(item => [item.id, item.clusterId]));
  const selected = selectTasks(tasks, { split: 'fixture', limit: 2 }, clusters);
  assert.deepEqual(selected.map(item => item.id), [tasks[0].id, tasks[3].id]);
  assert.equal(new Set(selection.map(item => item.clusterId)).size, 2);
  assert.equal(new Set(selection.map(item => item.sourceClusterId)).size, 4);
  assert.equal(selection[0].contentHash, capabilityTaskContentHash(tasks[0]));
  assert.doesNotThrow(() => assertBenchmarkTaskSelection({ suite, selection }, [...tasks].reverse(), audit));
  assert.throws(() => selectTasks(tasks, { split: 'fixture', limit: 2 }, new Map()), /task_source_cluster_required/);
  assert.deepEqual(benchmarkTaskSelection('qasper', tasks), tasks.map(item => ({
    id: item.id, clusterId: item.clusterId
  })));
});

test('source cluster binding rejects absent, duplicate, changed and self-reported qualification fields', () => {
  const tasks = [task('first'), task('second')], original = qualification(tasks);
  for (const mutate of [
    audit => { audit.schemaVersion = 1; },
    audit => { delete audit.tasks; },
    audit => { audit.tasks.push(structuredClone(audit.tasks[0])); },
    audit => { audit.tasks.pop(); },
    audit => { delete audit.tasks[0].sourceConnectedRoot; },
    audit => { audit.tasks[0].sourceConnectedRoot = ' '; },
    audit => { audit.tasks[0].clusterId = 'other-label'; },
    audit => { audit.tasks[0].contentHash = hash('changed'); }
  ]) {
    const audit = structuredClone(original); mutate(audit);
    assert.throws(() => benchmarkTaskSelection(suite, tasks, audit), /capability_(source_clusters_required|task_source_cluster_mismatch)/);
  }
  const selection = benchmarkTaskSelection(suite, tasks, original);
  for (const mutate of [
    frozen => { frozen.selection[0].clusterId = tasks[0].clusterId; },
    frozen => { delete frozen.selection[0].sourceClusterId; },
    frozen => { frozen.selection[0].sourceClusterId = 'other-label'; },
    frozen => { frozen.selection[0].contentHash = hash('changed'); },
    frozen => { frozen.selection[0].family = 'other-family'; },
    frozen => { frozen.selection.push(structuredClone(frozen.selection[0])); },
    frozen => { frozen.selection[0].id = 'missing'; }
  ]) {
    const frozen = { suite, selection: structuredClone(selection) }; mutate(frozen);
    assert.throws(() => assertBenchmarkTaskSelection(frozen, tasks, original),
      /capability_(frozen_task_selection_changed|application_selection_required|application_task_missing)/);
  }
});

test('six original labels sharing one actual source cannot obtain five-cluster statistical qualification', () => {
  const tasks = Array.from({ length: 6 }, (_, index) => task(`shared-${index}`));
  const selection = benchmarkTaskSelection(suite, tasks, qualification(tasks));
  const trials = selection.flatMap(item => Array.from({ length: 3 }, (_, repeat) => ({
    taskId: item.id, clusterId: item.clusterId, repeat, status: 'scored', success: true,
    failureClass: null, metrics: { taskCompletion: 1 },
    checks: [{ id: 'answer', required: true, passed: true }]
  })));
  const result = summarize({ suite, selection, repeats: 3, profile: 'full', split: 'fixture',
    evidence: 'fixture', metrics: ['taskCompletion'] }, trials);
  assert.equal(result.status, 'complete');
  assert.equal(result.metricStatistics.taskCompletion.clusters, 1);
  assert.equal(result.metricStatistics.taskCompletion.applicableTasks, 6);
  assert.equal(result.metricStatistics.taskCompletion.status, 'insufficient');
  assert.equal(result.metricStatistics.taskCompletion.confidence95, null);
  assert.equal(result.metricStatistics.taskCompletion.iterations, 0);
  assert.deepEqual(result.metricStatistics.taskCompletion.reasons, ['minimum_applicable_clusters']);
});
