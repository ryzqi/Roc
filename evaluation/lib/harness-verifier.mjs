import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { fileInventory, hash, readJson, sha256 } from './common.mjs';
import { harnessCases, selectHarnessCases } from './harness-cases.mjs';

// Independent of production code: use persisted rows, raw bytes and transport
// evidence, never runtime assertions or AgentToolEffectStore replay helpers.
function openEvidenceDatabase(path) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('harness_database_not_regular');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  if (db.pragma('quick_check', { simple: true }) !== 'ok') {
    db.close();
    throw new Error('harness_database_corrupt');
  }
  return db;
}
function decodedBlob(type, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 32 * 1024 * 1024) throw new Error('harness_checkpoint_encoding_invalid');
  if (type === 'bytes') return { encoding: 'bytes', base64: Buffer.from(bytes).toString('base64') };
  if (type !== 'json') throw new Error('harness_checkpoint_encoding_invalid');
  // Serialized LangChain constructors are data. Never load/revive their IDs.
  return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
}
function runEvent(row) {
  const envelope = JSON.parse(row.event_json), event = envelope.payload;
  const payloadHash = sha256(JSON.stringify(event));
  const eventId = sha256(JSON.stringify([envelope.streamId, envelope.sequence, envelope.eventType, envelope.actor,
    envelope.correlationId, envelope.causationId, envelope.projectId, envelope.taskId, envelope.runId, payloadHash, envelope.createdAt]));
  if (envelope.schemaVersion !== 1 || envelope.payloadRef !== null
    || envelope.payloadHash !== payloadHash || envelope.eventId !== eventId
    || envelope.streamId !== `chat:${row.run_id}` || envelope.runId !== row.run_id
    || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || envelope.sequence !== row.sequence
    || envelope.createdAt !== row.created_at || envelope.correlationId !== row.run_id
    || envelope.actor?.kind !== 'main' || envelope.actor.id !== 'agent-runtime' || envelope.causationId !== null
    || Buffer.byteLength(row.event_json) !== row.event_bytes || row.event_bytes > 1024 * 1024
    || !Number.isFinite(Date.parse(envelope.createdAt))
    || !event || event.runId !== row.run_id || envelope.eventType !== event.type) {
    throw new Error('harness_run_event_binding_invalid');
  }
  return { ...row, envelope, event };
}
export function readHarnessState(path) {
  const db = openEvidenceDatabase(path);
  try {
    const runs = db.prepare('SELECT id, thread_id, status, user_input, snapshot_json FROM agent_runs ORDER BY id').all()
      .map(row => ({ ...row, snapshot: JSON.parse(row.snapshot_json) }));
    const checkpoints = db.prepare('SELECT * FROM langgraph_checkpoints ORDER BY checkpoint_id, checkpoint_ns').all()
      .map(({ checkpoint_blob, metadata_blob, ...row }) => ({ ...row,
        checkpoint: decodedBlob(row.checkpoint_type, checkpoint_blob),
        metadata: decodedBlob(row.metadata_type, metadata_blob),
        checkpointHash: sha256(checkpoint_blob), metadataHash: sha256(metadata_blob) }));
    const writes = db.prepare('SELECT * FROM langgraph_checkpoint_writes ORDER BY checkpoint_id, checkpoint_ns, task_path, task_id, idx').all()
      .map(({ value_blob, ...row }) => ({ ...row, value: decodedBlob(row.value_type, value_blob), valueHash: sha256(value_blob) }));
    return { runs, checkpoints, writes,
      calls: db.prepare('SELECT * FROM agent_calls ORDER BY call_id').all(),
      effects: db.prepare('SELECT * FROM agent_tool_effects ORDER BY tool_call_id').all(),
      resultReceipts: db.prepare('SELECT * FROM agent_tool_effect_results ORDER BY operation_id').all(),
      approvals: db.prepare('SELECT * FROM agent_execution_approvals ORDER BY approval_reference').all(),
      grants: db.prepare('SELECT * FROM agent_execution_grants ORDER BY id').all(),
      artifacts: db.prepare('SELECT * FROM context_artifacts ORDER BY id').all(),
      taskContracts: db.prepare('SELECT * FROM agent_task_contracts ORDER BY run_id').all()
        .map(row => ({ ...row, contract: JSON.parse(row.contract_json) })),
      interrupts: db.prepare('SELECT * FROM agent_pending_interrupts ORDER BY position').all(),
      runEvents: db.prepare('SELECT * FROM agent_run_events ORDER BY run_id, sequence').all().map(runEvent),
      taskEvents: db.prepare('SELECT * FROM agent_events ORDER BY sequence, id').all()
        .map(row => ({ ...row, payload: JSON.parse(row.payload_json) })) };
  } finally { db.close(); }
}
export function readHarnessMemory(path) {
  const db = openEvidenceDatabase(path);
  try {
    const items = db.prepare('SELECT * FROM langgraph_store_items ORDER BY namespace_key, key').all()
      .map(row => ({ ...row, namespace: JSON.parse(row.namespace_json), value: JSON.parse(row.value_json) }));
    if (items.some(row => !Array.isArray(row.namespace) || !row.namespace.length
      || row.namespace.some(label => typeof label !== 'string' || !label || label.includes('\x1f'))
      || row.namespace_key !== row.namespace.join('\x1f') || typeof row.key !== 'string' || !row.key
      || !row.value || typeof row.value !== 'object' || Array.isArray(row.value))) throw new Error('harness_memory_encoding_invalid');
    return {
      items,
      triggers: db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()
    };
  } finally { db.close(); }
}
function readRecoveryPoints(path) {
  const db = openEvidenceDatabase(path);
  try {
    return db.prepare('SELECT * FROM recovery_points ORDER BY id').all();
  } finally { db.close(); }
}
function transcript(path, typed = true) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || statSync(path).size > 32 * 1024 * 1024) {
    throw new Error('harness_transcript_not_regular_or_bounded');
  }
  const text = new TextDecoder('utf8', { fatal: true }).decode(readFileSync(path));
  if (!text.endsWith('\n') || !text.trim()) throw new Error('harness_transcript_incomplete');
  const values = text.trim().split('\n').map(JSON.parse);
  if (values.some(v => !v || typeof v !== 'object' || Array.isArray(v)
    || (typed && typeof v.type !== 'string'))) throw new Error('harness_transcript_invalid');
  return values;
}
function scheduledAction(scenario, phase, index) {
  if (phase !== 'start') return null;
  if (scenario.fault === 'model-pending' && index === 0) return { action: 'interrupt', reason: 'controlled_request_interrupted' };
  if (scenario.requestBudget !== undefined && index >= scenario.requestBudget) return { action: 'cancel', reason: 'budget_max_model_requests' };
  if (scenario.cancel || scenario.cancelAtRequest === index) return { action: 'cancel', reason: 'controlled_request_cancelled' };
  if (scenario.modelErrorAtRequest === index) return { action: 'transport-error', reason: 'harness_child_model_unavailable', status: 503 };
  return null;
}
export function readHarnessTransport(scenario, path, phases) {
  if (!Array.isArray(phases) || phases.length !== (scenario.recover ? 2 : 1)
    || phases.some((phase, i) => phase.phase !== (i === 0 ? 'start' : 'recover')
      || !Number.isSafeInteger(phase.requests) || phase.requests < 0 || phase.requests > 12)) {
    throw new Error('harness_phase_evidence_missing');
  }
  const traces = [], responses = [], actions = [], requests = [], identities = new Set(), trialIds = new Set();
  for (const phase of phases) {
    const trace = transcript(join(path, `${phase.phase}.jsonl`)), calls = trace.filter(v => v.type === 'request');
    const responsePath = join(path, `${phase.phase}.responses.jsonl`), actionPath = join(path, `${phase.phase}.actions.jsonl`);
    const replies = existsSync(responsePath) ? transcript(responsePath, false) : [];
    const controls = existsSync(actionPath) ? transcript(actionPath, false) : [];
    if (phase.requests !== calls.length || calls.some((call, i) => call.index !== i || !Array.isArray(call.body?.messages))
      || replies.some((reply, i) => !Number.isSafeInteger(reply.request) || i > 0 && replies[i - 1].request >= reply.request)
      || controls.some((control, i) => !Number.isSafeInteger(control.request) || i > 0 && controls[i - 1].request >= control.request)
      || replies.length + controls.length !== calls.length) throw new Error('harness_transport_evidence_inconsistent');
    for (const [index, call] of calls.entries()) {
      const matching = [...replies, ...controls].filter(outcome => outcome.request === index);
      const outcome = matching[0], scheduled = scheduledAction(scenario, phase.phase, index);
      const invalidBinding = matching.length !== 1 || !outcome || typeof outcome.trialId !== 'string' || !outcome.trialId
        || typeof outcome.requestId !== 'string' || !/^controlled-.+-(?:start|recover)-[1-9][0-9]*$/.test(outcome.requestId)
        || !outcome.requestId.endsWith(`-${phase.phase}-${index + 1}`)
        || identities.has(outcome.requestId) || outcome.requestHash !== hash(call.body)
        || typeof call.body.model !== 'string';
      const invalidOutcome = !outcome || (scheduled
        ? Object.entries(scheduled).some(([key, value]) => outcome[key] !== value) || Object.hasOwn(outcome, 'body')
        : Object.hasOwn(outcome, 'action') || !Array.isArray(outcome.body?.choices) || outcome.body.choices.length !== 1
          || outcome.body.model !== call.body.model);
      if (invalidBinding || invalidOutcome) {
        throw new Error('harness_transport_evidence_inconsistent');
      }
      identities.add(outcome.requestId);
      trialIds.add(outcome.trialId);
      requests.push({ ...call, phase: phase.phase, outcome });
    }
    traces.push(trace);
    responses.push(...replies.map(reply => ({ ...reply, phase: phase.phase })));
    actions.push(...controls.map(control => ({ ...control, phase: phase.phase })));
  }
  if (trialIds.size !== 1) throw new Error('harness_transport_trial_binding_invalid');
  return { traces, requests, responses, actions };
}
function messageRecords(value, kind) {
  const found = [];
  const visit = node => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (!node || typeof node !== 'object') return;
    if (node.lc === 1 && node.type === 'constructor' && Array.isArray(node.id) && node.id.at(-1) === kind
      && node.kwargs && typeof node.kwargs === 'object') found.push(node.kwargs);
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return found;
}
function stateMessages(state, kind = 'ToolMessage') {
  return [...state.checkpoints.flatMap(row => messageRecords(row.checkpoint, kind)),
    ...state.writes.flatMap(row => messageRecords(row.value, kind))];
}
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
  return '';
}
function toolEvidence(state, all, callId) {
  const messages = stateMessages(state).filter(message => message.tool_call_id === callId);
  const effects = state.effects.filter(effect => effect.tool_call_id === callId);
  const events = all.filter(record => record.type === 'event' && record.event?.type === 'assistant_block'
    && record.event.block?.kind === 'tool_call' && record.event.block.callId === callId).map(record => record.event.block);
  return { messages, effects, events };
}
function failedTool(state, all, callId, pattern) {
  const evidence = toolEvidence(state, all, callId);
  return evidence.messages.some(message => pattern.test(contentText(message.content)))
    || evidence.effects.some(effect => [effect.error_json, effect.result_json].some(value => value !== null && pattern.test(value)))
    || evidence.events.some(event => event.phase === 'error' && pattern.test(JSON.stringify(event.error))
      || event.phase === 'end' && pattern.test(JSON.stringify(event.output)));
}
function publishedWrites(state) {
  return state.effects.filter(effect => effect.receipt_json !== null).filter(effect => {
    const receipt = JSON.parse(effect.receipt_json);
    return receipt.kind === 'workspace_write' && receipt.phase === 'durable';
  });
}
function inventory(files) {
  return Object.entries(files).map(([name, text]) => ({ path: name, bytes: Buffer.byteLength(text), sha256: sha256(text) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
function workspaceObservation(path) {
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('harness_workspace_not_regular');
  const actual = statSync(path);
  return { path: realpathSync(path), dev: String(actual.dev), ino: String(actual.ino), mode: actual.mode & 0o777,
    files: fileInventory(path) };
}
function readObservedSource(content, source) {
  const text = contentText(content);
  const match = /^@@ lines (\d+)-(\d+) of (\d+) @@\n([\s\S]*)$/.exec(text);
  const raw = source.endsWith('\n') ? source.slice(0, -1) : source;
  return match !== null && Number(match[1]) === 1 && Number(match[2]) === raw.split('\n').length
    && Number(match[3]) === raw.split('\n').length && match[4] === raw;
}
function sourceRead(state, requests, callId, source) {
  return stateMessages(state).some(message => message.tool_call_id === callId && readObservedSource(message.content, source))
    && requests.some(request => request.body.messages.some(message =>
      message.role === 'tool' && message.tool_call_id === callId && readObservedSource(message.content, source)));
}
export function readHarnessMcpTransport(scenario, path) {
  const records = transcript(join(path, 'worker/mcp-state/transport.jsonl'), false);
  const peers = new Set(), outstanding = new Map(), wire = [];
  for (const record of records) {
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('harness_mcp_transport_invalid');
    if (record.event === 'started') {
      if (peers.has(record.pid) || record.mode !== scenario.fault) throw new Error('harness_mcp_transport_invalid');
      peers.add(record.pid);
      continue;
    }
    if (!peers.has(record.pid)) throw new Error('harness_mcp_transport_invalid');
    if (record.event === 'wire') {
      if (!['in', 'out'].includes(record.direction) || typeof record.raw !== 'string') throw new Error('harness_mcp_transport_invalid');
      const rpc = JSON.parse(record.raw);
      if (!rpc || rpc.jsonrpc !== '2.0') throw new Error('harness_mcp_transport_invalid');
      const key = JSON.stringify([record.pid, rpc.id]);
      if (record.direction === 'in') {
        if (typeof rpc.method !== 'string' || !rpc.method) throw new Error('harness_mcp_transport_invalid');
        if (rpc.id !== undefined) {
          if (!['string', 'number'].includes(typeof rpc.id) || outstanding.has(key)) throw new Error('harness_mcp_transport_invalid');
          outstanding.set(key, rpc);
        }
      } else {
        const request = outstanding.get(key);
        if (!request || rpc.method !== undefined || !Object.hasOwn(rpc, 'result') || Object.hasOwn(rpc, 'error')) {
          throw new Error('harness_mcp_transport_invalid');
        }
        outstanding.delete(key);
      }
      wire.push({ ...record, rpc });
    } else if (!['effect-committed', 'disconnected'].includes(record.event)) throw new Error('harness_mcp_transport_invalid');
  }
  const calls = wire.filter(record => record.direction === 'in' && record.rpc.method === 'tools/call');
  const discoveries = wire.filter(record => record.direction === 'in' && record.rpc.method === 'tools/list')
    .map(record => ({ request: record, response: wire.find(reply => reply.pid === record.pid
      && reply.direction === 'out' && reply.rpc.id === record.rpc.id) }));
  return { records, wire, peers: [...peers], calls, discoveries };
}
export function harnessRunEventEvidence(state, run, traces, before = null) {
  const observed = traces.flatMap((trace, phase) => trace.filter(record => record.type === 'event')
    .map(record => ({ ...record, phase })));
  const rows = state.runEvents;
  const observedBound = rows.length > 0 && rows.length === observed.length && rows.every((row, i) =>
    row.run_id === run.id && row.sequence === i + 1 && hash(row.event) === hash(observed[i].event)
    && ['run-event-log', 'startup-reconciliation'].includes(observed[i].persisted?.source)
    && observed[i].persisted.runId === run.id && observed[i].persisted.sequence === row.sequence
    && observed[i].persisted.createdAt === row.created_at);
  const persisted = observed.filter(record => record.persisted?.source === 'startup-reconciliation');
  const notifications = traces.flatMap((trace, phase) => trace.filter(record => record.type === 'event-bus')
    .map(record => ({ ...record, phase })));
  const expectedNotifications = observed.filter(record => record.persisted?.source === 'run-event-log');
  // The production terminal transaction persists run_failed/run_cancelled
  // first. Its publisher then emits task_acceptance before that terminal
  // notification. Preserve and verify this concrete notification schedule;
  // the separate persisted stream must still match every raw row in order.
  for (let i = 0; i + 1 < expectedNotifications.length; i++) {
    const terminal = expectedNotifications[i], acceptance = expectedNotifications[i + 1];
    if (['run_failed', 'run_cancelled'].includes(terminal.event.type) && acceptance.event.type === 'task_acceptance'
      && terminal.phase === acceptance.phase && terminal.persisted.sequence + 1 === acceptance.persisted.sequence) {
      [expectedNotifications[i], expectedNotifications[i + 1]] = [acceptance, terminal];
      i++;
    }
  }
  const busBound = notifications.length === expectedNotifications.length && notifications.every((record, i) =>
    record.phase === expectedNotifications[i].phase && hash(record.event) === hash(expectedNotifications[i].event));
  const reconciled = traces.flatMap(trace => trace.filter(record => record.type === 'reconciled'));
  if (!before) return { observedBound, busBound, reconciliationBound: persisted.length === 0 && reconciled.length === 0 };
  const afterSequence = before.runEvents.at(-1)?.sequence;
  const recoveryEvents = observed.filter(record => record.phase === 1);
  const boundary = reconciled[0];
  const reconciliationBound = before.runEvents.length > 0 && traces.length === 2 && reconciled.length === 1
    && before.runEvents.every((row, i) => rows[i] && hash(row.envelope) === hash(rows[i].envelope))
    && boundary.runId === run.id && boundary.threadId === run.thread_id && boundary.checkpointPresent === true
    && boundary.afterSequence === afterSequence && boundary.throughSequence === afterSequence + 2
    && boundary.eventsObserved === 2 && Array.isArray(boundary.runs) && boundary.runs.length === 1
    && boundary.runs[0].id === run.id && boundary.runs[0].status === 'interrupted'
    && persisted.length === 2 && persisted.every((record, i) => {
      const row = rows[afterSequence + i], binding = record.persisted;
      return record.phase === 1 && hash(record.event) === hash(recoveryEvents[i]?.event)
        && binding?.source === 'startup-reconciliation' && binding.runId === run.id
        && binding.sequence === afterSequence + i + 1 && binding.sequence === row?.sequence
        && binding.createdAt === row?.created_at;
    })
    && persisted[0]?.event.type === 'run_failed'
    && persisted[0].event.threadId === run.thread_id
    && /^agent_run_interrupted_on_restart(?:_effect_unknown)?$/.test(persisted[0].event.code)
    && persisted[1]?.event.type === 'task_acceptance' && persisted[1].event.report?.status === 'blocked'
    && traces[1].findIndex(record => record.type === 'reconciled')
      > traces[1].findLastIndex(record => record.persisted?.source === 'startup-reconciliation');
  return { observedBound, busBound, reconciliationBound };
}
export function harnessContextEvidence(state, run, source) {
  const originals = stateMessages(state).filter(message => message.tool_call_id === 'read-large-source'
    && !message.response_metadata?.roc_context_artifact);
  const references = state.checkpoints.flatMap(row => messageRecords(row.checkpoint, 'ToolMessage'))
    .filter(message => message.tool_call_id === 'read-large-source' && message.response_metadata?.roc_context_artifact);
  const modelIds = new Set(references.map(message => message.response_metadata.roc_context_artifact.artifactId));
  // UI projection and model offload save separate artifacts. Resolve the
  // model artifact from its persisted checkpoint, never random UUID order.
  const artifact = modelIds.size === 1 ? state.artifacts.find(row => row.id === [...modelIds][0]) : null;
  if (!artifact) return { artifact: null, originalBound: false, checkpointBound: false, uiBound: false };
  const uiEvents = (state.runEvents ?? []).filter(row => row.event.type === 'assistant_block'
    && row.event.block?.kind === 'tool_call' && row.event.block.callId === 'read-large-source'
    && row.event.block.phase === 'end').map(row => row.event);
  const referencedIds = new Set([...modelIds, ...uiEvents.map(event => event.block.output?.artifactId)]);
  const lines = source.replace(/\n$/, '').split('\n');
  // Production grep "content" format retains each raw line and its line number.
  // Match the full source, rather than merely finding a magic reference string.
  const expectedContent = ['/workspace/large.txt:', ...lines.map((line, i) => `  ${i + 1}: ${line}`)].join('\n');
  const workspaceHash = createHash('sha1').update(resolve(run.snapshot.workspace.path).toLowerCase()).digest('hex').slice(0, 16);
  const originalBound = state.artifacts.length === referencedIds.size
    && new Set(state.artifacts.map(row => row.id)).size === state.artifacts.length
    && state.artifacts.every(row => referencedIds.has(row.id) && row.run_id === run.id && row.thread_id === run.thread_id
      && row.tool_call_id === 'read-large-source' && row.kind === 'tool_result' && row.tool_name === 'grep'
      && row.workspace_hash === workspaceHash && sha256(row.content) === row.sha256
      && row.content.length === row.original_chars && row.original_chars > 30000
      && row.preview === row.content.slice(0, 2000) && row.content === expectedContent
      && Number.isFinite(Date.parse(row.created_at)))
    && originals.length > 0 && originals.every(message => message.name === 'grep' && message.status !== 'error'
      && typeof message.content === 'string' && message.content === expectedContent);
  const expiry = Date.parse(artifact.created_at) + 90 * 86400000;
  const referenceContent = Number.isFinite(expiry) ? ['<roc_context_artifact>', `artifactId: ${artifact.id}`, `sha256: ${artifact.sha256}`,
    `originalChars: ${artifact.original_chars}`, `threadId: ${run.thread_id}`, `workspaceHash: ${workspaceHash}`,
    `expiresAt: ${new Date(expiry).toISOString()}`, 'source: grep:read-large-source',
    'retrievalHint: use read_context_artifact with artifactId, sha256, offset, and limit',
    'preview:', artifact.preview, '</roc_context_artifact>'].join('\n') : null;
  const checkpointBound = references.length > 0 && references.every(message => {
    const reference = message.response_metadata.roc_context_artifact;
    return message.name === 'grep' && reference.artifactId === artifact.id
      && message.status !== 'error' && reference.sha256 === artifact.sha256
      && contentText(message.content) === referenceContent;
  });
  const uiBound = uiEvents.length === 1 && state.artifacts.length === 2 && uiEvents.every(event => {
    const output = event.block.output, uiArtifact = state.artifacts.find(row => row.id === output?.artifactId);
    return event.runId === run.id && event.block.name === 'grep' && output?.kind === 'tool_result_artifact'
      && uiArtifact && uiArtifact.id !== artifact.id && output.sha256 === uiArtifact.sha256
      && output.originalChars === uiArtifact.original_chars && output.preview === uiArtifact.preview && output.truncated === true;
  });
  return { artifact, originalBound, checkpointBound, uiBound, referenceContent };
}
export function harnessSubagentEvidence(state, run, requests, all) {
  const children = state.calls.filter(call => call.kind === 'child');
  const proposal = requests.flatMap(request => request.outcome.body?.choices ?? [])
    .flatMap(choice => choice.message?.tool_calls ?? []).find(call => call.id === 'delegate-once');
  const events = state.runEvents.filter(row => row.event.type === 'subagent_event').map(row => row.event);
  const observed = all.filter(record => record.type === 'event' && record.event?.type === 'subagent_event').map(record => record.event);
  const contract = state.taskContracts.find(row => row.run_id === run.id)?.contract;
  if (!proposal || proposal.function.name !== 'task' || children.length !== 1 || !contract) {
    return { children, events, envelopeBound: false, lifecycleBound: false, failed: false };
  }
  const args = JSON.parse(proposal.function.arguments), child = children[0], envelope = JSON.parse(child.envelope_json);
  const criteria = (contract.criteria ?? []).map(criterion => ({ id: criterion.id, description: criterion.description }));
  const artifactRefs = (contract.criteria ?? []).flatMap(criterion => criterion.check.kind === 'artifact_sha256'
    ? [{ path: criterion.check.path, sha256: criterion.check.sha256 }] : []);
  const envelopeBound = child.call_id === `child_${hash({ executionPath: 'main', toolCallId: proposal.id })}`
    && child.run_id === run.id && child.input_hash === hash({ name: 'task', args })
    && envelope.schemaVersion === 1 && envelope.childTaskId === child.call_id && envelope.parentRunId === run.id
    && envelope.subagentType === args.subagent_type && envelope.subagentType === 'general-purpose'
    && envelope.taskDescription === args.description && envelope.taskDescriptionHash === hash(args.description)
    && hash(envelope.permissions) === hash(['workspace_read', 'research_read', 'web_read'])
    && hash(envelope.acceptanceCriteria) === hash(criteria) && hash(envelope.artifactRefs) === hash(artifactRefs)
    && hash(contract) === hash(run.snapshot.taskContract);
  const started = events.filter(event => event.event.kind === 'started');
  const lifecycleBound = started.length === 1 && events[0] === started[0] && events.length === observed.length
    && events.every((event, i) => hash(event) === hash(observed[i])
      && event.runId === run.id && event.identity.subagentId === started[0].identity.subagentId
      && event.identity.name === 'general-purpose' && event.identity.depth === 0
      && event.identity.parentSubagentId === null && event.identity.execution === 'sync'
      && event.identity.taskInput === null && Array.isArray(event.identity.path)
      && hash(event.identity.path) === hash(['general-purpose#0']) && event.sequence === i + 1)
    && new RegExp(`^subagent-${run.id}-[0-9]+$`).test(started[0]?.identity.subagentId ?? '');
  const receipt = envelope.settlementReceipt;
  const receiptBound = receipt?.schemaVersion === 1 && receipt.runId === run.id && receipt.callId === child.call_id
    && receipt.state === child.state && receipt.tokens === 0 && child.actual_tokens === 0
    && hash(receipt) === envelope.settlementReceiptHash && envelope.outcomeStatus === 'failed'
    && hash(receipt.outcome) === hash({ outcomeStatus: 'failed', failureCode: envelope.failureCode });
  const messages = stateMessages(state).filter(message => message.tool_call_id === proposal.id);
  const errorBound = messages.length > 0 && messages.every(message => message.name === 'task'
    && message.status === 'error' && typeof message.content === 'string'
    && /^\[ToolRuntimeError\] Error: 503 harness_child_model_unavailable$/.test(message.content)
    && envelope.outcomeHash === hash(message.content) && receipt?.outcomeHash === hash(message.content))
    && requests.some(request => request.phase === 'start' && request.index === 2
      && request.body?.messages.some(message => message.role === 'tool' && message.name === 'task'
        && message.tool_call_id === proposal.id && hash(message.content) === envelope.outcomeHash));
  const failed = envelopeBound && lifecycleBound && receiptBound && (child.state === 'unknown'
    ? envelope.failureCode === 'child_task_failed' && envelope.outcomeHash === undefined && receipt.outcomeHash === null
      && events.length <= 2 && events.every(event => ['started', 'failed'].includes(event.event.kind))
    : child.state === 'settled' && envelope.failureCode === 'child_task_reported_error' && errorBound
      && events.length === 2 && events[1].event.kind === 'completed' && events[1].event.summary === null);
  return { children, events, envelopeBound, lifecycleBound, failed, receiptBound, errorBound };
}
function validResultReceipts(state) {
  const succeeded = state.effects.filter(e => e.status === 'succeeded');
  return state.resultReceipts.length === succeeded.length && state.effects.every(effect =>
    effect.receipt_json === null ? effect.receipt_hash === null : hash(JSON.parse(effect.receipt_json)) === effect.receipt_hash
  ) && succeeded.every(effect => {
    const saved = state.resultReceipts.find(r => r.operation_id === effect.operation_id);
    if (!saved || !effect.result_json) return false;
    const receipt = JSON.parse(saved.receipt_json), result = JSON.parse(effect.result_json);
    return hash(receipt) === saved.receipt_hash && hash(result) === receipt.resultHash
      && receipt.operationId === effect.operation_id && receipt.inputHash === effect.input_hash
      && receipt.generation === effect.lease_generation && receipt.providerReceiptHash === effect.receipt_hash
      && result.toolCallId === effect.tool_call_id && result.name === effect.tool_name
      && (effect.receipt_json === null || hash(JSON.parse(effect.receipt_json)) === effect.receipt_hash);
  });
}
function validUsageReceipts(state, runId) {
  return state.calls.every(call => {
    if (call.run_id !== runId || !['reserved', 'settled', 'unknown'].includes(call.state)) return false;
    const envelope = JSON.parse(call.envelope_json);
    const receipt = envelope.settlementReceipt;
    if (receipt === undefined) return call.state !== 'settled' && call.actual_tokens === null
      && envelope.settlementReceiptHash === undefined;
    return call.state !== 'reserved' && receipt?.schemaVersion === 1 && receipt.runId === runId && receipt.callId === call.call_id
      && receipt.tokens === call.actual_tokens && receipt.state === call.state
      && (call.actual_tokens === null ? call.state === 'unknown' : Number.isSafeInteger(call.actual_tokens) && call.actual_tokens >= 0)
      && hash(receipt) === envelope.settlementReceiptHash;
  });
}
export function verifyHarnessCase(scenario, path) {
  const checks = [];
  const check = (id, passed, evidence, observed) => checks.push({ id, passed: Boolean(passed), evidence, observed });
  try {
    const final = readHarnessState(join(path, 'final.sqlite'));
    const before = scenario.recover ? readHarnessState(join(path, 'before.sqlite')) : null;
    const memory = readHarnessMemory(join(path, 'final-memory.sqlite'));
    const priorMemory = scenario.recover ? readHarnessMemory(join(path, 'before-memory.sqlite')) : null;
    const seededMemory = scenario.fault === 'memory-db-error' ? readHarnessMemory(join(path, 'seed-memory.sqlite')) : null;
    const phases = readJson(join(path, 'phases.json'));
    const cleanup = readJson(join(path, 'cleanup.json'));
    const { traces, requests, responses, actions } = readHarnessTransport(scenario, path, phases);
    const all = traces.flat();
    const proposedTools = responses.flatMap(reply => reply.body.choices.flatMap(choice => choice.message?.tool_calls ?? []))
      .map(call => ({ id: call.id, name: call.function.name,
        args: JSON.parse(call.function.arguments),
        inputHash: hash({ args: JSON.parse(call.function.arguments), name: call.function.name }) }));
    const run = final.runs[0];
    if (!run || !run.snapshot || !Array.isArray(run.snapshot.capabilityManifest?.tools)) throw new Error('harness_snapshot_missing');
    const result = all.findLast(v => v.type === 'result');
    if (!result) throw new Error('harness_terminal_evidence_missing');
    const initialEnvironment = readJson(join(path, 'initial-environment.json'));
    const finalEnvironment = readJson(join(path, 'final-environment.json'));
    const workspace = workspaceObservation(join(path, 'worker/workspace'));
    const childEvidence = scenario.id.startsWith('subagent-') ? harnessSubagentEvidence(final, run, requests, all) : null;
    const eventEvidence = harnessRunEventEvidence(final, run, traces, before);
    check('real-run-checkpoint', final.runs.length === 1 && final.checkpoints.some(c => c.thread_id === run.thread_id)
      && result.runId === run.id, ['final.sqlite', 'phases.json'], { runs: final.runs.length, checkpoints: final.checkpoints.length });
    check('frozen-model-manifest', run.snapshot.model.modelId === 'roc-harness-scripted'
      && hash(run.snapshot.capabilityManifest.tools.map(t => t.modelVisibleName).sort()) === hash([...scenario.tools].sort()),
    ['final.sqlite'], { model: run.snapshot.model, tools: run.snapshot.capabilityManifest.tools.map(t => t.modelVisibleName) });
    check('isolation-before-agent', traces.every(trace => trace[0]?.type === 'isolation' && trace[0].protectedFileDenied === true),
      phases.map(p => `${p.phase}.jsonl`));
    check('process-exits', phases.every(p => p.code === (p.phase === 'start' && scenario.recover ? 73 : 0) && p.signal === null),
      ['phases.json'], phases.map(({ phase, code, signal }) => ({ phase, code, signal })));
    check('process-cleanup', cleanup.processGroupsGone === true && cleanup.dependencyLinkRemoved === true
      && !existsSync(join(path, 'worker/node_modules')) && phases.every(p => p.processGroupGone === true), ['cleanup.json', 'phases.json']);
    check('model-tool-schemas', requests.length > 0 && requests.every(r => {
      const tools = r.body?.tools ?? [];
      const scopedTools = childEvidence && r.phase === 'start' && r.index === 1 && childEvidence.envelopeBound
        && childEvidence.lifecycleBound ? ['read_file'] : scenario.tools;
      return Array.isArray(r.body?.messages) && Array.isArray(tools)
        && hash(tools.map(t => t.function?.name).sort()) === hash([...scopedTools].sort());
    }), phases.map(p => `${p.phase}.jsonl`), { requests: requests.length });
    const files = workspace.files, expected = inventory(scenario.expectedFiles);
    check('workspace-state', [expected, ...(scenario.alternativeFiles ?? []).map(inventory)]
      .some(candidate => hash(files) === hash(candidate)), ['worker/workspace'], { actual: files, expected });
    check('workspace-observations', initialEnvironment.path === run.snapshot.workspaceIdentity?.path
      && initialEnvironment.dev === run.snapshot.workspaceIdentity?.dev && initialEnvironment.ino === run.snapshot.workspaceIdentity?.ino
      && initialEnvironment.mode === 0o700 && hash(initialEnvironment.files) === hash(inventory(scenario.files))
      && finalEnvironment.path === initialEnvironment.path && hash(finalEnvironment.files) === hash(files)
      && (scenario.mutation?.kind === 'revoke-write' ? finalEnvironment.mode === 0o500 : finalEnvironment.mode === workspace.mode),
    ['initial-environment.json', 'final-environment.json', 'final.sqlite', 'worker/workspace']);
    check('raw-events-observed', eventEvidence.observedBound && eventEvidence.reconciliationBound,
      ['final.sqlite', ...phases.map(p => `${p.phase}.jsonl`)],
      { persisted: final.runEvents.length, observed: all.filter(record => record.type === 'event').length });
    check('event-bus-bound', eventEvidence.busBound,
      ['final.sqlite', ...phases.map(p => `${p.phase}.jsonl`)],
      { observed: all.filter(record => record.type === 'event-bus').length });
    check('memory-state', scenario.memory ? memory.items.length === 1 : memory.items.length === 0 && memory.triggers.length === 0,
      ['final-memory.sqlite'], { items: memory.items.length, triggers: memory.triggers.map(trigger => trigger.name) });
    check('result-receipt-integrity', validResultReceipts(final), ['final.sqlite']);
    check('usage-ledger-integrity', validUsageReceipts(final, run.id)
      && final.calls.filter(call => call.kind === 'model').length === requests.length,
    ['final.sqlite', ...phases.map(p => `${p.phase}.jsonl`)]);
    check('tool-inputs-bound-to-responses', final.effects.every(effect => effect.run_id === run.id && effect.thread_id === run.thread_id
      && proposedTools.some(call => call.id === effect.tool_call_id && call.name === effect.tool_name && call.inputHash === effect.input_hash))
      && final.calls.filter(call => call.kind === 'tool').every(call => {
        const envelope = JSON.parse(call.envelope_json);
        return proposedTools.some(proposed => proposed.name === envelope.name && proposed.inputHash === call.input_hash
          && envelope.inputHash === call.input_hash);
      }), ['final.sqlite', ...phases.filter(p => p.requests > 0).map(p => `${p.phase}.responses.jsonl`)]);

    if (before) {
      const prior = before.runs[0];
      check('same-run-thread-snapshot', before.runs.length === 1 && prior.id === run.id && prior.thread_id === run.thread_id
        && hash(prior.snapshot) === hash(run.snapshot), ['before.sqlite', 'final.sqlite']);
      check('memory-preserved-on-recovery', hash(priorMemory) === hash(memory), ['before-memory.sqlite', 'final-memory.sqlite']);
      check('startup-reconciliation-observed', eventEvidence.reconciliationBound,
        ['before.sqlite', 'final.sqlite', 'recover.jsonl']);
      check('fault-boundary-reached', traces[0].some(v => v.type === 'boundary' && v.fault === scenario.fault),
        ['start.jsonl'], { fault: scenario.fault });
      if (!['receipt-durable', 'mcp-receipt-lost'].includes(scenario.fault)) {
        check('checkpoint-resumed-once', run.status === 'completed' && result.status === 'completed'
          && typeof result.repeatedResumeError === 'string' && /not_interrupted/.test(result.repeatedResumeError),
        ['recover.jsonl', 'final.sqlite'], { status: run.status, repeatedResumeError: result.repeatedResumeError });
      }
    }
    const toolCalls = state => state.calls.filter(c => c.kind === 'tool');
    const modelCalls = state => state.calls.filter(c => c.kind === 'model');
    if (scenario.id === 'cold-model-resume') {
      const old = modelCalls(before)[0], current = final.calls.find(c => c.call_id === old?.call_id);
      check('pending-usage-reconciled', modelCalls(before).length === 1 && old.state === 'reserved' && current?.state === 'unknown'
        && hash({ ...old, state: null }) === hash({ ...current, state: null })
        && modelCalls(final).length === 2 && modelCalls(final).filter(c => c.state === 'settled').length === 1,
      ['before.sqlite', 'final.sqlite'], modelCalls(final).map(c => ({ id: c.call_id, state: c.state })));
      check('one-recovery-model-call', traces[1].filter(v => v.type === 'request').length === 1 && final.effects.length === 0, ['recover.jsonl', 'final.sqlite']);
    } else if (scenario.recover && scenario.id !== 'context-compaction-crash') {
      const initial = before.effects[0] ?? {}, effect = final.effects[0] ?? {};
      check('one-effect-identity', before.effects.length === 1 && final.effects.length === 1 && initial.operation_id === effect.operation_id
        && initial.input_hash === effect.input_hash && initial.tool_call_id === effect.tool_call_id,
      ['before.sqlite', 'final.sqlite'], { before: initial?.operation_id, after: effect?.operation_id });
      if (scenario.fault === 'before-dispatch') {
        check('reserved-effect-retried', initial.status === 'reserved' && initial.receipt_json === null && effect.status === 'succeeded'
          && effect.attempt_count === 2 && effect.lease_generation === initial.lease_generation + 2 && effect.receipt_sequence === 3,
        ['before.sqlite', 'final.sqlite'], { status: effect.status, attempts: effect.attempt_count,
          previousGeneration: initial.lease_generation, generation: effect.lease_generation, receipts: effect.receipt_sequence });
        check('abandoned-tool-usage-unknown', toolCalls(final).length === 2
          && toolCalls(final).filter(c => c.state === 'unknown').length === 1
          && toolCalls(final).filter(c => c.state === 'settled').length === 1, ['final.sqlite']);
      } else if (scenario.fault === 'result-stored') {
        check('stored-result-replayed', initial.status === 'succeeded' && effect.status === 'succeeded'
          && effect.attempt_count === 1 && effect.lease_generation === initial.lease_generation
          && effect.receipt_sequence === 3 && hash(initial.result_json) === hash(effect.result_json)
          && toolCalls(final).length === toolCalls(before).length && validResultReceipts(before), ['before.sqlite', 'final.sqlite'],
        { attempts: effect.attempt_count, toolReservations: toolCalls(final).length, receipts: effect.receipt_sequence });
      } else if (scenario.fault === 'receipt-durable') {
        const receipt = initial.receipt_json === null ? null : JSON.parse(initial.receipt_json);
        check('durable-effect-remains-unknown', initial.status === 'in_progress' && receipt?.phase === 'durable'
          && initial.result_json === null && effect.status === 'unknown' && effect.attempt_count === 1
          && effect.receipt_sequence === 3 && final.resultReceipts.length === 0, ['before.sqlite', 'final.sqlite']);
        check('unattended-resume-blocked', result.status === 'blocked' && run.status === 'interrupted'
          && result.error === 'task_handoff_checkpoint_resume_unavailable'
          && traces[1].some(v => v.type === 'event' && v.event?.type === 'task_acceptance'
            && v.event.report?.status === 'blocked' && v.event.report.checkpointResumeAvailable === false)
          && traces[1].filter(v => v.type === 'request').length === 0
          && final.calls.length === before.calls.length, ['recover.jsonl', 'final.sqlite'],
        { status: result.status, error: result.error });
      } else if (scenario.fault === 'mcp-receipt-lost') {
        check('external-effect-remains-unknown', initial.status === 'in_progress' && initial.receipt_json === null
          && initial.result_json === null && effect.status === 'unknown' && effect.receipt_json === null && effect.result_json === null
          && effect.attempt_count === 1 && final.resultReceipts.length === 0,
        ['before.sqlite', 'final.sqlite'], { before: initial.status, after: effect.status });
        check('unattended-resume-blocked', result.status === 'blocked' && run.status === 'interrupted'
          && result.error === 'task_handoff_checkpoint_resume_unavailable'
          && traces[1].some(v => v.type === 'event' && v.event?.type === 'task_acceptance'
            && v.event.report?.status === 'blocked' && v.event.report.checkpointResumeAvailable === false)
          && traces[1].every(v => v.type !== 'request') && final.calls.length === before.calls.length,
        ['recover.jsonl', 'final.sqlite'], { status: result.status, error: result.error });
      }
    } else if (scenario.decision) {
      const pending = readHarnessState(join(path, 'approval.sqlite'));
      const beforeRecovery = readRecoveryPoints(join(path, 'approval-workspace.sqlite'));
      const recovery = readRecoveryPoints(join(path, 'final-workspace.sqlite'));
      const approval = all.findIndex(v => v.type === 'approval');
      const decisions = transcript(join(path, 'start.decisions.jsonl'));
      const audit = final.taskEvents.filter(event => event.type === 'approval_decision');
      const observedAudit = all.filter(v => v.type === 'task-event' && v.event?.type === 'approval_decision');
      check('approval-before-effect', approval > 0
        && all.slice(0, approval).some(v => v.type === 'event' && v.event?.type === 'run_interrupted')
        && pending.runs.length === 1 && pending.runs[0].id === run.id && pending.runs[0].status === 'waiting_user'
        && pending.interrupts.length === 1 && pending.interrupts[0].interrupt_id === all[approval].interrupts[0]?.interruptId
        && pending.effects.length === 0 && pending.resultReceipts.length === 0
        && beforeRecovery.length === 0 && pending.taskEvents.every(event => event.type !== 'approval_decision')
        && hash(readJson(join(path, 'approval-files.json'))) === hash(Object.entries(scenario.files)
          .map(([name, text]) => ({ path: name, bytes: Buffer.byteLength(text), sha256: sha256(text) }))
          .sort((a, b) => a.path.localeCompare(b.path))),
      ['start.jsonl', 'approval.sqlite', 'approval-workspace.sqlite', 'approval-files.json']);
      check('decision-consumed-once', audit.length === 1 && observedAudit.length === 1
        && audit[0].run_id === run.id && audit[0].payload.interruptId === pending.interrupts[0]?.interrupt_id
        && audit[0].payload.decisions.length === 1 && audit[0].payload.decisions[0].type === scenario.decision
        && decisions.length === 1 && decisions[0].decision === scenario.decision
        && requests.length === 2 && run.status === 'completed' && result.status === 'completed'
        && final.interrupts.length === 0 && result.repeatedDecisionError === 'chat_resume_no_pending_interrupt',
      ['start.jsonl', 'start.decisions.jsonl', 'final.sqlite'],
      { decisions: audit.length, requests: requests.length, status: run.status, repeatedDecisionError: result.repeatedDecisionError });
      check('approval-effect-policy', scenario.decision === 'reject'
        ? final.effects.length === 0 && final.resultReceipts.length === 0 && recovery.length === 0
        : final.effects.length === 1 && final.effects[0].status === 'succeeded' && recovery.length === 1,
      ['final.sqlite', 'final-workspace.sqlite']);
      if (scenario.decision === 'approve') {
        const point = recovery[0], original = Object.values(scenario.files)[0];
        const safeId = /^recovery_[0-9a-f-]{36}$/.test(point?.id ?? '');
        const savedPath = safeId ? join(path, 'worker/state/tasks/recovery', point.id, 'original') : null;
        check('approved-delete-recoverable', safeId && point.relative_path === 'keep.txt' && point.source === 'agent.delete_file'
          && point.restored === 0 && point.content_sha256 === sha256(original) && existsSync(savedPath)
          && lstatSync(savedPath).isFile() && !lstatSync(savedPath).isSymbolicLink()
          && sha256(readFileSync(savedPath)) === point.content_sha256,
        ['final-workspace.sqlite', 'worker/state/tasks/recovery'], { recoveryPoints: recovery.length, originalHash: point?.content_sha256 });
      }
    } else if (scenario.cancel) {
      check('cancel-propagated', run.status === 'cancelled' && result.status === 'cancelled'
        && all.some(v => v.type === 'model-aborted') && all.some(v => v.type === 'cancelled' && v.result?.cancelled === true),
      ['start.jsonl', 'final.sqlite']);
      check('cancel-no-later-work', requests.length === 1 && final.effects.length === 0 && final.calls.length === 1
        && final.calls[0].state === 'unknown', ['start.jsonl', 'final.sqlite'], final.calls.map(c => ({ kind: c.kind, state: c.state })));
    } else if (scenario.id === 'parallel-edits') {
      check('parallel-calls-serialized', requests[0]?.body.messages.every(m => m.role !== 'tool')
        && all.filter(v => v.type === 'request')[1]?.body.messages.some(m => m.role === 'assistant' && m.tool_calls?.length === 2)
        && final.effects.length === 2 && final.effects.every(e => e.status === 'succeeded' && e.attempt_count === 1 && e.receipt_sequence === 3)
        && toolCalls(final).length === 2 && toolCalls(final).every(c => c.state === 'settled') && run.status === 'completed',
      ['start.jsonl', 'final.sqlite']);
    } else if (scenario.id === 'denied-tool') {
      check('unavailable-tool-reported', run.status === 'failed' && result.status === 'failed'
        && result.error === 'agent_capability_manifest_tool_not_authorized:write_file'
        && all.some(v => v.type === 'event' && v.event?.type === 'run_failed'
          && v.event.message === result.error), ['start.jsonl', 'final.sqlite'], { error: result.error, status: run.status });
      check('denied-tool-no-effect', requests.length === 1 && toolCalls(final).length === 0
        && final.effects.length === 0 && final.resultReceipts.length === 0, ['start.jsonl', 'final.sqlite']);
    } else if (scenario.id === 'tool-loop') {
      check('loop-stopped-by-harness', run.status === 'failed' && result.status === 'failed'
        && /tool_call_loop_detected/.test(JSON.stringify(all)) && requests.length <= 4,
      ['start.jsonl', 'final.sqlite'], { status: run.status, requests: requests.length, error: result.error });
    }
    if (scenario.mutation) {
      const mutation = readJson(join(path, 'mutation.json')), request = requests.find(r => r.phase === 'start' && r.index === scenario.mutation.atRequest);
      check('mutation-after-observed-read', mutation.kind === scenario.mutation.kind && mutation.request === scenario.mutation.atRequest
        && mutation.requestHash === hash(request?.body) && hash(mutation.before) === hash(initialEnvironment)
        && mutation.after.path === initialEnvironment.path && hash(mutation.after) === hash(finalEnvironment)
        && sourceRead(final, requests, 'observe-source', scenario.files['source.txt']),
      ['mutation.json', 'initial-environment.json', 'final-environment.json', 'start.jsonl', 'final.sqlite']);
    }
    if (scenario.id === 'approval-expired') {
      const approval = final.approvals[0], observed = all.filter(record => record.type === 'trusted-approval');
      const clocks = all.filter(record => record.type === 'approval-clock');
      const decisions = transcript(join(path, 'start.trusted-decisions.jsonl'), false);
      const binding = observed[0]?.binding, clock = clocks[0], identity = run.snapshot.workspaceIdentity;
      const { manifestHash, ...manifestWithoutHash } = run.snapshot.capabilityManifest;
      check('expired-approval-bound', final.approvals.length === 1 && observed.length === 1 && clocks.length === 1
        && decisions.length === 1 && decisions[0].approved === true && decisions[0].runId === run.id
        && decisions[0].toolCallId === 'expired-command' && binding?.runId === run.id && binding.threadId === run.thread_id
        && binding.toolCallId === 'expired-command' && binding.toolName === 'run_trusted_host_command'
        && binding.command === 'printf approved' && binding.cwd === identity.path
        && binding.manifest.manifestHash === manifestHash && manifestHash === sha256(JSON.stringify(manifestWithoutHash))
        && approval?.schema_version === 1 && approval.run_id === run.id && approval.thread_id === run.thread_id
        && approval.tool_call_id === binding.toolCallId && approval.tool_name === binding.toolName
        && approval.workspace_path === identity.path && approval.workspace_dev === identity.dev && approval.workspace_ino === identity.ino
        && approval.cwd === identity.path && approval.command_hash === sha256(binding.command)
        && approval.resource_scope_hash === sha256(`${identity.path}\0${identity.path}`) && approval.manifest_hash === manifestHash
        && approval.approval_reference === clock?.approvalReference && Date.parse(approval.created_at) === clock?.issuedAtMs
        && Date.parse(approval.expires_at) === clock?.issuedAtMs + 30000 && clock?.observedAtMs === clock?.issuedAtMs + 30001
        && approval.status === 'expired' && approval.consumed_at === null,
      ['final.sqlite', 'start.jsonl', 'start.trusted-decisions.jsonl']);
      check('expired-approval-no-execution', final.grants.length === 0 && publishedWrites(final).length === 0
        && final.resultReceipts.length === 0 && final.effects.every(effect => effect.status !== 'succeeded')
        && failedTool(final, all, 'expired-command', /execution_grant_approval_expired/)
        && !stateMessages(final).some(message => message.tool_call_id === 'expired-command' && /approved/.test(contentText(message.content))
          && !/expired/.test(contentText(message.content))),
      ['final.sqlite', 'start.jsonl'], { grants: final.grants.length, effects: final.effects.map(effect => effect.status) });
    } else if (['permission-change', 'workspace-replaced'].includes(scenario.id)) {
      const mutation = readJson(join(path, 'mutation.json'));
      const identityRejected = run.status === 'failed' && result.status === 'failed'
        && result.error === 'tool_admission_workspace_identity_changed' && requests.length === 2
        && final.runEvents.filter(row => row.event.type === 'run_failed').length === 1
        && final.runEvents.some(row => row.event.type === 'run_failed' && row.event.threadId === run.thread_id
          && row.event.code === 'provider_execution_failed' && row.event.message === result.error && row.event.retryable === false)
        && final.effects.length === 0 && final.resultReceipts.length === 0
        && toolCalls(final).length === 1 && JSON.parse(toolCalls(final)[0].envelope_json).name === 'read_file'
        && toolCalls(final)[0].state === 'settled'
        && toolEvidence(final, all, 'write-after-read').messages.length === 0
        && toolEvidence(final, all, 'write-after-read').events.length === 0;
      check('workspace-write-rejected', proposedTools.filter(call => call.id === 'write-after-read').length === 1
        && final.effects.every(effect => effect.receipt_json === null)
        && (scenario.id === 'permission-change'
          ? failedTool(final, all, 'write-after-read', /EACCES|EPERM|permission denied/i) : identityRejected)
        && files.every(file => file.path !== 'result.txt'),
      ['final.sqlite', 'start.jsonl', 'worker/workspace']);
      if (scenario.id === 'permission-change') {
        const restored = readJson(join(path, 'permission-restored.json'));
        check('permission-revoked-and-restored', mutation.before.mode === 0o700 && mutation.after.mode === 0o500
          && mutation.before.dev === mutation.after.dev && mutation.before.ino === mutation.after.ino
          && restored.beforeMode === 0o500 && restored.afterMode === 0o700 && workspace.mode === 0o700,
        ['mutation.json', 'permission-restored.json', 'worker/workspace']);
      } else {
        const prior = workspaceObservation(join(path, 'worker/workspace-prior'));
        check('replaced-workspace-pinned', mutation.before.dev !== mutation.after.dev || mutation.before.ino !== mutation.after.ino,
          ['mutation.json', 'final.sqlite'], { before: mutation.before.ino, after: mutation.after.ino });
        check('replaced-workspace-original-preserved', hash(prior.files) === hash(inventory(scenario.files))
          && hash(mutation.after.files) === hash(inventory(scenario.files)) && prior.mode === 0o700,
        ['worker/workspace-prior', 'mutation.json']);
      }
    } else if (scenario.id === 'concurrent-edit-conflict') {
      const publications = publishedWrites(final), winner = publications[0];
      const winnerCall = proposedTools.find(call => call.id === winner?.tool_call_id);
      const loser = proposedTools.find(call => call.name === 'edit_file' && call.id !== winner?.tool_call_id);
      const receipt = winner ? JSON.parse(winner.receipt_json) : null;
      const expectedWinner = winnerCall ? scenario.files['source.txt'].replace(winnerCall.args.old_string, winnerCall.args.new_string) : null;
      check('conflict-single-publication', requests[0]?.outcome.body?.choices[0].message.tool_calls?.length === 2
        && final.effects.length === 2 && publications.length === 1 && winner?.status === 'succeeded'
        && winner.attempt_count === 1 && winner.receipt_sequence === 3
        && receipt?.path === '/source.txt' && receipt.resultHash === files[0]?.sha256
        && expectedWinner !== null && sha256(expectedWinner) === files[0]?.sha256
        && receipt.expectedVersion === sha256(scenario.files['source.txt'])
        && toolCalls(final).length === 2 && toolCalls(final).every(call => call.state === 'settled'),
      ['final.sqlite', 'start.jsonl', 'worker/workspace/source.txt'], { winner: winner?.tool_call_id, publications: publications.length });
      check('conflict-loser-observed', loser && failedTool(final, all, loser.id, /edit_old_string_not_found|atomic_write_version_conflict/)
        && final.effects.find(effect => effect.tool_call_id === loser.id)?.receipt_json === null
        && run.status === 'completed' && result.status === 'completed',
      ['final.sqlite', 'start.jsonl'], { loser: loser?.id });
    } else if (scenario.id === 'source-updated') {
      check('stale-edit-blocked', failedTool(final, all, 'stale-edit', /edit_old_string_not_found/)
        && final.effects.every(effect => effect.receipt_json === null) && publishedWrites(final).length === 0,
      ['final.sqlite', 'start.jsonl', 'worker/workspace/source.txt']);
      check('updated-source-reobserved', sourceRead(final, requests, 'observe-updated-source', scenario.mutation.content)
        && requests.length === 4 && proposedTools.filter(call => call.name === 'edit_file').length === 1
        && run.status === 'completed' && result.status === 'completed',
      ['final.sqlite', 'start.jsonl', 'mutation.json', 'worker/workspace/source.txt']);
    } else if (scenario.id === 'memory-db-error') {
      const row = memory.items[0];
      check('memory-fault-installed', memory.triggers.length === 2
        && ['harness_memory_insert_error', 'harness_memory_update_error'].every(name => memory.triggers.some(trigger =>
          trigger.name === name && trigger.tbl_name === 'langgraph_store_items' && /RAISE\(ABORT, 'harness_memory_persistence_failed'\)/.test(trigger.sql)))
        && hash(seededMemory.triggers) === hash(memory.triggers)
        && all.filter(record => record.type === 'memory-fault' && record.installed === true && record.database === 'memory.sqlite').length === 1
        && all.findIndex(record => record.type === 'memory-fault') < all.findIndex(record => record.type === 'request'),
      ['seed-memory.sqlite', 'final-memory.sqlite', 'start.jsonl']);
      check('memory-persistence-error-observed', failedTool(final, all, 'memory-edit', /harness_memory_persistence_failed/)
        && proposedTools.filter(call => call.id === 'memory-edit').length === 1 && toolCalls(final).length === 1,
      ['final.sqlite', 'start.jsonl']);
      check('memory-original-preserved', row?.key === scenario.memory.key && hash(row.namespace) === hash(['roc', 'memory', 'global'])
        && row.value.content === scenario.memory.content && row.value.mimeType === 'text/markdown'
        && row.value.created_at === row.value.modified_at && row.created_at === row.updated_at
        && Number.isFinite(Date.parse(row.created_at)) && Number.isFinite(Date.parse(row.value.created_at))
        && hash(seededMemory) === hash(memory) && memory.items.length === 1 && publishedWrites(final).length === 0
        && !stateMessages(final).some(message => message.tool_call_id === 'memory-edit'
          && /Successfully replaced|Successfully wrote/.test(contentText(message.content))),
      ['seed-memory.sqlite', 'final-memory.sqlite', 'final.sqlite'], { key: row?.key, contentHash: row ? sha256(row.value.content) : null });
    } else if (scenario.id === 'budget-stop') {
      const budget = readJson(join(path, 'start.budget.json')), budgetEvents = transcript(join(path, 'start.budget.jsonl'));
      const rejection = budgetEvents.filter(event => event.type === 'budget_rejected'), stopped = actions[0];
      const first = requests[0]?.outcome;
      check('request-budget-rejected', requests.length === 2 && responses.length === 1 && actions.length === 1
        && stopped.request === 1 && stopped.action === 'cancel' && stopped.reason === 'budget_max_model_requests'
        && rejection.length === 1 && rejection[0].reason === stopped.reason && rejection[0].requestId === stopped.requestId
        && rejection[0].requestHash === stopped.requestHash && rejection[0].trialId === stopped.trialId
        && budget.requests === 1 && budget.settledRequests === 1 && budget.pendingRequests === 0
        && budget.reservations.length === 1 && budget.reservations[0].requestId === first?.requestId
        && budget.reservations[0].requestHash === first?.requestHash
        && budgetEvents.filter(event => event.type === 'budget_dispatched').length === 1,
      ['start.budget.json', 'start.budget.jsonl', 'start.actions.jsonl', 'start.responses.jsonl']);
      check('budget-cancelled-real-run', run.status === 'cancelled' && result.status === 'cancelled'
        && all.some(record => record.type === 'model-aborted') && all.some(record => record.type === 'cancelled' && record.result?.cancelled === true)
        && sourceRead(final, requests, 'observe-source', scenario.files['source.txt'])
        && modelCalls(final).filter(call => call.state === 'unknown').length === 1
        && proposedTools.every(call => call.name === 'read_file') && final.effects.length === 0 && final.resultReceipts.length === 0,
      ['final.sqlite', 'start.jsonl', 'worker/workspace']);
    } else if (childEvidence) {
      const cancelled = scenario.id === 'subagent-cancel';
      check('child-delegation-envelope', childEvidence.envelopeBound, ['final.sqlite', 'start.responses.jsonl']);
      check('child-lifecycle-bound', childEvidence.lifecycleBound && childEvidence.failed,
        ['final.sqlite', 'start.jsonl'], { events: childEvidence.events.map(event => event.event.kind) });
      check('child-failed-settlement-bound', childEvidence.receiptBound && childEvidence.failed,
        ['final.sqlite', 'start.jsonl']);
      check('child-no-unreturned-result', requests.length === (cancelled ? 2 : 3) && actions.length === 1 && actions[0].request === 1
        && final.calls.filter(call => call.kind === 'child').length === 1
        && proposedTools.length === 1 && proposedTools[0].name === 'task'
        && toolCalls(final).length === 0 && final.effects.length === 0 && final.resultReceipts.length === 0
        && responses.length === (cancelled ? 1 : 2)
        && (cancelled || (responses.at(-1).body.choices[0].message.tool_calls ?? []).length === 0)
        && files.every(file => file.path === 'keep.txt')
        && stateMessages(final).filter(message => message.tool_call_id === 'delegate-once').every(message => message.status === 'error'),
      ['final.sqlite', 'start.jsonl', 'start.actions.jsonl']);
      check(cancelled ? 'child-cancellation-propagated' : 'child-transport-error-propagated',
        cancelled
          ? run.status === 'cancelled' && result.status === 'cancelled'
            && all.some(record => record.type === 'model-aborted') && all.some(record => record.type === 'cancelled' && record.result?.cancelled === true)
          : run.status === 'completed' && result.status === 'completed' && childEvidence.errorBound
            && all.some(record => record.type === 'model-transport-error' && record.index === 1 && record.status === 503)
            && actions[0]?.status === 503,
      ['final.sqlite', 'start.jsonl', 'start.actions.jsonl']);
    } else if (scenario.id === 'context-compaction-crash') {
      const original = harnessContextEvidence(before, before.runs[0], scenario.files['large.txt']);
      const recovered = harnessContextEvidence(final, run, scenario.files['large.txt']);
      check('context-artifact-original-bound', original.originalBound && recovered.originalBound
        && hash(before.artifacts) === hash(final.artifacts), ['before.sqlite', 'final.sqlite', 'worker/workspace/large.txt']);
      check('context-ui-artifact-bound', original.uiBound && recovered.uiBound,
        ['before.sqlite', 'final.sqlite', 'start.jsonl']);
      check('context-reference-checkpointed', original.checkpointBound && recovered.checkpointBound
        && final.runEvents.filter(row => row.event.type === 'context_maintenance'
          && row.event.event === 'context_tool_result_persisted' && row.event.threadId === run.thread_id
          && row.event.persistedChars === recovered.artifact?.original_chars).length === 1,
      ['before.sqlite', 'final.sqlite', 'start.jsonl', 'recover.jsonl']);
      check('context-resumed-without-reread', proposedTools.length === 1 && proposedTools[0].id === 'read-large-source'
        && proposedTools[0].name === 'grep' && final.effects.length === 0 && final.resultReceipts.length === 0
        && toolCalls(before).length === 1 && hash(toolCalls(before)) === hash(toolCalls(final))
        && traces[1].filter(record => record.type === 'request').length === 1
        && requests.some(request => request.phase === 'recover' && request.body.messages.some(message => message.role === 'tool'
          && message.name === 'grep' && message.tool_call_id === 'read-large-source'
          && contentText(message.content) === recovered.referenceContent)),
      ['before.sqlite', 'final.sqlite', 'start.responses.jsonl', 'recover.jsonl']);
    }
    if (scenario.mcp) {
      const transport = readHarnessMcpTransport(scenario, path), call = transport.calls[0];
      const tool = run.snapshot.capabilityManifest.tools.find(tool => tool.modelVisibleName === 'probe'), contract = tool?.mcpContract;
      const proposal = proposedTools.find(proposed => proposed.id === 'mcp-once');
      check('mcp-discovery-contract-bound', contract?.serverId === 'harness' && contract.remoteToolName === 'probe'
        && contract.runtimeToolName === 'harness_probe' && transport.discoveries.length >= 1
        && transport.discoveries.every(({ response }) => response?.rpc.result?.tools?.length === 1
          && response.rpc.result.tools[0].name === contract.remoteToolName
          && hash({ inputSchema: response.rpc.result.tools[0].inputSchema, outputSchema: response.rpc.result.tools[0].outputSchema ?? null }) === contract.schemaHash
          && sha256(response.rpc.result.tools[0].description) === contract.descriptionHash)
        && tool.toolVersion === `mcp-contract-v1:${contract.schemaHash}:${contract.descriptionHash}`,
      ['final.sqlite', 'worker/mcp-state/transport.jsonl']);
      check('mcp-call-bound-once', transport.calls.length === 1 && call?.rpc.params?.name === contract?.remoteToolName
        && hash(call?.rpc.params?.arguments) === hash(proposal?.args) && proposal?.name === 'probe'
        && final.effects.length === 1 && final.effects[0].tool_call_id === proposal.id
        && toolCalls(final).length === 1,
      ['final.sqlite', 'start.responses.jsonl', 'worker/mcp-state/transport.jsonl']);
      check('mcp-no-success-reply', call && !transport.wire.some(record => record.direction === 'out'
        && record.pid === call.pid && record.rpc.id === call.rpc.id)
        && final.effects.every(effect => effect.receipt_json === null && effect.result_json === null && effect.status !== 'succeeded')
        && final.resultReceipts.length === 0,
      ['final.sqlite', 'worker/mcp-state/transport.jsonl']);
      if (scenario.id === 'mcp-disconnect') {
        check('mcp-disconnect-observed', call && transport.records.some(record => record.event === 'disconnected'
          && record.pid === call.pid && record.rpcId === call.rpc.id && hash(record.args) === hash(call.rpc.params.arguments))
          && !existsSync(join(path, 'worker/mcp-state/remote-effect.json'))
          && transport.records.every(record => record.event !== 'effect-committed')
          && failedTool(final, all, 'mcp-once', /closed|disconnect|transport|EOF|-32000/i),
        ['final.sqlite', 'start.jsonl', 'worker/mcp-state/transport.jsonl', 'worker/mcp-state']);
      } else {
        const effectPath = join(path, 'worker/mcp-state/remote-effect.json'), markerPath = join(path, 'worker/mcp-state/commit-observed.json');
        if (![effectPath, markerPath].every(file => lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink())) {
          throw new Error('harness_mcp_effect_not_regular');
        }
        const bytes = readFileSync(effectPath), marker = readJson(markerPath);
        const committed = transport.records.filter(record => record.event === 'effect-committed');
        check('mcp-durable-effect-without-reply', call && committed.length === 1 && committed[0].pid === call.pid
          && committed[0].rpcId === call.rpc.id && hash(committed[0].args) === hash(call.rpc.params.arguments)
          && committed[0].sha256 === sha256(bytes) && committed[0].bytes === bytes.length && marker.sha256 === sha256(bytes)
          && bytes.toString('utf8') === `${JSON.stringify({ requestId: proposal.args.requestId, effect: 'committed' })}\n`
          && all.filter(record => record.type === 'mcp-commit-observed' && record.sha256 === sha256(bytes) && record.bytes === bytes.length).length === 1,
        ['worker/mcp-state/remote-effect.json', 'worker/mcp-state/commit-observed.json', 'worker/mcp-state/transport.jsonl', 'start.jsonl']);
      }
    }
    return { status: checks.every(c => c.passed) ? 'passed' : 'failed', checks,
      failureClass: checks.every(c => c.passed) ? null : 'harness',
      reason: checks.filter(c => !c.passed).map(c => c.id).join(',') || null,
      metrics: { scenarioPassRate: Number(checks.every(c => c.passed)) }, requests: requests.length };
  } catch (error) {
    return { status: 'invalid', checks, failureClass: 'verifier',
      reason: `harness_evidence_invalid:${error.message}`.slice(0, 320), metrics: null };
  }
}

export function summarizeHarness(manifest, trials, fatal = null) {
  const catalog = new Map(harnessCases.map(task => [task.id, task.dimension]));
  const selection = Array.isArray(manifest?.selection) ? manifest.selection : [];
  const repeats = Number.isSafeInteger(manifest?.repeats) && manifest.repeats > 0 ? manifest.repeats : 0;
  const expected = selection.length * repeats;
  const selected = new Map(selection.filter(task => task && typeof task === 'object').map(task => [task.id, task.dimension]));
  const seen = new Set();
  let malformed = selected.size !== selection.length || repeats === 0
    || selection.some(task => !task || !catalog.has(task.id) || catalog.get(task.id) !== task.dimension);
  try {
    const scope = selectHarnessCases(manifest.profile, selection.length === 1 ? selection[0]?.id : undefined);
    if (repeats !== scope.repeats || hash(selection.map(task => task?.id).sort()) !== hash(scope.cases.map(task => task.id).sort())) {
      malformed = true;
    }
  } catch { malformed = true; }
  for (const trial of trials) {
    const key = JSON.stringify([trial.taskId, trial.repeat]);
    if (!selected.has(trial.taskId) || selected.get(trial.taskId) !== trial.dimension
      || !Number.isSafeInteger(trial.repeat) || trial.repeat < 0 || trial.repeat >= repeats || seen.has(key)) malformed = true;
    else seen.add(key);
    if (!['passed', 'failed', 'invalid', 'cancelled', 'skipped'].includes(trial.status)) malformed = true;
  }
  if (malformed && !fatal) fatal = { failureClass: 'state', reason: 'harness_trial_set_invalid' };
  const scored = trials.filter(t => ['passed', 'failed'].includes(t.status));
  const complete = expected > 0 && !fatal && trials.length === expected && scored.length === expected;
  const passed = scored.filter(t => t.status === 'passed').length;
  const dimensions = Object.fromEntries([...new Set(selection.filter(c => c && catalog.has(c.id)
    && catalog.get(c.id) === c.dimension).map(c => c.dimension))].map(dimension => {
    const members = scored.filter(t => t.dimension === dimension), count = members.filter(t => t.status === 'passed').length;
    return [dimension, { passed: count, scored: members.length,
      expected: selection.filter(c => c?.dimension === dimension).length * repeats,
      passRate: members.length ? count / members.length : null }];
  }));
  return { schemaVersion: 1, suite: 'roc-harness', evidence: 'controlled-model',
    status: complete ? 'complete' : 'incomplete', assessment: !complete ? 'incomplete' : passed === expected ? 'pass' : 'fail',
    qualityConclusion: 'harness-only', coverage: !malformed && selected.size === catalog.size ? 'all-cases' : 'selected-cases',
    expected, attempted: trials.length, scored: scored.length, passed, failed: scored.length - passed,
    invalid: trials.length - scored.length, unattempted: Math.max(0, expected - seen.size), fatal, dimensions,
    metrics: { scenarioPassRate: scored.length ? passed / scored.length : null },
    exclusions: { profile_or_task_selection: catalog.size - [...selected].filter(([id, dimension]) => catalog.get(id) === dimension).length },
    failureCounts: Object.fromEntries([...new Set(trials.map(t => t.failureClass).filter(Boolean))].map(c => [c, trials.filter(t => t.failureClass === c).length])),
    latencyMs: { total: trials.reduce((n, t) => n + (t.latencyMs ?? 0), 0) },
    usage: { requests: trials.reduce((n, t) => n + (t.requests ?? 0), 0), inferenceRequests: 0 } };
}
