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

  getIpcSummary(topLimit: number): PerformanceIpcSummary {
    if (!Number.isInteger(topLimit) || topLimit <= 0) {
      throw new Error('IPC summary topLimit must be a positive integer.');
    }

    const ipcSamples = this.samples.filter((sample) => sample.phase === 'ipc_call');
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
      generatedFromSamples: this.samples.length,
      totalCalls: ipcSamples.length,
      topLimit,
      topSlowCalls,
      topFrequentCalls,
      windowSetBoundsCalls: windowSetBounds === undefined ? 0 : windowSetBounds.count
    };
  }
}

function roundDuration(value: number): number {
  return Math.round(value * 10) / 10;
}
