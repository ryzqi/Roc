import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { capabilityEngineeringCompletion, capabilityEngineeringDataset } from '../adapters/capability/fixture.mjs';
import { capabilityInput } from '../adapters/capability/run.mjs';
import { gradeCapability } from '../graders/capability.mjs';
import { executeApplication, prepareApplication } from '../lib/application.mjs';
import { applicationContractForInput, applicationSessionContract } from '../lib/application-verifier.mjs';
import { hash, sha256 } from '../lib/common.mjs';
import { fixtureConfig } from '../lib/fixture.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('capability-session-grader');
const selectedIds = ['memory-cross-session', 'stateful-clarification', 'mcp-record-lookup', 'context-summary', 'context-offload'];
const tasks = capabilityEngineeringDataset().tasks.filter(task => selectedIds.includes(task.id));
assert.equal(tasks.length, selectedIds.length);
const ablationTask = {
  schemaVersion: 2, id: 'empty-ablation', family: 'tool-selection-arguments', clusterId: 'empty-ablation', split: 'fixture',
  visible: { prompt: 'Return {"complete":true}.', files: {} },
  environment: { tools: ['ls', 'run_shell_command'], network: 'disabled' },
  expected: { checks: [{ id: 'result', kind: 'json-value', path: ['complete'], value: true }] }
};
const artifact = await prepareApplication(root, { kind: 'roc-capability', taskTools: [
  ...tasks.map(task => ({ taskId: task.id, toolNames: task.environment.tools, runMode: 'chat', mcp: task.environment.mcp })),
  { taskId: ablationTask.id, toolNames: [], runMode: 'task' }
] });
const trials = new Map();
function query(directory, sql, memory = false) {
  const db = new Database(join(directory, `worker/${memory ? 'memory' : 'agent'}.sqlite`), { readonly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
function grade(trial, task = trial.task) {
  return gradeCapability(task, trial.result, { directory: trial.directory });
}
function json(path) { return JSON.parse(readFileSync(path)); }
async function run(task, name = task.id, complete = capabilityEngineeringCompletion, selectedTools) {
  const directory = join(root, name); mkdirSync(directory);
  const input = capabilityInput('roc-capability', task, { toolNames: selectedTools });
  const purposes = [];
  const result = await executeApplication({ artifact, input, directory,
    config: { ...fixtureConfig, taskTimeoutMs: 60000 }, signal: new AbortController().signal, record: () => {},
    complete: (body, signal, binding) => {
      purposes.push({ purpose: binding.purpose, modelCallId: binding.modelCallId, phaseId: binding.phaseId });
      return complete(body, signal, binding);
    } }).catch(error => {
      let stderr = '';
      try { stderr = readFileSync(join(directory, 'stderr.log'), 'utf8').slice(-4000); } catch {}
      throw new Error(`${error.message}\n${stderr}`, { cause: error });
    });
  const trial = { task, directory, input, result, purposes };
  trials.set(name, trial);
  return trial;
}
function tamper(trial, paths, mutate, inspect) {
  const protocolPath = join(trial.directory, 'protocol-observations.json');
  const retained = [...new Set([...paths, 'protocol-observations.json'])].map(path => [path, readFileSync(join(trial.directory, path))]);
  try {
    mutate();
    const protocol = json(protocolPath);
    for (const path of Object.keys(protocol.artifactHashes)) protocol.artifactHashes[path] = sha256(readFileSync(join(trial.directory, path)));
    writeFileSync(protocolPath, JSON.stringify(protocol) + '\n');
    inspect(grade(trial));
  } finally {
    for (const [path, raw] of retained) {
      rmSync(join(trial.directory, path), { force: true });
      writeFileSync(join(trial.directory, path), raw);
    }
  }
}

test('official memory, stateful and MCP fixtures pass independent grading of actual production evidence', async () => {
  for (const task of tasks.filter(task => !task.id.startsWith('context-'))) {
    const trial = await run(task), scored = grade(trial);
    assert.equal(scored.status, 'scored', `${task.id}: ${JSON.stringify(scored)}`);
    assert.equal(scored.success, true, `${task.id}: ${JSON.stringify(scored)}`);
    assert.equal(scored.metrics.unauthorizedSideEffectRate, 0);
    assert.equal(scored.metrics.permissionBypassRate, 0);
    assert.equal(scored.metrics.approvalBypassRate, null);
    assert.equal(scored.metricApplicability.approvalBypassRate, 'not_applicable');
    assert.equal(trial.result.runtimeVerification.contractHash, hash(applicationContractForInput(trial.input)));
    if (task.environment.session) {
      assert.equal(trial.result.runtimeVerification.contractHash, hash(applicationSessionContract));
      assert.equal(scored.evidence.phases.length, task.environment.session.turns.length);
    }
    if (task.id === 'mcp-record-lookup') {
      assert.equal(scored.evidence.mcpCalls, 1);
      assert.equal(scored.metrics.duplicateSideEffectRate, null);
      const observed = scored.checks.find(check => check.kind === 'mcp').observed;
      assert.equal(observed.count, 1);
      assert.ok(observed.sourceJsonHash);
      const withoutBounds = structuredClone(task);
      for (const check of withoutBounds.expected.checks.filter(check => check.kind === 'mcp')) {
        delete check.min; delete check.max; check.required = true;
      }
      assert.equal(grade(trial, withoutBounds).success, true);
    }
  }
});

test('official summary fixture passes only with a separate summary call, raw transcript, digest and actual recovery', async () => {
  const trial = await run(tasks.find(task => task.id === 'context-summary')), scored = grade(trial);
  assert.equal(scored.status, 'scored', JSON.stringify(scored));
  assert.equal(scored.success, true, JSON.stringify(scored));
  assert.ok(trial.purposes.some(binding => binding.purpose === 'summary' && binding.modelCallId));
  assert.ok(scored.evidence.contextSummaries > 0);
  assert.ok(scored.evidence.contextArtifactReads > 0);
  assert.equal(scored.metrics.toolSelectionAccuracy, 1);
  assert.equal(scored.metrics.argumentAccuracy, 1);
  assert.ok(scored.checks.find(check => check.kind === 'context').passed);
});

test('official offload fixture passes using independently bound grep bytes and an executed tail read', async () => {
  const trial = await run(tasks.find(task => task.id === 'context-offload')), scored = grade(trial);
  assert.equal(scored.status, 'scored', JSON.stringify(scored));
  assert.equal(scored.success, true, JSON.stringify(scored));
  assert.equal(scored.evidence.contextSummaries, 0);
  assert.equal(scored.evidence.contextArtifactReads, 1);
  const artifacts = query(trial.directory, "SELECT * FROM context_artifacts WHERE kind='tool_result'");
  assert.ok(artifacts.some(artifact => artifact.original_chars > 30000 && artifact.content.includes('cobalt-42')));
  assert.ok(scored.checks.find(check => check.kind === 'context').passed);
});

test('a registered empty schema keeps the original prompt, permissions and task mode', async () => {
  const trial = await run(ablationTask, 'empty-schema', body => ({
    id: 'empty-schema', object: 'chat.completion', model: body.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"complete":true}' } }]
  }), []);
  const scored = grade(trial);
  assert.equal(scored.status, 'scored', JSON.stringify(scored));
  assert.equal(scored.success, true, JSON.stringify(scored));
  const protocol = json(join(trial.directory, 'protocol-observations.json'));
  assert.deepEqual(protocol.hostInput.toolNames, []);
  assert.equal(protocol.hostInput.runMode, 'task');
  assert.equal(protocol.hostInput.readOnly, false);
  assert.equal(protocol.hostInput.prompt, capabilityInput('roc-capability', ablationTask).prompt);
  assert.deepEqual(json(join(trial.directory, 'tool-schema.json')).tools, []);
  assert.ok(query(trial.directory, 'SELECT snapshot_json FROM agent_runs')
    .every(row => JSON.parse(row.snapshot_json).taskContract.kind === 'task'));
});

test('phase-specific answers are graded independently and cannot borrow the final phase answer', () => {
  const trial = trials.get('memory-cross-session'), wrong = structuredClone(trial.task);
  wrong.expected.checks.find(check => check.id === 'fact-stored').value = false;
  const scored = grade(trial, wrong);
  assert.equal(scored.status, 'scored', JSON.stringify(scored));
  assert.equal(scored.success, false);
  assert.equal(scored.failureClass, 'agent');
  assert.equal(scored.checks.find(check => check.id === 'fact-stored').passed, false);
  assert.equal(scored.checks.find(check => check.id === 'fact-recalled').passed, true);
});

test('missing initial state or a forged agent memory receipt cannot stand in for retained raw evidence', () => {
  const trial = trials.get('memory-cross-session');
  tamper(trial, ['initial-memory.sqlite'], () => {
    writeFileSync(join(trial.directory, 'initial-memory.sqlite'), '{"status":"accepted","key":"roc.fixture.detector-calibration"}');
  }, scored => assert.equal(scored.status, 'invalid', JSON.stringify(scored)));
});

test('retained phase database corruption is invalid even after refreshing the outer host hashes', () => {
  const trial = trials.get('stateful-clarification');
  tamper(trial, ['phases/clarify/agent.sqlite'], () => {
    const db = new Database(join(trial.directory, 'phases/clarify/agent.sqlite'));
    try { db.prepare('DELETE FROM langgraph_checkpoints').run(); } finally { db.close(); }
  }, scored => assert.equal(scored.status, 'invalid', JSON.stringify(scored)));
});

test('summary source bytes and summary purpose are required independently of a claimed context receipt', () => {
  const trial = trials.get('context-summary');
  tamper(trial, ['worker/agent.sqlite'], () => {
    const db = new Database(join(trial.directory, 'worker/agent.sqlite'));
    try {
      db.prepare("UPDATE context_artifacts SET content='agent-authored context receipt' WHERE kind='transcript'").run();
    } finally { db.close(); }
  }, scored => assert.equal(scored.status, 'invalid', JSON.stringify(scored)));
  tamper(trial, ['responses.jsonl'], () => {
    const path = join(trial.directory, 'responses.jsonl');
    const rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(row => row.purpose === 'summary'));
    for (const row of rows) if (row.purpose === 'summary') row.purpose = 'agent';
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }, scored => assert.equal(scored.status, 'invalid', JSON.stringify(scored)));
});

test('a wrong MCP value fails a functional criterion without inventing a mutation or approval result', () => {
  const trial = trials.get('mcp-record-lookup'), wrong = structuredClone(trial.task);
  wrong.expected.checks.find(check => check.kind === 'mcp').value = { protocol: 'wrong', units: 0 };
  const scored = grade(trial, wrong);
  assert.equal(scored.status, 'scored', JSON.stringify(scored));
  assert.equal(scored.success, false);
  assert.equal(scored.failureClass, 'agent');
  assert.equal(scored.metrics.unauthorizedSideEffectRate, 0);
  assert.equal(scored.metrics.approvalBypassRate, null);
});
