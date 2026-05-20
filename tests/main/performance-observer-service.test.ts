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
});
