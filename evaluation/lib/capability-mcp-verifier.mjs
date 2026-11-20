import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { hash, sha256 } from './common.mjs';

// Host-only. Neither this module nor hidden checks enter the worker graph.
// Pass iff original public values bind to real stdio, checkpoint ToolMessages,
// production usage settlement and durable result receipts under frozen tools.
const serverId = 'evaluation-mcp', toolName = 'lookup_record';
const artifactToolName = 'read_context_artifact';
const artifactReadSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  properties: {
    artifactId: { type: 'string', minLength: 1 }, sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: 'integer', exclusiveMinimum: 0, maximum: 12000 }
  },
  required: ['artifactId', 'sha256'], additionalProperties: false
};
const environment = { schemaVersion: 1, mode: 'local-records-v1', sourceFile: 'mcp-records.json' };
const description = 'Read the original public JSON value for a key in mcp-records.json.';
const inputSchema = { type: 'object', properties: { key: { type: 'string', minLength: 1, maxLength: 128 } },
  required: ['key'], additionalProperties: false };
const outputSchema = { type: 'object', properties: { key: { type: 'string', minLength: 1, maxLength: 128 }, value: {} },
  required: ['key', 'value'], additionalProperties: false };
const remoteTool = { name: toolName, description, inputSchema, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
const discoverParameters = { _meta: {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: '@roc/mcp-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {}
} };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => hash(a) === hash(b);
const requireEvidence = (passed, code) => { if (!passed) throw new Error(code); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const id = value => typeof value === 'string' || Number.isSafeInteger(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const argsValid = args => object(args) && Object.keys(args).length === 1 && typeof args.key === 'string'
  && [...args.key].length >= 1 && [...args.key].length <= 128;
const textContent = value => {
  if (typeof value === 'string') return value;
  requireEvidence(Array.isArray(value) && value.every(block => block?.type === 'text' && typeof block.text === 'string'),
    'capability_mcp_content_invalid');
  return value.map(block => block.text).join('');
};
function schemaCanonical(value, parent) {
  if (Array.isArray(value)) {
    const entries = value.map(item => schemaCanonical(item));
    return ['required', 'enum', 'type'].includes(parent)
      ? entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : entries;
  }
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, schemaCanonical(value[key], key)])) : value;
}
const contract = Object.freeze({
  schemaVersion: 1, canonicalizationVersion: 1, serverId, remoteToolName: toolName,
  runtimeToolName: `${serverId}_${toolName}`, transport: 'stdio',
  schemaHash: sha256(JSON.stringify(schemaCanonical({ inputSchema, outputSchema }))),
  descriptionHash: sha256(description), maxInputBytes: 65536, maxOutputBytes: 131072, maxInboundMessageBytes: 1048576
});
const toolVersion = `mcp-contract-v1:${contract.schemaHash}:${contract.descriptionHash}`;
const toolKeys = ['canonicalIdentity', 'toolVersion', 'mcpContract', 'modelVisibleName', 'provenance',
  'executionScopes', 'riskLevel', 'effectClass', 'approvalPolicy', 'idempotencyStrategy', 'reconcileStrategy', 'resourceScope'];

// The host computes this from the public protocol specification, independently
// of the production compiler. It never substitutes for actual discovery.
export function bindCapabilityMcpManifest(manifest) {
  requireEvidence(object(manifest) && Array.isArray(manifest.tools), 'capability_mcp_manifest_invalid');
  const { manifestHash, ...base } = manifest;
  requireEvidence(manifestHash === sha256(JSON.stringify(base)), 'capability_mcp_manifest_hash_invalid');
  const selected = manifest.tools.filter(tool => tool.provenance?.kind === 'mcp');
  if (!selected.length) return manifest;
  requireEvidence(selected.length === 1, 'capability_mcp_manifest_tools_invalid');
  const tools = manifest.tools.map(tool => {
    if (tool.provenance?.kind !== 'mcp') return Object.fromEntries(toolKeys.filter(key => Object.hasOwn(tool, key)).map(key => [key, tool[key]]));
    requireEvidence(tool.modelVisibleName === toolName && tool.canonicalIdentity === `mcp:${serverId}:${toolName}`
      && equal(tool.provenance, { kind: 'mcp', serverId }) && equal(tool.executionScopes, ['main', 'subagent'])
      && tool.riskLevel === 'low' && tool.effectClass === 'external_call' && equal(tool.approvalPolicy, { kind: 'none' })
      && tool.idempotencyStrategy === 'tool_call' && tool.reconcileStrategy === 'manual_confirmation'
      && tool.resourceScope === 'external', 'capability_mcp_manifest_policy_invalid');
    requireEvidence(tool.mcpContract === undefined ? tool.toolVersion === 'roc-mcp-adapter-v1'
      : equal(tool.mcpContract, contract) && tool.toolVersion === toolVersion, 'capability_mcp_manifest_contract_invalid');
    const bound = { ...tool, toolVersion, mcpContract: contract };
    requireEvidence(Object.keys(bound).every(key => toolKeys.includes(key)), 'capability_mcp_manifest_tool_fields_invalid');
    return Object.fromEntries(toolKeys.filter(key => Object.hasOwn(bound, key)).map(key => [key, bound[key]]));
  });
  const normalized = Object.fromEntries(['schemaVersion', 'requestedCapabilities', 'resolvedCapabilities',
    'skippedCapabilities', 'tools', 'skills', 'mcpServers', 'untrustedContextPolicy']
    .map(key => [key, key === 'tools' ? tools : base[key]]));
  return { ...normalized, manifestHash: sha256(JSON.stringify(normalized)) };
}

