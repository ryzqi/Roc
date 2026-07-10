import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyDiagnosticsPluginSchema,
  createDiagnosticsPerformanceAdapter
} from '../../../../src/main/plugins/diagnostics/performance-adapter';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyDiagnosticsPluginSchema(db);
});

afterEach(() => {
  db.close();
});

describe('diagnostics performance adapter', () => {
  it('records capability timing and returns it in performance samples', () => {
    const adapter = createDiagnosticsPerformanceAdapter({
      db,
      runtimeMetricsProvider: {
        getBrowserWindowCount: () => 2,
        getProcessMetrics: () => [
          {
            pid: 1234,
            type: 'browser',
            name: 'Roc',
            cpuPercent: 3,
            memory: {
              workingSetSizeKb: 2048,
              peakWorkingSetSizeKb: 4096,
              privateBytesKb: 1024,
              sharedBytesKb: 512
            }
          }
        ]
      }
    });

    adapter.recordCapabilityTiming({
      name: 'diagnostics.samplePerformance',
      startedAtMs: 10,
      durationMs: 8,
      ok: true
    });

    const sample = adapter.samplePerformance({
      mode: 'test',
      memoryBudgetMb: 1024
    });
    const stored = db
      .prepare('SELECT id, mode, memory_budget_mb, exceeds_budget FROM performance_samples WHERE id = ?')
      .get(sample.id);

    expect(sample.timing.samples).toEqual([
      expect.objectContaining({
        phase: 'ipc_call',
        label: 'diagnostics.samplePerformance',
        metadata: {
          channel: 'diagnostics.samplePerformance',
          ok: true
        }
      })
    ]);
    expect(sample.ipc).toMatchObject({
      totalCalls: 1,
      topSlowCalls: [
        expect.objectContaining({
          channel: 'diagnostics.samplePerformance',
          count: 1,
          maxDurationMs: 8,
          lastOk: true
        })
      ]
    });
    expect(sample.electron).toMatchObject({
      browserWindowCount: 2,
      processCount: 1,
      processMetrics: [
        expect.objectContaining({
          pid: 1234,
          memory: expect.objectContaining({
            workingSetSizeMb: 2,
            peakWorkingSetSizeMb: 4,
            privateBytesMb: 1,
            sharedBytesMb: 0.5
          })
        })
      ]
    });
    expect(stored).toMatchObject({
      id: sample.id,
      mode: 'test',
      memory_budget_mb: 1024,
      exceeds_budget: sample.exceedsBudget ? 1 : 0
    });
  });

  it('returns metrics snapshots through the diagnostics adapter', () => {
    const adapter = createDiagnosticsPerformanceAdapter({ db });

    adapter.metrics.incrementCounter('agent.run.started', { mode: 'task' });

    expect(adapter.getMetricsSnapshot({ name: 'agent.run.started' })).toMatchObject({
      summary: {
        totalMetrics: 1,
        counterCount: 1,
        gaugeCount: 0,
        histogramCount: 0
      },
      metrics: [
        expect.objectContaining({
          name: 'agent.run.started',
          labels: { mode: 'task' }
        })
      ]
    });
  });

  it('aggregates all process private and working set memory for the budget', () => {
    const adapter = createDiagnosticsPerformanceAdapter({
      db,
      runtimeMetricsProvider: {
        getBrowserWindowCount: () => 1,
        getProcessMetrics: () => [
          processMetric(1, 200, 240),
          processMetric(2, 220, 270)
        ]
      }
    });

    const sample = adapter.samplePerformance({ mode: 'test', memoryBudgetMb: 400 });

    expect(sample).toMatchObject({
      totalPrivateBytesMb: 420,
      totalWorkingSetMb: 510,
      memoryMeasurement: 'complete',
      exceedsBudget: true
    });
  });

  it('fails the budget when any process private bytes are unavailable', () => {
    const metric = processMetric(1, 200, 240);
    Reflect.deleteProperty(metric.memory, 'privateBytesKb');
    const adapter = createDiagnosticsPerformanceAdapter({
      db,
      runtimeMetricsProvider: {
        getBrowserWindowCount: () => 1,
        getProcessMetrics: () => [metric]
      }
    });

    const sample = adapter.samplePerformance({ mode: 'test', memoryBudgetMb: 450 });

    expect(sample).toMatchObject({
      totalPrivateBytesMb: null,
      totalWorkingSetMb: 240,
      memoryMeasurement: 'private_bytes_unavailable',
      exceedsBudget: true
    });
  });
});

function processMetric(pid: number, privateMb: number, workingSetMb: number) {
  return {
    pid,
    type: 'renderer',
    cpuPercent: 1,
    memory: {
      workingSetSizeKb: workingSetMb * 1024,
      peakWorkingSetSizeKb: workingSetMb * 1024,
      privateBytesKb: privateMb * 1024,
      sharedBytesKb: 0
    }
  };
}
