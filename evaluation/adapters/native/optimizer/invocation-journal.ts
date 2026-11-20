import { createHash } from 'node:crypto';
import type { Database as DatabaseConnection } from 'better-sqlite3';
import { canonicalJson } from './surface';

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
};

export type CallReceipt = {
  callId: string;
  attempt: number;
  state: 'reserved' | 'settled' | 'unknown';
  reused: boolean;
  reservedTokens: number;
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
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (experiment_id, call_id, attempt)
);
`;

export class OptimizerInvocationJournal {
  constructor(private readonly db: DatabaseConnection) {
    db.exec(schema);
  }

  createExperiment(id: string, manifestHash: string): void {
    this.db.prepare('INSERT OR IGNORE INTO opt_experiments (id, manifest_hash, created_at) VALUES (?, ?, ?)')
      .run(id, manifestHash, new Date().toISOString());
  }

  /**
   * Reservation is idempotent per (experiment, call, attempt). A repeated call returns the existing
   * receipt instead of inserting a second row, so resuming an experiment cannot duplicate it.
   */
  reserve(input: CallReservation): CallReceipt {
    const attempt = input.attempt ?? 1;
    const existing = this.db.prepare(`SELECT stage, call_id, attempt, parent_call_id, kind, input_hash,
      reserved_tokens, actual_tokens, state FROM opt_calls
      WHERE experiment_id = ? AND call_id = ? AND attempt = ?`).get(input.experimentId, input.callId, attempt) as CallRow | undefined;
    if (existing !== undefined) {
      if (existing.input_hash !== input.inputHash || existing.kind !== input.kind
        || existing.reserved_tokens !== input.tokens) {
        throw new Error(`optimizer_call_input_drift:${input.callId}`);
      }
      return {
        callId: existing.call_id, attempt: existing.attempt, state: existing.state as CallReceipt['state'], reused: true,
        reservedTokens: existing.reserved_tokens,
      };
    }
    this.db.prepare(`INSERT INTO opt_calls (experiment_id, stage, call_id, attempt, parent_call_id, kind,
      input_hash, reserved_tokens, actual_tokens, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'reserved', ?)`)
      .run(input.experimentId, input.stage, input.callId, attempt, input.parentCallId ?? null, input.kind,
        input.inputHash, input.tokens, new Date().toISOString());
    return { callId: input.callId, attempt, state: 'reserved', reused: false,
      reservedTokens: input.tokens };
  }

  settle(input: { experimentId: string; callId: string; attempt?: number; actualTokens: number | null; state?: 'settled' | 'unknown' }): void {
    const attempt = input.attempt ?? 1;
    const tokens = input.actualTokens;
    const result = this.db.prepare(`UPDATE opt_calls SET actual_tokens = ?, state = ?
      WHERE experiment_id = ? AND call_id = ? AND attempt = ? AND state = 'reserved'`)
      .run(tokens, input.state ?? 'settled', input.experimentId, input.callId, attempt);
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
    calls: number; tokens: number;
    byKind: Record<string, number>; byStage: Record<string, number>;
  } {
    const rows = this.db.prepare(`SELECT kind, stage, reserved_tokens, actual_tokens, state
      FROM opt_calls WHERE experiment_id = ?`).all(experimentId) as Pick<CallRow,
      'stage' | 'kind' | 'reserved_tokens' | 'actual_tokens' | 'state'>[];
    const byKind: Record<string, number> = {};
    const byStage: Record<string, number> = {};
    let tokens = 0;
    for (const row of rows) {
      // Keep the input estimate when a provider omits usage.
      const used = row.actual_tokens ?? row.reserved_tokens;
      tokens += used;
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      byStage[row.stage] = (byStage[row.stage] ?? 0) + 1;
    }
    return { calls: rows.length, tokens, byKind, byStage };
  }

  /** Every call row with its stage/kind/parent, so a report line maps back to one ledger entry. */
  report(experimentId: string): CallRow[] {
    return this.db.prepare(`SELECT stage, call_id, attempt, parent_call_id, kind, input_hash,
      reserved_tokens, actual_tokens, state FROM opt_calls
      WHERE experiment_id = ? ORDER BY created_at, call_id, attempt`).all(experimentId) as CallRow[];
  }

  /** Digest of the call table, used to prove a resume did not change accounting. */
  reportHash(experimentId: string): string {
    return createHash('sha256').update(canonicalJson(this.report(experimentId))).digest('hex');
  }
}
