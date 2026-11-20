import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { hash, ROOT, sha256 } from '../lib/common.mjs';
import { bindCapabilityMcpManifest, evaluateCapabilityMcpChecks, readCapabilityMcpTransport,
  verifyCapabilityMcpEvidence } from '../lib/capability-mcp-verifier.mjs';
import { testArtifacts } from './test-artifacts.mjs';

// Actual production stdio/client execution, without prepareApplication,
// sourceIdentity capture, a model endpoint or paid inference.
const root = realpathSync(testArtifacts('capability-mcp'));
const environment = { schemaVersion: 1, mode: 'local-records-v1', sourceFile: 'mcp-records.json' };
const source = JSON.stringify({
  alpha: { nested: [42, false, null, { text: '原始值\n🧪', order: ['second', 'first'] }] },
  empty: null, scalar: 'cobalt-42', '🧪': { present: true }
}) + '\n';
const records = JSON.parse(source);
const executable = realpathSync(process.execPath);
const execute = promisify(execFile);
const shim = join(root, 'application-worker.mjs');
await build({
  stdin: {
    resolveDir: ROOT, sourcefile: 'capability-mcp-test-driver.ts', loader: 'ts',
    contents: `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { CapabilityRegistry } from './src/main/kernel/capability-registry';
      import { benchmarkManifest, benchmarkMode } from './evaluation/runtime/benchmark-runtime';
      import { initializeCapabilityMcp, runCapabilityMcpPeer } from './evaluation/runtime/capability-mcp';
      if (process.argv.includes('--capability-mcp-peer')) {
        const input = JSON.parse(readFileSync('driver.json', 'utf8'));
        if (input.inspectStdioEnvironment) {
          writeFileSync('stdio-env-' + process.pid + '.json', JSON.stringify({
            pid: process.pid, opensslConf: process.env.OPENSSL_CONF ?? null,
            unrelatedPresent: Object.hasOwn(process.env, 'ROC_MCP_TEST_UNRELATED')
          }) + '\\n');
        }
        await runCapabilityMcpPeer();
      } else {
        const input = JSON.parse(readFileSync('driver.json', 'utf8'));
        if (input.inspectStdioEnvironment) {
          if (input.stdioOpenSsl === null) delete process.env.OPENSSL_CONF;
          else process.env.OPENSSL_CONF = input.stdioOpenSsl;
          process.env.ROC_MCP_TEST_UNRELATED = 'synthetic-parent-only-value';
        }
        const output = { pid: process.pid, results: [] };
        let runtime;
        try {
          if (input.manifests) {
            output.manifests = input.manifests.map(item => {
              try {
                return { manifest: benchmarkManifest(item.kind, item.toolNames, item.runMode, item.mcp),
                  mode: benchmarkMode(item.kind, item.toolNames, item.runMode) };
              } catch (error) { return { error: String(error.message) }; }
            });
          } else {
            const capabilities = new CapabilityRegistry();
            output.manifest = benchmarkManifest('roc-capability', input.toolNames, 'chat', input.mcp);
            runtime = initializeCapabilityMcp({ environment: input.mcp, capabilities, root: process.cwd() });
            output.servers = runtime.servers;
            const selected = output.manifest.tools.some(tool => tool.provenance.kind === 'mcp');
            if (selected) {
              output.contracts = await runtime.mcpContractDiscoveryProvider({ manifest: output.manifest });
              const tools = await capabilities.invoke('mcp.tools.get', { runId: 'stdio-test-run',
                servers: output.manifest.mcpServers, signal: new AbortController().signal });
              const tool = tools.find(tool => tool.name === 'evaluation-mcp_lookup_record');
              if (!tool) throw new Error('production_tool_missing');
              const invoke = async action => {
                try {
                  const result = await tool.invoke({ type: 'tool_call', id: action.id,
                    name: tool.name, args: action.args });
                  return { id: action.id, status: result.status ?? 'success', name: result.name,
                    toolCallId: result.tool_call_id, content: result.content, artifact: result.artifact };
                } catch (error) { return { id: action.id, status: 'error', error: String(error.message) }; }
              };
              for (const action of input.actions ?? []) {
                if (action.parallel) output.results.push(...await Promise.all(action.parallel.map(invoke)));
                else if (action.replaceSource !== undefined) writeFileSync('workspace/mcp-records.json', action.replaceSource);
                else if (action.renameTool !== undefined) tool.name = action.renameTool;
                else output.results.push(await invoke(action));
              }
              await capabilities.invoke('mcp.tools.release', { runId: 'stdio-test-run' });
            }
          }
        } catch (error) {
          output.error = String(error.message);
          process.exitCode = 1;
        } finally {
          if (runtime) await runtime.close();
          writeFileSync('driver-output.json', JSON.stringify(output) + '\\n');
        }
      }
    `
  },
  outfile: shim, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', logLevel: 'silent'
});
let trialIndex = 0;
async function run(actions = [], options = {}) {
  const directory = join(root, `trial-${++trialIndex}`), worker = join(directory, 'worker');
  mkdirSync(join(worker, 'workspace'), { recursive: true });
  copyFileSync(shim, join(worker, 'application-worker.mjs'));
  writeFileSync(join(worker, 'workspace/mcp-records.json'), options.source ?? source);
  writeFileSync(join(worker, 'driver.json'), JSON.stringify({
    mcp: environment, toolNames: ['lookup_record'], actions, ...options
  }) + '\n');
  let exitCode = 0, stderr = '';
  try {
    const result = await execute(executable, ['application-worker.mjs'], {
      cwd: worker, timeout: 20_000, maxBuffer: 1024 * 1024
    });
    stderr = result.stderr;
  } catch (error) {
    if (!Number.isInteger(error.code) || !existsSync(join(worker, 'driver-output.json'))) throw error;
    exitCode = error.code;
    stderr = error.stderr;
  }
  const output = JSON.parse(readFileSync(join(worker, 'driver-output.json'), 'utf8'));
  return { directory, worker, output, exitCode, stderr,
    input: { mcp: environment, files: { 'mcp-records.json': options.source ?? source } } };
}
function transport(trial) {
  return readCapabilityMcpTransport({ directory: trial.directory, environment, files: trial.input.files,
    manifest: trial.output.manifest, workerPid: trial.output.pid });
}
function editJson(path, edit) {
  const raw = readFileSync(path);
  writeFileSync(path, JSON.stringify(edit(JSON.parse(raw))) + '\n');
  return () => writeFileSync(path, raw);
}
function editWire(path, edit) {
  const raw = readFileSync(path), rows = raw.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  writeFileSync(path, edit(rows).map(row => JSON.stringify(row)).join('\n') + '\n');
  return () => writeFileSync(path, raw);
}
function replaceRpc(row, edit) {
  const message = edit(JSON.parse(Buffer.from(row.rawBase64, 'base64'))), raw = Buffer.from(JSON.stringify(message) + '\n');
  return { ...row, rawBase64: raw.toString('base64'), bytes: raw.length, sha256: sha256(raw) };
}
function text(content) { return typeof content === 'string' ? content : content.map(block => block.text).join(''); }

