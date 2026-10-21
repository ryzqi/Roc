import { createHash } from 'node:crypto';
import type { Database as DatabaseConnection } from 'better-sqlite3';
import { canonicalJson } from './surface';

/**
 * P5-05: an offline cost ledger. Unlike the product ledger, the fixture declares an explicit price
 * so totals can be compared between candidates. The price is a synthetic constant, never a claim
 * about a real provider.
 */
export const fixturePrice = {
  microusdPerToken: 12,
  basis: 'synthetic fixture price; not a product or provider price'
} as const;

export const optimizerCallKinds = ['model', 'tool', 'child', 'summary', 'selection', 'reflection', 'judge', 'retry'] as const;
export type OptimizerCallKind = (typeof optimizerCallKinds)[number];

export type CallReservation = {
  experimentId: string;
  stage: string;
  callId: string;
  attempt?: number;
  parentCallId?: string | null;
  kind: OptimizerCallKind;
  tokens: number;
  inputHash: string;
  maxMicrousd?: number | null;
};

export type CallReceipt = {
  callId: string;
  attempt: number;
  state: 'reserved' | 'settled' | 'unknown' | 'budget_stopped';
  reused: boolean;
  reservedTokens: number;
  reservedMicrousd: number;
};

type CallRow = {
  stage: string;
  call_id: string;
  attempt: number;
  parent_call_id: string | null;
  kind: string;
  input_hash: string;
  reserved_tokens: number;
  actual_tokens: number | null;
  cost_microusd: number;
  state: string;
};

const schema = `
CREATE TABLE IF NOT EXISTS opt_experiments (
  id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opt_calls (
  experiment_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  call_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  parent_call_id TEXT,
  kind TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  actual_tokens INTEGER,
  cost_microusd INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (experiment_id, call_id, attempt)
);
`;

export class OptimizerCostLedger {
  constructor(private readonly db: DatabaseConnection) {
    db.exec(schema);
  }

  createExperiment(id: string, manifestHash: string): void {
    this.db.prepare('INSERT OR IGNORE INTO opt_experiments (id, manifest_hash, created_at) VALUES (?, ?, ?)')
      .run(id, manifestHash, new Date().toISOString());
  }

  /**
   * Reservation is idempotent per (experiment, call, attempt). A repeated call returns the existing
   * receipt instead of inserting a second row, so resuming an experiment cannot double-charge it.
   */
  reserve(input: CallReservation): CallReceipt {
    const attempt = input.attempt ?? 1;
    const existing = this.db.prepare(`SELECT stage, call_id, attempt, parent_call_id, kind, input_hash,
      reserved_tokens, actual_tokens, cost_microusd, state FROM opt_calls
      WHERE experiment_id = ? AND call_id = ? AND attempt = ?`).get(input.experimentId, input.callId, attempt) as CallRow | undefined;
    if (existing !== undefined) {
      if (existing.input_hash !== input.inputHash || existing.kind !== input.kind
        || existing.reserved_tokens !== input.tokens) {
        throw new Error(`optimizer_call_input_drift:${input.callId}`);
      }
      return {
        callId: existing.call_id, attempt: existing.attempt, state: existing.state as CallReceipt['state'], reused: true,
        reservedTokens: existing.reserved_tokens,
        reservedMicrousd: existing.cost_microusd
      };
    }
    const reservedMicrousd = input.tokens * fixturePrice.microusdPerToken;
    const totals = this.totals(input.experimentId);
    if (input.maxMicrousd !== null && input.maxMicrousd !== undefined && totals.costMicrousd + reservedMicrousd > input.maxMicrousd) {
      // The stop itself is still recorded so a report can account for the call that hit the limit.
      this.db.prepare(`INSERT INTO opt_calls (experiment_id, stage, call_id, attempt, parent_call_id, kind,
        input_hash, reserved_tokens, actual_tokens, cost_microusd, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'budget_stopped', ?)`)
        .run(input.experimentId, input.stage, input.callId, attempt, input.parentCallId ?? null, input.kind,
          input.inputHash, input.tokens, input.tokens, reservedMicrousd, new Date().toISOString());
      throw new Error(`optimizer_budget_exhausted:${input.callId}`);
    }
    this.db.prepare(`INSERT INTO opt_calls (experiment_id, stage, call_id, attempt, parent_call_id, kind,
      input_hash, reserved_tokens, actual_tokens, cost_microusd, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'reserved', ?)`)
      .run(input.experimentId, input.stage, input.callId, attempt, input.parentCallId ?? null, input.kind,
        input.inputHash, input.tokens, reservedMicrousd, new Date().toISOString());
    return { callId: input.callId, attempt, state: 'reserved', reused: false,
      reservedTokens: input.tokens, reservedMicrousd };
  }

