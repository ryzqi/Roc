import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { fileInventory, hash, readJson, sha256 } from './common.mjs';

// Independent of production code: use persisted rows, raw bytes and transport
// evidence, never runtime assertions or AgentToolEffectStore replay helpers.
export function readHarnessState(path) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('harness_database_not_regular');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('harness_database_corrupt');
    const runs = db.prepare('SELECT id, thread_id, status, snapshot_json FROM agent_runs ORDER BY id').all()
      .map(row => ({ ...row, snapshot: JSON.parse(row.snapshot_json) }));
    const checkpoints = db.prepare('SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id FROM langgraph_checkpoints ORDER BY checkpoint_id').all();
    const writes = db.prepare('SELECT thread_id, checkpoint_id, task_id, channel FROM langgraph_checkpoint_writes ORDER BY checkpoint_id, task_id, idx').all();
    return { runs, checkpoints, writes,
      calls: db.prepare('SELECT * FROM agent_calls ORDER BY call_id').all(),
      effects: db.prepare('SELECT * FROM agent_tool_effects ORDER BY tool_call_id').all(),
      resultReceipts: db.prepare('SELECT * FROM agent_tool_effect_results ORDER BY operation_id').all(),
      interrupts: db.prepare('SELECT * FROM agent_pending_interrupts ORDER BY position').all(),
      taskEvents: db.prepare('SELECT * FROM agent_events ORDER BY sequence, id').all()
        .map(row => ({ ...row, payload: JSON.parse(row.payload_json) })) };
  } finally { db.close(); }
}
function readRecoveryPoints(path) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('harness_database_not_regular');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('harness_database_corrupt');
    return db.prepare('SELECT * FROM recovery_points ORDER BY id').all();
  } finally { db.close(); }
}
function transcript(path, typed = true) {
  const text = readFileSync(path, 'utf8');
  if (!text.endsWith('\n') || !text.trim()) throw new Error('harness_transcript_incomplete');
  const values = text.trim().split('\n').map(JSON.parse);
  if (values.some(v => !v || typeof v !== 'object' || (typed && typeof v.type !== 'string'))) throw new Error('harness_transcript_invalid');
  return values;
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
    const phases = readJson(join(path, 'phases.json'));
    const cleanup = readJson(join(path, 'cleanup.json'));
    if (!Array.isArray(phases) || phases.length !== (scenario.recover ? 2 : 1)) throw new Error('harness_phase_evidence_missing');
    const traces = phases.map(p => transcript(join(path, `${p.phase}.jsonl`)));
    const all = traces.flat(), requests = all.filter(v => v.type === 'request');
    const responses = phases.flatMap((phase, i) => {
      const calls = traces[i].filter(v => v.type === 'request');
      const expected = calls.length - Number(Boolean(phase.phase === 'start' && (scenario.fault === 'model-pending' || scenario.cancel)));
      const responsePath = join(path, `${phase.phase}.responses.jsonl`);
      const replies = expected > 0 || existsSync(responsePath) ? transcript(responsePath, false) : [];
      if (phase.requests !== calls.length || calls.some((call, index) => call.index !== index)
        || expected < 0 || replies.length !== expected || replies.some((reply, index) =>
          reply.request !== index || !Array.isArray(reply.body?.choices))) throw new Error('harness_transport_evidence_inconsistent');
      return replies;
    });
    const proposedTools = responses.flatMap(reply => reply.body.choices.flatMap(choice => choice.message?.tool_calls ?? []))
      .map(call => ({ id: call.id, name: call.function.name,
        inputHash: hash({ args: JSON.parse(call.function.arguments), name: call.function.name }) }));
    const run = final.runs[0];
    if (!run || !run.snapshot || !Array.isArray(run.snapshot.capabilityManifest?.tools)) throw new Error('harness_snapshot_missing');
    const result = all.findLast(v => v.type === 'result');
    if (!result) throw new Error('harness_terminal_evidence_missing');
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
      return Array.isArray(r.body?.messages) && Array.isArray(tools)
        && hash(tools.map(t => t.function?.name).sort()) === hash([...scenario.tools].sort());
    }), phases.map(p => `${p.phase}.jsonl`), { requests: requests.length });
    const files = fileInventory(join(path, 'worker/workspace'));
    const expected = Object.entries(scenario.expectedFiles).map(([name, text]) => ({ path: name, bytes: Buffer.byteLength(text), sha256: sha256(text) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    check('workspace-state', hash(files) === hash(expected), ['worker/workspace'], { actual: files, expected });
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
      check('fault-boundary-reached', traces[0].some(v => v.type === 'boundary' && v.fault === scenario.fault),
        ['start.jsonl'], { fault: scenario.fault });
      if (scenario.fault !== 'receipt-durable') {
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
    } else if (scenario.recover) {
      const initial = before.effects[0], effect = final.effects[0];
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
      } else {
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
  const expected = manifest.selection.length * manifest.repeats;
  const selected = new Map(manifest.selection.map(task => [task.id, task.dimension]));
  const seen = new Set();
  let malformed = selected.size !== manifest.selection.length || !Number.isInteger(manifest.repeats) || manifest.repeats < 1;
  for (const trial of trials) {
    const key = JSON.stringify([trial.taskId, trial.repeat]);
    if (!selected.has(trial.taskId) || selected.get(trial.taskId) !== trial.dimension
      || !Number.isInteger(trial.repeat) || trial.repeat < 0 || trial.repeat >= manifest.repeats || seen.has(key)) malformed = true;
    else seen.add(key);
  }
  if (malformed && !fatal) fatal = { failureClass: 'state', reason: 'harness_trial_set_invalid' };
  const scored = trials.filter(t => ['passed', 'failed'].includes(t.status));
  const complete = expected > 0 && !fatal && trials.length === expected && scored.length === expected;
  const passed = scored.filter(t => t.status === 'passed').length;
  const dimensions = Object.fromEntries([...new Set(manifest.selection.map(c => c.dimension))].map(dimension => {
    const members = scored.filter(t => t.dimension === dimension), count = members.filter(t => t.status === 'passed').length;
    return [dimension, { passed: count, scored: members.length,
      expected: manifest.selection.filter(c => c.dimension === dimension).length * manifest.repeats,
      passRate: members.length ? count / members.length : null }];
  }));
  return { schemaVersion: 1, suite: 'roc-harness', evidence: 'controlled-model',
    status: complete ? 'complete' : 'incomplete', assessment: !complete ? 'incomplete' : passed === expected ? 'pass' : 'fail',
    qualityConclusion: 'harness-only', coverage: manifest.selection.length === 10 ? 'all-cases' : 'selected-cases',
    expected, attempted: trials.length, scored: scored.length, passed, failed: scored.length - passed,
    invalid: trials.length - scored.length, unattempted: Math.max(0, expected - seen.size), fatal, dimensions,
    metrics: { scenarioPassRate: scored.length ? passed / scored.length : null },
    exclusions: { profile_or_task_selection: 10 - manifest.selection.length },
    failureCounts: Object.fromEntries([...new Set(trials.map(t => t.failureClass).filter(Boolean))].map(c => [c, trials.filter(t => t.failureClass === c).length])),
    latencyMs: { total: trials.reduce((n, t) => n + t.latencyMs, 0) },
    usage: { requests: trials.reduce((n, t) => n + (t.requests ?? 0), 0), inferenceRequests: 0 } };
}