test('real production client discovers the frozen contract and reads original nested, null and Unicode values', async () => {
  const trial = await run(['alpha', 'empty', 'scalar', '🧪'].map((key, index) => ({ id: `original-${index}`, args: { key } })));
  assert.equal(trial.exitCode, 0, JSON.stringify(trial.output));
  assert.equal(trial.output.servers[0].status, 'not_connected');
  assert.equal(trial.output.servers[0].command, `"${executable}" application-worker.mjs --capability-mcp-peer`);
  assert.deepEqual(bindCapabilityMcpManifest(trial.output.manifest), trial.output.manifest);
  assert.deepEqual(trial.output.contracts, [trial.output.manifest.tools[0].mcpContract]);
  const observed = transport(trial);
  assert.equal(observed.calls.length, 4);
  // Contract discovery and tool execution each use a real disposable modern
  // negotiation probe followed by a separate legacy session.
  assert.equal(observed.peers.length, 4);
  assert.equal(observed.peers.filter(peer => peer.role === 'session').length, 2);
  assert.equal(observed.peers.filter(peer => peer.role === 'negotiation-probe').length, 2);
  assert.equal(observed.sourceSha256, sha256(source));
  assert.equal(observed.sourceJsonHash, hash(records));
  for (const result of trial.output.results) {
    const raw = observed.calls.find(call => call.rpcId === result.artifact._meta.evaluationMcp.requestId
      && call.peerId === result.artifact._meta.evaluationMcp.peerId);
    assert.equal(result.status, 'success');
    assert.equal(result.toolCallId, result.id);
    assert.equal(text(result.content), JSON.stringify(records[raw.key]));
    assert.deepEqual(raw.value, records[raw.key]);
    assert.deepEqual(result.artifact.structuredContent, { key: raw.key, value: records[raw.key] });
  }
  assert.equal(readFileSync(join(trial.worker, 'workspace/mcp-records.json'), 'utf8'), source);
  assert.deepEqual(readdirSync(join(trial.worker, 'workspace')), ['mcp-records.json']);
  assert.ok(observed.evidence.some(file => file.path.endsWith('/wire.jsonl') && file.bytes > 0));
  assert.ok(observed.peers.every(peer => peer.parentPid === trial.output.pid));
  assert.ok(observed.peers.filter(peer => peer.role === 'session').every(peer => peer.discoveries > 0));
  assert.ok(observed.peers.filter(peer => peer.role === 'negotiation-probe')
    .every(peer => peer.discoveries === 0 && peer.calls === 0 && peer.messages === 2));
});

