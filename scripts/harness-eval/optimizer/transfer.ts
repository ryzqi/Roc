import { pairedClusterSummary, type PairedObservation, type PairedSummary } from './dataset';

/**
 * P6-02: transfer is measured separately from the single-task gain that justified a lesson.
 *
 * The four strata are reported independently and the claim is derived from them, never from the
 * single-task number alone. A lesson that helps the task it was learned on but fails to transfer is
 * reported as exactly that; the caller can then quarantine or revoke it.
 */

export const transferStrata = ['single-task', 'cross-task', 'cross-project', 'cross-model'] as const;
export type TransferStratum = (typeof transferStrata)[number];

export type TransferReport = {
  schemaVersion: 1;
  claims: 'fixture-rubric; not real-model transfer evidence';
  /**
   * Label-only: each stratum currently relabels the same deterministic adapter and dev scenarios.
   * A real cross-model/cross-project experiment must set this to `distinct-conditions` first.
   */
  strataRealism: 'label-only' | 'distinct-conditions';
  singleTask: PairedSummary;
  transfer: Record<Exclude<TransferStratum, 'single-task'>, PairedSummary>;
  verdict: {
    singleTaskGain: boolean;
    transferGain: boolean;
    claim: 'no-gain' | 'single-task-only' | 'transfers';
  };
};

export function transferReport(
  observations: Record<TransferStratum, readonly PairedObservation[]>,
  options: { seed?: number; strataRealism?: 'label-only' | 'distinct-conditions' } = {}
): TransferReport {
  for (const stratum of transferStrata) {
    if (observations[stratum].length === 0) throw new Error(`transfer_stratum_empty:${stratum}`);
  }
  const seed = options.seed ?? 20261021;
  const summary = (stratum: TransferStratum, offset: number): PairedSummary =>
    pairedClusterSummary(observations[stratum], { seed: seed + offset });
  const singleTask = summary('single-task', 0);
  const transfer = {
    'cross-task': summary('cross-task', 1),
    'cross-project': summary('cross-project', 2),
    'cross-model': summary('cross-model', 3)
  };
  const singleTaskGain = singleTask.ciLow > 0;
  const transferGain = Object.values(transfer).every(entry => entry.ciLow > 0);
  return {
    schemaVersion: 1,
    claims: 'fixture-rubric; not real-model transfer evidence',
    strataRealism: options.strataRealism ?? 'label-only',
    singleTask,
    transfer,
    verdict: {
      singleTaskGain,
      transferGain,
      claim: transferGain && singleTaskGain ? 'transfers' : singleTaskGain ? 'single-task-only' : 'no-gain'
    }
  };
}
