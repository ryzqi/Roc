import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
import { capabilityInput } from '../adapters/capability/run.mjs';
import { executeApplication, prepareApplication } from '../lib/application.mjs';
import { bindCapabilityMcpManifest, readCapabilityMcpTransport, verifyCapabilityMcpEvidence } from '../lib/capability-mcp-verifier.mjs';
import { directory, EVAL_ROOT, hash, sha256 } from '../lib/common.mjs';
import { fixtureConfig } from '../lib/fixture.mjs';

// These are real AgentRuntime runs with production MCP stdio/client, context
// storage and tool-effect settlement. Only model completions are controlled.
// An explicit evidence directory retains complete failing and passing runs.
const retained = process.env.ROC_MCP_EVIDENCE_DIR;
const root = directory(retained ? resolve(retained) : join(EVAL_ROOT, '.runtime/tests'), 'capability-mcp-runtime');
after(() => { if (!retained) rmSync(root, { recursive: true, force: true }); });
if (retained) console.log(`MCP runtime evidence: ${root}`);
const environment = { schemaVersion: 1, mode: 'local-records-v1', sourceFile: 'mcp-records.json' };
const records = { alpha: { calibration: 'cobalt-42', units: 42, nested: [false, null, '原始值'] } };
const largeValue = 'a'.repeat(31000 - 'cobalt-42'.length) + 'cobalt-42';
function task(id, tools, values, prompt, session) {
  return { schemaVersion: 2, id, family: 'mcp-interaction-recovery', clusterId: id, split: 'dev',
    visible: { prompt, files: { 'mcp-records.json': JSON.stringify(values) + '\n' } },
    environment: { tools, network: 'disabled', mcp: environment, ...(session ? { session } : {}) },
    expected: { checks: [] } };
}
const recoveryTask = task('mcp-runtime-recovery', ['lookup_record'], records,
  'Recover from an invalid lookup and a missing public key, then read alpha and return its original JSON value.');
const offloadTask = task('mcp-runtime-offload', ['lookup_record', 'read_context_artifact'], { large: largeValue },
  'Read large using lookup_record. Recover its final 1000 characters through read_context_artifact and return the calibration.');
const artifact = await prepareApplication(root, { kind: 'roc-capability', taskTools: [recoveryTask, offloadTask].map(task =>
  ({ taskId: task.id, toolNames: task.environment.tools, runMode: 'chat', mcp: environment })) });