test('concurrent equal arguments retain distinct actual RPC IDs and client artifacts', async () => {
  const trial = await run([{ parallel: [
    { id: 'equal-a', args: { key: 'alpha' } }, { id: 'equal-b', args: { key: 'alpha' } }
  ] }]);
  assert.equal(trial.exitCode, 0);
  const observed = transport(trial);
  assert.equal(observed.calls.length, 2);
  assert.equal(new Set(observed.calls.map(call => `${call.peerId}:${call.rpcId}`)).size, 2);
  assert.deepEqual(trial.output.results.map(result => result.toolCallId), ['equal-a', 'equal-b']);
  assert.equal(new Set(trial.output.results.map(result => result.artifact._meta.evaluationMcp.requestId)).size, 2);
});

test('production schema rejection sends no tools/call and a subsequent valid call recovers on the same peer', async () => {
  const invalid = [{ key: 42 }, { key: 'alpha', extra: true }, { key: '' }, { key: 'x'.repeat(129) }];
  const trial = await run([
    ...invalid.map((args, index) => ({ id: `schema-${index}`, args })),
    { id: 'schema-recovered', args: { key: 'alpha' } },
    { id: 'remote-missing', args: { key: 'missing' } }
  ]);
  assert.equal(trial.exitCode, 0);
  for (const result of trial.output.results.slice(0, invalid.length)) {
    assert.equal(result.status, 'error');
    assert.match(result.error, /mcp_tool_input_invalid|schema/i);
    assert.equal(result.artifact, undefined);
  }
  const observed = transport(trial);
  assert.deepEqual(observed.calls.map(call => [call.key, call.status]), [['alpha', 'success'], ['missing', 'error']]);
  assert.equal(trial.output.results.at(-2).status, 'success');
  assert.equal(trial.output.results.at(-1).status, 'error');
  assert.equal(trial.output.results.at(-1).name, 'evaluation-mcp_lookup_record');
  assert.equal(trial.output.results.at(-1).toolCallId, 'remote-missing');
  assert.equal(text(trial.output.results.at(-1).content), 'capability_mcp_record_not_found');
});

test('remote error ToolMessages follow the actual model-visible tool name after production renaming', async () => {
  const trial = await run([
    { id: 'prefixed-missing', args: { key: 'missing' } }, { renameTool: 'lookup_record' },
    { id: 'renamed-missing', args: { key: 'missing' } }, { id: 'renamed-recovered', args: { key: 'alpha' } }
  ]);
  assert.equal(trial.exitCode, 0);
  assert.deepEqual(trial.output.results.map(result => [result.toolCallId, result.name, result.status]), [
    ['prefixed-missing', 'evaluation-mcp_lookup_record', 'error'], ['renamed-missing', 'lookup_record', 'error'],
    ['renamed-recovered', 'lookup_record', 'success']
  ]);
  assert.equal(text(trial.output.results[0].content), 'capability_mcp_record_not_found');
  assert.equal(text(trial.output.results[1].content), 'capability_mcp_record_not_found');
  assert.equal(transport(trial).calls.length, 3);
});