function safePath(root, path) {
  requireEvidence(typeof path === 'string' && !isAbsolute(path) && !/[:\\\u0000-\u001f\u007f]/u.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..'), 'capability_mcp_path_invalid');
  let target = root;
  for (const [index, part] of path.split('/').entries()) {
    target = join(target, part);
    const stat = lstatSync(target);
    requireEvidence(!stat.isSymbolicLink() && (index === path.split('/').length - 1 || stat.isDirectory()),
      'capability_mcp_artifact_link');
  }
  requireEvidence(realpathSync(target) === target, 'capability_mcp_artifact_escape');
  return target;
}
function bytes(root, path, limit = 64 * 1024 * 1024) {
  const target = safePath(root, path), stat = lstatSync(target);
  requireEvidence(stat.isFile() && stat.nlink === 1 && stat.size <= limit, 'capability_mcp_artifact_not_regular');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd), raw = readFileSync(fd);
    requireEvidence(opened.dev === stat.dev && opened.ino === stat.ino && opened.size === stat.size
      && raw.length === stat.size, 'capability_mcp_artifact_changed');
    return raw;
  } finally { closeSync(fd); }
}
function strictJson(raw, depthLimit = 128) {
  const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const parsed = JSON.parse(text);
  let position = 0;
  const spaces = () => { while (position < text.length && /\s/u.test(text[position])) position++; };
  function string() {
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === '\\') position++;
      else if (char === '"') return JSON.parse(text.slice(start, position));
    }
    throw new Error('capability_mcp_json_string_invalid');
  }
  function scan(depth) {
    requireEvidence(depth <= depthLimit, 'capability_mcp_json_depth');
    spaces();
    if (text[position] === '{') {
      position++; spaces();
      const keys = new Set();
      if (text[position] !== '}') {
        while (true) {
          spaces(); const key = string();
          requireEvidence(!keys.has(key), 'capability_mcp_json_duplicate_key'); keys.add(key);
          spaces(); position++; scan(depth + 1); spaces();
          if (text[position] !== ',') break;
          position++;
        }
      }
      position++;
    } else if (text[position] === '[') {
      position++; spaces();
      if (text[position] !== ']') {
        while (true) { scan(depth + 1); spaces(); if (text[position] !== ',') break; position++; }
      }
      position++;
    } else if (text[position] === '"') string();
    else {
      const start = position;
      while (position < text.length && !/[\s,\]}]/u.test(text[position])) position++;
      const value = JSON.parse(text.slice(start, position));
      requireEvidence(typeof value !== 'number' || Number.isFinite(value), 'capability_mcp_json_nonfinite');
    }
  }
  scan(0); spaces();
  requireEvidence(position === text.length, 'capability_mcp_json_trailing_data');
  return parsed;
}
const json = (root, path, limit) => strictJson(bytes(root, path, limit));
function jsonl(root, path, limit, count = 8192) {
  const raw = bytes(root, path, limit), text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  requireEvidence(text.length > 0 && text.endsWith('\n'), 'capability_mcp_transport_incomplete');
  const lines = text.slice(0, -1).split('\n');
  requireEvidence(lines.length <= count && lines.every(line => line.length > 0), 'capability_mcp_transport_limit');
  return lines.map(line => strictJson(line));
}
function rootPath(directory) {
  const path = resolve(directory), stat = lstatSync(path);
  requireEvidence(stat.isDirectory() && !stat.isSymbolicLink(), 'capability_mcp_root_invalid');
  return realpathSync(path);
}
function serverConfig(manifest) {
  requireEvidence(manifest?.mcpServers?.length === 1, 'capability_mcp_server_missing');
  const server = manifest.mcpServers[0], executable = realpathSync(process.execPath);
  requireEvidence(equal(server, { id: serverId, name: 'Evaluation public records', enabled: true,
    transport: 'stdio', preset: false, riskLevel: 'low',
    command: `"${executable}" application-worker.mjs --capability-mcp-peer`, allowedTools: [toolName] })
    && equal(manifest.requestedCapabilities.mcpServers, [serverId])
    && equal(manifest.resolvedCapabilities.mcpServers, [serverId]), 'capability_mcp_server_contract_invalid');
  return executable;
}
function processGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

