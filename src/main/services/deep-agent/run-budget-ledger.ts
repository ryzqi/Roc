import type { Database as DatabaseConnection } from 'better-sqlite3';
import type { RunBudgetStatus, RunExecutionSnapshot } from '../../../shared/types';
import { taskContractSchema } from '../../../shared/schemas/task-acceptance';
import { parseStoredJson, parseStoredJsonObject } from '../../infrastructure/stored-json';
import { hashToolInput } from './tool-effect-store';
import { runBudgetSchema } from '../../../shared/schemas/agent';

export type RunLimits = RunExecutionSnapshot['budget'];
type Reservation = {
  id: string;
  kind: 'model' | 'tool' | 'child';
  tokens: number;
  inputHash: string;
  envelope: unknown;
  costMicrousd?: number | null;
  pricingVersion?: string | null;
};

/** The durable pilot grant for one run, plus what it has spent so far. */
export type PilotRunRow = {
  runId: string;
  taskId: string;
  decision: string;
  disclosure: string;
  profile: 'read-only' | 'low-side-effect' | null;
  bucket: number;
  extraBudgetMicrousd: number;
  allowance: { modelCalls: number; toolCalls: number; totalTokens: number };
  spent: { modelCalls: number; toolCalls: number; totalTokens: number };
  state: 'active' | 'exhausted' | 'finished' | 'cancelled';
  createdAt: string;
};

/** Internal marker: the public error is raised after the reservation transaction rolls back. */
class PilotAllowanceExhausted extends Error {
  constructor() {
    super('pilot_allowance_exhausted');
    this.name = 'PilotAllowanceExhausted';
  }
}

type PilotRunDbRow = {
  run_id: string; task_id: string; decision: string; disclosure: string; profile: PilotRunRow['profile']; bucket: number;
  extra_budget_microusd: number; allowance_model_calls: number; allowance_tool_calls: number;
  allowance_tokens: number; spent_model_calls: number; spent_tool_calls: number; spent_tokens: number;
  state: PilotRunRow['state']; created_at: string;
};

/** One durable ledger per root run, shared by retries, summaries and child agents. */
export class RunBudgetLedger {
  constructor(private readonly db: DatabaseConnection) {}

  reconcileStartup(): void {
    this.db.prepare("UPDATE agent_budget_calls SET state = 'unknown' WHERE state = 'reserved'").run();
  }

  reserve(runId: string, limits: RunLimits, input: Reservation): void {
    try {
      this.reserveWithinTransaction(runId, limits, input);
    } catch (error) {
      // The exhausted marker cannot live inside the rolled-back reservation transaction, so it is
      // written here: the run is refused, and the next attempt (and the breaker) can see why.
      if (error instanceof PilotAllowanceExhausted) {
        this.db.prepare("UPDATE agent_pilot_runs SET state = 'exhausted', updated_at = ? WHERE run_id = ?")
          .run(new Date().toISOString(), runId);
        throw new Error('run_pilot_allowance_exhausted');
      }
      throw error;
    }
  }