test('real Node stdio peers inherit only the explicitly empty OpenSSL config override', async () => {
  for (const config of ['/dev/null', '/synthetic/private-openssl.cnf', null]) {
    const trial = await run([{ id: 'env-record', args: { key: 'alpha' } }], {
      inspectStdioEnvironment: true, stdioOpenSsl: config
    });
    assert.equal(trial.exitCode, 0, JSON.stringify(trial.output));
    const observed = transport(trial);
    assert.equal(observed.calls.length, 1);
    const environments = readdirSync(trial.worker).filter(name => /^stdio-env-\d+\.json$/u.test(name))
      .map(name => JSON.parse(readFileSync(join(trial.worker, name), 'utf8')));
    assert.equal(environments.length, observed.peers.length);
    for (const peer of observed.peers) {
      const environment = environments.find(value => value.pid === peer.pid);
      assert.deepEqual(environment, {
        pid: peer.pid, opensslConf: config === '/dev/null' ? '/dev/null' : null, unrelatedPresent: false
      });
    }
  }
});

test('only new suite kinds allow empty subsets, with stable MCP configuration and no peer or call', async () => {
  const kinds = ['roc-capability', 'roc-e2e-research', 'roc-security'];
  const trial = await run([], { manifests: [
    ...kinds.map(kind => ({ kind, toolNames: [], runMode: 'task', mcp: environment })),
    ...['qasper', 'scienceagentbench', 'rag-paper-qa'].map(kind => ({ kind, toolNames: [] })),
    { kind: 'qasper', toolNames: ['read_file'], mcp: environment },
    { kind: 'roc-capability', toolNames: ['lookup_record', 'lookup_record'], mcp: environment },
    { kind: 'roc-capability', toolNames: ['lookup_record'] }
  ] });
  assert.equal(trial.exitCode, 0);
  for (const result of trial.output.manifests.slice(0, 3)) {
    assert.equal(result.mode, 'task'); // The existing third runMode argument survives.
    assert.deepEqual(result.manifest.tools, []);
    assert.equal(result.manifest.mcpServers[0].id, 'evaluation-mcp');
    assert.equal(result.manifest.mcpServers[0].command, `"${executable}" application-worker.mjs --capability-mcp-peer`);
    assert.deepEqual(bindCapabilityMcpManifest(result.manifest), result.manifest);
  }
  assert.deepEqual(trial.output.manifests.slice(3).map(result => result.error), [
    'benchmark_tool_subset_invalid', 'benchmark_tool_subset_invalid', 'benchmark_tool_subset_invalid',
    'benchmark_mcp_kind_invalid', 'benchmark_tool_subset_invalid', 'benchmark_tool_subset_invalid'
  ]);
  const empty = await run([], { toolNames: [] });
  assert.equal(empty.exitCode, 0);
  const observed = transport(empty);
  assert.deepEqual(observed.peers, []);
  assert.deepEqual(observed.calls, []);
  const another = await run([], { toolNames: [] });
  assert.deepEqual(empty.output.manifest, another.output.manifest);
});

test('source mutation produces a real remote error and independent transport verification fails closed', async () => {
  const trial = await run([
    { id: 'before-change', args: { key: 'scalar' } },
    { replaceSource: '{"scalar":"changed"}\n' },
    { id: 'after-change', args: { key: 'scalar' } }
  ]);
  assert.equal(trial.exitCode, 0);
  assert.equal(trial.output.results[0].status, 'success');
  assert.equal(trial.output.results[1].status, 'error');
  assert.equal(text(trial.output.results[1].content), 'capability_mcp_source_changed');
  assert.throws(() => transport(trial), /capability_mcp_source_changed/);
});

test('malformed public source and config fail initialization before a successful peer exists', async () => {
  for (const bad of ['{"alpha":1,"alpha":2}', '{"alpha":1e999}', '[]', Buffer.from([0x7b, 0xff, 0x7d])]) {
    const trial = await run([], { source: bad });
    assert.equal(trial.exitCode, 1);
    assert.match(trial.output.error, /capability_mcp_json_|capability_mcp_records_invalid|encoded data/i);
    assert.equal(existsSync(join(trial.worker, 'mcp-state')), false);
  }
  const trial = await run([], { mcp: { ...environment, sourceFile: '../private.json' } });
  assert.equal(trial.exitCode, 1);
  assert.equal(existsSync(join(trial.worker, 'mcp-state')), false);
});

