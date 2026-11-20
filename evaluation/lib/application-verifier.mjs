import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { fileInventory, hash, sha256 } from './common.mjs';
import { applicationManifest } from './application-manifest.mjs';

export const applicationContract = Object.freeze({
  schemaVersion: 2,
  runtime: 'roc-agent-plugin-deep-agent',
  answerBoundary: 'final-checkpoint-assistant-bound-to-terminal-model-response',
  responseRequirements: 'optional-json-schema-bound-to-frozen-task-inputs',
  verification: 'sqlite-transport-workspace-process-v2'
});
export const applicationSessionContract = Object.freeze({
  schemaVersion: 3,
  runtime: 'roc-agent-plugin-deep-agent',
  answerBoundary: 'each-phase-final-checkpoint-assistant-bound-to-terminal-model-response',
  responseRequirements: 'separate-public-user-turns-and-frozen-production-tools',
  verification: 'sqlite-transport-workspace-process-multiphase-v1'
});

export function applicationContractForInput(input) {
  return input.session === undefined ? applicationContract : applicationSessionContract;
}

export function applicationTurns(input) {
  if (input.session === undefined) return null;
  const session = input.session;
  if (session?.schemaVersion !== 1 || !Array.isArray(session.turns) || session.turns.length < 2 || session.turns.length > 32
    || !['roc-capability', 'roc-e2e-research', 'roc-security'].includes(input.kind)
    || Object.keys(session).some(key => !['schemaVersion', 'turns'].includes(key))) throw new Error('application_session_invalid');
  const ids = new Set();
  for (const turn of session.turns) {
    if (!turn || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(turn.id) || ids.has(turn.id)
      || typeof turn.prompt !== 'string' || !turn.prompt.trim() || turn.prompt !== turn.prompt.trim()
      || Buffer.byteLength(turn.prompt) > 65536 || !['new', 'continue'].includes(turn.thread)
      || Object.keys(turn).some(key => !['id', 'prompt', 'thread', 'responseContract'].includes(key))) {
      throw new Error('application_session_turn_invalid');
    }
    ids.add(turn.id);
  }
  if (session.turns[0].thread !== 'new' || session.turns[0].prompt !== input.prompt) throw new Error('application_session_first_turn_invalid');
  return session.turns;
}

export function applicationContextWindow(input, config) {
  const modelWindow = config.contextWindowTokens ?? 65536;
  if (input.context === undefined) return modelWindow;
  const context = input.context;
  if (!['roc-capability', 'roc-e2e-research', 'roc-security'].includes(input.kind)
    || context?.schemaVersion !== 1 || Object.keys(context).some(key => !['schemaVersion', 'contextWindowTokens'].includes(key))
    || !Number.isSafeInteger(context.contextWindowTokens) || context.contextWindowTokens < 8192
    || context.contextWindowTokens > modelWindow || context.contextWindowTokens <= (config.maxOutputTokens ?? 4096) + 1024) {
    throw new Error('application_context_window_invalid');
  }
  return context.contextWindowTokens;
}

function bytes(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('application_evidence_not_regular');
  return readFileSync(path);
}
const json = path => JSON.parse(bytes(path).toString('utf8'));
function jsonl(path) {
  const text = bytes(path).toString('utf8');
  if (!text.endsWith('\n') || !text.trim()) throw new Error('application_transport_incomplete');
  return text.trim().split('\n').map(JSON.parse);
}
function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) {
    throw new Error('application_answer_content_invalid');
  }
  return content.map(block => block.text).join('');
}
function readState(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('application_database_not_regular');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('application_database_corrupt');
    return {
      runs: db.prepare('SELECT * FROM agent_runs ORDER BY id').all(),
      threads: db.prepare('SELECT id,research_project_id FROM agent_threads ORDER BY id').all(),
      checkpoints: db.prepare("SELECT * FROM langgraph_checkpoints WHERE checkpoint_ns = '' ORDER BY checkpoint_id DESC").all(),
      writes: db.prepare('SELECT thread_id, checkpoint_ns, checkpoint_id, channel FROM langgraph_checkpoint_writes').all(),
      events: db.prepare('SELECT run_id, sequence, event_json, event_bytes FROM agent_run_events ORDER BY sequence').all(),
      cursors: db.prepare('SELECT * FROM agent_run_event_cursors').all(),
      eventSnapshots: db.prepare('SELECT run_id, through_sequence, snapshot_json FROM agent_run_event_snapshots').all(),
      calls: db.prepare('SELECT * FROM agent_calls ORDER BY rowid').all(),
      messages: db.prepare("SELECT * FROM session_messages WHERE role = 'assistant' ORDER BY rowid").all(),
      users: db.prepare("SELECT * FROM agent_events WHERE type = 'message' ORDER BY rowid").all()
        .map(row => ({ ...row, payload: JSON.parse(row.payload_json) })).filter(row => row.payload.role === 'user'),
      interrupts: db.prepare('SELECT run_id FROM agent_pending_interrupts').all(),
      artifacts: db.prepare('SELECT * FROM context_artifacts ORDER BY rowid').all()
    };
  } finally { db.close(); }
}
function usageReceipt(call, runId) {
  const envelope = JSON.parse(call.envelope_json), receipt = envelope.settlementReceipt;
  return call.run_id === runId && ['settled', 'unknown'].includes(call.state)
    && receipt?.schemaVersion === 1 && receipt.runId === runId && receipt.callId === call.call_id
    && receipt.state === call.state && receipt.tokens === call.actual_tokens
    && (call.actual_tokens === null ? call.state === 'unknown' : Number.isSafeInteger(call.actual_tokens) && call.actual_tokens >= 0)
    && hash(receipt) === envelope.settlementReceiptHash;
}

