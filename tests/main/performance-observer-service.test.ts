import { describe, expect, it } from 'vitest';
import { PerformanceObserverService } from '../../src/main/services/performance-observer-service';

describe('PerformanceObserverService', () => {
  it('keeps the newest bounded timing samples', () => {
    const service = new PerformanceObserverService({ maxSamples: 2 });

    service.record({
      phase: 'main_ready',
      label: 'one',
      startedAtMs: 1,
      durationMs: 2,
      metadata: {}
    });
    service.record({
      phase: 'window_created',
      label: 'two',
      startedAtMs: 3,
      durationMs: 4,
      metadata: {}
    });
    service.record({
      phase: 'renderer_loaded',
      label: 'three',
      startedAtMs: 5,
      durationMs: 6,
      metadata: {}
    });

    expect(service.getSnapshot().samples.map((sample) => sample.label)).toEqual(['two', 'three']);
  });

  it('accepts provider failure timing phases used by runtime diagnostics', () => {
    const service = new PerformanceObserverService();

    service.record({
      phase: 'provider_failed',
      label: 'nvidia:model',
      startedAtMs: 10,
      durationMs: 20,
      metadata: {
        providerId: 'nvidia',
        failureCode: 'provider_http_error'
      }
    });

    expect(service.getSnapshot().samples.at(-1)).toMatchObject({
      phase: 'provider_failed',
      label: 'nvidia:model'
    });
  });

  it('summarizes IPC calls by slowest and most frequent channels', () => {
    const service = new PerformanceObserverService();

    service.record({
      phase: 'ipc_call',
      label: 'roc:git:status',
      startedAtMs: 1,
      durationMs: 24,
      metadata: {
        channel: 'roc:git:status',
        ok: true
      }
    });
    service.record({
      phase: 'ipc_call',
      label: 'roc:window:get-bounds',
      startedAtMs: 2,
      durationMs: 2,
      metadata: {
        channel: 'roc:window:get-bounds',
        ok: true
      }
    });
    service.record({
      phase: 'ipc_call',
      label: 'roc:git:status',
      startedAtMs: 3,
      durationMs: 8,
      metadata: {
        channel: 'roc:git:status',
        ok: false
      }
    });
    service.record({
      phase: 'ipc_call',
      label: 'roc:window:set-bounds',
      startedAtMs: 4,
      durationMs: 1,
      metadata: {
        channel: 'roc:window:set-bounds',
        ok: true
      }
    });

    const summary = service.getIpcSummary(2);

    expect(summary.totalCalls).toBe(4);
    expect(summary.windowSetBoundsCalls).toBe(1);
    expect(summary.topSlowCalls).toEqual([
      {
        channel: 'roc:git:status',
        count: 2,
        averageDurationMs: 16,
        maxDurationMs: 24,
        lastOk: false,
        totalDurationMs: 32
      },
      {
        channel: 'roc:window:get-bounds',
        count: 1,
        averageDurationMs: 2,
        maxDurationMs: 2,
        lastOk: true,
        totalDurationMs: 2
      }
    ]);
    expect(summary.topFrequentCalls.map((item) => item.channel)).toEqual(['roc:git:status', 'roc:window:get-bounds']);
  });
});
