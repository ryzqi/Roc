import { randomUUID } from 'node:crypto';
import type { PerformanceSnapshot, PerformanceTimingSample } from '../../shared/types';

type PerformanceObserverOptions = {
  maxSamples?: number;
};

export class PerformanceObserverService {
  private readonly maxSamples: number;
  private readonly samples: PerformanceTimingSample[] = [];

  constructor(options: PerformanceObserverOptions = {}) {
    this.maxSamples = options.maxSamples ?? 500;
    if (!Number.isInteger(this.maxSamples) || this.maxSamples <= 0) {
      throw new Error('PerformanceObserverService maxSamples must be a positive integer.');
    }
  }

  record(input: Omit<PerformanceTimingSample, 'id'>): PerformanceTimingSample {
    const sample: PerformanceTimingSample = {
      id: `perf_timing_${randomUUID()}`,
      ...input
    };
    this.samples.push(sample);
    while (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
    return sample;
  }

  measure<T>(
    phase: PerformanceTimingSample['phase'],
    label: string,
    action: () => T,
    metadata: PerformanceTimingSample['metadata'] = {}
  ): T {
    const startedAtMs = performance.now();
    try {
      return action();
    } finally {
      this.record({
        phase,
        label,
        startedAtMs,
        durationMs: performance.now() - startedAtMs,
        metadata
      });
    }
  }

  async measureAsync<T>(
    phase: PerformanceTimingSample['phase'],
    label: string,
    action: () => Promise<T>,
    metadata: PerformanceTimingSample['metadata'] = {}
  ): Promise<T> {
    const startedAtMs = performance.now();
    try {
      return await action();
    } finally {
      this.record({
        phase,
        label,
        startedAtMs,
        durationMs: performance.now() - startedAtMs,
        metadata
      });
    }
  }

  getSnapshot(): PerformanceSnapshot {
    return {
      generatedAt: new Date().toISOString(),
      samples: [...this.samples]
    };
  }
}