// Host-only and independent of production verification helpers. Serialized
// LangChain constructor records are parsed as data; they are never revived.
export function verifyApplicationEvidence({ artifact, input, directory, config, requests, toolSchemaHash }) {
  if (input.session !== undefined) return verifySessionEvidence({ artifact, input, directory, config, requests, toolSchemaHash });
  const checks = [];
  const check = (id, passed, evidence, observed) => checks.push({ id, passed: Boolean(passed), evidence, observed });
  const report = { schemaVersion: 1, contract: applicationContract, status: 'invalid', checks };
  try {
    const worker = join(directory, 'worker'), workspace = join(worker, 'workspace');
    const trace = jsonl(join(directory, 'transcript.jsonl')), responses = jsonl(join(directory, 'responses.jsonl'));
    const proposed = trace.filter(value => value.type === 'request'), results = trace.filter(value => value.type === 'result');
    const output = json(join(directory, 'output.json')), schema = json(join(directory, 'tool-schema.json'));
    const state = readState(join(worker, 'agent.sqlite')), run = state.runs[0];
    if (!run) throw new Error('application_run_missing');
    const snapshot = JSON.parse(run.snapshot_json), checkpoint = state.checkpoints[0];
    if (!checkpoint || checkpoint.checkpoint_type !== 'json') throw new Error('application_checkpoint_missing_or_unsupported');
    const raw = JSON.parse(checkpoint.checkpoint_blob.toString('utf8')), final = raw.channel_values?.messages?.at(-1);
    if (final?.lc !== 1 || final.type !== 'constructor' || hash(final.id) !== hash(['langchain_core', 'messages', 'AIMessage'])) {
      throw new Error('application_final_assistant_missing');
    }
    const answer = textContent(final.kwargs?.content), terminal = responses.at(-1)?.body?.choices?.[0]?.message;
    const model = { providerId: config.providerId ?? 'evaluation-host', modelId: config.model };
    const limits = { contextWindowTokens: applicationContextWindow(input, config), maxOutputTokens: config.maxOutputTokens ?? 4096 };
    const manifest = applicationManifest(artifact, input), names = manifest.tools.filter(t => t.executionScopes.includes('main')).map(t => t.modelVisibleName).sort();
    report.runId = run.id; report.threadId = run.thread_id; report.checkpointId = checkpoint.checkpoint_id;
    report.requests = proposed.length; report.toolSchemaHash = schema.toolSchemaHash; report.finalAnswerHash = sha256(answer);

    check('worker-bytes', sha256(bytes(artifact.path)) === artifact.sha256
      && sha256(bytes(join(worker, 'application-worker.mjs'))) === artifact.sha256, ['worker/application-worker.mjs', 'worker.json']);
    check('completed-run-checkpoint', state.runs.length === 1 && state.threads.length === 1 && state.threads[0].id === run.thread_id
      && run.status === 'completed' && typeof run.ended_at === 'string' && snapshot.runId === run.id && snapshot.threadId === run.thread_id
      && checkpoint.thread_id === run.thread_id && raw.id === checkpoint.checkpoint_id
      && state.interrupts.length === 0 && !state.writes.some(w => w.thread_id === run.thread_id
        && w.checkpoint_ns === '' && w.checkpoint_id === checkpoint.checkpoint_id && ['__error__', '__interrupt__'].includes(w.channel)),
    ['worker/agent.sqlite'], { status: run.status, rootCheckpoints: state.checkpoints.length });
    const identity = statSync(workspace);
    check('frozen-inputs', run.user_input === input.prompt && snapshot.taskContract?.objective === input.prompt
      && hash(snapshot.taskContract?.responseContract ?? null) === hash(input.responseContract ?? null)
      && run.provider_id === model.providerId && run.model_id === model.modelId && hash(snapshot.model) === hash(model)
      && snapshot.modelConfig?.contextWindowTokens === limits.contextWindowTokens && snapshot.modelConfig?.maxOutputTokens === limits.maxOutputTokens
      && realpathSync(run.workspace_path) === realpathSync(workspace) && realpathSync(snapshot.workspace?.path) === realpathSync(workspace)
      && realpathSync(snapshot.workspaceIdentity?.path) === realpathSync(workspace)
      && snapshot.workspaceIdentity.dev === String(identity.dev) && snapshot.workspaceIdentity.ino === String(identity.ino)
      && snapshot.capabilityManifest?.manifestHash === manifest.manifestHash && snapshot.frozenInputs?.manifestHash === manifest.manifestHash
      && hash(snapshot.capabilityManifest) === hash(manifest)
      && (!names.some(name => name.startsWith('research_')) || (state.threads[0].research_project_id === input.researchProjectId
        && snapshot.researchProjectId === input.researchProjectId && snapshot.runOrigin === 'chat'))
      && (input.kind !== 'qasper' || (snapshot.runOrigin === 'chat' && snapshot.mode === 'run' && snapshot.taskContract.kind === 'reply')),
    ['worker/agent.sqlite', 'worker/workspace'], { model: snapshot.model, limits: snapshot.modelConfig, manifestHash: manifest.manifestHash });
    check('ordered-transport', proposed.length > 0 && proposed.length === requests && responses.length === requests
      && results.length === 1 && hash(results[0]) === hash(output) && output.requests === requests
      && output.runId === run.id && output.threadId === run.thread_id && output.manifestHash === manifest.manifestHash
      && trace.at(-1)?.type === 'result'
      && proposed.every((request, index) => request.index === index && request.requestHash === hash(request.body)
        && Array.isArray(request.body?.messages) && request.body.model === model.modelId && request.body.max_tokens === limits.maxOutputTokens
        && responses[index]?.request === index + 1 && responses[index].requestHash === request.requestHash
        && responses[index].responseHash === hash(responses[index].body)
        && responses[index].body?.model === model.modelId && responses[index].body.choices?.length === 1
        && responses[index].body.choices[0]?.message?.role === 'assistant'),
    ['transcript.jsonl', 'responses.jsonl', 'output.json'], { host: requests, worker: output.requests, responses: responses.length });
    const modelCalls = state.calls.filter(call => call.kind === 'model');
    check('fixed-tool-schemas', schema.toolSchemaHash === toolSchemaHash && schema.toolSchemaHash === hash(schema.tools)
      && proposed.every((request, index) => {
        const purpose = JSON.parse(modelCalls[index]?.envelope_json ?? '{}').purpose;
        if (purpose === 'summary') return summaryRequest(request);
        const tools = request.body.tools ?? [];
        return purpose === 'agent' && Array.isArray(tools) && tools.every(tool =>
        tool?.type === 'function' && typeof tool.function?.name === 'string' && tool.function.parameters
        && typeof tool.function.parameters === 'object' && !Array.isArray(tool.function.parameters))
        && hash(tools.map(t => t.function.name).sort()) === hash(names) && hash(tools) === schema.toolSchemaHash;
      }),
    ['transcript.jsonl', 'tool-schema.json']);
    check('final-answer-boundary', Array.isArray(final.kwargs.tool_calls) && final.kwargs.tool_calls.length === 0
      && Array.isArray(final.kwargs.invalid_tool_calls) && final.kwargs.invalid_tool_calls.length === 0
      && terminal?.role === 'assistant' && (!terminal.tool_calls || (Array.isArray(terminal.tool_calls) && terminal.tool_calls.length === 0))
      && textContent(terminal.content ?? '') === answer,
    ['worker/agent.sqlite', 'responses.jsonl'], { finalAnswerHash: report.finalAnswerHash, aggregateHash: sha256(output.output) });
    const events = trace.filter(value => value.type === 'event').map(value => value.event), cursor = state.cursors[0];
    const start = events.filter(e => e.type === 'run_started'), completed = events.filter(e => e.type === 'run_completed');
    const firstSequence = state.events[0]?.sequence, retention = state.eventSnapshots[0];
    check('persisted-events', state.cursors.length === 1 && cursor.run_id === run.id && cursor.next_sequence === events.length + 1
      && cursor.retained_count === state.events.length && state.events.length > 0
      && state.events.at(-1).sequence === events.length
      && (firstSequence === 1 || (retention?.run_id === run.id && retention.through_sequence === firstSequence - 1
        && JSON.parse(retention.snapshot_json).runId === run.id))
      && state.events.every((row, index) => {
        const envelope = JSON.parse(row.event_json);
        return row.run_id === run.id && row.sequence === firstSequence + index
          && envelope.runId === run.id && envelope.sequence === row.sequence && envelope.eventType === envelope.payload?.type
          && row.event_bytes === Buffer.byteLength(row.event_json)
          && envelope.payloadHash === sha256(JSON.stringify(envelope.payload))
          && envelope.eventId === sha256(JSON.stringify([envelope.streamId, envelope.sequence, envelope.eventType, envelope.actor,
            envelope.correlationId, envelope.causationId, envelope.projectId, envelope.taskId, envelope.runId, envelope.payloadHash, envelope.createdAt]))
          && hash(envelope.payload) === hash(events[row.sequence - 1]);
      })
      && events.every(e => e.runId === run.id) && start.length === 1 && completed.length === 1
      && events[0]?.type === 'run_started' && events.at(-1)?.type === 'run_completed'
      && !events.some(e => ['run_failed', 'run_interrupted'].includes(e.type))
      && completed[0].threadId === run.thread_id && completed[0].providerId === model.providerId && completed[0].modelId === model.modelId
      && completed[0].assistantMessage === output.output,
    ['transcript.jsonl', 'worker/agent.sqlite'], { transported: events.length, persisted: state.events.length, firstSequence });
    const visibleMessages = state.messages.filter(row => row.phase === 'visible');
    check('session-output', visibleMessages.length === 1 && visibleMessages[0].thread_id === run.thread_id
      && visibleMessages[0].content === output.output,
    ['worker/agent.sqlite', 'output.json']);
    check('usage-ledger', state.calls.every(call => usageReceipt(call, run.id) && ['model', 'tool'].includes(call.kind))
      && modelCalls.length === requests && modelCalls.every((call, index) => {
        const envelope = JSON.parse(call.envelope_json), usage = responses[index]?.body?.usage;
        const tokens = usage?.total_tokens ?? (Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens)
          ? usage.prompt_tokens + usage.completion_tokens : null);
        return envelope.callId === call.call_id && envelope.providerId === model.providerId && envelope.modelId === model.modelId
          && Number.isSafeInteger(envelope.maxOutputTokens) && envelope.maxOutputTokens > 0 && envelope.maxOutputTokens <= limits.maxOutputTokens
          && modelMessageBinding(call, proposed[index])
          && (responses[index].purpose ?? 'agent') === envelope.purpose
          && (responses[index].modelCallId === undefined || responses[index].modelCallId === call.call_id)
          && (tokens === null || (call.state === 'settled' && call.actual_tokens === tokens));
      }), ['worker/agent.sqlite', 'responses.jsonl'],
    { models: modelCalls.length, tools: state.calls.filter(call => call.kind === 'tool').length, unknown: state.calls.filter(call => call.state === 'unknown').length });
    const tools = responses.filter(response => (response.purpose ?? 'agent') === 'agent')
      .flatMap(response => response.body.choices.flatMap(choice => choice.message?.tool_calls ?? []))
      .map(tool => ({ id: tool.id, name: tool.function.name, args: JSON.parse(tool.function.arguments) }));
    check('tool-call-bindings', state.calls.filter(call => call.kind === 'tool').every(call => {
      const envelope = JSON.parse(call.envelope_json);
      return names.includes(envelope.name) && envelope.inputHash === call.input_hash
        && tools.some(tool => tool.name === envelope.name && hash({ name: tool.name, args: tool.args }) === call.input_hash);
    }), ['worker/agent.sqlite', 'responses.jsonl'], { proposed: tools.length, fileReads: tools.filter(t => t.name === 'read_file').length });
    if (['qasper', 'rag-paper-qa'].includes(input.kind)) {
      const expected = Object.entries(input.files).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), sha256: sha256(content) }))
        .sort((a, b) => a.path.localeCompare(b.path)), actual = fileInventory(workspace);
      check('public-workspace-unchanged', hash(actual) === hash(expected), ['worker/workspace'], { actual, expected });
    }
    if (artifact.taskManifests) {
      const before = readState(join(directory, 'initial-agent.sqlite'));
      const beforeMemory = readMemory(join(directory, 'initial-memory.sqlite'));
      check('unseeded-initial-state', before.runs.length === 0 && before.threads.length === 0
        && before.calls.length === 0 && before.checkpoints.length === 0 && before.artifacts.length === 0
        && beforeMemory.items.length === 0 && beforeMemory.audits.length === 0
        && trace.filter(row => row.type === 'runtime_ready').length === 1,
      ['initial-agent.sqlite', 'initial-memory.sqlite', 'transcript.jsonl']);
      const initial = json(join(directory, 'initial-workspace.json')), finalInventory = json(join(directory, 'final-workspace.json'));
      const actual = fileInventory(workspace);
      const inputs = Object.entries(input.files).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), sha256: sha256(content) }));
      check('task-workspace-inventories', initial.schemaVersion === 1 && finalInventory.schemaVersion === 1
        && Array.isArray(initial.files) && initial.files.length === inputs.length
        && hash([...initial.files].sort((a, b) => a.path.localeCompare(b.path))) === hash(inputs.sort((a, b) => a.path.localeCompare(b.path)))
        && hash(finalInventory.files) === hash(actual)
        && (!input.readOnly || hash(initial.files) === hash(actual)),
      ['initial-workspace.json', 'final-workspace.json', 'worker/workspace']);
    }
    const process = json(join(directory, 'process.json')), cleanup = json(join(directory, 'cleanup.json'));
    check('isolation-and-cleanup', trace[0]?.type === 'isolation' && trace[0].filesDenied === true && trace[0].childDenied === true
      && process.code === 0 && process.signal === null && cleanup.processGroupGone === true && cleanup.dependencyLinkRemoved === true
      && lstatSync(join(worker, 'node_modules'), { throwIfNoEntry: false }) === undefined,
    ['transcript.jsonl', 'process.json', 'cleanup.json']);
    if (checks.every(c => c.passed)) {
      report.status = 'verified';
      report.finalAnswer = { schemaVersion: 1, boundary: applicationContract.answerBoundary,
        runId: run.id, threadId: run.thread_id, checkpointId: checkpoint.checkpoint_id,
        request: requests, sha256: report.finalAnswerHash, output: answer };
    } else report.reason = checks.filter(c => !c.passed).map(c => c.id).join(',');
  } catch (error) {
    report.reason = 'application_evidence_missing_or_corrupt';
    report.error = String(error.message ?? error).slice(0, 320);
  }
  return report;
}

