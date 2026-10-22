import {
  pilotStatusSchema,
  type PilotOptInRequest,
  type PilotSettings,
  type PilotRunSummary,
  type PilotStatus
} from '../../../shared/schemas/harness-pilot';
import {
  pilotAllowance,
  PilotStateStore,
  type PilotDecision,
  type PilotRequest
} from './pilot-gate';
import type { PilotRunRow, RunBudgetLedger } from './run-budget-ledger';

/**
 * P6-04 product path: the gate is consulted at dispatch, its grant is written to the durable budget
 * ledger, and the outcome feeds the breaker.
 *
 * Three invariants live here rather than in the runtime:
 *  - a run without a grant keeps the base budget exactly (no extra headroom is invented),
 *  - the granted allowance is persisted before the run starts, so a restart sees the same numbers,
 *  - an exhausted allowance or a failed pilot run opens the breaker instead of silently retrying.
 */

type StartedDecision = Extract<PilotDecision, { start: true }>;

export class PilotRunCoordinator {
  constructor(
    private readonly options: {
      store: PilotStateStore;
      ledger: RunBudgetLedger;
    }
  ) {}

  /** The profile the gate would apply. Callers need it to narrow the manifest before deciding. */
  settings(): PilotSettings {
    return this.options.store.read();
  }

  plan(request: PilotRequest): PilotDecision {
    return this.options.store.decide(request);
  }

  /** Called once, after the run row exists, for a decision that started. */
  attach(input: { runId: string; taskId: string; decision: StartedDecision }): void {
    this.options.ledger.grantPilotAllowance(input.runId, {
      taskId: input.taskId,
      decision: input.decision.reason,
      disclosure: input.decision.disclosure,
      profile: input.decision.profile,
      bucket: input.decision.bucket,
      extraBudgetMicrousd: input.decision.extraBudgetMicrousd,
      allowance: input.decision.allowance
    });
  }

  /**
   * Terminal accounting. Never throws: this runs after the terminal transaction, and a pilot bookkeeping
   * failure must not turn a completed run into a failed one. It is best-effort like the event publishing
   * beside it.
   */
  recordOutcome(input: { runId: string; status: 'completed' | 'failed' | 'cancelled'; errorCode: string | null }): void {
    try {
      const row = this.options.ledger.readPilotRun(input.runId);
      if (row === null) return;
      if (input.status === 'failed') {
        // The allowance running out is the budget breaker, not a model failure: name it once.
        if (input.errorCode === 'run_pilot_allowance_exhausted') {
          this.options.store.trip('pilot_allowance_exhausted');
        }
        this.options.store.recordFailure();
      }
      const nextState = row.state === 'exhausted'
        ? 'exhausted'
        : input.status === 'cancelled' ? 'cancelled' : 'finished';
      this.options.ledger.finishPilotRun(input.runId, nextState);
    } catch (error) {
      console.error('[PilotRunCoordinator] Pilot accounting failed.', error);
    }
  }

  status(): PilotStatus {
    const lastRun = this.options.ledger.latestPilotRun();
    return pilotStatusSchema.parse({
      settings: this.options.store.read(),
      allowance: { ...pilotAllowance },
      costState: 'unknown_without_price_table',
      lastRun: lastRun === null ? null : toSummary(lastRun)
    });
  }

  enable(request: PilotOptInRequest): PilotStatus {
    this.options.store.enable(request);
    return this.status();
  }

  rollback(): PilotStatus {
    this.options.store.rollback();
    return this.status();
  }
}

function toSummary(row: PilotRunRow): PilotRunSummary {
  return {
    runId: row.runId,
    taskId: row.taskId,
    decision: row.decision,
    disclosure: row.disclosure,
    profile: row.profile,
    bucket: row.bucket,
    extraBudgetMicrousd: row.extraBudgetMicrousd,
    allowance: { ...row.allowance },
    spent: { ...row.spent },
    state: row.state,
    createdAt: row.createdAt
  };
}
