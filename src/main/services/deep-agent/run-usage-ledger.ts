import type { Database as DatabaseConnection } from 'better-sqlite3';
import {registerExecutionEventFunctions} from '../../infrastructure/execution-events';
import type { RunUsageStatus, RunExecutionSnapshot } from '../../../shared/types';
import { taskContractSchema } from '../../../shared/schemas/task-acceptance';
import { parseStoredJson, parseStoredJsonObject } from '../../infrastructure/stored-json';
import { hashToolInput } from './tool-effect-store';

export type RunModelConfig = RunExecutionSnapshot['modelConfig'];
type Reservation = {
  id: string;
  kind: 'model' | 'tool' | 'child';
  tokens: number;
  inputHash: string;
  envelope: unknown;
};

/** Durable pilot enrollment for one run. */
export type PilotRunRow = {
  runId: string;
  taskId: string;
  decision: string;
  disclosure: string;
  profile: 'read-only' | 'low-side-effect' | null;
  bucket: number;
  state: 'active' | 'finished' | 'cancelled';
  createdAt: string;
};

type PilotRunDbRow = {
  run_id: string; task_id: string; decision: string; disclosure: string; profile: PilotRunRow['profile']; bucket: number;
  state: PilotRunRow['state']; created_at: string;
};

/** Usage receipts shared by retries, summaries and child agents. Calls are recorded without execution quotas. */
export class RunUsageLedger {
  constructor(private readonly db: DatabaseConnection) {
    registerExecutionEventFunctions(db);
  }

  reconcileStartup(): void {
    this.db.prepare("UPDATE agent_calls SET state = 'unknown' WHERE state = 'reserved'").run();
  }

