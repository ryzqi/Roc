import type { Database } from 'better-sqlite3';
import { createExecutionEvent, executionPayloadHash, parseExecutionEvent } from './execution-events';
import { hashToolInput } from '../services/deep-agent/tool-effect-store';

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('execution_migration_object_invalid');
  return value as RecordValue;
}
function usage(value: unknown): unknown {
  if (value === null) return null;
  const source = object(value);
  const tokens = object(source.tokens);
  const calls = object(source.calls);
  return {
    tokens: { settled: tokens.settled, unknown: tokens.unknown, reserved: tokens.reserved },
    calls: Object.fromEntries(['models', 'tools', 'children'].map(key => {
      const call = object(calls[key]);
      return [key, { total: call.total, reserved: call.reserved }];
    }))
  };
}

function contextCapacity(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(contextCapacity); return; }
  if (value === null || typeof value !== 'object') return;
  const record = value as RecordValue;
  if ('budgetTokens' in record) {
    record.capacityTokens = record.budgetTokens;
    delete record.budgetTokens;
  }
  Object.values(record).forEach(contextCapacity);
}

/** One-time removal. Historical names are confined to migration, never runtime contracts. */
export function removeExecutionAccounting(db: Database): void {
  for (const row of db.prepare('SELECT id, snapshot_json FROM agent_runs WHERE snapshot_version = 10 AND snapshot_json IS NOT NULL').all() as Array<{id: string; snapshot_json: string}>) {
    const old = object(JSON.parse(row.snapshot_json));
    const frozen = object(old.frozenInputs);
    const oldPolicy = {budget: old.budget, model: old.model, taskContract: old.taskContract};
    if (frozen.policyHash !== executionPayloadHash(oldPolicy)) throw new Error('run_execution_snapshot_inputs_invalid');
    const config = object(old.budget);
    const {budget: _removed, ...rest} = old;
    const modelConfig = {policyVersion: 1, contextWindowTokens: config.contextWindowTokens, maxOutputTokens: config.maxOutputTokens};
    const snapshot = {...rest, schemaVersion: 11, modelConfig,
      frozenInputs: {...frozen, policyHash: executionPayloadHash({modelConfig, model: old.model, taskContract: old.taskContract})}};
    db.prepare('UPDATE agent_runs SET snapshot_json = ?, snapshot_version = 11 WHERE id = ?').run(JSON.stringify(snapshot), row.id);
    db.prepare("UPDATE research_task_executions SET snapshot_json = json_set(snapshot_json, '$.frozenInputs', json(?)) WHERE kind = 'chat' AND execution_id = ?")
      .run(JSON.stringify(snapshot.frozenInputs), row.id);
  }

  for (const row of db.prepare('SELECT run_id, call_id, envelope_json FROM agent_calls').all() as Array<{run_id: string; call_id: string; envelope_json: string}>) {
    const envelope = object(JSON.parse(row.envelope_json));
    delete envelope.reservedCostMicrousd;
    delete envelope.pricingVersion;
    for (const key of ['maxChildTasks', 'maxConcurrentChildTasks', 'maxTotalTokens', 'maxModelCalls', 'maxToolCalls', 'maxCostMicrousd', 'deadlineAt']) delete envelope[key];
    if (envelope.settlementReceipt !== undefined) {
      const receipt = object(envelope.settlementReceipt);
      if (envelope.settlementReceiptHash !== hashToolInput(receipt)) throw new Error('run_call_settlement_invalid');
      delete receipt.costMicrousd;
      delete receipt.pricingVersion;
      delete receipt.effectivePricingVersion;
      envelope.settlementReceiptHash = hashToolInput(receipt);
    }
    db.prepare('UPDATE agent_calls SET envelope_json = ? WHERE run_id = ? AND call_id = ?').run(JSON.stringify(envelope), row.run_id, row.call_id);
  }

  for (const table of ['agent_run_events', 'agent_run_event_snapshot_pending']) {
    for (const row of db.prepare(`SELECT run_id, sequence, event_json FROM ${table}`).all() as Array<{run_id: string; sequence: number; event_json: string}>) {
      const raw = object(JSON.parse(row.event_json));
      if (!['run_budget', 'run_usage', 'context_maintenance'].includes(String(raw.eventType))) continue;
      const envelope = parseExecutionEvent(row.event_json);
      const payload = object(envelope.payload);
      if (payload.type !== envelope.eventType) throw new Error('agent_run_event_envelope_mismatch');
      contextCapacity(payload);
      const event = envelope.eventType === 'context_maintenance' ? payload : {type: 'run_usage', runId: payload.runId, threadId: payload.threadId,
        usage: usage(envelope.eventType === 'run_budget' ? payload.budget : payload.usage)};
      const json = JSON.stringify(createExecutionEvent({...envelope, eventType: String(event.type), payload: event}));
      db.prepare(`UPDATE ${table} SET event_json = ?, event_bytes = ? WHERE run_id = ? AND sequence = ?`)
        .run(json, Buffer.byteLength(json), row.run_id, row.sequence);
    }
  }
  for (const row of db.prepare('SELECT run_id, snapshot_json, snapshot_bytes FROM agent_run_event_snapshots').all() as Array<{run_id: string; snapshot_json: string; snapshot_bytes: number}>) {
    if (Buffer.byteLength(row.snapshot_json) !== row.snapshot_bytes) throw new Error('agent_run_event_snapshot_corrupt');
    const snapshot = object(JSON.parse(row.snapshot_json));
    const state = object(snapshot.state);
    contextCapacity(state);
    if ('budget' in state) {
      state.usage = usage(state.budget);
      delete state.budget;
    } else if (state.usage !== undefined) state.usage = usage(state.usage);
    const json = JSON.stringify(snapshot);
    db.prepare('UPDATE agent_run_event_snapshots SET snapshot_json = ?, snapshot_bytes = ? WHERE run_id = ?')
      .run(json, Buffer.byteLength(json), row.run_id);
  }
  for (const row of db.prepare('SELECT run_id, telemetry_json FROM agent_run_telemetry').all() as Array<{run_id: string; telemetry_json: string}>) {
    const telemetry = object(JSON.parse(row.telemetry_json));
    if (telemetry.model !== undefined) delete object(telemetry.model).reportedCostUsd;
    contextCapacity(telemetry);
    db.prepare('UPDATE agent_run_telemetry SET telemetry_json = ? WHERE run_id = ?').run(JSON.stringify(telemetry), row.run_id);
  }
  db.exec(`UPDATE agent_run_event_cursors SET
    retained_bytes = (SELECT COALESCE(SUM(event_bytes),0) FROM agent_run_events WHERE run_id = agent_run_event_cursors.run_id),
    pending_bytes = (SELECT COALESCE(SUM(event_bytes),0) FROM agent_run_event_snapshot_pending WHERE run_id = agent_run_event_cursors.run_id);
    UPDATE research_tasks SET snapshot_json = json_remove(snapshot_json, '$.budgetPolicyVersion', '$.deadlineClock');`);
}