test('host wire audit rejects changed bytes, RPC IDs, discovery schemas, source hashes and incomplete close evidence', async () => {
  const trial = await run([{ id: 'wire-proof', args: { key: 'alpha' } }]);
  assert.equal(trial.exitCode, 0);
  const baseline = transport(trial), wire = join(trial.directory, baseline.calls[0].wirePath);
  for (const [edit, pattern] of [
    [rows => rows.map((row, index) => index === 0 ? { ...row, sha256: '0'.repeat(64) } : row), /wire_bytes_invalid/],
    [rows => rows.map(row => row.direction === 'out' && JSON.parse(Buffer.from(row.rawBase64, 'base64')).result?.structuredContent
      ? replaceRpc(row, message => ({ ...message, id: 'unbound-id' })) : row), /rpc_reply_unbound/],
    [rows => rows.map(row => row.direction === 'out' && JSON.parse(Buffer.from(row.rawBase64, 'base64')).result?.tools
      ? replaceRpc(row, message => ({ ...message, result: { tools: [] } })) : row), /discovery_schema_invalid/],
    [rows => rows.map(row => row.direction === 'out' && JSON.parse(Buffer.from(row.rawBase64, 'base64')).result?.structuredContent
      ? replaceRpc(row, message => ({ ...message, result: { ...message.result, structuredContent: { key: 'alpha', value: 99 } } })) : row),
    /original_value_invalid/]
  ]) {
    const restore = editWire(wire, edit);
    try { assert.throws(() => transport(trial), pattern); } finally { restore(); }
  }
  const path = wire.slice(0, -'wire.jsonl'.length);
  for (const [file, edit, pattern] of [
    ['pid.json', value => ({ ...value, sourceJsonHash: '0'.repeat(64) }), /peer_identity_invalid/],
    ['close.json', value => ({ ...value, clean: false }), /peer_close_invalid/],
    ['close.json', value => ({ ...value, calls: 0 }), /discovery_or_reply_missing/]
  ]) {
    const restore = editJson(join(path, file), edit);
    try { assert.throws(() => transport(trial), pattern); } finally { restore(); }
  }
  const raw = readFileSync(wire);
  writeFileSync(wire, raw.subarray(0, -1));
  try { assert.throws(() => transport(trial), /wire_incomplete/); } finally { writeFileSync(wire, raw); }
  const probe = baseline.peers.find(peer => peer.role === 'negotiation-probe');
  const probeWire = join(trial.worker, 'mcp-state', `peer-${probe.peerId}`, 'wire.jsonl');
  for (const [edit, pattern] of [
    [rows => rows.map(row => row.direction === 'in'
      ? replaceRpc(row, message => ({ ...message, params: { _meta: {} } })) : row), /probe_request_invalid/],
    [rows => rows.map(row => row.direction === 'out'
      ? replaceRpc(row, message => ({ ...message, error: { code: -32601, message: 'pretend success' } })) : row),
    /probe_reply_invalid/]
  ]) {
    const restore = editWire(probeWire, edit);
    try { assert.throws(() => transport(trial), pattern); } finally { restore(); }
  }
  assert.equal(transport(trial).calls.length, 1);
});

// Below are explicitly unit SQLite/checkpoint fixtures layered over actual
// stdio and client results. They test verifier contracts and tamper rejection;
// they are never credited as a production AgentRuntime acceptance run.
const inputSchema = { type: 'object', properties: { key: { type: 'string', minLength: 1, maxLength: 128 } },
  required: ['key'], additionalProperties: false };