  reserve(runId: string, _config: RunModelConfig, input: Reservation): void {
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT input_hash FROM agent_calls WHERE run_id = ? AND call_id = ?')
        .get(runId, input.id) as { input_hash: string } | undefined;
      if (existing !== undefined) {
        if (existing.input_hash !== input.inputHash) throw new Error('run_call_call_input_drift');
        throw new Error('run_call_call_already_reserved');
      }
      if (!Number.isSafeInteger(input.tokens) || input.tokens < 0) {
        throw new Error('run_call_reservation_invalid');
      }
      const execution = this.db.prepare("SELECT kind, task_id FROM research_task_executions WHERE execution_id = ? AND kind IN ('chat','stage')")
        .get(runId) as { kind: 'chat' | 'stage'; task_id: string } | undefined;
      if (execution === undefined && this.db.prepare('SELECT 1 FROM agent_runs WHERE id = ?').get(runId) === undefined) {
        throw new Error('run_call_execution_unlinked');
      }
      if (execution !== undefined) this.assertTaskActive(execution.task_id);
      this.db.prepare(`INSERT INTO agent_calls
        (run_id, call_id, execution_kind, task_id, kind, input_hash, reserved_tokens, state, envelope_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`).run(
        runId, input.id, execution?.kind ?? 'chat', execution?.task_id ?? null, input.kind, input.inputHash, input.tokens, JSON.stringify(input.envelope), new Date().toISOString());
    }).immediate();
  }

  private assertTaskActive(taskId: string): void {
    const row = this.db.prepare('SELECT status FROM research_tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
    if (row === undefined) throw new Error('research_task_not_found');
    if (row.status !== 'active') throw new Error('research_task_not_active');
  }

  settle(runId: string, callId: string, tokens: number | null, state: 'settled' | 'unknown', outcomeHash?: string,
    outcome: Record<string, unknown> = {}): void {
    if ((tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0)) ||
      (state === 'settled' && tokens === null)) throw new Error('run_call_settlement_invalid');
    this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT envelope_json, state, actual_tokens
        FROM agent_calls WHERE run_id = ? AND call_id = ?`)
        .get(runId, callId) as { envelope_json: string; state: string; actual_tokens: number | null } | undefined;
      if (existing === undefined) throw new Error('run_call_settlement_invalid');
      const receipt = { schemaVersion: 1, runId, callId, tokens, state, outcomeHash: outcomeHash ?? null,
        outcome };
      const receiptHash = hashToolInput(receipt);
      const previous = parseStoredJsonObject(existing.envelope_json, 'run_call_envelope_corrupt');
      if (existing.state !== 'reserved') {
        const recorded = previous.settlementReceipt;
        if (recorded === undefined || hashToolInput(recorded) !== receiptHash ||
          previous.settlementReceiptHash !== receiptHash || existing.state !== state ||
          existing.actual_tokens !== tokens) {
          throw new Error('run_call_settlement_invalid');
        }
        return;
      }
      if ('settlementReceipt' in previous || 'settlementReceiptHash' in previous ||
        'settlementReceipt' in outcome || 'settlementReceiptHash' in outcome) {
        throw new Error('run_call_settlement_invalid');
      }
      const envelope = JSON.stringify({ ...previous, ...(outcomeHash === undefined ? {} : { outcomeHash }),
        ...outcome, settlementReceipt: receipt, settlementReceiptHash: receiptHash });
      const result = this.db.prepare(`UPDATE agent_calls SET actual_tokens = ?, state = ?, envelope_json = ?
        WHERE run_id = ? AND call_id = ? AND state = 'reserved'`).run(
        tokens, state, envelope, runId, callId);
      if (result.changes !== 1) throw new Error('run_call_settlement_invalid');
    }).immediate();
  }

  recordModelObservation(runId: string, callId: string, observation: {startedAt: string; durationMs: number; status: 'completed'|'failed'}): void {
    const row = this.db.prepare('SELECT kind FROM agent_calls WHERE run_id=? AND call_id=?').get(runId, callId) as {kind: string}|undefined;
    if (row?.kind !== 'model') throw new Error('run_model_observation_call_invalid');
    this.db.prepare('INSERT INTO agent_call_observations (run_id,call_id,started_at,duration_ms,status) VALUES (?,?,?,?,?)')
      .run(runId, callId, observation.startedAt, observation.durationMs, observation.status);
  }

  readUsageStatus(runId: string): RunUsageStatus {
    return this.readScopedUsageStatus('run_id', runId);
  }

  readTaskUsageStatus(taskId: string, projectId: string): RunUsageStatus {
    const row = this.db.prepare('SELECT project_id FROM research_tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
    if (row === undefined) throw new Error('research_task_not_found');
    if (row.project_id !== projectId) throw new Error('research_task_project_mismatch');
    return this.readScopedUsageStatus('task_id', taskId);
  }

  private readScopedUsageStatus(column: 'run_id' | 'task_id', id: string): RunUsageStatus {
    const totals = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_tokens ELSE 0 END), 0) settled_tokens,
      COALESCE(SUM(CASE WHEN state = 'unknown' THEN MAX(COALESCE(actual_tokens, 0), reserved_tokens) ELSE 0 END), 0) unknown_tokens,
      COALESCE(SUM(CASE WHEN state = 'reserved' THEN reserved_tokens ELSE 0 END), 0) reserved_tokens,
      COALESCE(SUM(CASE WHEN kind = 'model' THEN 1 ELSE 0 END), 0) model_calls,
      COALESCE(SUM(CASE WHEN kind = 'model' AND state = 'reserved' THEN 1 ELSE 0 END), 0) reserved_models,
      COALESCE(SUM(CASE WHEN kind IN ('tool','child') THEN 1 ELSE 0 END), 0) tool_calls,
      COALESCE(SUM(CASE WHEN kind IN ('tool','child') AND state = 'reserved' THEN 1 ELSE 0 END), 0) reserved_tools,
      COALESCE(SUM(CASE WHEN kind = 'child' THEN 1 ELSE 0 END), 0) child_calls,
      COALESCE(SUM(CASE WHEN kind = 'child' AND state = 'reserved' THEN 1 ELSE 0 END), 0) reserved_children
      FROM agent_calls WHERE ${column} = ?`).get(id) as {
        settled_tokens: number; unknown_tokens: number; reserved_tokens: number;
        model_calls: number; reserved_models: number; tool_calls: number; reserved_tools: number;
        child_calls: number; reserved_children: number;
      };
    return {
      tokens: {
        settled: totals.settled_tokens,
        unknown: totals.unknown_tokens,
        reserved: totals.reserved_tokens
      },
      calls: {
        models: { total: totals.model_calls, reserved: totals.reserved_models },
        tools: { total: totals.tool_calls, reserved: totals.reserved_tools },
        children: { total: totals.child_calls, reserved: totals.reserved_children }
      }
    };
  }

  // Pilot enrollment

  /** Records pilot enrollment, idempotently. */
  recordPilotRun(runId: string, input: {
    taskId: string;
    decision: string;
    disclosure: string;
    profile: 'read-only' | 'low-side-effect' | null;
    bucket: number;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO agent_pilot_runs
      (run_id, task_id, decision, disclosure, profile, bucket, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(
      runId, input.taskId, input.decision, input.disclosure, input.profile, input.bucket,
      now, now);
  }

  readPilotRun(runId: string): PilotRunRow | null {
    const row = this.db.prepare('SELECT * FROM agent_pilot_runs WHERE run_id = ?').get(runId) as PilotRunDbRow | undefined;
    return row === undefined ? null : toPilotRunRow(row);
  }

  latestPilotRun(): PilotRunRow | null {
    const row = this.db.prepare('SELECT * FROM agent_pilot_runs ORDER BY created_at DESC, run_id DESC LIMIT 1')
      .get() as PilotRunDbRow | undefined;
    return row === undefined ? null : toPilotRunRow(row);
  }

  finishPilotRun(runId: string, state: 'finished' | 'cancelled' = 'finished'): void {
    this.db.prepare("UPDATE agent_pilot_runs SET state = ?, updated_at = ? WHERE run_id = ? AND state = 'active'")
      .run(state, new Date().toISOString(), runId);
  }

  readContextControlState(runId: string): {
    acceptanceIds: string[];
    acceptanceConditions: { id: string; description: string }[];
    pendingEffects: string[];
    pendingApprovals: string[];
    pendingCorrections: { id: string; content: string }[];
  } {
    const contractRow = this.db.prepare('SELECT contract_json FROM agent_task_contracts WHERE run_id = ?')
      .get(runId) as { contract_json: string } | undefined;
    if (contractRow === undefined) throw new Error('task_contract_missing');
    const criteria = parseStoredJson(contractRow.contract_json, taskContractSchema, 'task_contract_corrupt').criteria;
    const effects = this.db.prepare(`SELECT tool_call_id FROM agent_tool_effects
      WHERE run_id = ? AND status IN ('reserved','in_progress','unknown') ORDER BY tool_call_id`).all(runId) as { tool_call_id: string }[];
    const approvals = this.db.prepare(`SELECT interrupt_id FROM agent_pending_interrupts
      WHERE run_id = ? ORDER BY position`).all(runId) as { interrupt_id: string }[];
    return {
      acceptanceIds: criteria.map(criterion => criterion.id),
      acceptanceConditions: criteria.map(({ id, description }) => ({ id, description })),
      pendingEffects: effects.map(row => row.tool_call_id),
      pendingApprovals: approvals.map(row => row.interrupt_id),
      pendingCorrections: this.pendingCorrections(runId).map(({ submission_id, content }) => ({ id: submission_id, content }))
    };
  }

  enqueueCorrection(runId: string, submissionId: string, content: string): number {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId) as { status: string } | undefined;
      if (row === undefined || !['dispatch_pending', 'running', 'recovering', 'waiting_user'].includes(row.status)) {
        throw new Error('run_correction_not_active');
      }
      this.db.prepare(`INSERT OR IGNORE INTO agent_run_inbox (run_id, submission_id, content, created_at)
        VALUES (?, ?, ?, ?)`).run(runId, submissionId, content, new Date().toISOString());
      const stored = this.db.prepare('SELECT sequence, content FROM agent_run_inbox WHERE run_id = ? AND submission_id = ?')
        .get(runId, submissionId) as { sequence: number; content: string };
      if (stored.content !== content) throw new Error('run_correction_input_drift');
      return stored.sequence;
    }).immediate();
  }

  pendingCorrections(runId: string): { submission_id: string; content: string }[] {
    return this.db.prepare(`SELECT submission_id, content FROM agent_run_inbox
      WHERE run_id = ? AND consumed_at IS NULL ORDER BY sequence`).all(runId) as { submission_id: string; content: string }[];
  }

  consumeCorrections(runId: string, messageIds: readonly string[]): void {
    const statement = this.db.prepare(`UPDATE agent_run_inbox SET consumed_at = ?
      WHERE run_id = ? AND submission_id = ? AND consumed_at IS NULL`);
    this.db.transaction(() => {
      for (const id of messageIds) {
        if (id.startsWith('roc-correction:')) statement.run(new Date().toISOString(), runId, id.slice('roc-correction:'.length));
      }
    })();
  }

  recordProgress(runId: string, toolName: string, args: unknown, result: unknown, progressScope?: string): void {
    const fingerprint = hashToolInput(progressScope === undefined
      ? { toolName, args, result } : { progressScope, toolName, args, result });
    this.db.prepare('INSERT INTO agent_tool_progress (run_id, fingerprint) VALUES (?, ?)').run(runId, fingerprint);
    const rows = this.db.prepare(`SELECT fingerprint FROM agent_tool_progress WHERE run_id = ?
      ORDER BY sequence DESC LIMIT 10`).all(runId) as { fingerprint: string }[];
    const seen = new Set<string>();
    let withoutProgress = 0;
    for (const row of rows.reverse()) {
      if (seen.has(row.fingerprint)) withoutProgress++;
      else { seen.add(row.fingerprint); withoutProgress = 0; }
    }
    if (withoutProgress >= 2) throw new Error('tool_call_loop_detected');
  }

  freezeRevision(runId: string, revision: unknown): string {
    const hash = hashToolInput(revision);
    const row = this.db.prepare('SELECT revision_hash FROM agent_harness_revisions WHERE run_id = ?').get(runId) as
      { revision_hash: string } | undefined;
    if (row !== undefined) {
      if (row.revision_hash !== hash) throw new Error('run_harness_revision_changed');
      return hash;
    }
    this.db.prepare('INSERT INTO agent_harness_revisions (run_id, revision_hash, revision_json) VALUES (?, ?, ?)')
      .run(runId, hash, JSON.stringify(revision));
    return hash;
  }
}

function toPilotRunRow(row: PilotRunDbRow): PilotRunRow {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    decision: row.decision,
    disclosure: row.disclosure,
    profile: row.profile,
    bucket: row.bucket,
    state: row.state,
    createdAt: row.created_at
  };
}

/**
 * Stored JSON columns are written by this class, so a parse failure means corrupted state rather
 * than untrusted input. Fail with a named code so the run's failure mapping stays meaningful
 * instead of surfacing a bare SyntaxError.
 */
