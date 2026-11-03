import type { Database as DatabaseConnection } from 'better-sqlite3';
import {
  researchProjectBudgetLimitsSchema, researchProjectBudgetStatusSchema,
  type ResearchProjectBudgetLimits, type ResearchProjectBudgetStatus
} from '../../../shared/schemas/research-project-budget';

type PolicyRow = { revision: number; limits_json: string; stop_reason: string | null; updated_at: string };
type Totals = {
  tokens: number; settled_tokens: number; unknown_tokens: number; reserved_tokens: number;
  models: number; active_models: number; cost: number; settled_cost: number; reserved_cost: number;
  unknown_costs: number; unpriced_costs: number;
};
type ModelReservation = { tokens: number; costMicrousd?: number | null };

/** One project view over the existing call rows; policy changes never reset consumption. */
export class ProjectBudgetLedger {
  constructor(private readonly db: DatabaseConnection) {}

  save(request: { projectId: string; expectedRevision: number; limits: ResearchProjectBudgetLimits }): ResearchProjectBudgetStatus {
    const limits = researchProjectBudgetLimitsSchema.parse(request.limits);
    return this.db.transaction(() => {
      const current = this.policy(request.projectId);
      if ((current?.revision ?? 0) !== request.expectedRevision) throw new Error('research_project_budget_revision_conflict');
      const revision = request.expectedRevision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('research_project_budget_revision_exhausted');
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO research_project_budget_policies(project_id,revision,limits_json,created_at)
        VALUES (?,?,?,?)`).run(request.projectId, revision, JSON.stringify(limits), now);
      this.db.prepare(`INSERT INTO research_project_budget_states(project_id,revision,stop_reason,updated_at)
        VALUES (?,?,NULL,?) ON CONFLICT(project_id) DO UPDATE SET
        revision=excluded.revision,stop_reason=NULL,updated_at=excluded.updated_at`)
        .run(request.projectId, revision, now);
      return this.status(request.projectId)!;
    }).immediate();
  }

  status(projectId: string): ResearchProjectBudgetStatus | null {
    const policy = this.policy(projectId);
    if (policy === null) return null;
    const limits = researchProjectBudgetLimitsSchema.parse(JSON.parse(policy.limits_json));
    const totals = this.totals(projectId);
    return researchProjectBudgetStatusSchema.parse({
      projectId, policyVersion: 1, revision: policy.revision, limits,
      tokens: { settled: totals.settled_tokens, unknown: totals.unknown_tokens,
        reserved: totals.reserved_tokens, remaining: Math.max(0, limits.maxTotalTokens - totals.tokens) },
      models: { total: totals.models, reserved: totals.active_models },
      cost: { state: totals.unknown_costs > 0 ? 'unknown' : 'known',
        settledMicrousd: totals.settled_cost, reservedMicrousd: totals.reserved_cost },
      stopReason: policy.stop_reason, updatedAt: policy.updated_at
    });
  }

  /** Called inside the same immediate transaction as task/stage admission and call INSERT. */
  assertReservation(projectId: string, input: ModelReservation): number {
    const policy = this.policy(projectId);
    if (policy === null) throw new ProjectBudgetRefusal(projectId, 'research_project_budget_missing', null);
    const refusal = (reason: string): ProjectBudgetRefusal => new ProjectBudgetRefusal(projectId, reason, policy.revision);
    if (policy.stop_reason !== null) throw refusal(policy.stop_reason);
    const limits = researchProjectBudgetLimitsSchema.parse(JSON.parse(policy.limits_json));
    const totals = this.totals(projectId);
    if (totals.active_models >= limits.maxConcurrentModelCalls) {
      throw refusal('research_project_model_concurrency_exhausted');
    }
    if (totals.models >= limits.maxModelCalls) throw refusal('research_project_model_call_budget_exhausted');
    if (input.tokens > limits.maxTotalTokens - totals.tokens) throw refusal('research_project_token_budget_exhausted');
    if (limits.maxCostMicrousd !== null) {
      if (input.costMicrousd === null || input.costMicrousd === undefined || totals.unpriced_costs > 0) {
        throw refusal('research_project_cost_estimate_unavailable');
      }
      if (input.costMicrousd > limits.maxCostMicrousd - totals.cost) {
        throw refusal('research_project_cost_budget_exhausted');
      }
    }
    return policy.revision;
  }

  recordRefusal(projectId: string, reason: string, revision: number | null): void {
    if (reason === 'research_project_model_concurrency_exhausted' || reason === 'research_project_budget_missing') return;
    this.db.prepare(`UPDATE research_project_budget_states SET stop_reason=COALESCE(stop_reason,?),updated_at=?
      WHERE project_id=? AND revision=?`)
      .run(reason, new Date().toISOString(), projectId, revision);
  }

  private policy(projectId: string): PolicyRow | null {
    return this.db.prepare(`SELECT s.revision,p.limits_json,s.stop_reason,s.updated_at
      FROM research_project_budget_states s JOIN research_project_budget_policies p
      ON p.project_id=s.project_id AND p.revision=s.revision WHERE s.project_id=?`)
      .get(projectId) as PolicyRow | undefined ?? null;
  }

  private totals(projectId: string): Totals {
    return this.db.prepare(`SELECT
      COALESCE(SUM(COALESCE(actual_tokens,reserved_tokens)),0) tokens,
      COALESCE(SUM(CASE WHEN state='settled' THEN actual_tokens ELSE 0 END),0) settled_tokens,
      COALESCE(SUM(CASE WHEN state='unknown' THEN reserved_tokens ELSE 0 END),0) unknown_tokens,
      COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_tokens ELSE 0 END),0) reserved_tokens,
      COALESCE(SUM(kind='model'),0) models,
      COALESCE(SUM(kind='model' AND state='reserved'),0) active_models,
      COALESCE(SUM(COALESCE(actual_cost_microusd,reserved_cost_microusd)),0) cost,
      COALESCE(SUM(CASE WHEN state='settled' THEN actual_cost_microusd ELSE 0 END),0) settled_cost,
      COALESCE(SUM(CASE WHEN state IN ('reserved','unknown') THEN COALESCE(actual_cost_microusd,reserved_cost_microusd,0) ELSE 0 END),0) reserved_cost,
      COALESCE(SUM(kind='model' AND (state='unknown' OR COALESCE(actual_cost_microusd,reserved_cost_microusd) IS NULL)),0) unknown_costs,
      COALESCE(SUM(kind='model' AND actual_cost_microusd IS NULL AND reserved_cost_microusd IS NULL),0) unpriced_costs
      FROM agent_budget_calls WHERE project_id=?`).get(projectId) as Totals;
  }
}

export class ProjectBudgetRefusal extends Error {
  constructor(readonly projectId: string, reason: string, readonly revision: number | null) { super(reason); }
}
