import { randomUUID } from 'node:crypto';
import type {
  PerformanceIpcChannelSummary,
  PerformanceIpcSummary,
  PerformanceSnapshot,
  PerformanceTimingSample
} from '../../shared/types';

type PerformanceObserverOptions = {
  maxSamples?: number;
};

export class PerformanceObserverService {
  private readonly maxSamples: number;
  private readonly samples: Array<PerformanceTimingSample | undefined>;
  private sampleStart = 0;
  private sampleCount = 0;

  constructor(options: PerformanceObserverOptions = {}) {
    this.maxSamples = options.maxSamples ?? 500;
    if (!Number.isInteger(this.maxSamples) || this.maxSamples <= 0) {
      throw new Error('PerformanceObserverService maxSamples must be a positive integer.');
    }
    this.samples = new Array<PerformanceTimingSample | undefined>(this.maxSamples);
  }

  record(input: Omit<PerformanceTimingSample, 'id'>): PerformanceTimingSample {
    const sample: PerformanceTimingSample = {
      id: `perf_timing_${randomUUID()}`,
      ...input
    };
    const writeIndex = (this.sampleStart + this.sampleCount) % this.maxSamples;
    this.samples[writeIndex] = sample;
    if (this.sampleCount < this.maxSamples) {
      this.sampleCount += 1;
    } else {
      this.sampleStart = (this.sampleStart + 1) % this.maxSamples;
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
      samples: this.snapshotSamples()
    };
  }

  getIpcSummary(topLimit: number): PerformanceIpcSummary {
    if (!Number.isInteger(topLimit) || topLimit <= 0) {
      throw new Error('IPC summary topLimit must be a positive integer.');
    }

    const ipcSamples = this.snapshotSamples().filter((sample) => sample.phase === 'ipc_call');
    const channels = new Map<string, PerformanceIpcChannelSummary>();
    for (const sample of ipcSamples) {
      const channel = sample.metadata.channel;
      if (typeof channel !== 'string' || channel.length === 0) {
        throw new Error(`IPC timing sample ${sample.id} is missing metadata.channel.`);
      }
      const ok = sample.metadata.ok;
      if (typeof ok !== 'boolean') {
        throw new Error(`IPC timing sample ${sample.id} is missing metadata.ok.`);
      }
      const existing = channels.get(channel);
      if (existing === undefined) {
        channels.set(channel, {
          channel,
          count: 1,
          totalDurationMs: roundDuration(sample.durationMs),
          averageDurationMs: roundDuration(sample.durationMs),
          maxDurationMs: roundDuration(sample.durationMs),
          lastOk: ok
        });
        continue;
      }
      const nextTotal = existing.totalDurationMs + sample.durationMs;
      existing.count += 1;
      existing.totalDurationMs = roundDuration(nextTotal);
      existing.averageDurationMs = roundDuration(nextTotal / existing.count);
      existing.maxDurationMs = roundDuration(Math.max(existing.maxDurationMs, sample.durationMs));
      existing.lastOk = ok;
    }

    const summaries = [...channels.values()];
    const topSlowCalls = [...summaries]
      .sort((left, right) => right.maxDurationMs - left.maxDurationMs || left.channel.localeCompare(right.channel))
      .slice(0, topLimit);
    const topFrequentCalls = [...summaries]
      .sort((left, right) => right.count - left.count || right.maxDurationMs - left.maxDurationMs || left.channel.localeCompare(right.channel))
      .slice(0, topLimit);
    const windowSetBounds = channels.get('roc:window:set-bounds');

    return {
      generatedFromSamples: this.sampleCount,
      totalCalls: ipcSamples.length,
      topLimit,
      topSlowCalls,
      topFrequentCalls,
      windowSetBoundsCalls: windowSetBounds === undefined ? 0 : windowSetBounds.count
    };
  }

  private snapshotSamples(): PerformanceTimingSample[] {
    const snapshot = new Array<PerformanceTimingSample>(this.sampleCount);
    for (let index = 0; index < this.sampleCount; index += 1) {
      const sample = this.samples[(this.sampleStart + index) % this.maxSamples];
      if (sample === undefined) {
        throw new Error('performance_sample_buffer_corrupted');
      }
      snapshot[index] = sample;
    }
    return snapshot;
  }
}

function roundDuration(value: number): number {
  return Math.round(value * 10) / 10;
}