function readMemory(path) {
  bytes(path);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('application_memory_database_corrupt');
    return {
      items: db.prepare('SELECT * FROM langgraph_store_items ORDER BY namespace_key,key').all(),
      audits: db.prepare('SELECT * FROM memory_auto_audit ORDER BY rowid').all()
    };
  } finally { db.close(); }
}
function parsedCheckpoint(row) {
  if (!row || row.checkpoint_type !== 'json') throw new Error('application_phase_checkpoint_missing');
  const raw = JSON.parse(row.checkpoint_blob.toString('utf8'));
  if (raw.id !== row.checkpoint_id) throw new Error('application_phase_checkpoint_identity_invalid');
  return raw;
}
function dictContent(value) {
  if (!value || !['human', 'ai', 'tool', 'system'].includes(value.type) || !value.data) return null;
  return { role: { human: 'user', ai: 'assistant', tool: 'tool', system: 'system' }[value.type],
    text: textContent(value.data.content), toolCallId: value.data.tool_call_id };
}
function modelMessageBinding(call, request) {
  const envelope = JSON.parse(call.envelope_json);
  if (!['agent', 'summary'].includes(envelope.purpose) || !Array.isArray(envelope.messages)
    || call.input_hash !== hash({ purpose: envelope.purpose, messages: envelope.messages })) return false;
  // Persisted model messages are data, not revived LangChain constructors.
  const messages = envelope.messages.map(dictContent);
  if (messages.some(value => value === null)) return false;
  const observed = request.body.messages;
  let cursor = 0;
  for (const message of messages.filter(value => value.role !== 'system')) {
    const index = observed.findIndex((value, index) => index >= cursor && value.role === message.role
      && textContent(value.content ?? '') === message.text
      && (message.role !== 'tool' || value.tool_call_id === message.toolCallId));
    if (index < 0) return false;
    cursor = index + 1;
  }
  return messages.some(value => value.role === 'user');
}

