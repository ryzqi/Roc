import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { fileInventory, hash, sha256 } from './common.mjs';

export const applicationContract = Object.freeze({
  schemaVersion: 2,
  runtime: 'roc-agent-plugin-deep-agent',
  answerBoundary: 'final-checkpoint-assistant-bound-to-terminal-model-response',
  responseRequirements: 'optional-json-schema-bound-to-frozen-task-inputs',
  verification: 'sqlite-transport-workspace-process-v2'
});

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
      messages: db.prepare("SELECT thread_id, role, content, phase FROM session_messages WHERE role = 'assistant'").all(),
      interrupts: db.prepare('SELECT run_id FROM agent_pending_interrupts').all()
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
    const limits = { contextWindowTokens: config.contextWindowTokens ?? 65536, maxOutputTokens: config.maxOutputTokens ?? 4096 };
    const manifest = artifact.manifests[input.kind], names = manifest.tools.filter(t => t.executionScopes.includes('main')).map(t => t.modelVisibleName).sort();
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
      && (input.kind !== 'rag-paper-qa' || (state.threads[0].research_project_id === input.researchProjectId
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
    check('fixed-tool-schemas', schema.toolSchemaHash === toolSchemaHash && schema.toolSchemaHash === hash(schema.tools)
      && proposed.every(request => Array.isArray(request.body?.tools) && request.body.tools.every(tool =>
        tool?.type === 'function' && typeof tool.function?.name === 'string' && tool.function.parameters
        && typeof tool.function.parameters === 'object' && !Array.isArray(tool.function.parameters))
        && hash(request.body.tools.map(t => t.function.name).sort()) === hash(names) && hash(request.body.tools) === schema.toolSchemaHash),
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
    check('session-output', state.messages.length === 1 && state.messages[0].thread_id === run.thread_id
      && state.messages[0].phase === 'visible' && state.messages[0].content === output.output,
    ['worker/agent.sqlite', 'output.json']);
    const modelCalls = state.calls.filter(call => call.kind === 'model');
    check('usage-ledger', state.calls.every(call => usageReceipt(call, run.id) && ['model', 'tool'].includes(call.kind))
      && modelCalls.length === requests && modelCalls.every((call, index) => {
        const envelope = JSON.parse(call.envelope_json), usage = responses[index]?.body?.usage;
        const tokens = usage?.total_tokens ?? (Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens)
          ? usage.prompt_tokens + usage.completion_tokens : null);
        return envelope.callId === call.call_id && envelope.providerId === model.providerId && envelope.modelId === model.modelId
          && Number.isSafeInteger(envelope.maxOutputTokens) && envelope.maxOutputTokens > 0 && envelope.maxOutputTokens <= limits.maxOutputTokens
          && (tokens === null || (call.state === 'settled' && call.actual_tokens === tokens));
      }), ['worker/agent.sqlite', 'responses.jsonl'],
    { models: modelCalls.length, tools: state.calls.filter(call => call.kind === 'tool').length, unknown: state.calls.filter(call => call.state === 'unknown').length });
    const tools = responses.flatMap(response => response.body.choices.flatMap(choice => choice.message?.tool_calls ?? []))
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
