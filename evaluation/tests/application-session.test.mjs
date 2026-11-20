import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { executeApplication, prepareApplication, recoverApplication } from '../lib/application.mjs';
import { applicationSessionContract, verifyApplicationEvidence } from '../lib/application-verifier.mjs';
import { fixtureConfig } from '../lib/fixture.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('application-session');
const toolsets = {
  'session-state': ['ls'],
  'session-memory': ['remember', 'memory_search', 'session_search'],
  'session-context': ['read_file', 'read_context_artifact'],
  'session-revision': ['remember', 'read_context_artifact'],
  'session-mode': ['ls']
};
const artifact = await prepareApplication(root, { kind: 'roc-capability', taskTools: Object.entries(toolsets)
  .map(([taskId, toolNames]) => ({ taskId, toolNames, runMode: taskId === 'session-mode' ? 'task' : 'chat' })) });
const wireTool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function completion(body, message, id) {
  return { id, object: 'chat.completion', created: 0, model: body.model,
    choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
}
function input(taskId, turns, files = {}) {
  return { kind: 'roc-capability', taskId, toolNames: [...toolsets[taskId]].sort(),
    runMode: taskId === 'session-mode' ? 'task' : 'chat', viewFamily: 'long-memory', difficulty: 'hard',
    prompt: turns[0].prompt, files, readOnly: true, session: { schemaVersion: 1, turns } };
}
async function run(name, selectedInput, respond, config = fixtureConfig) {
  const directory = join(root, name); mkdirSync(directory);
  const result = await executeApplication({ artifact, input: selectedInput, directory, config,
    signal: new AbortController().signal, record: () => {},
    complete: (body, _signal, binding) => completion(body, respond(body, binding), `${name}-${binding.request}`) });
  return { directory, input: selectedInput, result, config };
}
function query(directory, sql) {
  const db = new Database(join(directory, 'worker/agent.sqlite'), { readonly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

test('clarification uses separate completed production runs and preserves real same-thread checkpoints', async () => {
  const turns = [
    { id: 'clarify', prompt: 'The instrument code is R42. Ask for a precision before giving the result, in JSON.', thread: 'new' },
    { id: 'answer', prompt: 'Use two decimal places. Return the earlier instrument code and precision as JSON.', thread: 'continue' }
  ];
  const trial = await run('same-thread', input('session-state', turns), (body, binding) => {
    if (binding.phaseId === 'clarify') return { role: 'assistant', content: '{"question":"Which precision?"}' };
    assert.ok(body.messages.some(message => message.role === 'user' && message.content === turns[0].prompt));
    assert.ok(body.messages.some(message => message.role === 'assistant' && message.content === '{"question":"Which precision?"}'));
    assert.equal(body.messages.filter(message => message.role === 'user').at(-1).content, turns[1].prompt);
    return { role: 'assistant', content: '{"code":"R42","precision":2}' };
  });
  assert.equal(trial.result.output, '{"code":"R42","precision":2}');
  const runs = query(trial.directory, 'SELECT id,thread_id,user_input,status FROM agent_runs');
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs.map(run => run.thread_id)).size, 1);
  assert.deepEqual(runs.map(run => run.user_input).sort(), turns.map(turn => turn.prompt).sort());
  assert.ok(runs.every(run => run.status === 'completed'));
  const report = JSON.parse(readFileSync(join(trial.directory, 'runtime-verification.json')));
  assert.equal(report.status, 'verified', JSON.stringify(report));
  assert.deepEqual(report.contract, applicationSessionContract);
  assert.equal(report.phases.length, 2);
  assert.equal(JSON.parse(readFileSync(join(trial.directory, 'protocol-observations.json'))).schemaVersion, 2);
  assert.equal(recoverApplication({ artifact, input: trial.input, directory: trial.directory, config: trial.config }).output, trial.result.output);
});

test('a new session retrieves memory written by a real remember call rather than a concatenated earlier prompt', async () => {
  const turns = [
    { id: 'store', prompt: 'Remember this workspace fact with quoted evidence: calibration is cobalt-42. Return JSON after saving.', thread: 'new' },
    { id: 'recall', prompt: 'Search durable memory for calibration and return its value as JSON.', thread: 'new' }
  ];
  const trial = await run('cross-session', input('session-memory', turns), (body, binding) => {
    const tools = body.messages.filter(message => message.role === 'tool');
    if (binding.phaseId === 'store') {
      if (!tools.length) return { role: 'assistant', content: null, tool_calls: [wireTool('remember-calibration', 'remember', {
        status: 'active', counterexamples: [], type: 'workspace_fact', confidence: 'high',
        key: 'calibration', summary: 'Calibration is cobalt-42.', evidence: ['calibration is cobalt-42']
      })] };
      assert.equal(JSON.parse(tools.at(-1).content).status, 'accepted');
      return { role: 'assistant', content: '{"stored":true}' };
    }
    assert.ok(!body.messages.some(message => message.role === 'user' && message.content === turns[0].prompt));
    if (!tools.length) return { role: 'assistant', content: null,
      tool_calls: [wireTool('search-calibration', 'memory_search', { query: 'calibration', limit: 5 })] };
    const hit = JSON.parse(tools.at(-1).content).hits.find(hit => hit.key === 'calibration');
    assert.ok(hit?.text.includes('cobalt-42'), JSON.stringify(tools));
    return { role: 'assistant', content: '{"calibration":"cobalt-42"}' };
  });
  assert.equal(trial.result.runtimeVerification.status, 'verified');
  assert.equal(query(trial.directory, 'SELECT id FROM agent_threads').length, 2);
  const db = new Database(join(trial.directory, 'worker/memory.sqlite'), { readonly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_auto_audit WHERE action='accepted' AND memory_key='calibration'").get().count, 1);
    assert.ok(db.prepare('SELECT value_json FROM langgraph_store_items').all().some(row => row.value_json.includes('cobalt-42')));
  } finally { db.close(); }
  const report = verifyApplicationEvidence({ artifact, input: trial.input, directory: trial.directory, config: trial.config,
    requests: trial.result.requests, toolSchemaHash: trial.result.toolSchemaHash });
  assert.equal(report.status, 'verified', JSON.stringify(report));
});

test('the original task mode survives an ablation that removes shell from the visible tool subset', async () => {
  const trial = await run('mode', input('session-mode', [
    { id: 'first', prompt: 'Return {"step":1}.', thread: 'new' },
    { id: 'second', prompt: 'Return {"step":2}.', thread: 'continue' }
  ]), (_body, binding) => ({ role: 'assistant', content: JSON.stringify({ step: binding.phaseIndex + 1 }) }));
  const snapshots = query(trial.directory, 'SELECT snapshot_json FROM agent_runs').map(row => JSON.parse(row.snapshot_json));
  assert.ok(snapshots.every(snapshot => snapshot.taskContract.kind === 'task'), JSON.stringify(snapshots.map(snapshot => snapshot.taskContract)));
  assert.ok(snapshots.every(snapshot => snapshot.capabilityManifest.tools.every(tool => tool.modelVisibleName !== 'run_shell_command')));
});

test('harness revisions retain scoped subagent tools and readonly permissions', async () => {
  const trial = await run('revision', input('session-revision', [
    { id: 'inspect', prompt: 'Return {"ready":true}.', thread: 'new' },
    { id: 'continue', prompt: 'Return {"ready":true} again.', thread: 'continue' }
  ]), () => ({ role: 'assistant', content: '{"ready":true}' }));
  assert.equal(trial.result.runtimeVerification.status, 'verified');
  const rows = query(trial.directory, 'SELECT revision_json FROM agent_harness_revisions');
  assert.equal(rows.length, 2);
  const revision = JSON.parse(rows[0].revision_json);
  assert.deepEqual(revision.subagents, JSON.parse(rows[1].revision_json).subagents);
  assert.ok(revision.tools.some(tool => tool.name === 'remember'));
  assert.ok(revision.permissions.some(permission => permission.mode === 'allow' && permission.operations.includes('write')));
  assert.deepEqual(revision.subagents.map(({ name, tools, skills }) => ({ name, tools, skills })), [
    { name: 'general-purpose', tools: ['read_context_artifact'], skills: [] },
    { name: 'research', tools: [], skills: [] }
  ]);
  for (const subagent of revision.subagents) {
    assert.deepEqual(subagent.permissions, [
      { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/**'], mode: 'deny' }
    ]);
  }
});