  private reserveWithinTransaction(runId: string, limits: RunLimits, input: Reservation): void {
    this.db.transaction(() => {
      if (Date.now() >= Date.parse(limits.deadlineAt)) throw new Error('run_deadline_exhausted');
      const existing = this.db.prepare('SELECT input_hash FROM agent_budget_calls WHERE run_id = ? AND call_id = ?')
        .get(runId, input.id) as { input_hash: string } | undefined;
      if (existing !== undefined) {
        if (existing.input_hash !== input.inputHash) throw new Error('run_budget_call_input_drift');
        throw new Error('run_budget_call_already_reserved');
      }
      if (!Number.isSafeInteger(input.tokens) || input.tokens < 0 ||
        (input.costMicrousd !== null && input.costMicrousd !== undefined &&
          (!Number.isSafeInteger(input.costMicrousd) || input.costMicrousd < 0))) {
        throw new Error('run_budget_reservation_invalid');
      }
      const execution = this.db.prepare("SELECT kind, task_id FROM research_task_executions WHERE execution_id = ? AND kind IN ('chat','stage')")
        .get(runId) as { kind: 'chat' | 'stage'; task_id: string } | undefined;
      if (execution === undefined && this.db.prepare('SELECT 1 FROM agent_runs WHERE id = ?').get(runId) === undefined) {
        throw new Error('run_budget_execution_unlinked');
      }
      if (execution !== undefined) this.assertTaskReservation(execution.task_id, input);
      const totals = this.db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN kind = 'model' THEN 1 ELSE 0 END), 0) model_calls,
        COALESCE(SUM(CASE WHEN kind IN ('tool', 'child') THEN 1 ELSE 0 END), 0) tool_calls,
        COALESCE(SUM(COALESCE(actual_tokens, reserved_tokens)), 0) tokens,
        COALESCE(SUM(CASE WHEN kind = 'model' AND state = 'reserved' THEN 1 ELSE 0 END), 0) active_models,
        COALESCE(SUM(CASE WHEN kind = 'tool' AND state = 'reserved' THEN 1 ELSE 0 END), 0) active_tools,
        COALESCE(SUM(CASE WHEN kind = 'child' THEN 1 ELSE 0 END), 0) child_calls,
        COALESCE(SUM(CASE WHEN kind = 'child' AND state = 'reserved' THEN 1 ELSE 0 END), 0) active_children,
        COALESCE(SUM(COALESCE(actual_cost_microusd, reserved_cost_microusd)), 0) cost_microusd,
        COALESCE(SUM(CASE WHEN kind = 'model' AND actual_cost_microusd IS NULL AND reserved_cost_microusd IS NULL THEN 1 ELSE 0 END), 0) unknown_cost_calls
        FROM agent_budget_calls WHERE run_id = ?`).get(runId) as {
          model_calls: number; tool_calls: number; tokens: number; active_models: number; active_tools: number;
          child_calls: number; active_children: number; cost_microusd: number; unknown_cost_calls: number;
        };
      if (input.kind === 'model' && totals.active_models >= limits.maxConcurrentModelCalls) throw new Error('run_model_concurrency_exhausted');
      if (input.kind === 'tool' && totals.active_tools >= limits.maxConcurrentToolCalls) throw new Error('run_tool_concurrency_exhausted');
      if (input.kind === 'child' && totals.child_calls >= limits.maxChildTasks) throw new Error('run_child_task_budget_exhausted');
      if (input.kind === 'child' && totals.active_children >= limits.maxConcurrentChildTasks) throw new Error('run_child_task_concurrency_exhausted');
      // A started pilot run gets bounded extra headroom above the frozen budget. Without a pilot
      // grant these branches throw exactly what they threw before, so ordinary requests are
      // unchanged; with a grant the overshoot is metered and the breaker trips when it runs out.
      if (input.kind === 'model' && totals.model_calls >= limits.maxModelCalls) {
        this.consumePilotAllowance(runId, 'model', input.tokens, 'run_model_call_budget_exhausted');
      }
      if (input.kind !== 'model' && totals.tool_calls >= limits.maxToolCalls) {
        this.consumePilotAllowance(runId, 'tool', 0, 'run_tool_call_budget_exhausted');
      }
      if (input.kind === 'model' && input.tokens > limits.maxCallTokens) {
        throw new Error('run_model_call_token_reservation_exhausted');
      }
      if (input.tokens > limits.maxTotalTokens - totals.tokens) {
        this.consumePilotAllowance(runId, 'token', input.tokens, 'run_total_token_budget_exhausted');
      }
      if (input.kind === 'model' && limits.maxCostMicrousd !== null) {
        if (input.costMicrousd === null || input.costMicrousd === undefined || totals.unknown_cost_calls > 0) {
          throw new Error('run_cost_estimate_unavailable');
        }
        if (input.costMicrousd > limits.maxCostMicrousd - totals.cost_microusd) {
          throw new Error('run_cost_budget_exhausted');
        }
      }
      this.db.prepare(`INSERT INTO agent_budget_calls
        (run_id, call_id, execution_kind, task_id, kind, input_hash, reserved_tokens, reserved_cost_microusd, pricing_version, state, envelope_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`).run(
        runId, input.id, execution?.kind ?? 'chat', execution?.task_id ?? null, input.kind, input.inputHash, input.tokens, input.costMicrousd ?? null,
        input.pricingVersion ?? null, JSON.stringify(input.envelope), new Date().toISOString());
    }).immediate();
  }

  private assertTaskReservation(taskId: string, input: Reservation): void {
    const row = this.db.prepare(`SELECT b.limits_json,b.stop_reason,json_extract(t.snapshot_json,'$.status') status
      FROM research_task_budgets b JOIN research_tasks t ON t.id = b.task_id WHERE b.task_id = ?`)
      .get(taskId) as { limits_json: string; stop_reason: string | null; status: string } | undefined;
    if (row === undefined) throw new Error('research_task_budget_missing');
    if (row.status !== 'active') throw new Error('research_task_not_active');
    if (row.stop_reason !== null) throw new Error(row.stop_reason);
    const limits = runBudgetSchema.parse(JSON.parse(row.limits_json));
    if (Date.now() >= Date.parse(limits.deadlineAt)) throw new Error('run_deadline_exhausted');
    const totals = this.db.prepare(`SELECT
      COALESCE(SUM(kind = 'model'),0) models, COALESCE(SUM(kind IN ('tool','child')),0) tools,
      COALESCE(SUM(kind = 'child'),0) children,
      COALESCE(SUM(kind = 'model' AND state = 'reserved'),0) active_models,
      COALESCE(SUM(kind = 'tool' AND state = 'reserved'),0) active_tools,
      COALESCE(SUM(kind = 'child' AND state = 'reserved'),0) active_children,
      COALESCE(SUM(COALESCE(actual_tokens,reserved_tokens)),0) tokens,
      COALESCE(SUM(COALESCE(actual_cost_microusd,reserved_cost_microusd)),0) cost,
      COALESCE(SUM(kind = 'model' AND actual_cost_microusd IS NULL AND reserved_cost_microusd IS NULL),0) unknown_costs
      FROM agent_budget_calls WHERE task_id = ?`).get(taskId) as {
        models: number; tools: number; children: number; active_models: number; active_tools: number;
        active_children: number; tokens: number; cost: number; unknown_costs: number;
      };
    if (input.kind === 'model' && totals.models >= limits.maxModelCalls) throw new Error('run_model_call_budget_exhausted');
    if (input.kind !== 'model' && totals.tools >= limits.maxToolCalls) throw new Error('run_tool_call_budget_exhausted');
    if (input.kind === 'model' && totals.active_models >= limits.maxConcurrentModelCalls) throw new Error('run_model_concurrency_exhausted');
    if (input.kind === 'tool' && totals.active_tools >= limits.maxConcurrentToolCalls) throw new Error('run_tool_concurrency_exhausted');
    if (input.kind === 'child' && totals.children >= limits.maxChildTasks) throw new Error('run_child_task_budget_exhausted');
    if (input.kind === 'child' && totals.active_children >= limits.maxConcurrentChildTasks) throw new Error('run_child_task_concurrency_exhausted');
    if (input.kind === 'model' && input.tokens > limits.maxCallTokens) throw new Error('run_model_call_token_reservation_exhausted');
    if (input.tokens > limits.maxTotalTokens - totals.tokens) throw new Error('run_total_token_budget_exhausted');
    if (input.kind === 'model' && limits.maxCostMicrousd !== null) {
      if (input.costMicrousd === null || input.costMicrousd === undefined || totals.unknown_costs > 0) {
        throw new Error('run_cost_estimate_unavailable');
      }
      if (input.costMicrousd > limits.maxCostMicrousd - totals.cost) throw new Error('run_cost_budget_exhausted');
    }
  }

  settle(runId: string, callId: string, tokens: number | null, state: 'settled' | 'unknown', outcomeHash?: string,
    outcome: Record<string, unknown> = {}, costMicrousd: number | null = null, pricingVersion: string | null = null): void {
    if ((tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0)) ||
      (costMicrousd !== null && (!Number.isSafeInteger(costMicrousd) || costMicrousd < 0)) ||
      (state === 'settled' && tokens === null)) throw new Error('run_budget_settlement_invalid');
    const existing = this.db.prepare('SELECT envelope_json FROM agent_budget_calls WHERE run_id = ? AND call_id = ?')
      .get(runId, callId) as { envelope_json: string } | undefined;
    if (existing === undefined) throw new Error('run_budget_settlement_invalid');
    const envelope = JSON.stringify({
      ...parseStoredJsonObject(existing.envelope_json, 'run_budget_envelope_corrupt'),
      ...(outcomeHash === undefined ? {} : { outcomeHash }),
      ...outcome
    });
    const result = this.db.prepare(`UPDATE agent_budget_calls SET actual_tokens = ?, actual_cost_microusd = ?,
      pricing_version = COALESCE(?, pricing_version), state = ?, envelope_json = ?
      WHERE run_id = ? AND call_id = ? AND state = 'reserved'`).run(
      tokens, costMicrousd, pricingVersion, state, envelope, runId, callId);
    if (result.changes !== 1) throw new Error('run_budget_settlement_invalid');
  }

  recordStopReason(runId: string, reason: string): void {
    this.db.prepare('UPDATE agent_runs SET budget_stop_reason = COALESCE(budget_stop_reason, ?) WHERE id = ?')
      .run(reason.slice(0, 128), runId);
    if (reason.includes('_concurrency_exhausted')) return;
    this.db.prepare(`UPDATE research_task_budgets SET stop_reason = COALESCE(stop_reason, ?)
      WHERE task_id IN (SELECT task_id FROM research_task_executions WHERE execution_id = ? AND kind IN ('chat','stage'))`)
      .run(reason.slice(0, 128), runId);
  }

  readBudgetStatus(runId: string, limits: RunLimits, modelPricingKnown: boolean): RunBudgetStatus {
    const totals = this.db.prepare(`SELECT
      COALESCE(SUM(COALESCE(actual_tokens, reserved_tokens)), 0) total_tokens,
      COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_tokens ELSE 0 END), 0) settled_tokens,
      COALESCE(SUM(CASE WHEN state = 'unknown' THEN reserved_tokens ELSE 0 END), 0) unknown_tokens,
      COALESCE(SUM(CASE WHEN state = 'reserved' THEN reserved_tokens ELSE 0 END), 0) reserved_tokens,
      COALESCE(SUM(CASE WHEN kind = 'model' THEN 1 ELSE 0 END), 0) model_calls,
      COALESCE(SUM(CASE WHEN kind = 'model' AND state = 'reserved' THEN 1 ELSE 0 END), 0) reserved_models,
      COALESCE(SUM(CASE WHEN kind IN ('tool','child') THEN 1 ELSE 0 END), 0) tool_calls,
      COALESCE(SUM(CASE WHEN kind IN ('tool','child') AND state = 'reserved' THEN 1 ELSE 0 END), 0) reserved_tools,
      COALESCE(SUM(CASE WHEN kind = 'child' THEN 1 ELSE 0 END), 0) child_calls,
      COALESCE(SUM(CASE WHEN kind = 'child' AND state = 'reserved' THEN 1 ELSE 0 END), 0) reserved_children,
      COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_cost_microusd ELSE 0 END), 0) settled_cost,
      COALESCE(SUM(CASE WHEN state IN ('reserved','unknown') THEN COALESCE(actual_cost_microusd,reserved_cost_microusd,0) ELSE 0 END), 0) reserved_cost,
      COALESCE(SUM(CASE WHEN kind = 'model' AND (state = 'unknown' OR COALESCE(actual_cost_microusd,reserved_cost_microusd) IS NULL) THEN 1 ELSE 0 END), 0) unknown_cost_calls
      FROM agent_budget_calls WHERE run_id = ?`).get(runId) as {
        total_tokens: number; settled_tokens: number; unknown_tokens: number; reserved_tokens: number;
        model_calls: number; reserved_models: number; tool_calls: number; reserved_tools: number;
        child_calls: number; reserved_children: number; settled_cost: number; reserved_cost: number;
        unknown_cost_calls: number;
      };
    const row = this.db.prepare(`SELECT COALESCE(b.stop_reason,r.budget_stop_reason) budget_stop_reason
      FROM agent_runs r
      LEFT JOIN research_task_executions e ON e.kind = 'chat' AND e.execution_id = r.id
      LEFT JOIN research_task_budgets b ON b.task_id = e.task_id WHERE r.id = ?
      UNION ALL
      SELECT b.stop_reason budget_stop_reason FROM research_task_executions e
      JOIN research_task_budgets b ON b.task_id = e.task_id
      WHERE e.kind = 'stage' AND e.execution_id = ?`).get(runId, runId) as
      { budget_stop_reason: string | null } | undefined;
    if (row === undefined) throw new Error('task_run_not_found');
    return {
      tokens: {
        limit: limits.maxTotalTokens,
        settled: totals.settled_tokens,
        unknown: totals.unknown_tokens,
        reserved: totals.reserved_tokens,
        remaining: Math.max(0, limits.maxTotalTokens - totals.total_tokens)
      },
      calls: {
        models: { limit: limits.maxModelCalls, total: totals.model_calls, reserved: totals.reserved_models },
        tools: { limit: limits.maxToolCalls, total: totals.tool_calls, reserved: totals.reserved_tools },
        children: { limit: limits.maxChildTasks, total: totals.child_calls, reserved: totals.reserved_children }
      },
      cost: {
        state: !modelPricingKnown || totals.unknown_cost_calls > 0 ? 'unknown' : 'known',
        limitMicrousd: limits.maxCostMicrousd,
        settledMicrousd: totals.settled_cost,
        reservedMicrousd: totals.reserved_cost
      },
      pricingCatalogVersion: limits.pricingCatalogVersion,
      deadlineAt: limits.deadlineAt,
      stopReason: row.budget_stop_reason
    };
  }

  // --- P6-04 pilot allowance -----------------------------------------------------------------

  /** Records the granted headroom for a run that the pilot gate started. Idempotent per run. */
  grantPilotAllowance(runId: string, input: {
    taskId: string;
    decision: string;
    disclosure: string;
    profile: 'read-only' | 'low-side-effect' | null;
    bucket: number;
    extraBudgetMicrousd: number;
    allowance: { modelCalls: number; toolCalls: number; totalTokens: number };
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO agent_pilot_runs
      (run_id, task_id, decision, disclosure, profile, bucket, extra_budget_microusd,
       allowance_model_calls, allowance_tool_calls, allowance_tokens, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(
      runId, input.taskId, input.decision, input.disclosure, input.profile, input.bucket,
      input.extraBudgetMicrousd, input.allowance.modelCalls, input.allowance.toolCalls,
      input.allowance.totalTokens, now, now);
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

  finishPilotRun(runId: string, state: 'finished' | 'exhausted' | 'cancelled' = 'finished'): void {
    this.db.prepare("UPDATE agent_pilot_runs SET state = ?, updated_at = ? WHERE run_id = ? AND state = 'active'")
      .run(state, new Date().toISOString(), runId);
  }

  /**
   * Metered overshoot above the frozen budget. Called only when a base limit is already reached, so
   * a run without a pilot grant throws the original budget error and nothing changes for it.
   */
  private consumePilotAllowance(
    runId: string,
    kind: 'model' | 'tool' | 'token',
    tokens: number,
    baseError: string
  ): void {
    const row = this.db.prepare('SELECT * FROM agent_pilot_runs WHERE run_id = ?').get(runId) as PilotRunDbRow | undefined;
    if (row === undefined || row.state !== 'active') throw new Error(baseError);
    const spentModel = row.spent_model_calls + (kind === 'model' ? 1 : 0);
    const spentTools = row.spent_tool_calls + (kind === 'tool' ? 1 : 0);
    const spentTokens = row.spent_tokens + (kind === 'token' ? tokens : 0);
    const exhausted = spentModel > row.allowance_model_calls
      || spentTools > row.allowance_tool_calls
      || spentTokens > row.allowance_tokens;
    if (exhausted) {
      throw new PilotAllowanceExhausted();
    }
    this.db.prepare(`UPDATE agent_pilot_runs SET spent_model_calls = ?, spent_tool_calls = ?, spent_tokens = ?,
      updated_at = ? WHERE run_id = ?`).run(spentModel, spentTools, spentTokens, new Date().toISOString(), runId);
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

function toPilotRunRow(row: PilotRunDbRow): PilotRunRow {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    decision: row.decision,
    disclosure: row.disclosure,
    profile: row.profile,
    bucket: row.bucket,
    extraBudgetMicrousd: row.extra_budget_microusd,
    allowance: {
      modelCalls: row.allowance_model_calls,
      toolCalls: row.allowance_tool_calls,
      totalTokens: row.allowance_tokens
    },
    spent: {
      modelCalls: row.spent_model_calls,
      toolCalls: row.spent_tool_calls,
      totalTokens: row.spent_tokens
    },
    state: row.state,
    createdAt: row.created_at
  };
}

/**
 * Stored JSON columns are written by this class, so a parse failure means corrupted state rather
 * than untrusted input. Fail with a named code so the run's failure mapping stays meaningful
 * instead of surfacing a bare SyntaxError.
 */