const wireTool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolReply = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
const text = content => typeof content === 'string' ? content : content.map(block => block.text).join('');
function query(path, sql) {
  const db = new Database(join(path, 'worker/agent.sqlite'), { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
function jsonl(path, file) {
  return readFileSync(join(path, file), 'utf8').trimEnd().split('\n').map(JSON.parse);
}
function mcpReport(trial) {
  return verifyCapabilityMcpEvidence({ directory: trial.directory, input: trial.input, manifest: trial.manifest });
}
function rejectDatabaseMutation(trial, name, mutate, reason) {
  // Retain the original runtime bytes, including any SQLite sidecars. Each
  // host-only tamper check must leave the actual passing evidence intact.
  const path = join(trial.directory, 'worker/agent.sqlite');
  const original = ['', '-wal', '-shm'].map(suffix => ({
    path: path + suffix, raw: existsSync(path + suffix) ? readFileSync(path + suffix) : null
  }));
  try {
    const db = new Database(path, { fileMustExist: true });
    try { mutate(db); } finally { db.close(); }
    const report = mcpReport(trial);
    assert.equal(report.status, 'invalid', `${name} must fail independent verification`);
    assert.equal(report.reason, reason, JSON.stringify(report.checks));
    appendFileSync(join(trial.directory, 'host-tamper-checks.jsonl'), JSON.stringify({
      name, status: report.status, reason: report.reason
    }) + '\n');
  } finally {
    for (const file of original) {
      if (file.raw !== null) writeFileSync(file.path, file.raw);
      else if (existsSync(file.path)) unlinkSync(file.path);
    }
  }
  for (const file of original) {
    if (file.raw !== null) assert.deepEqual(readFileSync(file.path), file.raw);
    else assert.equal(existsSync(file.path), false);
  }
  assert.equal(mcpReport(trial).status, 'valid', `${name} must restore the original runtime evidence`);
}
async function run(name, selectedTask, respond) {
  const path = join(root, name);
  mkdirSync(path);
  const input = capabilityInput('roc-capability', selectedTask);
  const manifest = artifact.taskManifests.find(item => item.taskId === selectedTask.id).manifest;
  writeFileSync(join(path, 'test-input.json'), JSON.stringify({ input, manifest }) + '\n');
  try {
    const result = await executeApplication({ artifact, input, directory: path,
      config: { ...fixtureConfig, taskTimeoutMs: 60000 }, signal: new AbortController().signal,
      record: entry => appendFileSync(join(path, 'host-events.jsonl'), JSON.stringify(entry) + '\n'),
      complete: (body, _signal, binding) => {
        const message = respond(body, binding);
        return { id: `${name}-${binding.request}`, object: 'chat.completion', created: 0, model: body.model,
          choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
      } });
    writeFileSync(join(path, 'test-outcome.json'), JSON.stringify({ status: 'passed', result }) + '\n');
    return { directory: path, input, manifest, result };
  } catch (error) {
    writeFileSync(join(path, 'test-outcome.json'), JSON.stringify({
      status: 'failed', error: error.message, stack: error.stack, failureClass: error.failureClass ?? null
    }) + '\n');
    throw error;
  }
}

test('real AgentRuntime preserves lookup errors, recovers and commits one independent durable MCP receipt', async () => {
  const trial = await run('error-recovery', recoveryTask, body => {
    const tools = body.messages.filter(message => message.role === 'tool');
    if (!tools.some(message => message.tool_call_id === 'lookup-invalid-schema'))
      return toolReply(wireTool('lookup-invalid-schema', 'lookup_record', { key: 42 }));
    if (!tools.some(message => message.tool_call_id === 'lookup-missing-record'))
      return toolReply(wireTool('lookup-missing-record', 'lookup_record', { key: 'missing' }));
    if (!tools.some(message => message.tool_call_id === 'lookup-recovered'))
      return toolReply(wireTool('lookup-recovered', 'lookup_record', { key: 'alpha' }));
    const value = JSON.parse(text(tools.find(message => message.tool_call_id === 'lookup-recovered').content));
    assert.deepEqual(value, records.alpha);
    return { role: 'assistant', content: JSON.stringify(value) };
  });
  assert.equal(trial.result.runtimeVerification.status, 'verified');
  assert.equal(trial.result.mcpVerification.status, 'valid');
  assert.deepEqual(bindCapabilityMcpManifest(trial.manifest), trial.manifest);
  const report = mcpReport(trial);
  assert.equal(report.status, 'valid', JSON.stringify(report));
  assert.deepEqual(report.calls.map(call => [call.id, call.status, call.schemaRejected]), [
    ['lookup-invalid-schema', 'error', true], ['lookup-missing-record', 'error', false], ['lookup-recovered', 'success', false]
  ]);
  assert.equal(report.calls.find(call => call.id === 'lookup-missing-record').text, 'capability_mcp_record_not_found');
  const requests = jsonl(trial.directory, 'transcript.jsonl').filter(row => row.type === 'request');
  const observed = requests.flatMap(row => row.body.messages).find(message => message.tool_call_id === 'lookup-missing-record'
    && message.role === 'tool');
  assert.equal(text(observed.content), 'capability_mcp_record_not_found');
  assert.deepEqual(report.recoveries.map(value => [value.errorCallId, value.successCallId]),
    [['lookup-invalid-schema', 'lookup-recovered']]);
  const receipts = query(trial.directory, 'SELECT * FROM agent_tool_effect_results');
  const effects = query(trial.directory, 'SELECT * FROM agent_tool_effects');
  assert.equal(receipts.length, 1);
  assert.equal(effects.filter(row => row.status === 'succeeded').length, 1);
  const successful = effects.find(row => row.tool_call_id === 'lookup-recovered');
  assert.equal(successful.receipt_json, null);
  assert.equal(successful.receipt_hash, null);
  const receipt = JSON.parse(receipts[0].receipt_json);
  assert.equal(receipt.operationId, successful.operation_id);
  assert.equal(receipt.resultHash, hash(JSON.parse(successful.result_json)));
  assert.equal(receipts[0].receipt_hash, hash(receipt));
  assert.equal(receipt.providerReceiptHash, null);
  const process = JSON.parse(readFileSync(join(trial.directory, 'process.json'), 'utf8'));
  const wire = readCapabilityMcpTransport({ directory: trial.directory, environment, files: trial.input.files,
    manifest: trial.manifest, workerPid: process.pid });
  assert.deepEqual(wire.calls.map(call => [call.key, call.status]).sort(),
    [['alpha', 'success'], ['missing', 'error']]);
});

test('large real MCP result binds original wire and durable receipt to production offload and an executed artifact read', async () => {
  let recoveredSlice;
  const trial = await run('large-offload', offloadTask, body => {
    const tools = body.messages.filter(message => message.role === 'tool');
    const lookup = tools.find(message => message.tool_call_id === 'lookup-large-record');
    if (!lookup) return toolReply(wireTool('lookup-large-record', 'lookup_record', { key: 'large' }));
    const read = tools.find(message => message.tool_call_id === 'read-large-tail');
    if (!read) {
      const reference = text(lookup.content).match(/^<roc_context_artifact>\nartifactId: (ctx_artifact_[a-f0-9-]+)\nsha256: ([a-f0-9]{64})\noriginalChars: (\d+)\n/u);
      assert.ok(reference, 'The model must receive a real offload reference.');
      assert.equal(Number(reference[3]), JSON.stringify(largeValue).length);
      return toolReply(wireTool('read-large-tail', 'read_context_artifact', {
        artifactId: reference[1], sha256: reference[2], offset: Number(reference[3]) - 1000, limit: 12000
      }));
    }
    recoveredSlice = JSON.parse(text(read.content));
    assert.equal(recoveredSlice.content, JSON.stringify(largeValue).slice(-1000));
    assert.equal(recoveredSlice.complete, true);
    return { role: 'assistant', content: '{"calibration":"cobalt-42"}' };
  });
  assert.equal(trial.result.runtimeVerification.status, 'verified');
  assert.equal(trial.result.mcpVerification.status, 'valid');
  const report = mcpReport(trial);
  assert.equal(report.status, 'valid', JSON.stringify(report));
  assert.equal(report.calls.length, 1);
  assert.equal(report.calls[0].text, JSON.stringify(largeValue));
  assert.equal(report.calls[0].value, largeValue);
  const artifacts = query(trial.directory, 'SELECT * FROM context_artifacts');
  const original = artifacts.find(row => row.id === recoveredSlice.artifactId);
  assert.ok(original);
  assert.equal(original.kind, 'tool_result');
  assert.equal(original.tool_call_id, 'lookup-large-record');
  assert.equal(original.tool_name, 'lookup_record');
  assert.equal(original.content, JSON.stringify(largeValue));
  assert.equal(original.sha256, sha256(original.content));
  assert.equal(original.original_chars, original.content.length);
  assert.ok(original.original_chars > 30000);
  assert.equal(original.thread_id, report.calls[0].threadId);
  const effects = query(trial.directory, 'SELECT * FROM agent_tool_effects');
  const mcp = effects.find(row => row.tool_call_id === 'lookup-large-record');
  assert.equal(text(JSON.parse(mcp.result_json).content), original.content);
  assert.ok(query(trial.directory, 'SELECT * FROM agent_tool_effect_results').some(row => row.operation_id === mcp.operation_id));
  assert.ok(query(trial.directory, "SELECT * FROM agent_calls WHERE kind='tool'")
    .some(row => JSON.parse(row.envelope_json).name === 'read_context_artifact' && row.state === 'settled'));
  const trace = jsonl(trial.directory, 'transcript.jsonl');
  assert.ok(trace.some(row => row.type === 'event' && JSON.stringify(row.event).includes('context_tool_result_persisted')));
  assert.ok(trace.filter(row => row.type === 'request').every(row => !row.body.messages.some(message =>
    message.role === 'tool' && message.tool_call_id === 'lookup-large-record' && text(message.content) === original.content)));
  const context = report.calls[0].contextEvidence;
  assert.equal(context.originalObserved, false);
  assert.equal(context.artifacts.length, 1);
  assert.equal(context.artifacts[0].artifactId, original.id);
  assert.equal(context.artifacts[0].sha256, original.sha256);
  assert.equal(context.artifacts[0].reads.length, 1);
  const read = context.artifacts[0].reads[0];
  assert.equal(read.id, 'read-large-tail');
  assert.equal(read.chars, 1000);
  assert.equal(read.sliceSha256, sha256(original.content.slice(-1000)));
  rejectDatabaseMutation(trial, 'missing-original-artifact', db =>
    db.prepare('DELETE FROM context_artifacts WHERE id=?').run(original.id), 'capability_mcp_artifact_missing');
  const changed = original.content.replace('a', 'b');
  rejectDatabaseMutation(trial, 'self-consistent-artifact-with-changed-original-value', db =>
    db.prepare('UPDATE context_artifacts SET content=?, sha256=?, preview=? WHERE id=?')
      .run(changed, sha256(changed), changed.slice(0, 2000), original.id), 'capability_mcp_artifact_original_content_invalid');
  rejectDatabaseMutation(trial, 'missing-durable-mcp-result-receipt', db =>
    db.prepare('DELETE FROM agent_tool_effect_results WHERE operation_id=?').run(mcp.operation_id),
  'capability_mcp_result_receipt_missing');
  rejectDatabaseMutation(trial, 'missing-executed-artifact-read-usage', db =>
    db.prepare('DELETE FROM agent_calls WHERE run_id=? AND call_id=?').run(read.runId, read.usageCallId),
  'capability_mcp_artifact_read_usage_missing');
});
