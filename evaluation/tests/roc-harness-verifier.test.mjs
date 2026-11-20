import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { hash, ROOT, sha256 } from '../lib/common.mjs';
import { harnessCases, harnessCompletion, harnessCoreCaseIds, harnessSmokeCaseIds, selectHarnessCases } from '../lib/harness-cases.mjs';
import { harnessContextEvidence, harnessRunEventEvidence, harnessSubagentEvidence, readHarnessMcpTransport, readHarnessMemory,
  readHarnessState, readHarnessTransport, summarizeHarness } from '../lib/harness-verifier.mjs';

// Parser/contract fixtures only. No worker execution, sourceIdentity capture,
// model inference or synthetic fixture is credited as a Runtime pass.
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'roc-harness-verifier-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const scenario = id => harnessCases.find(c => c.id === id);
const jsonLines = (root, name, records) => writeFileSync(join(root, name),
  records.map(record => JSON.stringify(record)).join('\n') + '\n');
function selection(profile, task) {
  const selected = selectHarnessCases(profile, task);
  return { profile, repeats: selected.repeats, selection: selected.cases.map(({ id, dimension }) => ({ id, dimension })) };
}
function passingTrials(manifest) {
  return manifest.selection.flatMap(task => Array.from({ length: manifest.repeats }, (_, repeat) =>
    ({ taskId: task.id, dimension: task.dimension, repeat, status: 'passed', latencyMs: 1, requests: 1 })));
}
function request(index) {
  return { type: 'request', index, body: { model: 'roc-harness-scripted',
    messages: [{ role: 'user', content: `observed request ${index}` }], tools: [] } };
}
function binding(call, phase = 'start') {
  return { request: call.index, trialId: 'trial-pure', requestId: `controlled-trace-${phase}-${call.index + 1}`,
    requestHash: hash(call.body) };
}
function response(call, phase = 'start') {
  return { ...binding(call, phase), body: { model: call.body.model, choices: [
    { index: 0, message: { role: 'assistant', content: 'Complete.' }, finish_reason: 'stop' }
  ] } };
}
function constructor(kind, kwargs) {
  return { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', kind], kwargs };
}
function executionEnvelope(event, sequence, createdAt) {
  const envelope = { schemaVersion: 1, streamId: `chat:${event.runId}`, projectId: null, taskId: null,
    runId: event.runId, sequence, eventType: event.type, actor: { kind: 'main', id: 'agent-runtime' },
    correlationId: event.runId, causationId: null, payloadHash: sha256(JSON.stringify(event)),
    payloadRef: null, payload: event, createdAt };
  envelope.eventId = sha256(JSON.stringify([envelope.streamId, sequence, envelope.eventType, envelope.actor,
    envelope.correlationId, envelope.causationId, envelope.projectId, envelope.taskId, envelope.runId,
    envelope.payloadHash, createdAt]));
  return envelope;
}
function rawDatabase(path) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE agent_runs (id TEXT, thread_id TEXT, status TEXT, user_input TEXT, snapshot_json TEXT);
    CREATE TABLE langgraph_checkpoints (checkpoint_id TEXT, checkpoint_ns TEXT, thread_id TEXT,
      checkpoint_type TEXT, checkpoint_blob BLOB, metadata_type TEXT, metadata_blob BLOB);
    CREATE TABLE langgraph_checkpoint_writes (checkpoint_id TEXT, checkpoint_ns TEXT, task_path TEXT,
      task_id TEXT, idx INTEGER, value_type TEXT, value_blob BLOB);
    CREATE TABLE agent_calls (call_id TEXT);
    CREATE TABLE agent_tool_effects (tool_call_id TEXT);
    CREATE TABLE agent_tool_effect_results (operation_id TEXT);
    CREATE TABLE agent_execution_approvals (approval_reference TEXT);
    CREATE TABLE agent_execution_grants (id TEXT);
    CREATE TABLE context_artifacts (id TEXT);
    CREATE TABLE agent_task_contracts (run_id TEXT, contract_json TEXT);
    CREATE TABLE agent_pending_interrupts (position INTEGER);
    CREATE TABLE agent_run_events (run_id TEXT, sequence INTEGER, event_json TEXT, created_at TEXT, event_bytes INTEGER);
    CREATE TABLE agent_events (sequence INTEGER, id TEXT, payload_json TEXT);
  `);
  return db;
}

test('catalog preserves original ten IDs, smoke three and 22 distinct fault sequences in 13 dimensions', () => {
  const core = ['cold-model-resume', 'tool-before-dispatch', 'tool-result-replay', 'tool-receipt-unknown',
    'approval-reject', 'approval-approve', 'cancel-model', 'parallel-edits', 'denied-tool', 'tool-loop'];
  assert.deepEqual(harnessCoreCaseIds, core);
  assert.deepEqual(harnessCases.slice(0, 10).map(c => c.id), core);
  assert.deepEqual(harnessSmokeCaseIds, ['tool-result-replay', 'tool-receipt-unknown', 'approval-reject']);
  assert.equal(harnessCases.length, 22);
  assert.equal(new Set(harnessCases.map(c => c.id)).size, 22);
  assert.equal(new Set(harnessCases.map(({ id: _id, dimension: _dimension, ...sequence }) => hash(sequence))).size, 22);
  assert.equal(new Set(harnessCases.map(c => c.dimension)).size, 13);
  for (const [profile, count, repeats] of [['smoke', 3, 1], ['fast', 22, 1], ['full', 22, 3]]) {
    const selected = selectHarnessCases(profile);
    assert.equal(selected.cases.length, count);
    assert.equal(selected.repeats, repeats);
  }
  assert.throws(() => selectHarnessCases('release'), /harness_profile_requires/);
  assert.throws(() => selectHarnessCases('fast', 'alias'), /harness_task_not_found/);
});

test('new controlled sequences dispatch concrete production tools with independent fault schedules', () => {
  const first = id => harnessCompletion(scenario(id), request(0).body, 0).choices[0].message.tool_calls;
  assert.equal(first('approval-expired')[0].function.name, 'run_trusted_host_command');
  assert.equal(first('memory-db-error')[0].function.name, 'edit_file');
  assert.equal(JSON.parse(first('memory-db-error')[0].function.arguments).file_path, '/memory/global/MEMORY.md');
  assert.equal(first('subagent-cancel')[0].function.name, 'task');
  assert.equal(first('subagent-error')[0].function.name, 'task');
  assert.equal(scenario('subagent-cancel').cancelAtRequest, 1);
  assert.equal(scenario('subagent-error').modelErrorAtRequest, 1);
  assert.equal(first('mcp-disconnect')[0].function.name, 'probe');
  assert.equal(first('mcp-receipt-lost')[0].function.name, 'probe');
  assert.equal(scenario('mcp-receipt-lost').recover, true);
  assert.equal(first('context-compaction-crash')[0].function.name, 'grep');
  assert.equal(scenario('context-compaction-crash').fault, 'context-compacted');
  assert.ok(Buffer.byteLength(scenario('context-compaction-crash').files['large.txt']) > 30000);
  assert.deepEqual(first('concurrent-edit-conflict').map(c => JSON.parse(c.function.arguments).new_string), ['FIRST', 'SECOND']);
  for (const id of ['permission-change', 'workspace-replaced', 'source-updated', 'budget-stop']) {
    assert.equal(first(id)[0].function.name, 'read_file');
  }
});

test('summary enforces full catalog, profiles, repeats and the selected scope', () => {
  for (const [profile, expected, coverage] of [['smoke', 3, 'selected-cases'], ['fast', 22, 'all-cases'], ['full', 66, 'all-cases']]) {
    const manifest = selection(profile), trials = passingTrials(manifest), summary = summarizeHarness(manifest, trials);
    assert.equal(summary.status, 'complete');
    assert.equal(summary.assessment, 'pass');
    assert.equal(summary.expected, expected);
    assert.equal(summary.coverage, coverage);
    assert.equal(summary.exclusions.profile_or_task_selection, 22 - manifest.selection.length);
    trials[0].status = 'failed';
    assert.equal(summarizeHarness(manifest, trials).assessment, 'fail');
  }
  const manifest = selection('full', 'memory-db-error');
  assert.equal(summarizeHarness(manifest, passingTrials(manifest)).expected, 3);
  assert.equal(summarizeHarness(manifest, passingTrials(manifest)).coverage, 'selected-cases');
});

test('missing, duplicate, renamed, wrong-dimension and out-of-profile identities cannot complete', () => {
  const manifest = selection('fast'), trials = passingTrials(manifest);
  for (const mutate of [
    (m, ts) => { ts[21] = ts[0]; },
    (_m, ts) => { ts.pop(); },
    (_m, ts) => { ts[0].repeat = 1; },
    (_m, ts) => { ts[0].status = 'success'; },
    (m, ts) => { m.selection[0].id = ts[0].taskId = 'renamed-case'; },
    (m, ts) => { m.selection[0].dimension = ts[0].dimension = 'invented'; },
    (m, ts) => { m.selection = m.selection.slice(0, 2); ts.splice(2); },
    (m, ts) => { m.profile = 'full'; },
    (m, ts) => { m.profile = 'smoke'; }
  ]) {
    const m = structuredClone(manifest), ts = structuredClone(trials);
    mutate(m, ts);
    assert.equal(summarizeHarness(m, ts).status, 'incomplete');
  }
  const duplicate = structuredClone(trials); duplicate[21] = duplicate[0];
  assert.equal(summarizeHarness(manifest, duplicate).unattempted, 1);
  const fatal = { failureClass: 'environment', reason: 'setup_failed' };
  assert.equal(summarizeHarness({ profile: 'fast', selection: [], repeats: 1 }, [], fatal).fatal, fatal);
  assert.equal(summarizeHarness({ profile: 'fast', selection: [null], repeats: 0 }, []).status, 'incomplete');
});

test('transport binds every request to one ordered response or the actual scheduled host action', t => {
  const root = temporary(t), calls = [request(0), request(1)];
  jsonLines(root, 'start.jsonl', [{ type: 'isolation', protectedFileDenied: true }, ...calls]);
  jsonLines(root, 'start.responses.jsonl', [response(calls[0])]);
  const action = { ...binding(calls[1]), action: 'cancel', reason: 'budget_max_model_requests' };
  jsonLines(root, 'start.actions.jsonl', [action]);
  const phases = [{ phase: 'start', requests: 2 }];
  const evidence = readHarnessTransport(scenario('budget-stop'), root, phases);
  assert.equal(evidence.responses.length, 1);
  assert.equal(evidence.actions.length, 1);
  for (const mutate of [
    value => { value.requestHash = '0'.repeat(64); },
    value => { value.reason = 'unscheduled'; },
    value => { value.requestId = 'controlled-trace-start-1'; },
    value => { value.trialId = 'another-trial'; },
    value => { value.body = response(calls[1]).body; }
  ]) {
    const forged = structuredClone(action); mutate(forged);
    jsonLines(root, 'start.actions.jsonl', [forged]);
    assert.throws(() => readHarnessTransport(scenario('budget-stop'), root, phases), /harness_transport/);
  }
  jsonLines(root, 'start.actions.jsonl', [action]);
  jsonLines(root, 'start.responses.jsonl', [response(calls[0]), response(calls[1])]);
  assert.throws(() => readHarnessTransport(scenario('budget-stop'), root, phases), /harness_transport/);
});

test('transport requires complete recovery traces and observes real cancellation/HTTP-error schedules', t => {
  const root = temporary(t), calls = [request(0), request(1)];
  jsonLines(root, 'start.jsonl', calls);
  jsonLines(root, 'start.responses.jsonl', [response(calls[0])]);
  for (const [id, action, reason, detail] of [
    ['subagent-cancel', 'cancel', 'controlled_request_cancelled', {}],
    ['subagent-error', 'transport-error', 'harness_child_model_unavailable', { status: 503 }]
  ]) {
    jsonLines(root, 'start.actions.jsonl', [{ ...binding(calls[1]), action, reason, ...detail }]);
    assert.equal(readHarnessTransport(scenario(id), root, [{ phase: 'start', requests: 2 }]).requests.length, 2);
  }
  jsonLines(root, 'start.jsonl', [request(0)]);
  rmSync(join(root, 'start.responses.jsonl'));
  jsonLines(root, 'start.actions.jsonl', [{ ...binding(calls[0]), action: 'interrupt', reason: 'controlled_request_interrupted' }]);
  const recover = request(0);
  jsonLines(root, 'recover.jsonl', [recover]);
  jsonLines(root, 'recover.responses.jsonl', [response(recover, 'recover')]);
  const phases = [{ phase: 'start', requests: 1 }, { phase: 'recover', requests: 1 }];
  assert.equal(readHarnessTransport(scenario('cold-model-resume'), root, phases).requests.length, 2);
  writeFileSync(join(root, 'recover.jsonl'), JSON.stringify(recover));
  assert.throws(() => readHarnessTransport(scenario('cold-model-resume'), root, phases), /harness_transcript_incomplete/);
});

test('raw SQLite decoding keeps checkpoint constructors inert and rejects corrupted blobs/event envelopes', t => {
  const root = temporary(t), path = join(root, 'agent.sqlite'), db = rawDatabase(path);
  const checkpoint = { messages: [constructor('ToolMessage', { name: 'grep', tool_call_id: 'read-large-source', content: 'actual text' })],
    inert: { lc: 1, type: 'constructor', id: ['node:fs', 'writeFileSync'], kwargs: { path: join(root, 'must-not-exist') } } };
  db.prepare('INSERT INTO langgraph_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)').run('c1', '', 'thread', 'json',
    Buffer.from(JSON.stringify(checkpoint)), 'json', Buffer.from('{}'));
  db.prepare('INSERT INTO langgraph_checkpoint_writes VALUES (?, ?, ?, ?, ?, ?, ?)').run('c1', '', '', 'task', 0, 'bytes', Buffer.from([0, 255]));
  const event = { type: 'run_started', runId: 'run' }, createdAt = '2026-11-15T00:00:00.000Z';
  const envelope = executionEnvelope(event, 1, createdAt), raw = JSON.stringify(envelope);
  db.prepare('INSERT INTO agent_run_events VALUES (?, ?, ?, ?, ?)').run('run', 1, raw, createdAt, Buffer.byteLength(raw));
  t.after(() => { if (db.open) db.close(); });
  const parsed = readHarnessState(path);
  assert.deepEqual(parsed.checkpoints[0].checkpoint, checkpoint);
  assert.deepEqual(parsed.writes[0].value, { encoding: 'bytes', base64: 'AP8=' });
  assert.deepEqual(parsed.runEvents[0].event, event);
  assert.equal(existsSync(join(root, 'must-not-exist')), false);
  const corrupt = structuredClone(envelope); corrupt.payload.type = 'run_completed';
  db.prepare('UPDATE agent_run_events SET event_json = ?, event_bytes = ?').run(JSON.stringify(corrupt), Buffer.byteLength(JSON.stringify(corrupt)));
  assert.throws(() => readHarnessState(path), /harness_run_event_binding_invalid/);
  db.prepare('UPDATE agent_run_events SET event_json = ?, event_bytes = ?').run(raw, Buffer.byteLength(raw));
  db.prepare('UPDATE langgraph_checkpoints SET checkpoint_blob = ?').run(Buffer.from([0xff]));
  assert.throws(() => readHarnessState(path), /encoded data/);
  db.close();
  symlinkSync(path, join(root, 'linked.sqlite'));
  assert.throws(() => readHarnessState(join(root, 'linked.sqlite')), /harness_database_not_regular/);
});

test('run events require an ordered bijection and actual startup row sequence/timestamp provenance', () => {
  const run = { id: 'run-events', thread_id: 'thread-events' }, createdAt = '2026-11-15T00:00:00.000Z';
  const events = [{ type: 'run_started', runId: run.id },
    { type: 'run_failed', runId: run.id, threadId: run.thread_id, code: 'agent_run_interrupted_on_restart' },
    { type: 'task_acceptance', runId: run.id, report: { status: 'blocked' } },
    { type: 'run_completed', runId: run.id }];
  const rows = events.map((event, i) => ({ run_id: run.id, sequence: i + 1, created_at: createdAt,
    event, envelope: executionEnvelope(event, i + 1, createdAt) }));
  const before = { runEvents: [rows[0]] }, state = { runEvents: rows };
  const live = row => [{ type: 'event-bus', event: row.event }, { type: 'event', event: row.event,
    persisted: { source: 'run-event-log', runId: run.id, sequence: row.sequence, createdAt } }];
  const traces = [live(rows[0]), [
    ...rows.slice(1, 3).map(row => ({ type: 'event', event: row.event,
      persisted: { source: 'startup-reconciliation', runId: run.id, sequence: row.sequence, createdAt } })),
    { type: 'reconciled', runId: run.id, threadId: run.thread_id, checkpointPresent: true,
      afterSequence: 1, throughSequence: 3, eventsObserved: 2, runs: [{ id: run.id, status: 'interrupted' }] },
    ...live(rows[3])
  ]];
  assert.deepEqual(harnessRunEventEvidence(state, run, traces, before), { observedBound: true, busBound: true, reconciliationBound: true });
  for (const mutate of [
    value => { value[1].splice(0, 1); },
    value => { value[1].push(structuredClone(value[1].at(-1))); },
    value => { [value[1][0], value[1][1]] = [value[1][1], value[1][0]]; }
  ]) {
    const forged = structuredClone(traces); mutate(forged);
    assert.equal(harnessRunEventEvidence(state, run, forged, before).observedBound, false);
  }
  for (const mutate of [
    value => { value[1][0].persisted.sequence = 1; },
    value => { value[1][0].persisted.createdAt = '2026-11-16T00:00:00.000Z'; },
    value => { value[1][0].persisted.source = 'invented'; },
    value => { delete value[1][0].persisted; },
    value => { value[1][2].afterSequence = 0; }
  ]) {
    const forged = structuredClone(traces); mutate(forged);
    assert.equal(harnessRunEventEvidence(state, run, forged, before).reconciliationBound, false);
  }
  const corruptedBefore = structuredClone(before); corruptedBefore.runEvents[0].envelope.payload.type = 'forged';
  assert.equal(harnessRunEventEvidence(state, run, traces, corruptedBefore).reconciliationBound, false);
});

test('actual terminal EventBus order is independently bound while persisted observations stay in SQLite order', () => {
  const run = { id: 'run-events', thread_id: 'thread-events' }, createdAt = '2026-11-15T00:00:00.000Z';
  for (const type of ['run_failed', 'run_cancelled']) {
    const events = [{ type: 'run_started', runId: run.id }, { type, runId: run.id },
      { type: 'task_acceptance', runId: run.id, report: { status: 'blocked' } }];
    const rows = events.map((event, i) => ({ run_id: run.id, sequence: i + 1, created_at: createdAt, event }));
    const persisted = row => ({ type: 'event', event: row.event,
      persisted: { source: 'run-event-log', runId: run.id, sequence: row.sequence, createdAt } });
    const bus = event => ({ type: 'event-bus', event });
    const trace = [bus(events[0]), persisted(rows[0]), bus(events[2]), persisted(rows[1]), persisted(rows[2]), bus(events[1])];
    const state = { runEvents: rows };
    assert.deepEqual(harnessRunEventEvidence(state, run, [trace]), { observedBound: true, busBound: true, reconciliationBound: true });
    for (const mutate of [
      records => { records.splice(0, 1); },
      records => { records.push(structuredClone(records[0])); },
      records => { [records[0], records[2]] = [records[2], records[0]]; },
      records => { records.at(-1).event = { type: 'run_completed', runId: run.id }; }
    ]) {
      const forged = structuredClone(trace); mutate(forged);
      assert.equal(harnessRunEventEvidence(state, run, [forged]).busBound, false);
    }
    for (const mutate of [
      records => { [records[3], records[4]] = [records[4], records[3]]; },
      records => { records[1].persisted.sequence = 9; },
      records => { records[1].persisted.createdAt = '2000-01-01T00:00:00.000Z'; },
      records => { delete records[1].persisted; }
    ]) {
      const forged = structuredClone(trace); mutate(forged);
      assert.equal(harnessRunEventEvidence(state, run, [forged]).observedBound, false);
    }
  }
});

test('memory reader inspects raw persistent values/aborting triggers and rejects namespace tampering', t => {
  const root = temporary(t), path = join(root, 'memory.sqlite'), db = new Database(path);
  t.after(() => { if (db.open) db.close(); });
  db.exec(`CREATE TABLE langgraph_store_items (namespace_key TEXT, namespace_json TEXT, key TEXT,
    value_json TEXT, created_at TEXT, updated_at TEXT)`);
  const namespace = ['roc', 'memory', 'global'], value = { content: 'durable memory before fault\n', mimeType: 'text/plain' };
  db.prepare('INSERT INTO langgraph_store_items VALUES (?, ?, ?, ?, ?, ?)').run(namespace.join('\x1f'), JSON.stringify(namespace),
    '/MEMORY.md', JSON.stringify(value), '2026-11-15', '2026-11-15');
  db.exec(`CREATE TRIGGER harness_memory_update_error BEFORE UPDATE ON langgraph_store_items
    BEGIN SELECT RAISE(ABORT, 'harness_memory_persistence_failed'); END`);
  assert.throws(() => db.exec("UPDATE langgraph_store_items SET value_json = '{}'"), /harness_memory_persistence_failed/);
  assert.deepEqual(readHarnessMemory(path).items[0].value, value);
  assert.equal(readHarnessMemory(path).triggers[0].name, 'harness_memory_update_error');
  db.exec('DROP TRIGGER harness_memory_update_error');
  db.prepare('UPDATE langgraph_store_items SET namespace_json = ?').run(JSON.stringify(['roc', 'memory', 'project']));
  assert.throws(() => readHarnessMemory(path), /harness_memory_encoding_invalid/);
});

test('MCP parser binds raw JSON-RPC discovery/calls/replies to actual peer identities', t => {
  const root = temporary(t); mkdirSync(join(root, 'worker/mcp-state'), { recursive: true });
  const rpc = (direction, value) => ({ event: 'wire', direction, pid: 123, raw: JSON.stringify({ jsonrpc: '2.0', ...value }) });
  const records = [{ event: 'started', mode: 'mcp-disconnect', pid: 123 },
    rpc('in', { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
    rpc('out', { id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } }),
    rpc('in', { method: 'notifications/initialized' }),
    rpc('in', { id: 2, method: 'tools/list' }), rpc('out', { id: 2, result: { tools: [{ name: 'probe' }] } }),
    rpc('in', { id: 3, method: 'tools/call', params: { name: 'probe', arguments: { requestId: 'disconnect-once' } } }),
    { event: 'disconnected', pid: 123, rpcId: 3, args: { requestId: 'disconnect-once' } }];
  jsonLines(root, 'worker/mcp-state/transport.jsonl', records);
  const parsed = readHarnessMcpTransport(scenario('mcp-disconnect'), root);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.discoveries[0].response.rpc.result.tools[0].name, 'probe');
  assert.ok(!parsed.wire.some(record => record.direction === 'out' && record.rpc.id === 3));
  for (const mutate of [
    values => { values[2].pid = 456; },
    values => { values[2].raw = JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} }); },
    values => { values.splice(2, 0, structuredClone(values[1])); },
    values => { values[0].mode = 'mcp-receipt-lost'; }
  ]) {
    const forged = structuredClone(records); mutate(forged);
    jsonLines(root, 'worker/mcp-state/transport.jsonl', forged);
    assert.throws(() => readHarnessMcpTransport(scenario('mcp-disconnect'), root), /harness_mcp_transport_invalid/);
  }
});

function contextFixture() {
  const source = scenario('context-compaction-crash').files['large.txt'], run = {
    id: 'run-context', thread_id: 'thread-context', snapshot: { workspace: { path: '/private/eval/workspace' } }
  };
  const content = ['/workspace/large.txt:', ...source.replace(/\n$/, '').split('\n').map((line, i) => `  ${i + 1}: ${line}`)].join('\n');
  const artifact = { id: 'artifact-1', run_id: run.id, thread_id: run.thread_id, kind: 'tool_result',
    tool_call_id: 'read-large-source', tool_name: 'grep', content, sha256: sha256(content), original_chars: content.length,
    preview: content.slice(0, 2000), workspace_hash: createHash('sha1').update(resolve(run.snapshot.workspace.path).toLowerCase()).digest('hex').slice(0, 16),
    created_at: '2026-11-15T00:00:00.000Z' };
  const original = constructor('ToolMessage', { tool_call_id: artifact.tool_call_id, name: 'grep', content });
  const locator = ['<roc_context_artifact>', `artifactId: ${artifact.id}`, `sha256: ${artifact.sha256}`,
    `originalChars: ${artifact.original_chars}`, `threadId: ${run.thread_id}`, `workspaceHash: ${artifact.workspace_hash}`,
    'expiresAt: 2027-02-13T00:00:00.000Z', 'source: grep:read-large-source',
    'retrievalHint: use read_context_artifact with artifactId, sha256, offset, and limit',
    'preview:', artifact.preview, '</roc_context_artifact>'].join('\n');
  const reference = constructor('ToolMessage', { tool_call_id: artifact.tool_call_id, name: 'grep', content: locator,
    response_metadata: { roc_context_artifact: { artifactId: artifact.id, sha256: artifact.sha256 } } });
  return { source, run, state: { artifacts: [artifact], checkpoints: [{ checkpoint: { messages: [reference] } }],
    writes: [{ value: original }] } };
}

test('context evidence requires every original source byte plus a real checkpointed hash/expiry-bound locator', () => {
  const fixture = contextFixture();
  assert.equal(harnessContextEvidence(fixture.state, fixture.run, fixture.source).originalBound, true);
  assert.equal(harnessContextEvidence(fixture.state, fixture.run, fixture.source).checkpointBound, true);
  for (const mutate of [
    state => { state.artifacts[0].content = 'forged source'; state.artifacts[0].sha256 = sha256('forged source'); },
    state => { state.artifacts[0].thread_id = 'another-thread'; },
    state => { state.artifacts[0].workspace_hash = '0'.repeat(16); },
    state => { state.writes = []; },
    state => { state.artifacts.push(structuredClone(state.artifacts[0])); }
  ]) {
    const state = structuredClone(fixture.state); mutate(state);
    assert.equal(harnessContextEvidence(state, fixture.run, fixture.source).originalBound, false);
  }
  for (const mutate of [
    reference => { reference.response_metadata.roc_context_artifact.sha256 = '0'.repeat(64); },
    reference => { reference.content = reference.content.replace('2027-02-13', '2027-02-14'); },
    reference => { reference.content = 'Artifact persisted successfully.'; }
  ]) {
    const state = structuredClone(fixture.state); mutate(state.checkpoints[0].checkpoint.messages[0].kwargs);
    assert.equal(harnessContextEvidence(state, fixture.run, fixture.source).checkpointBound, false);
  }
});

test('context UI and model artifacts are independently bound, regardless of their UUID order', () => {
  const f = contextFixture(), modelArtifact = f.state.artifacts[0];
  const uiArtifact = { ...modelArtifact, id: 'artifact-ui', created_at: '2026-11-14T23:59:59.999Z' };
  f.state.artifacts.unshift(uiArtifact);
  f.state.runEvents = [{ event: { type: 'assistant_block', runId: f.run.id, block: {
    kind: 'tool_call', callId: 'read-large-source', name: 'grep', phase: 'end',
    output: { kind: 'tool_result_artifact', artifactId: uiArtifact.id, sha256: uiArtifact.sha256,
      originalChars: uiArtifact.original_chars, preview: uiArtifact.preview, truncated: true }
  } } }];
  const evidence = harnessContextEvidence(f.state, f.run, f.source);
  assert.equal(evidence.artifact.id, modelArtifact.id);
  assert.equal(evidence.originalBound, true);
  assert.equal(evidence.checkpointBound, true);
  assert.equal(evidence.uiBound, true);
  f.state.artifacts.reverse();
  assert.equal(harnessContextEvidence(f.state, f.run, f.source).artifact.id, modelArtifact.id);
  for (const mutate of [
    state => { const row = state.artifacts.find(row => row.id === 'artifact-ui');
      row.content = 'forged'; row.sha256 = sha256(row.content); row.original_chars = row.content.length; row.preview = row.content; },
    state => { state.runEvents = []; },
    state => { state.artifacts.push({ ...state.artifacts[0], id: 'unreferenced-artifact' }); }
  ]) {
    const state = structuredClone(f.state); mutate(state);
    assert.equal(harnessContextEvidence(state, f.run, f.source).originalBound, false);
  }
  for (const mutate of [
    state => { state.runEvents[0].event.block.output.sha256 = '0'.repeat(64); },
    state => { state.runEvents[0].event.block.output.artifactId = modelArtifact.id; },
    state => { state.runEvents[0].event.block.output.preview = 'invented preview'; }
  ]) {
    const state = structuredClone(f.state); mutate(state);
    assert.equal(harnessContextEvidence(state, f.run, f.source).uiBound, false);
  }
});

function childFixture() {
  const run = { id: 'run-child', snapshot: { taskContract: { criteria: [{ id: 'read', description: 'Read the source',
    check: { kind: 'artifact_sha256', path: 'keep.txt', sha256: 'a'.repeat(64) } }] } } };
  const args = { description: 'Read /workspace/keep.txt and return only the observed contents.', subagent_type: 'general-purpose' };
  const callId = `child_${hash({ executionPath: 'main', toolCallId: 'delegate-once' })}`;
  const envelope = { schemaVersion: 1, childTaskId: callId, parentRunId: run.id, subagentType: 'general-purpose',
    taskDescription: args.description, taskDescriptionHash: hash(args.description),
    permissions: ['workspace_read', 'research_read', 'web_read'],
    acceptanceCriteria: [{ id: 'read', description: 'Read the source' }],
    artifactRefs: [{ path: 'keep.txt', sha256: 'a'.repeat(64) }], outcomeStatus: 'failed', failureCode: 'child_task_failed' };
  envelope.settlementReceipt = { schemaVersion: 1, runId: run.id, callId, tokens: 0, state: 'unknown',
    outcomeHash: null, outcome: { outcomeStatus: 'failed', failureCode: envelope.failureCode } };
  envelope.settlementReceiptHash = hash(envelope.settlementReceipt);
  const identity = { subagentId: `subagent-${run.id}-0`, parentSubagentId: null, name: 'general-purpose',
    depth: 0, path: ['general-purpose#0'], execution: 'sync', taskInput: null };
  const events = ['started', 'failed'].map((kind, i) => ({ type: 'subagent_event', runId: run.id,
    sequence: i + 1, identity, event: { kind, ...(kind === 'failed' ? { error: '503 harness_child_model_unavailable' } : {}) } }));
  return { run, requests: [{ outcome: { body: { choices: [{ message: { tool_calls: [
    { id: 'delegate-once', function: { name: 'task', arguments: JSON.stringify(args) } }
  ] } }] } } }], all: events.map(event => ({ type: 'event', event })),
    state: { checkpoints: [], writes: [], calls: [{ kind: 'child', call_id: callId, run_id: run.id, input_hash: hash({ name: 'task', args }),
      state: 'unknown', actual_tokens: 0, envelope_json: JSON.stringify(envelope) }],
    taskContracts: [{ run_id: run.id, contract: run.snapshot.taskContract }], runEvents: events.map(event => ({ event })) } };
}

test('child evidence requires the actual delegation envelope, scoped permissions and independent failure lifecycle', () => {
  const f = childFixture(), evidence = harnessSubagentEvidence(f.state, f.run, f.requests, f.all);
  assert.equal(evidence.envelopeBound, true);
  assert.equal(evidence.lifecycleBound, true);
  assert.equal(evidence.failed, true);
  for (const mutate of [
    envelope => { envelope.parentRunId = 'another-run'; },
    envelope => { envelope.permissions.push('workspace_write'); },
    envelope => { envelope.taskDescriptionHash = '0'.repeat(64); },
    envelope => { envelope.artifactRefs = []; }
  ]) {
    const state = structuredClone(f.state), envelope = JSON.parse(state.calls[0].envelope_json); mutate(envelope);
    state.calls[0].envelope_json = JSON.stringify(envelope);
    assert.equal(harnessSubagentEvidence(state, f.run, f.requests, f.all).envelopeBound, false);
  }
  const missing = structuredClone(f.state); missing.runEvents.pop();
  assert.equal(harnessSubagentEvidence(missing, f.run, f.requests, f.all).lifecycleBound, false);
  const completed = structuredClone(f.state); completed.runEvents[1].event.event.kind = 'completed';
  assert.equal(harnessSubagentEvidence(completed, f.run, f.requests, f.all).failed, false);
  const missingReceipt = structuredClone(f.state), envelope = JSON.parse(missingReceipt.calls[0].envelope_json);
  delete envelope.settlementReceipt;
  missingReceipt.calls[0].envelope_json = JSON.stringify(envelope);
  assert.equal(harnessSubagentEvidence(missingReceipt, f.run, f.requests, f.all).failed, false);
});

test('a completed child wrapper with an error requires the failed receipt and original error in the parent wire', () => {
  const f = childFixture(), content = '[ToolRuntimeError] Error: 503 harness_child_model_unavailable';
  const call = f.state.calls[0], envelope = JSON.parse(call.envelope_json);
  call.state = 'settled';
  envelope.failureCode = 'child_task_reported_error';
  envelope.outcomeHash = hash(content);
  envelope.settlementReceipt = { schemaVersion: 1, runId: f.run.id, callId: call.call_id, tokens: 0, state: 'settled',
    outcomeHash: hash(content), outcome: { outcomeStatus: 'failed', failureCode: envelope.failureCode } };
  envelope.settlementReceiptHash = hash(envelope.settlementReceipt);
  call.envelope_json = JSON.stringify(envelope);
  f.state.runEvents[1].event.event = { kind: 'completed', summary: null };
  f.all = f.state.runEvents.map(row => ({ type: 'event', event: row.event }));
  f.state.writes.push({ value: constructor('ToolMessage', { tool_call_id: 'delegate-once', name: 'task', status: 'error', content }) });
  f.requests.push({ phase: 'start', index: 2, body: { messages: [
    { role: 'tool', name: 'task', tool_call_id: 'delegate-once', content }
  ] }, outcome: {} });
  const evidence = harnessSubagentEvidence(f.state, f.run, f.requests, f.all);
  assert.equal(evidence.lifecycleBound, true);
  assert.equal(evidence.receiptBound, true);
  assert.equal(evidence.errorBound, true);
  assert.equal(evidence.failed, true);
  for (const mutate of [
    value => { value.state.writes[0].value.kwargs.status = 'success'; },
    value => { value.state.writes[0].value.kwargs.name = 'another-tool'; },
    value => { value.requests[1].body.messages[0].content = 'child input'; },
    value => { const row = value.state.calls[0], env = JSON.parse(row.envelope_json);
      env.outcomeHash = env.settlementReceipt.outcomeHash = hash('forged result');
      env.settlementReceiptHash = hash(env.settlementReceipt); row.envelope_json = JSON.stringify(env); },
    value => { const row = value.state.calls[0], env = JSON.parse(row.envelope_json);
      env.outcomeStatus = env.settlementReceipt.outcome.outcomeStatus = 'completed';
      env.settlementReceiptHash = hash(env.settlementReceipt); row.envelope_json = JSON.stringify(env); }
  ]) {
    const forged = structuredClone(f); mutate(forged);
    assert.equal(harnessSubagentEvidence(forged.state, forged.run, forged.requests, forged.all).failed, false);
  }
});

test('worker bundles production seams without any evaluator truth and the Task Spec covers exactly the catalog', async () => {
  const result = await build({ entryPoints: [join(ROOT, 'evaluation/runtime/harness-worker.ts')], bundle: true,
    write: false, packages: 'external', platform: 'node', format: 'esm', metafile: true, loader: { '.md': 'text' }, logLevel: 'silent' });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.some(path => path.endsWith('/plugins/agent/runtime.ts')));
  assert.ok(inputs.some(path => path.endsWith('/plugins/mcp/mcp-client-adapter.ts')));
  assert.ok(inputs.some(path => path.endsWith('/services/deep-agent/context/context-artifact-store.ts')));
  assert.ok(inputs.some(path => path.endsWith('/services/memory/sqlite-store.ts')));
  assert.ok(inputs.every(path => !/fixtures|evaluation\/(?:lib|adapters|graders|analysis|tests|tasks)\//.test(path)));
  const task = readFileSync(join(ROOT, 'evaluation/tasks/roc-harness/Task.md'), 'utf8');
  assert.equal((task.match(/^\| `[^`]+` \|/gm) ?? []).length, 22);
  for (const c of harnessCases) assert.ok(task.includes(`| \`${c.id}\` |`), c.id);
  assert.match(task, /13 dimensions/);
  assert.match(task, /cross-session.*unavailable|cross-session recall|not cross-session/);
});