function summaryRequest(request) {
  const tools = request.body.tools ?? [];
  return request.body.messages[0]?.role === 'system'
    && textContent(request.body.messages[0].content) === 'Summarize Roc runtime context.'
    && (tools.length === 1 && tools[0].type === 'function' && tools[0].function?.name === 'roc_context_summary'
      || tools.length === 0 && request.body.response_format?.type === 'json_schema'
        && request.body.response_format.json_schema?.name === 'roc_context_summary');
}

function verifySessionEvidence({ artifact, input, directory, config, requests, toolSchemaHash }) {
  const checks = [];
  const check = (id, passed, evidence, observed) => checks.push({ id, passed: Boolean(passed), evidence, observed });
  const report = { schemaVersion: 2, contract: applicationSessionContract, status: 'invalid', checks, phases: [] };
  try {
    const turns = applicationTurns(input), worker = join(directory, 'worker'), workspace = join(worker, 'workspace');
    const trace = jsonl(join(directory, 'transcript.jsonl')), responses = jsonl(join(directory, 'responses.jsonl'));
    const transport = trace.filter(row => row.type === 'request'), output = json(join(directory, 'output.json'));
    const retained = json(join(directory, 'phase-evidence.json')), schema = json(join(directory, 'tool-schema.json'));
    const all = readState(join(worker, 'agent.sqlite')), memory = readMemory(join(worker, 'memory.sqlite'));
    const manifest = applicationManifest(artifact, input);
    const names = manifest.tools.filter(tool => tool.executionScopes.includes('main')).map(tool => tool.modelVisibleName).sort();
    const model = { providerId: config.providerId ?? 'evaluation-host', modelId: config.model };
    const limits = { contextWindowTokens: applicationContextWindow(input, config), maxOutputTokens: config.maxOutputTokens ?? 4096 };
    if (retained.schemaVersion !== 2 || retained.complete !== true || !Array.isArray(retained.phases)
      || retained.phases.length !== turns.length) throw new Error('application_phase_evidence_incomplete');
    check('worker-bytes', sha256(bytes(artifact.path)) === artifact.sha256
      && sha256(bytes(join(worker, 'application-worker.mjs'))) === artifact.sha256, ['worker/application-worker.mjs', 'worker.json']);
    check('phase-counts', all.runs.length === turns.length && all.threads.length === turns.filter(turn => turn.thread === 'new').length
      && all.interrupts.length === 0 && all.runs.every(run => run.status === 'completed'),
    ['worker/agent.sqlite', 'phase-evidence.json']);
    check('ordered-transport', transport.length > 0 && transport.length === requests && responses.length === requests
      && output.schemaVersion === 2 && output.requests === requests && output.phases?.length === turns.length
      && trace.at(-1)?.type === 'result' && trace.filter(row => row.type === 'result').length === 1 && hash(trace.at(-1)) === hash(output)
      && transport.every((request, index) => request.index === index && request.requestHash === hash(request.body)
        && request.body.model === model.modelId && request.body.max_tokens === limits.maxOutputTokens
        && Array.isArray(request.body.messages) && responses[index]?.request === index + 1
        && responses[index].requestHash === request.requestHash && responses[index].responseHash === hash(responses[index].body)
        && responses[index].body?.model === model.modelId && responses[index].body.choices?.length === 1
        && responses[index].body.choices[0].message?.role === 'assistant'),
    ['transcript.jsonl', 'responses.jsonl', 'output.json']);
    check('main-tool-schema', schema.toolSchemaHash === toolSchemaHash && hash(schema.tools) === toolSchemaHash
      && hash(schema.tools.map(tool => tool.function.name).sort()) === hash(names), ['tool-schema.json']);
    const identity = statSync(workspace);
    let previous = null, previousMemory = null, requestEnd = 0;
    const runIds = new Set(), threadIds = new Set(), finalAnswers = [];
    for (const [index, turn] of turns.entries()) {
      const phase = retained.phases[index], prefix = `phases/${turn.id}/`;
      const phaseCheck = (id, passed, observed) => check(`${turn.id}:${id}`, passed,
        [`${prefix}phase.json`, `${prefix}agent.sqlite`, 'transcript.jsonl', 'responses.jsonl'], observed);
      if (phase?.id !== turn.id || phase.index !== index || phase.schemaVersion !== 2
        || phase.inputHash !== hash(turn) || phase.thread !== turn.thread
        || phase.requestStart !== requestEnd || !Number.isSafeInteger(phase.requestEnd) || phase.requestEnd <= requestEnd
        || !phase.artifactHashes || hash(phase) !== hash(json(join(directory, prefix, 'phase.json')))) {
        throw new Error('application_phase_receipt_invalid');
      }
      for (const name of ['initial-agent.sqlite', 'initial-memory.sqlite', 'agent.sqlite', 'memory.sqlite',
        'initial-workspace.json', 'final-workspace.json']) {
        if (phase.artifactHashes[name] !== sha256(bytes(join(directory, prefix, name)))) throw new Error('application_phase_artifact_hash_invalid');
      }
      for (const [name, expectedHash] of Object.entries(phase.artifactHashes)) {
        if (typeof name !== 'string' || name.split('/').some(part => !part || part === '.' || part === '..')
          || /[:\\\u0000-\u001f\u007f]/u.test(name) || expectedHash !== sha256(bytes(join(directory, prefix, name)))) {
          throw new Error('application_phase_artifact_hash_invalid');
        }
      }
      phaseCheck('workspace-bytes', hash(fileInventory(join(directory, prefix, 'workspace')))
        === hash(json(join(directory, prefix, 'final-workspace.json')).files));
      const before = readState(join(directory, prefix, 'initial-agent.sqlite'));
      const after = readState(join(directory, prefix, 'agent.sqlite'));
      const beforeMemory = readMemory(join(directory, prefix, 'initial-memory.sqlite'));
      const afterMemory = readMemory(join(directory, prefix, 'memory.sqlite'));
      const run = after.runs.find(run => run.id === phase.runId), checkpoint = after.checkpoints.find(row =>
        row.thread_id === phase.threadId && row.checkpoint_id === phase.checkpointId);
      if (!run || !checkpoint) throw new Error('application_phase_run_or_checkpoint_missing');
      const raw = parsedCheckpoint(checkpoint), final = raw.channel_values?.messages?.at(-1);
      if (final?.lc !== 1 || final.type !== 'constructor' || hash(final.id) !== hash(['langchain_core', 'messages', 'AIMessage'])) {
        throw new Error('application_phase_final_assistant_missing');
      }
      const answer = textContent(final.kwargs.content), snapshot = JSON.parse(run.snapshot_json);
      const proposed = transport.slice(phase.requestStart, phase.requestEnd), replies = responses.slice(phase.requestStart, phase.requestEnd);
      const phaseTrace = trace.filter(row => row.phaseId === turn.id && row.type !== 'result');
      const events = phaseTrace.filter(row => row.type === 'event').map(row => row.event);
      const phaseCalls = after.calls.filter(call => call.run_id === run.id), modelCalls = phaseCalls.filter(call => call.kind === 'model');
      phaseCheck('snapshot-chain', before.runs.length === index && after.runs.length === index + 1
        && (index === 0 ? before.calls.length === 0 && before.checkpoints.length === 0
          && beforeMemory.items.length === 0 && beforeMemory.audits.length === 0
          : hash(before) === hash(previous) && hash(beforeMemory) === hash(previousMemory))
        && before.runs.every(prior => hash(prior) === hash(after.runs.find(row => row.id === prior.id)))
        && before.calls.every(prior => hash(prior) === hash(after.calls.find(row => row.call_id === prior.call_id)))
        && before.artifacts.every(prior => hash(prior) === hash(after.artifacts.find(row => row.id === prior.id))));
      phaseCheck('completed-run-checkpoint', run.status === 'completed' && typeof run.ended_at === 'string'
        && run.thread_id === phase.threadId && snapshot.runId === run.id && snapshot.threadId === run.thread_id
        && !runIds.has(run.id) && (turn.thread === 'continue' ? run.thread_id === retained.phases[index - 1].threadId : !threadIds.has(run.thread_id))
        && !after.writes.some(write => write.thread_id === run.thread_id && write.checkpoint_id === phase.checkpointId
          && ['__error__', '__interrupt__'].includes(write.channel)));
      runIds.add(run.id); threadIds.add(run.thread_id);
      phaseCheck('frozen-inputs', run.user_input === turn.prompt && snapshot.taskContract?.objective === turn.prompt
        && hash(snapshot.taskContract?.responseContract ?? null) === hash(turn.responseContract ?? null)
        && run.provider_id === model.providerId && run.model_id === model.modelId && hash(snapshot.model) === hash(model)
        && snapshot.modelConfig?.contextWindowTokens === limits.contextWindowTokens
        && snapshot.modelConfig?.maxOutputTokens === limits.maxOutputTokens
        && realpathSync(run.workspace_path) === realpathSync(workspace)
        && realpathSync(snapshot.workspaceIdentity?.path) === realpathSync(workspace)
        && snapshot.workspaceIdentity.dev === String(identity.dev) && snapshot.workspaceIdentity.ino === String(identity.ino)
        && hash(snapshot.capabilityManifest) === hash(manifest) && snapshot.frozenInputs?.manifestHash === manifest.manifestHash
        && (!names.some(name => name.startsWith('research_')) || snapshot.researchProjectId === input.researchProjectId));
      phaseCheck('phase-transport', proposed.length > 0 && phaseTrace[0]?.type === 'phase_begin'
        && phaseTrace.at(-1)?.type === 'phase_end' && phaseTrace.filter(row => row.type === 'phase_begin').length === 1
        && phaseTrace.filter(row => row.type === 'phase_end').length === 1
        && phaseTrace[0].inputHash === hash(turn) && phaseTrace.at(-1).runId === run.id
        && phaseTrace.at(-1).threadId === run.thread_id && phaseTrace.at(-1).checkpointId === phase.checkpointId
        && phaseTrace.at(-1).requestStart === phase.requestStart && phaseTrace.at(-1).requestEnd === phase.requestEnd
        && typeof phaseTrace.at(-1).output === 'string' && phase.outputHash === sha256(phaseTrace.at(-1).output)
        && [...proposed, ...replies].every(row => row.schemaVersion === 2 && row.phaseId === turn.id && row.phaseIndex === index
          && row.runId === run.id && row.threadId === run.thread_id)
        && output.phases[index].id === turn.id && output.phases[index].runId === run.id
        && output.phases[index].threadId === run.thread_id && output.phases[index].output === phaseTrace.at(-1).output);
      const terminal = replies.at(-1)?.body.choices[0].message;
      phaseCheck('final-answer-boundary', final.kwargs.tool_calls?.length === 0 && final.kwargs.invalid_tool_calls?.length === 0
        && terminal?.role === 'assistant' && (terminal.tool_calls ?? []).length === 0 && textContent(terminal.content ?? '') === answer);
      const persisted = after.events.filter(row => row.run_id === run.id), cursor = after.cursors.find(row => row.run_id === run.id);
      const first = persisted[0]?.sequence, retention = after.eventSnapshots.find(row => row.run_id === run.id);
      phaseCheck('persisted-events', events[0]?.type === 'run_started' && events.at(-1)?.type === 'run_completed'
        && events.filter(event => event.type === 'run_started').length === 1 && events.filter(event => event.type === 'run_completed').length === 1
        && events.every(event => event.runId === run.id && !['run_failed', 'run_interrupted'].includes(event.type))
        && events.at(-1).assistantMessage === phaseTrace.at(-1).output
        && cursor?.next_sequence === events.length + 1 && cursor.retained_count === persisted.length
        && persisted.length > 0 && persisted.at(-1).sequence === events.length
        && (first === 1 || retention?.through_sequence === first - 1)
        && persisted.every((row, position) => {
          const envelope = JSON.parse(row.event_json);
          return row.sequence === first + position && envelope.runId === run.id && envelope.sequence === row.sequence
            && envelope.eventType === envelope.payload?.type && row.event_bytes === Buffer.byteLength(row.event_json)
            && envelope.payloadHash === sha256(JSON.stringify(envelope.payload))
            && envelope.eventId === sha256(JSON.stringify([envelope.streamId, envelope.sequence, envelope.eventType, envelope.actor,
              envelope.correlationId, envelope.causationId, envelope.projectId, envelope.taskId, envelope.runId, envelope.payloadHash, envelope.createdAt]))
            && hash(envelope.payload) === hash(events[row.sequence - 1]);
        }));
      const newMessages = after.messages.filter(row => !before.messages.some(prior => prior.id === row.id) && row.phase === 'visible');
      const newUsers = after.users.filter(row => !before.users.some(prior => prior.id === row.id));
      phaseCheck('session-output', newMessages.length === 1 && newMessages[0].thread_id === run.thread_id
        && newMessages[0].content === phaseTrace.at(-1).output && newUsers.length === 1
        && newUsers[0].run_id === run.id && newUsers[0].thread_id === run.thread_id && newUsers[0].payload.content === turn.prompt);
      phaseCheck('usage-and-model-wire', phaseCalls.every(call => usageReceipt(call, run.id) && ['model', 'tool'].includes(call.kind))
        && modelCalls.length === proposed.length && modelCalls.every((call, position) => {
          const envelope = JSON.parse(call.envelope_json), usage = replies[position]?.body.usage;
          return envelope.providerId === model.providerId && envelope.modelId === model.modelId
            && envelope.maxOutputTokens === limits.maxOutputTokens && modelMessageBinding(call, proposed[position])
            && (usage?.total_tokens === undefined || call.actual_tokens === usage.total_tokens)
            && (replies[position].purpose ?? 'agent') === envelope.purpose
            && (replies[position].modelCallId === undefined || replies[position].modelCallId === call.call_id);
        }));
      phaseCheck('fixed-tool-schemas', proposed.every((request, position) => {
        const purpose = JSON.parse(modelCalls[position]?.envelope_json ?? '{}').purpose;
        if (purpose === 'summary') return summaryRequest(request);
        return purpose === 'agent' && hash(request.body.tools ?? []) === schema.toolSchemaHash;
      }));
      phaseCheck('context-artifact-bytes', after.artifacts.every(row => row.sha256 === sha256(row.content)
        && row.original_chars === row.content.length && row.preview === row.content.slice(0, 2000)
        && after.runs.some(owner => owner.id === row.run_id && owner.thread_id === row.thread_id)));
      finalAnswers.push({ schemaVersion: 2, id: turn.id, index, runId: run.id, threadId: run.thread_id,
        checkpointId: phase.checkpointId, request: phase.requestEnd, sha256: sha256(answer), output: answer });
      report.phases.push({ id: turn.id, index, runId: run.id, threadId: run.thread_id, checkpointId: phase.checkpointId,
        requestStart: phase.requestStart, requestEnd: phase.requestEnd, finalAnswerHash: sha256(answer) });
      previous = after; previousMemory = afterMemory; requestEnd = phase.requestEnd;
    }
    const last = finalAnswers.at(-1);
    check('final-state-and-answer', requestEnd === requests && hash(previous) === hash(all) && hash(previousMemory) === hash(memory)
      && output.runId === last.runId && output.threadId === last.threadId && output.phaseId === last.id
      && output.output === output.phases.at(-1).output,
    ['worker/agent.sqlite', 'worker/memory.sqlite', 'output.json']);
    if (artifact.taskManifests) {
      const before = readState(join(directory, 'initial-agent.sqlite'));
      const beforeMemory = readMemory(join(directory, 'initial-memory.sqlite'));
      check('unseeded-initial-state', before.runs.length === 0 && before.threads.length === 0
        && before.calls.length === 0 && before.checkpoints.length === 0 && before.artifacts.length === 0
        && beforeMemory.items.length === 0 && beforeMemory.audits.length === 0
        && hash(before) === hash(readState(join(directory, `phases/${turns[0].id}/initial-agent.sqlite`)))
        && hash(beforeMemory) === hash(readMemory(join(directory, `phases/${turns[0].id}/initial-memory.sqlite`)))
        && trace.filter(row => row.type === 'runtime_ready').length === 1,
      ['initial-agent.sqlite', 'initial-memory.sqlite', 'phases', 'transcript.jsonl']);
      const initial = json(join(directory, 'initial-workspace.json')), final = json(join(directory, 'final-workspace.json'));
      const expected = Object.entries(input.files).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), sha256: sha256(content) }))
        .sort((a, b) => a.path.localeCompare(b.path));
      check('task-workspace-inventories', initial.schemaVersion === 1 && final.schemaVersion === 1
        && hash(initial.files) === hash(expected) && hash(final.files) === hash(fileInventory(workspace))
        && retained.phases.every((phase, index) => {
          const before = json(join(directory, `phases/${phase.id}/initial-workspace.json`));
          const after = json(join(directory, `phases/${phase.id}/final-workspace.json`));
          return before.schemaVersion === 1 && after.schemaVersion === 1
            && hash(before) === hash(index ? json(join(directory, `phases/${retained.phases[index - 1].id}/final-workspace.json`)) : initial)
            && (index !== retained.phases.length - 1 || hash(after) === hash(final))
            && (!input.readOnly || hash(before) === hash(after));
        }), ['initial-workspace.json', 'final-workspace.json', 'phases']);
    }
    const process = json(join(directory, 'process.json')), cleanup = json(join(directory, 'cleanup.json'));
    check('isolation-and-cleanup', trace[0]?.type === 'isolation' && trace[0].filesDenied === true && trace[0].childDenied === true
      && process.code === 0 && process.signal === null && cleanup.processGroupGone === true && cleanup.dependencyLinkRemoved === true
      && lstatSync(join(worker, 'node_modules'), { throwIfNoEntry: false }) === undefined, ['process.json', 'cleanup.json', 'transcript.jsonl']);
    report.runId = last.runId; report.threadId = last.threadId; report.checkpointId = last.checkpointId;
    report.requests = requests; report.toolSchemaHash = toolSchemaHash; report.finalAnswerHash = last.sha256;
    if (checks.every(check => check.passed)) {
      report.status = 'verified';
      report.finalAnswer = { ...last, boundary: applicationSessionContract.answerBoundary, phases: finalAnswers };
    } else report.reason = checks.filter(check => !check.passed).map(check => check.id).join(',');
  } catch (error) {
    report.reason = 'application_evidence_missing_or_corrupt';
    report.error = String(error.message ?? error).slice(0, 320);
  }
  return report;
}
