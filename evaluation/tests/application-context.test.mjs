import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { capabilityInput } from '../adapters/capability/run.mjs';
import { executeApplication, prepareApplication } from '../lib/application.mjs';
import { fixtureConfig } from '../lib/fixture.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('application-context');
const summaryTurns = [
  { id: 'progress', thread: 'new',
    prompt: 'Calibration is cobalt-42. Observe directories round-1 through round-14 with ls, explaining the public calibration status in each round. Keep the progress log recoverable. Return JSON after the rounds.' },
  { id: 'recover', thread: 'continue',
    prompt: 'Recover the compacted progress log using read_context_artifact and return calibration as JSON.' }
];
function task(id, tools, prompt, files = {}, environment = {}) {
  return { schemaVersion: 2, id, family: 'memory-context-compaction', clusterId: id, split: 'dev',
    visible: { prompt, files }, environment: { tools, network: 'disabled', ...environment },
    expected: { checks: [{ id: 'calibration', kind: 'json-value', path: ['calibration'], value: 'cobalt-42' }] } };
}
const summaryFiles = Object.fromEntries(Array.from({ length: 14 }, (_, index) =>
  [`round-${index + 1}/record.txt`, `Public calibration progress ${index + 1}: cobalt-42.\n`]));
const summaryTask = task('context-summary', ['ls', 'read_context_artifact'], summaryTurns[0].prompt, summaryFiles,
  { session: { schemaVersion: 1, turns: summaryTurns }, context: { schemaVersion: 1, contextWindowTokens: 65536 } });
const source = Array.from({ length: 600 }, (_, index) =>
  `observed source bytes ${index}: ${'public calibration log '.repeat(3)}${index === 599 ? 'cobalt-42' : ''}`).join('\n') + '\n';
const offloadTask = task('context-offload', ['grep', 'read_context_artifact'],
  'Observe all lines of large.txt with grep for "observed source bytes" (max_count 2000, output_mode content). Recover the end through read_context_artifact and return calibration as JSON.',
  { 'large.txt': source });
const artifact = await prepareApplication(root, { kind: 'roc-capability',
  taskTools: [summaryTask, offloadTask].map(task => ({ taskId: task.id, toolNames: task.environment.tools, runMode: 'chat' })) });
