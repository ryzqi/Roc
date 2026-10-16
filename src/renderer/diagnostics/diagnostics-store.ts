import type {
  DiagnosticCheck,
  DiagnosticPackage,
  HealthCheckResult,
  MetricFilter,
  MetricsSnapshot,
  PerformanceSample,
  RocRunMode
} from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';

/**
 * Diagnostics data layer (P6/T6.8).
 *
 * Two contract facts are handled here rather than at the call sites:
 *
 *   1. The capability is **`diagnostics.createPackage`**, not
 *      `diagnostics.createDiagnosticPackage` (the plan and `capability-matrix.md` both say
 *      the latter) — see F18. The preload method *is* `createDiagnosticPackage`, which is
 *      exactly the trap P5 hit: method names and capability names are different namespaces.
 *   2. `{ taskId, errorSummary }` is **required and task-scoped**. A diagnostic package is
 *      collected *for a task*, so a failed stage run (which has no task) cannot produce one.
 *      The view says that instead of sending a placeholder id.
 *
 * The memory budget passed to `samplePerformance` is the same 300 MB the backend's own
 * package collector falls back to (`plugins/diagnostics/index.ts`), and the run mode comes
 * from `app.getStatus()` — sampled values are compared against the budget, so inventing one
 * would produce a meaningless `exceedsBudget`.
 */

export const DIAGNOSTIC_MEMORY_BUDGET_MB = 300;

export function runChecks(client: RocClient): Promise<IpcLikeResult<DiagnosticCheck[]>> {
  return client.api.diagnostics.runChecks();
}

export function runHealthCheck(client: RocClient): Promise<IpcLikeResult<HealthCheckResult>> {
  return client.api.diagnostics.runHealthCheck();
}

export function getMetricsSnapshot(
  client: RocClient,
  filter?: MetricFilter
): Promise<IpcLikeResult<MetricsSnapshot>> {
  return filter === undefined
    ? client.api.diagnostics.getMetricsSnapshot()
    : client.api.diagnostics.getMetricsSnapshot(filter);
}

export function samplePerformance(
  client: RocClient,
  input: { mode: RocRunMode; memoryBudgetMb: number }
): Promise<IpcLikeResult<PerformanceSample>> {
  return client.api.diagnostics.samplePerformance(input);
}

export function createDiagnosticPackage(
  client: RocClient,
  input: { taskId: string; errorSummary: string }
): Promise<IpcLikeResult<DiagnosticPackage>> {
  return client.api.diagnostics.createDiagnosticPackage(input);
}

export function getAppStatusMode(client: RocClient): Promise<IpcLikeResult<{ mode: RocRunMode }>> {
  return client.api.app.getStatus();
}
