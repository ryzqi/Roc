import { randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';
import type {
  PerformanceIpcChannelSummary,
  PerformanceIpcSummary,
  PerformanceSnapshot,
  PerformanceTimingSample
} from '../../shared/types';

type PerformanceObserverOptions = {
  maxSamples?: number;
  maxSqlTemplates?: number;
  sqlSampleEvery?: number;
  ipcSampleEvery?: number;
};

export type SqlObservation = NonNullable<PerformanceSnapshot['sql']>[number];

export class PerformanceObserverService {
  private readonly maxSamples: number;
  private readonly samples: Array<PerformanceTimingSample | undefined>;
  private sampleStart = 0;
  private sampleCount = 0;
  private readonly sql = new Map<string, SqlObservation>();
  private readonly maxSqlTemplates: number;
  private readonly sqlSampleEvery: number;
  private readonly ipcSampleEvery: number;
  private ipcCalls = 0;

  constructor(options: PerformanceObserverOptions = {}) {
    this.maxSamples = options.maxSamples ?? 500;
    if (!Number.isInteger(this.maxSamples) || this.maxSamples <= 0) {
      throw new Error('PerformanceObserverService maxSamples must be a positive integer.');
    }
    this.samples = new Array<PerformanceTimingSample | undefined>(this.maxSamples);
    this.maxSqlTemplates = options.maxSqlTemplates ?? 128;
    this.sqlSampleEvery = options.sqlSampleEvery ?? 64;
    this.ipcSampleEvery = options.ipcSampleEvery ?? 64;
    for (const value of [this.maxSqlTemplates, this.sqlSampleEvery, this.ipcSampleEvery]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('performance_sampling_option_invalid');
      }
    }
  }

  record(input: Omit<PerformanceTimingSample, 'id'>): PerformanceTimingSample {
    const sample: PerformanceTimingSample = {
      id: `perf_timing_${randomUUID()}`,
      operation: input.label,
      pid: process.pid,
      creationTime: performance.timeOrigin,
      workload: 'main',
      outcome: input.metadata.ok === false ? 'failed' : 'completed',
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
    let outcome: PerformanceTimingSample['outcome'] = 'completed';
    try {
      return action();
    } catch (error) {
      outcome = performanceOutcome(error);
      throw error;
    } finally {
      this.record({
        phase,
        label,
        startedAtMs,
        durationMs: performance.now() - startedAtMs,
        outcome,
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
    let outcome: PerformanceTimingSample['outcome'] = 'completed';
    try {
      return await action();
    } catch (error) {
      outcome = performanceOutcome(error);
      throw error;
    } finally {
      this.record({
        phase,
        label,
        startedAtMs,
        durationMs: performance.now() - startedAtMs,
        outcome,
        metadata
      });
    }
  }

  getSnapshot(): PerformanceSnapshot {
    const samples = this.snapshotSamples();
    return {
      generatedAt: new Date().toISOString(),
      samples,
      sql: [...this.sql.values()].map((sample) => ({ ...sample })),
      operations: aggregateOperations(samples)
    };
  }

  /** Only a fingerprint is retained. SQL text, bound parameters and result rows never enter telemetry. */
  observeSql<T>(database: string, templateHash: string, action: () => T): T {
    const key = `${database}:${templateHash}`;
    let aggregate = this.sql.get(key);
    if (aggregate === undefined) {
      if (this.sql.size >= this.maxSqlTemplates) {
        const oldest = this.sql.keys().next().value;
        if (oldest !== undefined) this.sql.delete(oldest);
      }
      aggregate = { database, templateHash, calls: 0, sampledCalls: 0, failures: 0, sampledSqlMs: 0, maxSqlMs: 0 };
      this.sql.set(key, aggregate);
    }
    aggregate.calls += 1;
    const sampled = aggregate.calls === 1 || aggregate.calls % this.sqlSampleEvery === 0;
    const startedAtMs = sampled ? performance.now() : 0;
    let ok = true;
    try {
      return action();
    } catch (error) {
      ok = false;
      aggregate.failures += 1;
      throw error;
    } finally {
      if (sampled) {
        const durationMs = performance.now() - startedAtMs;
        aggregate.sampledCalls += 1;
        aggregate.sampledSqlMs += durationMs;
        aggregate.maxSqlMs = Math.max(aggregate.maxSqlMs, durationMs);
        this.record({ phase: 'db_query', label: templateHash, operation: `sqlite:${database}`,
          startedAtMs, durationMs, sqlMs: durationMs, metadata: { database, templateHash, ok } });
      }
    }
  }

  /** V8 serialization is a sampled proxy for response size, never a measurement of Chromium transport. */
  sampleIpcResponse(result: unknown): Pick<PerformanceTimingSample, 'ipcEncodeMs' | 'ipcTransferBytes' | 'ipcByteMeasurement'> {
    this.ipcCalls += 1;
    if (this.ipcCalls % this.ipcSampleEvery !== 0) return { ipcByteMeasurement: 'unavailable' };
    const startedAtMs = performance.now();
    try {
      const bytes = serialize(result).byteLength;
      return { ipcEncodeMs: performance.now() - startedAtMs, ipcTransferBytes: bytes,
        ipcByteMeasurement: 'v8_serialized_estimate' };
    } catch {
      // Observability must not change the result or error of the actual IPC operation.
      return { ipcByteMeasurement: 'unavailable' };
    }
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

function performanceOutcome(error: unknown): PerformanceTimingSample['outcome'] {
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  if (error instanceof Error && error.name === 'TimeoutError') return 'timed_out';
  return 'failed';
}

function aggregateOperations(samples: PerformanceTimingSample[]): NonNullable<PerformanceSnapshot['operations']> {
  const aggregates = new Map<string, NonNullable<PerformanceSnapshot['operations']>[number]>();
  for (const sample of samples) {
    const operation = sample.operation ?? sample.label;
    const pid = sample.pid ?? process.pid;
    const creationTime = sample.creationTime ?? performance.timeOrigin;
    const workload = sample.workload ?? 'main';
    const key = JSON.stringify([operation, sample.phase, pid, creationTime, workload]);
    let aggregate = aggregates.get(key);
    if (aggregate === undefined) {
      aggregate = { operation, phase: sample.phase, pid, creationTime, workload, count: 0, totalDurationMs: 0,
        maxDurationMs: 0, queueWaitMs: 0, sqlMs: 0, workerMs: 0, ipcEncodeMs: 0, ipcTransferBytes: 0, memoryPeakBytes: 0 };
      aggregates.set(key, aggregate);
    }
    aggregate.count += 1;
    aggregate.totalDurationMs += sample.durationMs;
    aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, sample.durationMs);
    for (const field of ['queueWaitMs', 'sqlMs', 'workerMs', 'ipcEncodeMs', 'ipcTransferBytes'] as const) {
      aggregate[field] += sample[field] ?? 0;
    }
    aggregate.memoryPeakBytes = Math.max(aggregate.memoryPeakBytes, sample.memoryPeakBytes ?? 0);
  }
  return [...aggregates.values()];
}