const description = 'Read the original public JSON value for a key in mcp-records.json.';
const providerTools = [{ type: 'function', function: { name: 'lookup_record', description, parameters: inputSchema } }];
function constructor(name, kwargs) {
  return { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', name], kwargs };
}
function fixture(trial, { schemaError = false, summary = false } = {}) {
  const manifest = trial.output.manifest, policy = manifest.tools[0], runId = 'unit-run', threadId = 'unit-thread';
  const wire = transport(trial), successful = trial.output.results.filter(result => result.status === 'success');
  assert.equal(successful.length, wire.calls.filter(call => call.status === 'success').length);
  const calls = [
    ...(schemaError ? [{ id: 'unit-schema-error', args: { key: 42 }, content: 'mcp_tool_input_invalid', status: 'error' }] : []),
    ...successful.map(result => ({ ...result, args: result.artifact.structuredContent
      ? { key: result.artifact.structuredContent.key } : undefined }))
  ];
  const db = new Database(join(trial.worker, 'agent.sqlite'));
  db.exec(`
    CREATE TABLE agent_runs(id TEXT, thread_id TEXT, status TEXT, snapshot_json TEXT);
    CREATE TABLE langgraph_checkpoints(thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT,
      parent_checkpoint_id TEXT, checkpoint_type TEXT, checkpoint_blob BLOB);
    CREATE TABLE agent_calls(run_id TEXT, call_id TEXT, kind TEXT, input_hash TEXT, envelope_json TEXT,
      state TEXT, actual_tokens INTEGER);
    CREATE TABLE agent_tool_effects(run_id TEXT, thread_id TEXT, tool_call_id TEXT, execution_path TEXT,
      tool_name TEXT, input_hash TEXT, identity_version INTEGER, canonicalization_version TEXT,
      canonical_tool_identity TEXT, tool_version TEXT, operation_id TEXT, idempotency_key TEXT,
      effect_class TEXT, reconcile_strategy TEXT, receipt_json TEXT, receipt_hash TEXT,
      lease_generation INTEGER, attempt_count INTEGER, checkpoint_id TEXT, status TEXT,
      result_json TEXT, error_json TEXT);
    CREATE TABLE agent_tool_effect_results(operation_id TEXT, receipt_json TEXT, receipt_hash TEXT);
    CREATE TABLE context_artifacts(id TEXT, run_id TEXT, thread_id TEXT, kind TEXT, tool_call_id TEXT,
      tool_name TEXT, sha256 TEXT, original_chars INTEGER, preview TEXT, content TEXT, workspace_hash TEXT, created_at TEXT);
  `);
  const insert = (table, value) => db.prepare(`INSERT INTO ${table} (${Object.keys(value).join(',')})
    VALUES (${Object.keys(value).map(() => '?').join(',')})`).run(...Object.values(value));
  insert('agent_runs', { id: runId, thread_id: threadId, status: 'completed', snapshot_json: JSON.stringify({
    runId, threadId, capabilityManifest: manifest, frozenInputs: { manifestHash: manifest.manifestHash }
  }) });
  const requests = [], responses = [];
  const messages = [{ role: 'user', content: 'Lookup the public records.' }];
  function model(reply, purpose = 'agent') {
    const index = requests.length, callId = `unit-model-${index}`;
    const modelMessages = messages.map(message => ({ type: { user: 'human', assistant: 'ai', tool: 'tool' }[message.role],
      data: { content: message.content ?? '', ...(message.role === 'tool' ? { tool_call_id: message.tool_call_id } : {}) } }));
    const body = { model: 'unit-controlled', messages: purpose === 'summary'
      ? [{ role: 'system', content: 'Summarize Roc runtime context.' }, ...messages] : [...messages],
    tools: purpose === 'summary'
      ? [{ type: 'function', function: { name: 'roc_context_summary', parameters: { type: 'object' } } }] : providerTools };
    const request = { type: 'request', index, runId, threadId, requestHash: hash(body), body };
    const responseBody = { choices: [{ index: 0, message: reply }], usage: { total_tokens: 10 } };
    requests.push(request);
    responses.push({ request: index + 1, runId, threadId, purpose, modelCallId: callId,
      requestHash: request.requestHash, responseHash: hash(responseBody), body: responseBody });
    insert('agent_calls', { run_id: runId, call_id: callId, kind: 'model',
      input_hash: hash({ purpose, messages: modelMessages }), state: 'settled', actual_tokens: 10,
      envelope_json: JSON.stringify({ callId, purpose, messages: modelMessages }) });
  }
  if (summary) model({ role: 'assistant', content: null, tool_calls: [{ id: 'unit-summary', type: 'function',
    function: { name: 'roc_context_summary', arguments: '{"summary":"public facts"}' } }] }, 'summary');
  for (const [index, call] of calls.entries()) {
    const args = call.args, before = `unit-before-${index}`, after = `unit-after-${index}`;
    const toolCall = { id: call.id, name: 'lookup_record', args, type: 'tool_call' };
    const proposed = { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function',
      function: { name: 'lookup_record', arguments: JSON.stringify(args) } }] };
    model(proposed); messages.push(proposed);
    const result = { tool_call_id: call.id, name: 'lookup_record', content: call.content, status: call.status,
      ...(call.artifact === undefined ? {} : { artifact: call.artifact }) };
    const ai = constructor('AIMessage', { content: '', tool_calls: [toolCall] });
    for (const [checkpointId, parent, values] of [[before, null, [ai]], [after, before, [ai, constructor('ToolMessage', result)]]]) {
      insert('langgraph_checkpoints', { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpointId,
        parent_checkpoint_id: parent, checkpoint_type: 'json',
        checkpoint_blob: Buffer.from(JSON.stringify({ id: checkpointId, channel_values: { messages: values } })) });
    }
    const inputHash = hash({ name: 'lookup_record', args });
    const operationId = hash({ identityVersion: 1, canonicalizationVersion: 'roc-json-sort-v1', runId, threadId,
      executionPath: 'main', checkpointId: before, toolCallId: call.id,
      canonicalToolIdentity: policy.canonicalIdentity, toolVersion: policy.toolVersion, parameterHash: inputHash });
    // Production durable results retain content/status/metadata. The original
    // MCP artifact remains independently observable in the real checkpoint.
    const stored = { kind: 'tool_message', toolCallId: call.id, name: 'lookup_record', content: call.content, status: call.status };
    insert('agent_tool_effects', {
      run_id: runId, thread_id: threadId, tool_call_id: call.id, execution_path: 'main', tool_name: 'lookup_record',
      input_hash: inputHash, identity_version: 1, canonicalization_version: 'roc-json-sort-v1',
      canonical_tool_identity: policy.canonicalIdentity, tool_version: policy.toolVersion, operation_id: operationId,
      idempotency_key: `roc-tool-effect-v1:${operationId}`, effect_class: policy.effectClass,
      reconcile_strategy: policy.reconcileStrategy, receipt_json: null, receipt_hash: null, lease_generation: 1,
      attempt_count: 1, checkpoint_id: before, status: call.status === 'success' ? 'succeeded' : 'unknown',
      result_json: call.status === 'success' ? JSON.stringify(stored) : null,
      error_json: call.status === 'success' ? null : JSON.stringify({ message: call.content })
    });
    if (call.status === 'success') {
      const receipt = { schemaVersion: 1, operationId, inputHash, generation: 1, resultHash: hash(stored), providerReceiptHash: null };
      insert('agent_tool_effect_results', { operation_id: operationId, receipt_json: JSON.stringify(receipt), receipt_hash: hash(receipt) });
    }
    const callId = `unit-usage-${index}`, receipt = {
      schemaVersion: 1, runId, callId, tokens: 0, state: 'settled', outcomeHash: null, outcome: {}
    };
    insert('agent_calls', { run_id: runId, call_id: callId, kind: 'tool', input_hash: inputHash,
      state: 'settled', actual_tokens: 0, envelope_json: JSON.stringify({
        name: 'lookup_record', inputHash, settlementReceipt: receipt, settlementReceiptHash: hash(receipt)
      }) });
    messages.push({ role: 'tool', tool_call_id: call.id, content: text(call.content) });
  }
  model({ role: 'assistant', content: '{"complete":true}' });
  db.close();
  writeFileSync(join(trial.directory, 'transcript.jsonl'), requests.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(trial.directory, 'responses.jsonl'), responses.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(trial.directory, 'process.json'), JSON.stringify({ pid: trial.output.pid, code: 0, signal: null }) + '\n');
  writeFileSync(join(trial.directory, 'cleanup.json'), '{"processGroupGone":true}\n');
  return () => verifyCapabilityMcpEvidence({ directory: trial.directory, input: trial.input, manifest });
}

