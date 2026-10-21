import type { Database as DatabaseConnection } from 'better-sqlite3';
import type { RunExecutionSnapshot } from '../../../shared/types';
import { hashToolInput } from './tool-effect-store';

export type RunLimits = RunExecutionSnapshot['budget'];
type Reservation = { id: string; kind: 'model' | 'tool' | 'child'; tokens: number; inputHash: string; envelope: unknown };

/** One durable ledger per root run, shared by retries, summaries and child agents. */
export class RunBudgetLedger {
  constructor(private readonly db: DatabaseConnection) {}

  reconcileStartup(): void {
    this.db.prepare("UPDATE agent_budget_calls SET state = 'unknown' WHERE state = 'reserved'").run();
  }

  reserve(runId: string, limits: RunLimits, input: Reservation): void {
    this.db.transaction(() => {
      if (limits.deadlineAt !== null && Date.now() >= Date.parse(limits.deadlineAt)) throw new Error('run_deadline_exhausted');
      const existing = this.db.prepare('SELECT input_hash FROM agent_budget_calls WHERE run_id = ? AND call_id = ?')
        .get(runId, input.id) as { input_hash: string } | undefined;
      if (existing !== undefined) {
        if (existing.input_hash !== input.inputHash) throw new Error('run_budget_call_input_drift');
        throw new Error('run_budget_call_already_reserved');
      }
      const totals = this.db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN kind = 'model' THEN 1 ELSE 0 END), 0) model_calls,
        COALESCE(SUM(CASE WHEN kind IN ('tool', 'child') THEN 1 ELSE 0 END), 0) tool_calls,
        COALESCE(SUM(COALESCE(actual_tokens, reserved_tokens)), 0) tokens,
        COALESCE(SUM(CASE WHEN kind = 'model' AND state = 'reserved' THEN 1 ELSE 0 END), 0) active_models,
        COALESCE(SUM(CASE WHEN kind = 'tool' AND state = 'reserved' THEN 1 ELSE 0 END), 0) active_tools
        FROM agent_budget_calls WHERE run_id = ?`).get(runId) as { model_calls: number; tool_calls: number; tokens: number; active_models: number; active_tools: number };
      if (input.kind === 'model' && totals.active_models >= limits.maxConcurrentModelCalls) throw new Error('run_model_concurrency_exhausted');
      if (input.kind === 'tool' && totals.active_tools >= limits.maxConcurrentToolCalls) throw new Error('run_tool_concurrency_exhausted');
      if (input.kind === 'model' && totals.model_calls >= limits.maxModelCalls) throw new Error('run_model_call_budget_exhausted');
      if (input.kind !== 'model' && totals.tool_calls >= limits.maxToolCalls) throw new Error('run_tool_call_budget_exhausted');
      if (limits.maxTotalTokens !== null && totals.tokens + input.tokens > limits.maxTotalTokens) {
        throw new Error('run_total_token_budget_exhausted');
      }
      // No price table is configured yet. A cost limit must fail closed rather than count unknown as zero.
      if (input.kind === 'model' && limits.maxCostUsd !== null) throw new Error('run_cost_estimate_unavailable');
      this.db.prepare(`INSERT INTO agent_budget_calls
        (run_id, call_id, kind, input_hash, reserved_tokens, state, envelope_json, created_at)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`)
        .run(runId, input.id, input.kind, input.inputHash, input.tokens, JSON.stringify(input.envelope), new Date().toISOString());
    }).immediate();
  }

  settle(runId: string, callId: string, tokens: number | null, state: 'settled' | 'unknown'): void {
    const result = this.db.prepare(`UPDATE agent_budget_calls SET actual_tokens = ?, state = ?
      WHERE run_id = ? AND call_id = ? AND state = 'reserved'`).run(tokens, state, runId, callId);
    if (result.changes !== 1) throw new Error('run_budget_settlement_invalid');
  }

  readContextControlState(runId: string): { acceptanceIds: string[]; pendingEffects: string[]; pendingApprovals: string[] } {
    const effects = this.db.prepare(`SELECT tool_call_id FROM agent_tool_effects
      WHERE run_id = ? AND status IN ('reserved','in_progress','unknown') ORDER BY tool_call_id`).all(runId) as { tool_call_id: string }[];
    const approvals = this.db.prepare(`SELECT interrupt_id FROM agent_pending_interrupts
      WHERE run_id = ? ORDER BY position`).all(runId) as { interrupt_id: string }[];
    return { acceptanceIds: [], pendingEffects: effects.map(row => row.tool_call_id),
      pendingApprovals: approvals.map(row => row.interrupt_id) };
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

  recordProgress(runId: string, toolName: string, args: unknown, result: unknown): void {
    const fingerprint = hashToolInput({ toolName, args, result });
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
