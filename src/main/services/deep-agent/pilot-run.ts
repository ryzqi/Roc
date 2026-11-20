import {
  pilotStatusSchema,
  type PilotOptInRequest,
  type PilotSettings,
  type PilotRunSummary,
  type PilotStatus
} from '../../../shared/schemas/harness-pilot';
import {
  PilotStateStore,
  type PilotDecision,
  type PilotRequest
} from './pilot-gate';
import type { PilotRunRow, RunUsageLedger } from './run-usage-ledger';

/** Persists pilot enrollment and reports terminal outcomes to the failure breaker. */

type StartedDecision = Extract<PilotDecision, { start: true }>;

export class PilotRunCoordinator {
  constructor(
    private readonly options: {
      store: PilotStateStore;
      ledger: RunUsageLedger;
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
    this.options.ledger.recordPilotRun(input.runId, {
      taskId: input.taskId,
      decision: input.decision.reason,
      disclosure: input.decision.disclosure,
      profile: input.decision.profile,
      bucket: input.decision.bucket
    });
  }

  /**
   * Terminal outcome recording. Never throws: this runs after the terminal transaction, and a pilot bookkeeping
   * failure must not turn a completed run into a failed one. It is best-effort like the event publishing
   * beside it.
   */
  recordOutcome(input: { runId: string; status: 'completed' | 'failed' | 'cancelled'; errorCode: string | null }): void {
    try {
      const row = this.options.ledger.readPilotRun(input.runId);
      if (row === null) return;
      if (input.status === 'failed') {
        this.options.store.recordFailure();
      }
      const nextState = input.status === 'cancelled' ? 'cancelled' : 'finished';
      this.options.ledger.finishPilotRun(input.runId, nextState);
    } catch (error) {
      console.error('[PilotRunCoordinator] Pilot outcome recording failed.', error);
    }
  }

  status(): PilotStatus {
    const lastRun = this.options.ledger.latestPilotRun();
    return pilotStatusSchema.parse({
      settings: this.options.store.read(),
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
    state: row.state,
    createdAt: row.createdAt
  };
}