test('unit DB fixture binds actual wire/result to durable receipts, independent summary purpose and recovery checks', async () => {
  const trial = await run([{ id: 'receipt-proof', args: { key: 'alpha' } }]);
  const verify = fixture(trial, { schemaError: true, summary: true }), report = verify();
  assert.equal(report.status, 'valid', JSON.stringify(report));
  assert.equal(report.calls.length, 2);
  assert.equal(report.schemaErrors.length, 1);
  assert.deepEqual(report.recoveries, [{
    runId: 'unit-run', errorCallId: 'unit-schema-error', successCallId: 'receipt-proof', key: 'alpha'
  }]);
  const checks = [
    { id: 'original', kind: 'mcp', name: 'lookup_record', args: { key: 'alpha' }, value: records.alpha, min: 1, max: 1 },
    { id: 'wrong', kind: 'mcp', name: 'lookup_record', args: { key: 'alpha' }, value: 42, min: 1, max: 1 }
  ];
  assert.deepEqual(evaluateCapabilityMcpChecks(checks, report).map(check => check.passed), [true, false]);
  assert.deepEqual(evaluateCapabilityMcpChecks(checks, { ...report, status: 'invalid' }).map(check => check.passed), [false, false]);
  const responses = join(trial.directory, 'responses.jsonl'), raw = readFileSync(responses);
  const edited = raw.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  edited[0].purpose = 'agent';
  writeFileSync(responses, edited.map(row => JSON.stringify(row)).join('\n') + '\n');
  try {
    assert.equal(verify().status, 'invalid');
    assert.match(verify().reason, /model_purpose_binding_invalid/);
  } finally { writeFileSync(responses, raw); }
});

