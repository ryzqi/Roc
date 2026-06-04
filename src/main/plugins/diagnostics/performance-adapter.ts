import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  MetricFilter,
  MetricsSnapshot,
  PerformanceElectronMetrics,
  PerformanceProcessMetric,
  PerformanceSample,
  PerformanceSampleRequest,
  PerformanceTimingSample
} from '../../../shared/types';
import { RocDomainError } from '../../services/errors';
import { MetricsService } from '../../services/metrics-service';
import { PerformanceObserverService } from '../../services/performance-observer-service';
import type { RuntimeMetricsProvider, RuntimeProcessMetric } from '../../services/diagnostics-service';

const emptyRuntimeMetricsProvider: RuntimeMetricsProvider = {
  getBrowserWindowCount: () => 0,
  getProcessMetrics: () => []
};

export type CapabilityTimingInput = {
  name: string;
  startedAtMs: number;
  durationMs: number;
  ok: boolean;
};

export type DiagnosticsPerformanceAdapterOptions = {
  db: DatabaseConnection;
  metricsService?: MetricsService;
  performanceObserverService?: PerformanceObserverService;
  runtimeMetricsProvider?: RuntimeMetricsProvider;
};

export type DiagnosticsPerformanceAdapter = {
  readonly metrics: MetricsService;
  recordCapabilityTiming(input: CapabilityTimingInput): PerformanceTimingSample;
  samplePerformance(request: PerformanceSampleRequest): PerformanceSample;
  getLatestPerformanceSample(): PerformanceSample | null;
  getMetricsSnapshot(filter?: MetricFilter): MetricsSnapshot;
};

export function createDiagnosticsPerformanceAdapter(
  options: DiagnosticsPerformanceAdapterOptions
): DiagnosticsPerformanceAdapter {
  const metrics = options.metricsService === undefined ? new MetricsService() : options.metricsService;
  const performanceObserver =
    options.performanceObserverService === undefined
      ? new PerformanceObserverService()
      : options.performanceObserverService;
  const runtimeMetricsProvider =
    options.runtimeMetricsProvider === undefined ? emptyRuntimeMetricsProvider : options.runtimeMetricsProvider;

  return {
    metrics,
    recordCapabilityTiming(input) {
      return performanceObserver.record({
        phase: 'ipc_call',
        label: input.name,
        startedAtMs: input.startedAtMs,
        durationMs: input.durationMs,
        metadata: {
          channel: input.name,
          ok: input.ok
        }
      });
    },
    samplePerformance(request) {
      if (request.memoryBudgetMb <= 0) {
        throw new RocDomainError({
          code: 'performance_budget_invalid',
          message: '性能采样预算必须大于 0。',
          category: 'validation',
          retryable: false,
          userAction: '请设置有效的内存预算。'
        });
      }

      const memoryUsage = process.memoryUsage();
      const sample: PerformanceSample = {
        id: `perf_${randomUUID()}`,
        sampledAt: new Date().toISOString(),
        mode: request.mode,
        uptimeSeconds: process.uptime(),
        rssMb: bytesToMb(memoryUsage.rss),
        heapUsedMb: bytesToMb(memoryUsage.heapUsed),
        heapTotalMb: bytesToMb(memoryUsage.heapTotal),
        memoryBudgetMb: request.memoryBudgetMb,
        exceedsBudget: bytesToMb(memoryUsage.rss) > request.memoryBudgetMb,
        timing: performanceObserver.getSnapshot(),
        ipc: performanceObserver.getIpcSummary(5),
        electron: readElectronMetrics(runtimeMetricsProvider)
      };

      options.db
        .prepare(
          `INSERT INTO performance_samples
           (id, sampled_at, mode, uptime_seconds, rss_mb, heap_used_mb, heap_total_mb, memory_budget_mb, exceeds_budget)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sample.id,
          sample.sampledAt,
          sample.mode,
          sample.uptimeSeconds,
          sample.rssMb,
          sample.heapUsedMb,
          sample.heapTotalMb,
          sample.memoryBudgetMb,
          sample.exceedsBudget ? 1 : 0
        );

      return sample;
    },
    getLatestPerformanceSample() {
      const row = options.db
        .prepare(
          `SELECT id, sampled_at, mode, uptime_seconds, rss_mb, heap_used_mb, heap_total_mb, memory_budget_mb, exceeds_budget
           FROM performance_samples
           ORDER BY sampled_at DESC
           LIMIT 1`
        )
        .get() as
        | {
            id: string;
            sampled_at: string;
            mode: PerformanceSample['mode'];
            uptime_seconds: number;
            rss_mb: number;
            heap_used_mb: number;
            heap_total_mb: number;
            memory_budget_mb: number;
            exceeds_budget: number;
          }
        | undefined;

      if (row === undefined) {
        return null;
      }

      return {
        id: row.id,
        sampledAt: row.sampled_at,
        mode: row.mode,
        uptimeSeconds: row.uptime_seconds,
        rssMb: row.rss_mb,
        heapUsedMb: row.heap_used_mb,
        heapTotalMb: row.heap_total_mb,
        memoryBudgetMb: row.memory_budget_mb,
        exceedsBudget: row.exceeds_budget === 1,
        timing: performanceObserver.getSnapshot(),
        ipc: performanceObserver.getIpcSummary(5),
        electron: readElectronMetrics(runtimeMetricsProvider)
      };
    },
    getMetricsSnapshot(filter = {}) {
      return metrics.getSnapshot(filter);
    }
  };
}

export function applyDiagnosticsPluginSchema(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS performance_samples (
      id TEXT PRIMARY KEY,
      sampled_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      uptime_seconds REAL NOT NULL,
      rss_mb REAL NOT NULL,
      heap_used_mb REAL NOT NULL,
      heap_total_mb REAL NOT NULL,
      memory_budget_mb REAL NOT NULL,
      exceeds_budget INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS diagnostic_packages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      includes_json TEXT NOT NULL,
      redacted INTEGER NOT NULL
    );
  `);
}

function readElectronMetrics(runtimeMetricsProvider: RuntimeMetricsProvider): PerformanceElectronMetrics {
  const processMetrics = runtimeMetricsProvider.getProcessMetrics().map((metric) => toPerformanceProcessMetric(metric));
  return {
    browserWindowCount: runtimeMetricsProvider.getBrowserWindowCount(),
    processCount: processMetrics.length,
    processMetrics
  };
}

function toPerformanceProcessMetric(metric: RuntimeProcessMetric): PerformanceProcessMetric {
  return {
    pid: metric.pid,
    type: metric.type,
    name: metric.name === undefined ? null : metric.name,
    serviceName: metric.serviceName === undefined ? null : metric.serviceName,
    cpuPercent: metric.cpuPercent,
    sandboxed: metric.sandboxed === undefined ? null : metric.sandboxed,
    integrityLevel: metric.integrityLevel === undefined ? null : metric.integrityLevel,
    memory: {
      workingSetSizeMb: kbToMb(metric.memory.workingSetSizeKb),
      peakWorkingSetSizeMb: kbToMb(metric.memory.peakWorkingSetSizeKb),
      privateBytesMb: metric.memory.privateBytesKb === undefined ? null : kbToMb(metric.memory.privateBytesKb),
      sharedBytesMb: metric.memory.sharedBytesKb === undefined ? null : kbToMb(metric.memory.sharedBytesKb)
    }
  };
}

function bytesToMb(value: number): number {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}

function kbToMb(value: number): number {
  return Math.round((value / 1024) * 10) / 10;
}
