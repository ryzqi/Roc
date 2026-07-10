import { describe, expect, it, vi } from 'vitest';

import { loadOperationsData } from '../../src/renderer/app/data-loading';
import type { RocClient } from '../../src/renderer/shared/roc-client';

describe('data loading concurrency', () => {
  it('starts independent operations requests before background tasks resolve', async () => {
    const background = deferred<{ ok: true; data: [] }>();
    const listBackgroundTasks = vi.fn().mockReturnValue(background.promise);
    const samplePerformance = vi.fn().mockResolvedValue({ ok: true, data: performanceSample() });
    const runChecks = vi.fn().mockResolvedValue({ ok: true, data: [] });
    const client = {
      api: {
        tasks: { listBackgroundTasks },
        diagnostics: {
          samplePerformance,
          runChecks,
          createDiagnosticPackage: vi.fn()
        }
      }
    } as unknown as RocClient;

    const loading = loadOperationsData('test', client);

    expect(listBackgroundTasks).toHaveBeenCalledTimes(1);
    expect(samplePerformance).toHaveBeenCalledTimes(1);
    expect(runChecks).toHaveBeenCalledTimes(1);

    background.resolve({ ok: true, data: [] });
    await expect(loading).resolves.toMatchObject({ diagnosticPackage: null });
  });
});

function performanceSample() {
  return {
    id: 'perf-test',
    sampledAt: '2026-07-10T00:00:00.000Z',
    mode: 'test' as const,
    uptimeSeconds: 1,
    rssMb: 1,
    heapUsedMb: 1,
    heapTotalMb: 1,
    memoryBudgetMb: 450,
    totalPrivateBytesMb: 1,
    totalWorkingSetMb: 1,
    memoryMeasurement: 'complete' as const,
    exceedsBudget: false,
    timing: { samples: [] },
    ipc: { totalCalls: 0, failedCalls: 0, averageDurationMs: 0, topSlowCalls: [] },
    electron: { browserWindowCount: 1, processCount: 0, processMetrics: [] }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === null) {
        throw new Error('deferred_not_initialized');
      }
      resolvePromise(value);
    }
  };
}