test('unit DB fixture rejects missing result receipts, changed checkpoint values, forged provider receipts and RPC reuse', async () => {
  const trial = await run([{ parallel: [
    { id: 'receipt-a', args: { key: 'alpha' } }, { id: 'receipt-b', args: { key: 'alpha' } }
  ] }]);
  const verify = fixture(trial);
  const baseline = verify();
  assert.equal(baseline.status, 'valid', JSON.stringify(baseline));
  const path = join(trial.worker, 'agent.sqlite'), original = readFileSync(path);
  const sql = command => db => db.exec(command);
  const checkpoint = (db, key, edit) => {
    const row = db.prepare('SELECT checkpoint_blob FROM langgraph_checkpoints WHERE checkpoint_id=?').get(key);
    const value = edit(JSON.parse(row.checkpoint_blob));
    db.prepare('UPDATE langgraph_checkpoints SET checkpoint_blob=? WHERE checkpoint_id=?')
      .run(Buffer.from(JSON.stringify(value)), key);
  };
  const mutations = [
    [sql("DELETE FROM agent_tool_effect_results WHERE operation_id=(SELECT operation_id FROM agent_tool_effects LIMIT 1)"),
      /result_receipt_missing/],
    [sql("UPDATE agent_tool_effects SET receipt_json='{}',receipt_hash='pretend-provider'"), /effect_identity_invalid/],
    [sql("UPDATE agent_tool_effect_results SET receipt_hash='wrong'"), /result_receipt_invalid/],
    [db => checkpoint(db, 'unit-after-0', value => {
      value.channel_values.messages[1].kwargs.content = 'changed checkpoint value'; return value;
    }), /result_receipt_invalid/],
    [db => checkpoint(db, 'unit-after-0', value => {
      value.channel_values.messages[1].kwargs.artifact._meta.evaluationMcp.requestId = 'unobserved-rpc'; return value;
    }), /result_rpc_binding_invalid/],
    [db => checkpoint(db, 'unit-after-0', value => {
      value.channel_values.messages[1].kwargs.artifact = trial.output.results[1].artifact; return value;
    }), /rpc_reused/],
    [sql("UPDATE langgraph_checkpoints SET parent_checkpoint_id='unobserved' WHERE checkpoint_id='unit-after-0'"),
      /immediate_checkpoint_binding_invalid/],
    [db => {
      const row = db.prepare("SELECT envelope_json FROM agent_calls WHERE call_id='unit-usage-0'").get();
      const envelope = JSON.parse(row.envelope_json); envelope.settlementReceiptHash = 'changed';
      db.prepare("UPDATE agent_calls SET envelope_json=? WHERE call_id='unit-usage-0'").run(JSON.stringify(envelope));
    }, /usage_receipt_invalid/]
  ];
  for (const [mutate, pattern] of mutations) {
    const db = new Database(path);
    try { mutate(db); } finally { db.close(); }
    try {
      const report = verify();
      assert.equal(report.status, 'invalid');
      assert.match(report.reason, pattern);
    } finally { writeFileSync(path, original); }
  }
  assert.equal(verify().status, 'valid');
});