  settle(input: { experimentId: string; callId: string; attempt?: number; actualTokens: number | null; state?: 'settled' | 'unknown' }): void {
    const attempt = input.attempt ?? 1;
    const tokens = input.actualTokens;
    const cost = tokens === null ? null : tokens * fixturePrice.microusdPerToken;
    const result = this.db.prepare(`UPDATE opt_calls SET actual_tokens = ?,
      cost_microusd = COALESCE(?, cost_microusd), state = ?
      WHERE experiment_id = ? AND call_id = ? AND attempt = ? AND state = 'reserved'`)
      .run(tokens, cost, input.state ?? 'settled', input.experimentId, input.callId, attempt);
    if (result.changes !== 1) throw new Error(`optimizer_settlement_invalid:${input.callId}`);
  }

  /** Convenience for fixture calls that are known to complete immediately. */
  record(input: CallReservation & { actualTokens: number | null; state?: 'settled' | 'unknown' }): CallReceipt {
    const receipt = this.reserve(input);
    if (receipt.state !== 'reserved') return receipt;
    const state = input.state ?? 'settled';
    this.settle({ experimentId: input.experimentId, callId: input.callId,
      attempt: receipt.attempt, actualTokens: input.actualTokens, state });
    return { ...receipt, state };
  }

  totals(experimentId: string): {
    calls: number; tokens: number; costMicrousd: number;
    byKind: Record<string, number>; byStage: Record<string, number>;
  } {
    const rows = this.db.prepare(`SELECT kind, stage, reserved_tokens, actual_tokens, cost_microusd, state
      FROM opt_calls WHERE experiment_id = ?`).all(experimentId) as Pick<CallRow,
      'stage' | 'kind' | 'reserved_tokens' | 'actual_tokens' | 'cost_microusd' | 'state'>[];
    const byKind: Record<string, number> = {};
    const byStage: Record<string, number> = {};
    let tokens = 0;
    let costMicrousd = 0;
    for (const row of rows) {
      // A stopped or unknown call still consumed its reservation; it is never counted as zero.
      const used = row.actual_tokens ?? row.reserved_tokens;
      tokens += used;
      costMicrousd += row.cost_microusd;
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      byStage[row.stage] = (byStage[row.stage] ?? 0) + 1;
    }
    return { calls: rows.length, tokens, costMicrousd, byKind, byStage };
  }

  /** Every call row with its stage/kind/parent, so a report line maps back to one ledger entry. */
  report(experimentId: string): CallRow[] {
    return this.db.prepare(`SELECT stage, call_id, attempt, parent_call_id, kind, input_hash,
      reserved_tokens, actual_tokens, cost_microusd, state FROM opt_calls
      WHERE experiment_id = ? ORDER BY created_at, call_id, attempt`).all(experimentId) as CallRow[];
  }

  /** Digest of the call table, used to prove a resume did not change accounting. */
  reportHash(experimentId: string): string {
    return createHash('sha256').update(canonicalJson(this.report(experimentId))).digest('hex');
  }
}