const wireTool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function query(directory, sql) {
  const db = new Database(join(directory, 'worker/agent.sqlite'), { readonly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
function references(body) {
  const text = JSON.stringify(body.messages);
  return [...text.matchAll(/artifactId: (ctx_artifact_[a-f0-9-]+)\\nsha256: ([a-f0-9]{64})\\noriginalChars: (\d+)/gu)]
    .map(match => ({ artifactId: match[1], sha256: match[2], originalChars: Number(match[3]) }));
}
async function run(name, selectedTask, respond) {
  const directory = join(root, name); mkdirSync(directory);
  const selectedInput = capabilityInput('roc-capability', selectedTask);
  const result = await executeApplication({ artifact, input: selectedInput, directory,
    config: { ...fixtureConfig, taskTimeoutMs: 60000 }, signal: new AbortController().signal, record: () => {},
    complete: (body, _signal, binding) => {
      const message = respond(body, binding);
      return { id: `${name}-${binding.request}`, object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
    } }).catch(error => {
      let stderr = '';
      try { stderr = readFileSync(join(directory, 'stderr.log'), 'utf8').slice(-6000); } catch {}
      throw new Error(`${error.message}\n${stderr}`, { cause: error });
    });
  return { directory, result };
}

test('large real grep output is offloaded and recovered by an executed artifact read', async () => {
  const trial = await run('offload', offloadTask, body => {
    const tools = body.messages.filter(message => message.role === 'tool');
    if (!tools.length) return { role: 'assistant', content: null, tool_calls: [
      wireTool('read-large-source', 'grep', { pattern: 'observed source bytes', path: '/workspace/large.txt',
        max_count: 2000, output_mode: 'content' })
    ] };
    if (!tools.some(message => message.name === 'read_context_artifact')) {
      const reference = references(body)[0];
      assert.ok(reference, JSON.stringify(tools));
      return { role: 'assistant', content: null, tool_calls: [
        wireTool('recover-source-tail', 'read_context_artifact', { artifactId: reference.artifactId,
          sha256: reference.sha256, offset: Math.max(0, reference.originalChars - 1200), limit: 12000 })
      ] };
    }
    assert.ok(JSON.parse(tools.at(-1).content).content.includes('cobalt-42'));
    return { role: 'assistant', content: '{"calibration":"cobalt-42"}' };
  });
  assert.equal(trial.result.runtimeVerification.status, 'verified');
  const artifacts = query(trial.directory, 'SELECT * FROM context_artifacts');
  const sourceArtifacts = artifacts.filter(row => row.kind === 'tool_result' && row.tool_call_id === 'read-large-source');
  assert.ok(sourceArtifacts.length > 0);
  assert.ok(sourceArtifacts.every(row => row.original_chars > 30000
    && row.content.includes(source.trim().split('\n').at(-1))));
  const modelCalls = query(trial.directory, "SELECT envelope_json FROM agent_calls WHERE kind='model'");
  assert.ok(modelCalls.every(row => JSON.parse(row.envelope_json).purpose === 'agent'));
});

test('a genuine multi-turn context summary has its own model call, transcript and recoverable digest', async () => {
  let summaryCalls = 0, progressCalls = 0, recovered = false;
  const trial = await run('summary', summaryTask, (body, binding) => {
    if (binding.purpose === 'summary') {
      summaryCalls++;
      assert.ok(binding.modelCallId);
      assert.equal(body.messages[0].content, 'Summarize Roc runtime context.');
      const summary = { goal: 'Preserve the observed calibration progress.', facts: ['Calibration is cobalt-42.'],
        decisions: [], filesTouched: [], toolEvidence: [], verification: [], openQuestions: [], nextActions: ['Recover the old log.'] };
      return body.tools?.length
        ? { role: 'assistant', content: null, tool_calls: [wireTool(`summary-${summaryCalls}`, 'roc_context_summary', summary)] }
        : { role: 'assistant', content: JSON.stringify(summary) };
    }
    if (binding.phaseIndex < summaryTurns.length - 1) {
      if (progressCalls < 14) {
        progressCalls++;
        return { role: 'assistant', content: 'Observed calibration cobalt-42 progress. '.repeat(100), tool_calls: [
          wireTool(`progress-${progressCalls}`, 'ls', { path: `/workspace/round-${progressCalls}` })
        ] };
      }
      return { role: 'assistant', content: '{"calibration":"cobalt-42","rounds":14}' };
    }
    const read = body.messages.find(message => message.role === 'tool' && message.name === 'read_context_artifact');
    if (!read) {
      const reference = references(body).at(-1);
      assert.ok(reference, `No actual context artifact in final request; summaries=${summaryCalls}`);
      return { role: 'assistant', content: null, tool_calls: [
        wireTool('recover-summary-transcript', 'read_context_artifact', { artifactId: reference.artifactId,
          sha256: reference.sha256, offset: 0, limit: 12000 })
      ] };
    }
    assert.ok(JSON.parse(read.content).content.includes('cobalt-42'));
    recovered = true;
    return { role: 'assistant', content: '{"calibration":"cobalt-42"}' };
  });
  assert.ok(summaryCalls > 0);
  assert.equal(recovered, true);
  assert.equal(trial.result.runtimeVerification.status, 'verified');
  const calls = query(trial.directory, "SELECT * FROM agent_calls WHERE kind='model'");
  assert.equal(calls.filter(row => JSON.parse(row.envelope_json).purpose === 'summary').length, summaryCalls);
  const transcripts = query(trial.directory, "SELECT * FROM context_artifacts WHERE kind='transcript'");
  assert.ok(transcripts.length > 0);
  assert.ok(transcripts.every(row => row.content.includes('cobalt-42')));
  assert.ok(query(trial.directory, "SELECT * FROM session_messages WHERE phase='pre_compaction_flush'")
    .every(row => row.content.includes('roc_context_digest')));
  const trace = readFileSync(join(trial.directory, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(trace.some(row => row.type === 'event' && JSON.stringify(row.event).includes('context_summary_completed')));
  assert.ok(trace.some(row => row.type === 'request'
    && row.body.messages.some(message => String(message.content).includes('<roc_context_digest>'))));
});