// Useful independently for production-client tests. This audits actual wire,
// not Runtime success; verifyCapabilityMcpEvidence adds DB/model bindings.
export function readCapabilityMcpTransport({ directory, environment: config, files, manifest, workerPid }) {
  const root = rootPath(directory), statePath = 'worker/mcp-state', evidence = [];
  requireEvidence(equal(config, environment) && typeof files?.[environment.sourceFile] === 'string',
    'capability_mcp_frozen_environment_invalid');
  const capture = (path, limit) => {
    const raw = bytes(root, path, limit);
    evidence.push({ path, bytes: raw.length, sha256: sha256(raw) });
    return raw;
  };
  requireEvidence(equal(strictJson(capture(`${statePath}/config.json`, 4096)), config), 'capability_mcp_config_changed');
  const original = capture(`${statePath}/source.json`, 32768), publicBytes = capture(`worker/workspace/${environment.sourceFile}`, 32768);
  requireEvidence(original.equals(Buffer.from(files[environment.sourceFile], 'utf8')) && original.equals(publicBytes),
    'capability_mcp_source_changed');
  const records = strictJson(original, 64);
  requireEvidence(object(records), 'capability_mcp_records_invalid');
  const sourceSha256 = sha256(original), sourceJsonHash = hash(records);
  const executable = manifest ? serverConfig(manifest) : realpathSync(process.execPath);
  const selected = manifest?.tools.some(tool => tool.provenance?.kind === 'mcp') ?? true;
  const entries = readdirSync(safePath(root, statePath)).sort();
  requireEvidence(entries.every(name => ['config.json', 'source.json'].includes(name) || name.startsWith('peer-') && uuid.test(name.slice(5))),
    'capability_mcp_state_files_invalid');
  const peerNames = entries.filter(name => name.startsWith('peer-'));
  requireEvidence(peerNames.length <= 128 && (selected ? peerNames.length > 0 : peerNames.length === 0),
    'capability_mcp_peer_selection_invalid');
  const peers = [], calls = [], pids = new Set();
  let parentPid;
  for (const name of peerNames) {
    const path = `${statePath}/${name}`, peerId = name.slice(5);
    requireEvidence(equal(readdirSync(safePath(root, path)).sort(), ['close.json', 'pid.json', 'wire.jsonl']),
      'capability_mcp_peer_files_invalid');
    const pid = strictJson(capture(`${path}/pid.json`, 4096)), closed = strictJson(capture(`${path}/close.json`, 4096));
    requireEvidence(pid.schemaVersion === 1 && pid.serverId === serverId && pid.peerId === peerId
      && positive(pid.pid) && positive(pid.parentPid) && pid.pid !== pid.parentPid && !pids.has(pid.pid)
      && (parentPid === undefined || parentPid === pid.parentPid) && (workerPid === undefined || workerPid === pid.parentPid)
      && pid.executable === executable && pid.cwd === join(root, 'worker')
      && equal(pid.argv, [join(root, 'worker/application-worker.mjs'), '--capability-mcp-peer'])
      && pid.sourceFile === environment.sourceFile && pid.sourceSha256 === sourceSha256 && pid.sourceJsonHash === sourceJsonHash,
    'capability_mcp_peer_identity_invalid');
    parentPid = pid.parentPid; pids.add(pid.pid);
    const rawWire = capture(`${path}/wire.jsonl`, 4 * 1024 * 1024);
    requireEvidence(rawWire.length > 0 && rawWire.at(-1) === 10, 'capability_mcp_wire_incomplete');
    const wire = new TextDecoder('utf-8', { fatal: true }).decode(rawWire).slice(0, -1).split('\n').map(line => strictJson(line));
    requireEvidence(wire.length <= 512 && closed.schemaVersion === 1 && closed.peerId === peerId && closed.pid === pid.pid
      && closed.clean === true, 'capability_mcp_peer_close_invalid');
    requireEvidence(['stdin-ended', 'SIGTERM'].includes(closed.reason), 'capability_mcp_peer_close_reason_invalid');
    requireEvidence(closed.messages === wire.length, 'capability_mcp_peer_close_messages_invalid');
    requireEvidence(processGone(pid.pid), 'capability_mcp_peer_still_running');
    const requests = new Map(), pending = new Map();
    let initialized = false, notified = false, discoveries = 0, peerCalls = 0, probeOnly = false;
    for (const [index, entry] of wire.entries()) {
      requireEvidence(entry.schemaVersion === 1 && entry.sequence === index + 1 && entry.peerId === peerId && entry.pid === pid.pid
        && ['in', 'out'].includes(entry.direction) && positive(entry.bytes) && entry.bytes <= 65536
        && typeof entry.rawBase64 === 'string', 'capability_mcp_wire_entry_invalid');
      const raw = Buffer.from(entry.rawBase64, 'base64');
      requireEvidence(raw.toString('base64') === entry.rawBase64 && raw.length === entry.bytes
        && sha256(raw) === entry.sha256 && raw.at(-1) === 10 && raw.subarray(0, -1).indexOf(10) === -1,
      'capability_mcp_wire_bytes_invalid');
      const message = strictJson(raw, 64);
      requireEvidence(object(message) && message.jsonrpc === '2.0', 'capability_mcp_rpc_invalid');
      if (entry.direction === 'in') {
        requireEvidence(typeof message.method === 'string', 'capability_mcp_rpc_request_invalid');
        if (!Object.hasOwn(message, 'id')) {
          requireEvidence(message.method === 'notifications/initialized' && initialized && !notified
            || message.method === 'notifications/cancelled' && initialized, 'capability_mcp_rpc_notification_invalid');
          if (message.method === 'notifications/initialized') notified = true;
          continue;
        }
        requireEvidence(id(message.id), 'capability_mcp_rpc_id_invalid');
        const identity = JSON.stringify(message.id);
        requireEvidence(!requests.has(identity), 'capability_mcp_rpc_id_duplicate');
        if (message.method === 'server/discover') {
          requireEvidence(index === 0 && requests.size === 0 && message.id === 'server-discover-probe-1'
            && equal(message.params, discoverParameters), 'capability_mcp_probe_request_invalid');
          probeOnly = true;
        } else if (message.method === 'initialize') requireEvidence(!probeOnly && !initialized && requests.size === 0
          && object(message.params) && typeof message.params.protocolVersion === 'string', 'capability_mcp_initialize_invalid');
        else requireEvidence(!probeOnly && initialized && notified && ['ping', 'tools/list', 'tools/call'].includes(message.method),
          'capability_mcp_rpc_method_invalid');
        requests.set(identity, message); pending.set(identity, { message, sequence: entry.sequence });
        continue;
      }
      requireEvidence(id(message.id) && !Object.hasOwn(message, 'method'), 'capability_mcp_rpc_reply_invalid');
      const identity = JSON.stringify(message.id), request = pending.get(identity);
      requireEvidence(request && Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error'),
        'capability_mcp_rpc_reply_unbound');
      pending.delete(identity);
      const proposal = request.message;
      if (proposal.method === 'server/discover') {
        requireEvidence(equal(message.error, { code: -32601, message: 'Method not found' }),
          'capability_mcp_probe_reply_invalid');
      } else if (proposal.method === 'initialize') {
        requireEvidence(equal(message.result, { protocolVersion: '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: serverId, version: '1.0.0' } }), 'capability_mcp_initialize_contract_invalid');
        initialized = true;
      } else if (proposal.method === 'tools/list') {
        requireEvidence(equal(message.result, { tools: [remoteTool] }), 'capability_mcp_discovery_schema_invalid');
        discoveries++;
      } else if (proposal.method === 'ping') requireEvidence(equal(message.result, {}), 'capability_mcp_ping_invalid');
      else {
        peerCalls++;
        requireEvidence(discoveries > 0 && proposal.params?.name === toolName && argsValid(proposal.params.arguments),
          'capability_mcp_call_schema_invalid');
        const args = proposal.params.arguments, key = args.key, result = message.result;
        const success = Object.hasOwn(records, key);
        if (success) {
          requireEvidence(equal(result, { isError: false, content: [{ type: 'text', text: JSON.stringify(records[key]) }],
            structuredContent: { key, value: records[key] },
            _meta: { evaluationMcp: { schemaVersion: 1, peerId, pid: pid.pid, requestId: message.id } } }),
          'capability_mcp_original_value_invalid');
        } else requireEvidence(equal(result, { isError: true,
          content: [{ type: 'text', text: 'capability_mcp_record_not_found' }] }), 'capability_mcp_remote_error_invalid');
        calls.push({ peerId, pid: pid.pid, rpcId: message.id, args, key,
          ...(success ? { value: records[key] } : {}),
          text: textContent(result.content), status: success ? 'success' : 'error',
          requestSequence: request.sequence, responseSequence: entry.sequence, wirePath: `${path}/wire.jsonl` });
      }
    }
    requireEvidence(pending.size === 0 && closed.calls === peerCalls && (probeOnly
      ? wire.length === 2 && requests.size === 1 && !initialized && !notified && discoveries === 0 && peerCalls === 0
      : initialized && notified && discoveries > 0),
      'capability_mcp_discovery_or_reply_missing');
    peers.push({ peerId, pid: pid.pid, parentPid: pid.parentPid,
      role: probeOnly ? 'negotiation-probe' : 'session', discoveries, calls: peerCalls, messages: wire.length });
  }
  const sessions = peers.filter(peer => peer.role === 'session').length;
  requireEvidence(!selected || sessions > 0 && peers.filter(peer => peer.role === 'negotiation-probe').length === sessions,
    'capability_mcp_negotiation_peer_missing');
  requireEvidence(selected || calls.length === 0, 'capability_mcp_removed_tool_called');
  return { schemaVersion: 1, sourceSha256, sourceJsonHash, contract, records, peers, calls, evidence };
}

function readState(root, path) {
  bytes(root, path);
  const db = new Database(safePath(root, path), { readonly: true, fileMustExist: true });
  try {
    requireEvidence(db.pragma('quick_check', { simple: true }) === 'ok', 'capability_mcp_database_corrupt');
    const state = {
      runs: db.prepare('SELECT * FROM agent_runs ORDER BY id').all(),
      checkpoints: db.prepare("SELECT * FROM langgraph_checkpoints WHERE checkpoint_ns='' ORDER BY checkpoint_id").all(),
      calls: db.prepare('SELECT * FROM agent_calls ORDER BY rowid').all(),
      effects: db.prepare('SELECT * FROM agent_tool_effects').all(),
      results: db.prepare('SELECT * FROM agent_tool_effect_results').all(),
      artifacts: db.prepare('SELECT * FROM context_artifacts').all()
    };
    requireEvidence(state.runs.length <= 32 && state.checkpoints.length <= 16384 && state.calls.length <= 8192
      && state.artifacts.length <= 8192,
      'capability_mcp_database_limit');
    for (const row of state.checkpoints) {
      requireEvidence(row.checkpoint_type === 'json', 'capability_mcp_checkpoint_encoding_invalid');
      row.raw = strictJson(row.checkpoint_blob);
      requireEvidence(row.raw.id === row.checkpoint_id, 'capability_mcp_checkpoint_id_invalid');
    }
    return state;
  } finally { db.close(); }
}
function isMessage(value, name) {
  return value?.lc === 1 && value.type === 'constructor' && equal(value.id, ['langchain_core', 'messages', name]) && object(value.kwargs);
}
function proposalIn(checkpoint, call) {
  return checkpoint?.raw.channel_values?.messages?.some(value => isMessage(value, 'AIMessage')
    && value.kwargs.tool_calls?.some(tool => tool.id === call.id && tool.name === (call.name ?? toolName) && equal(tool.args, call.args)));
}
function resultIn(checkpoint, callId) {
  return checkpoint?.raw.channel_values?.messages?.filter(value => isMessage(value, 'ToolMessage') && value.kwargs.tool_call_id === callId) ?? [];
}
function effectBinding(state, run, call, policy) {
  const effects = state.effects.filter(row => row.run_id === run.id && row.tool_call_id === call.id);
  requireEvidence(effects.length === 1, 'capability_mcp_effect_missing');
  const effect = effects[0], inputHash = hash({ name: toolName, args: call.args });
  const operationId = hash({ identityVersion: 1, canonicalizationVersion: 'roc-json-sort-v1', runId: run.id,
    threadId: run.thread_id, executionPath: 'main', checkpointId: effect.checkpoint_id, toolCallId: call.id,
    canonicalToolIdentity: policy.canonicalIdentity, toolVersion: policy.toolVersion, parameterHash: inputHash });
  requireEvidence(effect.thread_id === run.thread_id && effect.execution_path === 'main' && effect.tool_name === toolName
    && effect.input_hash === inputHash && effect.identity_version === 1 && effect.canonicalization_version === 'roc-json-sort-v1'
    && effect.canonical_tool_identity === policy.canonicalIdentity && effect.tool_version === policy.toolVersion
    && effect.operation_id === operationId && effect.idempotency_key === `roc-tool-effect-v1:${operationId}`
    && effect.effect_class === policy.effectClass && effect.reconcile_strategy === policy.reconcileStrategy
    && effect.receipt_json === null && effect.receipt_hash === null && positive(effect.lease_generation)
    && positive(effect.attempt_count), 'capability_mcp_effect_identity_invalid');
  const before = state.checkpoints.find(row => row.thread_id === run.thread_id && row.checkpoint_id === effect.checkpoint_id);
  const after = state.checkpoints.filter(row => row.thread_id === run.thread_id && row.parent_checkpoint_id === effect.checkpoint_id
    && resultIn(row, call.id).length > 0);
  requireEvidence(proposalIn(before, call) && resultIn(before, call.id).length === 0 && after.length === 1
    && resultIn(after[0], call.id).length === 1, 'capability_mcp_immediate_checkpoint_binding_invalid');
  const result = resultIn(after[0], call.id)[0].kwargs, text = textContent(result.content);
  requireEvidence(result.name === undefined || result.name === toolName, 'capability_mcp_result_name_invalid');
  const receipts = state.results.filter(row => row.operation_id === operationId);
  let originalText = text;
  if ((result.status ?? 'success') === 'success') {
    requireEvidence(effect.status === 'succeeded' && typeof effect.result_json === 'string' && receipts.length === 1,
      'capability_mcp_result_receipt_missing');
    const stored = strictJson(effect.result_json), row = receipts[0], receipt = strictJson(row.receipt_json);
    requireEvidence(row.receipt_hash === hash(receipt) && receipt.schemaVersion === 1 && receipt.operationId === operationId
      && receipt.inputHash === inputHash && receipt.generation === effect.lease_generation && receipt.resultHash === hash(stored)
      && receipt.providerReceiptHash === null && stored.kind === 'tool_message' && stored.toolCallId === call.id
      && stored.name === toolName && (stored.status ?? 'success') === 'success',
    'capability_mcp_result_receipt_invalid');
    originalText = textContent(stored.content);
    requireEvidence(text === originalText || state.artifacts.some(artifact =>
      artifact.tool_call_id === call.id && artifact.tool_name === toolName && artifact.content === originalText
      && text === artifactReference(artifact)), 'capability_mcp_result_receipt_invalid');
  } else requireEvidence(result.status === 'error' && ['unknown', 'failed_final', 'failed_retryable'].includes(effect.status)
    && effect.result_json === null && effect.error_json !== null && receipts.length === 0, 'capability_mcp_error_effect_invalid');
  return { effect, result, text: originalText, checkpointText: text, inputHash, operationId,
    resultHash: effect.result_json === null ? null : hash(strictJson(effect.result_json)),
    checkpointId: before.checkpoint_id, resultCheckpointId: after[0].checkpoint_id };
}
function usageBinding(row, runId, inputHash, name = toolName) {
  const envelope = strictJson(row.envelope_json), receipt = envelope.settlementReceipt;
  requireEvidence(row.run_id === runId && row.kind === 'tool' && row.input_hash === inputHash
    && envelope.inputHash === inputHash && envelope.name === name && row.state === 'settled' && row.actual_tokens === 0
    && equal(receipt, { schemaVersion: 1, runId, callId: row.call_id, tokens: 0, state: 'settled', outcomeHash: null, outcome: {} })
    && envelope.settlementReceiptHash === hash(receipt), 'capability_mcp_usage_receipt_invalid');
}

function modelRequestPurpose(row, request, response, runId) {
  const envelope = strictJson(row.envelope_json);
  requireEvidence(row.kind === 'model' && row.run_id === runId && envelope.callId === row.call_id
    && ['agent', 'summary'].includes(envelope.purpose) && Array.isArray(envelope.messages)
    && row.input_hash === hash({ purpose: envelope.purpose, messages: envelope.messages })
    && (response.purpose ?? 'agent') === envelope.purpose
    && (response.modelCallId === undefined || response.modelCallId === row.call_id),
  'capability_mcp_model_purpose_binding_invalid');
  let cursor = 0;
  for (const message of envelope.messages) {
    const role = { human: 'user', ai: 'assistant', tool: 'tool', system: 'system' }[message?.type];
    requireEvidence(role && object(message.data), 'capability_mcp_model_messages_invalid');
    if (role === 'system') continue;
    const index = request.body.messages.findIndex((observed, index) => index >= cursor && observed.role === role
      && textContent(observed.content ?? '') === textContent(message.data.content)
      && (role !== 'tool' || observed.tool_call_id === message.data.tool_call_id));
    requireEvidence(index >= 0, 'capability_mcp_model_messages_unbound');
    cursor = index + 1;
  }
  requireEvidence(envelope.messages.some(message => message.type === 'human'), 'capability_mcp_model_user_missing');
  return envelope.purpose;
}

function summaryRequest(request, proposals) {
  const tools = request.body.tools ?? [];
  return request.body.messages[0]?.role === 'system'
    && textContent(request.body.messages[0].content) === 'Summarize Roc runtime context.'
    && (tools.length === 1 && tools[0].type === 'function' && tools[0].function?.name === 'roc_context_summary'
      && proposals.every(tool => tool?.function?.name === 'roc_context_summary')
      || tools.length === 0 && request.body.response_format?.type === 'json_schema'
        && request.body.response_format.json_schema?.name === 'roc_context_summary' && proposals.length === 0);
}

function artifactExpiry(artifact) {
  const created = Date.parse(artifact.created_at);
  requireEvidence(Number.isFinite(created), 'capability_mcp_artifact_created_at_invalid');
  return new Date(created + 90 * 86400000).toISOString();
}
function artifactReference(artifact, locator = false) {
  return [
    '<roc_context_artifact>', `artifactId: ${artifact.id}`, `sha256: ${artifact.sha256}`,
    `originalChars: ${artifact.original_chars}`, `threadId: ${artifact.thread_id}`,
    `workspaceHash: ${artifact.workspace_hash ?? 'none'}`, `expiresAt: ${artifactExpiry(artifact)}`,
    `source: ${artifact.tool_name ?? artifact.kind}:${artifact.tool_call_id ?? artifact.run_id}`,
    'retrievalHint: use read_context_artifact with artifactId, sha256, offset, and limit',
    ...(locator ? [] : ['preview:', artifact.preview]), '</roc_context_artifact>'
  ].join('\n');
}
function artifactIdIn(text) {
  if (!text.startsWith('<roc_context_artifact>\n')) return null;
  const match = text.match(/^<roc_context_artifact>\nartifactId: (ctx_artifact_[a-f0-9-]+)\n/u);
  requireEvidence(match && uuid.test(match[1].slice('ctx_artifact_'.length)), 'capability_mcp_artifact_reference_invalid');
  return match[1];
}
function artifactBinding({ artifact, all, states, run, call, binding, root, trace }) {
  const owner = states.get(artifact.run_id);
  const workspace = realpathSync(safePath(root, 'worker/workspace'));
  const workspaceHash = createHash('sha1').update(workspace.toLowerCase()).digest('hex').slice(0, 16);
  requireEvidence(owner && artifact.thread_id === run.thread_id && owner.run.thread_id === run.thread_id
    && equal(artifact, owner.state.artifacts.find(row => row.id === artifact.id))
    && equal(artifact, all.artifacts.find(row => row.id === artifact.id)),
  'capability_mcp_artifact_phase_or_owner_invalid');
  for (const current of [run, owner.run]) {
    const snapshot = strictJson(current.snapshot_json);
    requireEvidence(snapshot.workspace?.path === workspace && snapshot.workspace.hash === workspaceHash
      && current.workspace_path === workspace, 'capability_mcp_artifact_workspace_invalid');
  }
  const created = Date.parse(artifact.created_at), start = Date.parse(owner.run.started_at), end = Date.parse(owner.run.ended_at);
  requireEvidence(Number.isFinite(created) && Number.isFinite(start) && Number.isFinite(end)
    && start <= created && created <= end && Date.parse(run.started_at) <= created,
  'capability_mcp_artifact_time_invalid');
  requireEvidence(artifact.kind === 'tool_result' && artifact.tool_call_id === call.id && artifact.tool_name === toolName
    && artifact.workspace_hash === workspaceHash && artifact.content === binding.text
    && artifact.sha256 === sha256(binding.text) && artifact.original_chars === binding.text.length
    && artifact.preview === binding.text.slice(0, 2000), 'capability_mcp_artifact_original_content_invalid');
  const reference = artifactReference(artifact), locator = artifactReference(artifact, true);
  // UI projection may persist a different artifact with the same original
  // bytes. Execution credit belongs to the artifact referenced by model wire
  // and backed by an actual compacted checkpoint, never to that UI projection.
  const checkpoints = owner.state.checkpoints.filter(checkpoint => checkpoint.thread_id === run.thread_id
    && resultIn(checkpoint, call.id).some(value => {
      const message = value.kwargs;
      return message.name === toolName && (message.status ?? 'success') === 'success'
        && textContent(message.content) === reference
        && equal(message.response_metadata?.roc_context_artifact, { artifactId: artifact.id, sha256: artifact.sha256 })
        && equal(message.artifact, binding.result.artifact);
    }));
  requireEvidence(checkpoints.length > 0, 'capability_mcp_artifact_checkpoint_missing');
  requireEvidence(trace.some(row => row.type === 'event' && row.event?.type === 'context_maintenance'
    && row.event.runId === owner.run.id && row.event.threadId === run.thread_id
    && row.event.event === 'context_tool_result_persisted' && row.event.stage === 'persist'
    && row.event.persistedChars === artifact.original_chars), 'capability_mcp_artifact_persistence_event_missing');
  return { artifact, owner, reference, locator, checkpointId: checkpoints[0].checkpoint_id };
}
function readArgsValid(args) {
  return object(args) && Object.keys(args).every(key => ['artifactId', 'sha256', 'offset', 'limit'].includes(key))
    && typeof args.artifactId === 'string' && args.artifactId.trim().length > 0
    && typeof args.sha256 === 'string' && /^[a-fA-F0-9]{64}$/u.test(args.sha256)
    && (args.offset === undefined || Number.isSafeInteger(args.offset) && args.offset >= 0)
    && (args.limit === undefined || positive(args.limit) && args.limit <= 12000);
}
function artifactReadBindings({ proof, firstRequest, states, all, requests, responses, purposes, manifest, run }) {
  const reads = [], artifact = proof.artifact;
  for (const request of requests.filter(row => row.index >= firstRequest && purposes.get(row.index) === 'agent')) {
    const current = states.get(request.runId ?? (states.size === 1 ? run.id : undefined));
    if (current?.run.thread_id !== run.thread_id) continue;
    const proposals = responses[request.index].body.choices[0].message.tool_calls ?? [];
    for (const proposal of proposals.filter(tool => tool.function?.name === artifactToolName)) {
      const args = strictJson(proposal.function.arguments);
      if (!readArgsValid(args) || args.artifactId.trim() !== artifact.id || args.sha256.toLowerCase() !== artifact.sha256) continue;
      requireEvidence(typeof proposal.id === 'string' && proposal.id.length > 0 && proposal.type === 'function',
        'capability_mcp_artifact_read_proposal_invalid');
      const call = { id: proposal.id, name: artifactToolName, args };
      const after = current.state.checkpoints.filter(checkpoint => {
        const before = current.state.checkpoints.find(row => row.thread_id === run.thread_id
          && row.checkpoint_id === checkpoint.parent_checkpoint_id);
        return checkpoint.thread_id === run.thread_id && resultIn(checkpoint, call.id).length === 1
          && resultIn(before, call.id).length === 0 && proposalIn(before, call);
      });
      if (after.length !== 1 || resultIn(after[0], call.id)[0].kwargs.status === 'error') continue;
      const before = current.state.checkpoints.find(row => row.thread_id === run.thread_id
        && row.checkpoint_id === after[0].parent_checkpoint_id), result = resultIn(after[0], call.id)[0].kwargs;
      const selected = manifest.tools.filter(tool => tool.modelVisibleName === artifactToolName);
      const visible = request.body.tools?.filter(tool => tool.function?.name === artifactToolName) ?? [];
      requireEvidence(selected.length === 1 && selected[0].canonicalIdentity === `builtin:${artifactToolName}`
        && equal(selected[0].provenance, { kind: 'builtin', source: 'roc' }) && selected[0].effectClass === 'none'
        && visible.length === 1 && visible[0].type === 'function' && equal(visible[0].function.parameters, artifactReadSchema),
      'capability_mcp_artifact_read_contract_invalid');
      requireEvidence(resultIn(before, call.id).length === 0 && result.name === artifactToolName
        && (result.status ?? 'success') === 'success', 'capability_mcp_artifact_read_checkpoint_invalid');
      const offset = args.offset ?? 0, limit = args.limit ?? 4000, end = Math.min(artifact.original_chars, offset + limit);
      requireEvidence(offset <= artifact.original_chars, 'capability_mcp_artifact_read_offset_invalid');
      const expected = {
        artifactId: artifact.id, sha256: artifact.sha256, kind: artifact.kind, expiresAt: artifactExpiry(artifact),
        originalChars: artifact.original_chars, offset, content: artifact.content.slice(offset, end),
        nextOffset: end >= artifact.original_chars ? null : end, complete: end >= artifact.original_chars
      };
      const text = textContent(result.content);
      requireEvidence(equal(strictJson(text), expected), 'capability_mcp_artifact_read_original_slice_invalid');
      const inputHash = hash({ name: artifactToolName, args });
      const ledger = current.state.calls.filter(row => row.run_id === current.run.id && row.kind === 'tool'
        && row.input_hash === inputHash && strictJson(row.envelope_json).name === artifactToolName);
      requireEvidence(ledger.length === 1 && equal(ledger[0], all.calls.find(row => row.run_id === current.run.id
        && row.call_id === ledger[0].call_id)), 'capability_mcp_artifact_read_usage_missing');
      usageBinding(ledger[0], current.run.id, inputHash, artifactToolName);
      const readAt = Date.parse(ledger[0].created_at), readerSnapshot = strictJson(current.run.snapshot_json);
      requireEvidence(Number.isFinite(readAt) && Date.parse(artifact.created_at) <= readAt
        && readAt < Date.parse(artifactExpiry(artifact)) && readerSnapshot.workspace?.hash === artifact.workspace_hash
        && current.run.thread_id === artifact.thread_id, 'capability_mcp_artifact_read_scope_or_expiry_invalid');
      requireEvidence(requests.some(next => next.index > request.index
        && (next.runId ?? current.run.id) === current.run.id && purposes.get(next.index) === 'agent'
        && next.body.messages.some(message => message.role === 'tool' && message.tool_call_id === call.id
          && textContent(message.content) === text)), 'capability_mcp_artifact_read_model_wire_missing');
      reads.push({ id: call.id, runId: current.run.id, requestIndex: request.index, artifactId: artifact.id,
        sha256: artifact.sha256, offset, limit, chars: expected.content.length, complete: expected.complete,
        sliceSha256: sha256(expected.content), inputHash, usageCallId: ledger[0].call_id,
        checkpointId: before.checkpoint_id, resultCheckpointId: after[0].checkpoint_id });
    }
  }
  requireEvidence(reads.length > 0, 'capability_mcp_artifact_read_missing');
  return reads;
}
function modelResultBinding({ binding, call, run, requestIndex, states, all, requests, responses, purposes, manifest, root, trace }) {
  let originalObserved = false;
  const references = new Map();
  for (const next of requests.filter(row => row.index > requestIndex && purposes.get(row.index) === 'agent')) {
    const current = states.get(next.runId ?? (states.size === 1 ? run.id : undefined));
    if (current?.run.thread_id !== run.thread_id) continue;
    for (const message of next.body.messages.filter(value => value.role === 'tool' && value.tool_call_id === call.id)) {
      const text = textContent(message.content);
      if (text === binding.text && current.run.id === run.id) {
        originalObserved = true;
        continue;
      }
      const artifactId = artifactIdIn(text);
      if (artifactId === null) continue;
      requireEvidence((binding.result.status ?? 'success') === 'success', 'capability_mcp_error_result_offloaded');
      const artifact = current.state.artifacts.find(row => row.id === artifactId);
      requireEvidence(artifact, 'capability_mcp_artifact_missing');
      const proof = artifactBinding({ artifact, all, states, run, call, binding, root, trace });
      requireEvidence(text === proof.reference || text === proof.locator, 'capability_mcp_artifact_reference_invalid');
      if (!references.has(artifactId)) references.set(artifactId, { proof, firstRequest: next.index });
    }
  }
  requireEvidence(originalObserved || references.size > 0, 'capability_mcp_result_model_wire_missing');
  const evidence = [];
  for (const { proof, firstRequest } of references.values()) {
    const reads = artifactReadBindings({ proof, firstRequest, states, all, requests, responses, purposes, manifest, run });
    evidence.push({ artifactId: proof.artifact.id, ownerRunId: proof.owner.run.id, sha256: proof.artifact.sha256,
      originalChars: proof.artifact.original_chars, referenceRequestIndex: firstRequest,
      checkpointId: proof.checkpointId, reads });
  }
  if (binding.checkpointText !== binding.text) {
    const artifactId = artifactIdIn(binding.checkpointText), artifact = states.get(run.id).state.artifacts.find(row => row.id === artifactId);
    requireEvidence(artifact, 'capability_mcp_artifact_missing');
    const proof = artifactBinding({ artifact, all, states, run, call, binding, root, trace });
    requireEvidence(binding.checkpointText === proof.reference, 'capability_mcp_artifact_reference_invalid');
  }
  return { originalObserved, artifacts: evidence };
}

export function verifyCapabilityMcpEvidence({ directory, input, manifest }) {
  const report = { schemaVersion: 1, status: 'invalid', checks: [], calls: [], schemaErrors: [], recoveries: [], evidence: [] };
  const check = (id, observed) => report.checks.push({ id, passed: true, observed, evidence: report.evidence.map(file => file.path) });
  try {
    const root = rootPath(directory), bound = bindCapabilityMcpManifest(manifest);
    requireEvidence(equal(bound, manifest), 'capability_mcp_manifest_not_bound');
    serverConfig(bound);
    const process = json(root, 'process.json', 4096), cleanup = json(root, 'cleanup.json', 4096);
    requireEvidence(positive(process.pid) && process.code === 0 && process.signal === null
      && cleanup.processGroupGone === true, 'capability_mcp_worker_cleanup_invalid');
    const transport = readCapabilityMcpTransport({ directory, environment: input.mcp, files: input.files,
      manifest: bound, workerPid: process.pid });
    report.evidence = transport.evidence;
    report.sourceSha256 = transport.sourceSha256; report.sourceJsonHash = transport.sourceJsonHash;
    report.peers = transport.peers;
    check('mcp-public-source-and-raw-transport', { peers: transport.peers.length, wireCalls: transport.calls.length });
    const trace = jsonl(root, 'transcript.jsonl'), requests = trace.filter(row => row.type === 'request'), responses = jsonl(root, 'responses.jsonl');
    requireEvidence(requests.length > 0 && requests.length === responses.length && requests.every((request, index) =>
      request.index === index && request.requestHash === hash(request.body) && Array.isArray(request.body?.messages)
      && responses[index].request === index + 1 && responses[index].requestHash === request.requestHash
      && responses[index].responseHash === hash(responses[index].body) && responses[index].body?.choices?.length === 1
      && responses[index].body.choices[0].message?.role === 'assistant'), 'capability_mcp_model_transport_invalid');
    const all = readState(root, 'worker/agent.sqlite'), states = new Map();
    const evidenceFile = path => {
      const raw = bytes(root, path);
      report.evidence.push({ path, bytes: raw.length, sha256: sha256(raw) });
      return raw;
    };
    for (const path of ['process.json', 'cleanup.json', 'transcript.jsonl', 'responses.jsonl', 'worker/agent.sqlite']) evidenceFile(path);
    if (input.session !== undefined) {
      const phases = strictJson(evidenceFile('phase-evidence.json'));
      requireEvidence(phases.schemaVersion === 2 && phases.complete === true && Array.isArray(phases.phases)
        && phases.phases.length === input.session.turns.length && phases.phases.length === all.runs.length,
      'capability_mcp_phase_count_invalid');
      for (const [index, phase] of phases.phases.entries()) {
        const turn = input.session.turns[index], path = `phases/${turn.id}/agent.sqlite`;
        requireEvidence(phase.id === turn.id && phase.index === index && phase.inputHash === hash(turn)
          && phase.artifactHashes?.['agent.sqlite'] === sha256(evidenceFile(path)) && !states.has(phase.runId),
        'capability_mcp_phase_binding_invalid');
        const state = readState(root, path), run = state.runs.find(run => run.id === phase.runId);
        requireEvidence(run && run.thread_id === phase.threadId && equal(run, all.runs.find(row => row.id === run.id))
          && requests.slice(phase.requestStart, phase.requestEnd).length > 0
          && requests.slice(phase.requestStart, phase.requestEnd).every(request => request.runId === run.id
            && request.threadId === run.thread_id && request.phaseId === turn.id && request.phaseIndex === index),
        'capability_mcp_phase_run_invalid');
        states.set(run.id, { state, run });
      }
    } else {
      requireEvidence(all.runs.length === 1, 'capability_mcp_run_count_invalid');
      states.set(all.runs[0].id, { state: all, run: all.runs[0] });
    }
    const purposes = new Map();
    for (const { state, run } of states.values()) {
      const snapshot = strictJson(run.snapshot_json);
      requireEvidence(run.status === 'completed' && snapshot.runId === run.id && snapshot.threadId === run.thread_id
        && equal(snapshot.capabilityManifest, bound) && snapshot.frozenInputs?.manifestHash === bound.manifestHash,
      'capability_mcp_frozen_run_invalid');
      const runRequests = requests.filter(request => (request.runId ?? (states.size === 1 ? run.id : undefined)) === run.id);
      const modelCalls = state.calls.filter(row => row.run_id === run.id && row.kind === 'model');
      requireEvidence(modelCalls.length === runRequests.length, 'capability_mcp_model_ledger_count_invalid');
      for (const [index, row] of modelCalls.entries()) {
        requireEvidence(equal(row, all.calls.find(value => value.run_id === row.run_id && value.call_id === row.call_id)),
          'capability_mcp_phase_model_changed');
        const request = runRequests[index];
        purposes.set(request.index, modelRequestPurpose(row, request, responses[request.index], run.id));
      }
      for (const row of state.calls.filter(row => row.run_id === run.id && row.kind === 'tool'
        && [toolName, artifactToolName].includes(strictJson(row.envelope_json).name))) {
        requireEvidence(equal(row, all.calls.find(value => value.run_id === row.run_id && value.call_id === row.call_id)),
          'capability_mcp_phase_usage_changed');
      }
      for (const row of state.effects.filter(row => row.run_id === run.id && row.tool_name === toolName)) {
        requireEvidence(equal(row, all.effects.find(value => value.run_id === row.run_id && value.tool_call_id === row.tool_call_id)),
          'capability_mcp_phase_effect_changed');
        for (const receipt of state.results.filter(value => value.operation_id === row.operation_id))
          requireEvidence(equal(receipt, all.results.find(value => value.operation_id === row.operation_id)), 'capability_mcp_phase_receipt_changed');
      }
    }
    const policy = bound.tools.find(tool => tool.provenance?.kind === 'mcp'), consumedWire = new Set(), consumedUsage = new Set(), ids = new Set();
    for (const [requestIndex, response] of responses.entries()) {
      const request = requests[requestIndex], runId = request.runId ?? (states.size === 1 ? states.keys().next().value : undefined);
      const entry = states.get(runId);
      requireEvidence(entry, 'capability_mcp_request_run_missing');
      const proposals = response.body.choices[0].message.tool_calls ?? [];
      requireEvidence(Array.isArray(proposals), 'capability_mcp_model_calls_invalid');
      const visible = request.body.tools?.filter(tool => tool?.function?.name === toolName) ?? [];
      if (purposes.get(requestIndex) === 'summary') {
        requireEvidence(visible.length === 0 && summaryRequest(request, proposals),
          'capability_mcp_summary_schema_invalid');
        continue;
      }
      requireEvidence(purposes.get(requestIndex) === 'agent', 'capability_mcp_model_purpose_missing');
      requireEvidence(policy ? visible.length === 1 && visible[0].type === 'function'
        && visible[0].function.description === description && equal(visible[0].function.parameters, inputSchema) : visible.length === 0,
      'capability_mcp_provider_schema_invalid');
      for (const proposal of proposals.filter(tool => tool.function?.name === toolName)) {
        requireEvidence(policy && typeof proposal.id === 'string' && proposal.id.length > 0 && proposal.type === 'function'
          && typeof proposal.function.arguments === 'string' && !ids.has(`${runId}:${proposal.id}`), 'capability_mcp_model_call_invalid');
        ids.add(`${runId}:${proposal.id}`);
        const call = { id: proposal.id, args: strictJson(proposal.function.arguments) };
        const binding = effectBinding(entry.state, entry.run, call, policy), status = binding.result.status ?? 'success';
        const contextEvidence = modelResultBinding({ binding, call, run: entry.run, requestIndex, states, all,
          requests, responses, purposes, manifest: bound, root, trace });
        const ledger = entry.state.calls.find(row => row.run_id === runId && row.kind === 'tool'
          && row.input_hash === binding.inputHash && strictJson(row.envelope_json).name === toolName
          && !consumedUsage.has(`${runId}:${row.call_id}`));
        requireEvidence(ledger, 'capability_mcp_usage_missing');
        usageBinding(ledger, runId, binding.inputHash); consumedUsage.add(`${runId}:${ledger.call_id}`);
        let wire = null;
        if (status === 'success') {
          const meta = binding.result.artifact?._meta?.evaluationMcp;
          requireEvidence(argsValid(call.args) && meta?.schemaVersion === 1 && id(meta.requestId), 'capability_mcp_result_correlation_missing');
          wire = transport.calls.find(row => row.peerId === meta.peerId && row.pid === meta.pid && row.rpcId === meta.requestId);
          requireEvidence(wire && wire.status === 'success' && equal(wire.args, call.args) && wire.text === binding.text
            && equal(binding.result.artifact.structuredContent, { key: wire.key, value: wire.value }),
          'capability_mcp_result_rpc_binding_invalid');
        } else if (argsValid(call.args)) {
          wire = transport.calls.find(row => row.status === 'error' && equal(row.args, call.args)
            && row.text === binding.text && !consumedWire.has(`${row.peerId}:${JSON.stringify(row.rpcId)}`));
          requireEvidence(wire, 'capability_mcp_error_wire_missing');
        } else requireEvidence(status === 'error' && !transport.calls.some(row => equal(row.args, call.args))
          && binding.result.artifact?._meta?.evaluationMcp === undefined, 'capability_mcp_schema_rejection_invalid');
        if (wire) {
          const identity = `${wire.peerId}:${JSON.stringify(wire.rpcId)}`;
          requireEvidence(!consumedWire.has(identity), 'capability_mcp_rpc_reused');
          consumedWire.add(identity);
        }
        const observed = { id: call.id, toolCallId: call.id, runId, threadId: entry.run.thread_id, requestIndex,
          name: toolName, args: call.args, key: wire?.key ?? call.args?.key ?? null,
          ...(wire?.status === 'success' ? { value: wire.value } : {}),
          text: binding.text, status, inputHash: binding.inputHash, operationId: binding.operationId,
          resultHash: binding.resultHash, checkpointId: binding.checkpointId, resultCheckpointId: binding.resultCheckpointId,
          contextEvidence,
          peerId: wire?.peerId ?? null, pid: wire?.pid ?? null, rpcId: wire?.rpcId ?? null, schemaRejected: !argsValid(call.args) };
        report.calls.push(observed);
        if (observed.schemaRejected) report.schemaErrors.push(observed);
      }
    }
    requireEvidence(consumedWire.size === transport.calls.length
      && consumedUsage.size === all.calls.filter(row => row.kind === 'tool' && strictJson(row.envelope_json).name === toolName).length
      && all.effects.filter(row => row.tool_name === toolName).length === report.calls.length
      && all.results.filter(row => all.effects.some(effect => effect.tool_name === toolName && effect.operation_id === row.operation_id))
        .length === report.calls.filter(call => call.status === 'success').length, 'capability_mcp_unbound_execution');
    for (const failure of report.schemaErrors) {
      const recovered = report.calls.find(call => call.runId === failure.runId && call.status === 'success' && call.requestIndex > failure.requestIndex);
      if (recovered) report.recoveries.push({ runId: failure.runId, errorCallId: failure.id, successCallId: recovered.id, key: recovered.key });
    }
    check('mcp-frozen-manifest-and-provider-schema', { manifestHash: bound.manifestHash, selected: Boolean(policy) });
    check('mcp-checkpoint-usage-effect-result-binding', { calls: report.calls.length, schemaErrors: report.schemaErrors.length, recoveries: report.recoveries.length });
    report.status = 'valid';
  } catch (error) {
    report.reason = String(error.message ?? error).slice(0, 320);
    report.checks.push({ id: 'mcp-evidence-integrity', passed: false, evidence: report.evidence.map(file => file.path), observed: report.reason });
  }
  return report;
}

export function evaluateCapabilityMcpChecks(checks, report) {
  requireEvidence(Array.isArray(checks), 'capability_mcp_checks_invalid');
  return checks.filter(check => check.kind === 'mcp').map(check => {
    requireEvidence(typeof check.id === 'string' && check.id.length > 0 && check.name === toolName && argsValid(check.args)
      && Number.isSafeInteger(check.min) && check.min >= 0 && Number.isSafeInteger(check.max) && check.max >= check.min
      && Object.keys(check).every(key => ['id', 'kind', 'name', 'args', 'value', 'min', 'max'].includes(key)),
    'capability_mcp_check_contract_invalid');
    const calls = report.status === 'valid' ? report.calls.filter(call => call.status === 'success'
      && call.name === toolName && call.peerId !== null && call.rpcId !== null && equal(call.args, check.args)
      && (!Object.hasOwn(check, 'value') || equal(call.value, check.value))) : [];
    return { id: check.id, passed: report.status === 'valid' && calls.length >= check.min && calls.length <= check.max,
      observed: { count: calls.length, callIds: calls.map(call => call.id), sourceJsonHash: report.sourceJsonHash ?? null },
      evidence: report.evidence.map(file => file.path) };
  });
}
