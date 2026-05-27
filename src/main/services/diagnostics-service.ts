import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DiagnosticCheck,
  DiagnosticPackage,
  DiagnosticPackageRequest,
  PerformanceElectronMetrics,
  PerformanceProcessMetric,
  PerformanceSample,
  PerformanceSampleRequest,
  SchedulerStatus
} from '../../shared/types';
import type { DatabaseService } from './database-service';
import { RocDomainError } from './errors';
import type { PerformanceObserverService } from './performance-observer-service';
import type { RocPaths } from './paths';
import type { RtkService } from './rtk-service';
import type { TaskService } from './task-service';
import { parseCronExpression } from './task/cron-parser';
import { requireText } from './validation';

export type RuntimeProcessMetric = {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  cpuPercent: number;
  sandboxed?: boolean;
  integrityLevel?: string;
  memory: {
    workingSetSizeKb: number;
    peakWorkingSetSizeKb: number;
    privateBytesKb?: number;
    sharedBytesKb?: number;
  };
};

export type RuntimeMetricsProvider = {
  getBrowserWindowCount: () => number;
  getProcessMetrics: () => RuntimeProcessMetric[];
};

const emptyRuntimeMetricsProvider: RuntimeMetricsProvider = {
  getBrowserWindowCount: () => 0,
  getProcessMetrics: () => []
};

export class DiagnosticsService {
  constructor(
    private readonly paths: RocPaths,
    private readonly database: DatabaseService,
    private readonly taskService: TaskService,
    private readonly rtkService: RtkService,
    private readonly performanceObserverService: PerformanceObserverService,
    private readonly runtimeMetricsProvider: RuntimeMetricsProvider = emptyRuntimeMetricsProvider
  ) {}

  samplePerformance(request: PerformanceSampleRequest): PerformanceSample {
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
      rssMb: this.bytesToMb(memoryUsage.rss),
      heapUsedMb: this.bytesToMb(memoryUsage.heapUsed),
      heapTotalMb: this.bytesToMb(memoryUsage.heapTotal),
      memoryBudgetMb: request.memoryBudgetMb,
      exceedsBudget: this.bytesToMb(memoryUsage.rss) > request.memoryBudgetMb,
      timing: this.performanceObserverService.getSnapshot(),
      electron: this.readElectronMetrics()
    };

    this.database.db
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
  }

  getLatestPerformanceSample(): PerformanceSample | null {
    const row = this.database.db
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
      timing: this.performanceObserverService.getSnapshot(),
      electron: this.readElectronMetrics()
    };
  }

  runChecks(schedulerStatus: SchedulerStatus): DiagnosticCheck[] {
    const checkedAt = new Date().toISOString();
    const scheduledTaskCount = this.countScheduledRunningTasks();
    const recentSkippedCount = this.taskService.countRecentSkippedScheduledRuns(
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    );
    const invalidCronCount = this.countInvalidCronExpressions();
    const registeredMatches = schedulerStatus.registeredTaskCount === scheduledTaskCount;

    return [
      {
        id: 'scheduler_running',
        label: '调度器运行',
        status: schedulerStatus.running ? 'pass' : 'fail',
        severity: schedulerStatus.running ? 'info' : 'error',
        message: schedulerStatus.running ? '调度器正在运行。' : '调度器未启动。',
        checkedAt
      },
      {
        id: 'scheduler_tasks_registered',
        label: '调度任务注册',
        status: registeredMatches ? 'pass' : 'warn',
        severity: registeredMatches ? 'info' : 'warning',
        message: registeredMatches
          ? `已注册 ${schedulerStatus.registeredTaskCount} 个调度任务。`
          : `已注册 ${schedulerStatus.registeredTaskCount} 个调度任务，数据库中有 ${scheduledTaskCount} 个运行中的计划任务。`,
        checkedAt
      },
      {
        id: 'scheduler_missed_runs_recent',
        label: '近期错过调度',
        status: recentSkippedCount === 0 ? 'pass' : 'warn',
        severity: recentSkippedCount === 0 ? 'info' : 'warning',
        message:
          recentSkippedCount === 0
            ? '过去 24 小时没有 skipped 调度。'
            : `过去 24 小时存在 ${recentSkippedCount} 条 skipped 调度。`,
        checkedAt
      },
      {
        id: 'cron_expressions_valid',
        label: 'Cron 表达式',
        status: invalidCronCount === 0 ? 'pass' : 'fail',
        severity: invalidCronCount === 0 ? 'info' : 'error',
        message: invalidCronCount === 0 ? '所有 cron 表达式均可解析。' : `${invalidCronCount} 个 cron 表达式无效。`,
        checkedAt
      }
    ];
  }

  createDiagnosticPackage(request: DiagnosticPackageRequest): DiagnosticPackage {
    const taskId = requireText(request.taskId, 'diagnostic_task_id_empty', '诊断包任务 ID 不能为空。', '请选择要诊断的任务。');
    const createdAt = new Date().toISOString();
    const packageId = `diagnostic_${randomUUID()}`;
    const diagnosticsDir = this.paths.diagnosticsDir;
    if (!existsSync(diagnosticsDir)) {
      mkdirSync(diagnosticsDir, { recursive: true });
    }

    const latestPerformance = this.getLatestPerformanceSample();
    const performanceSample =
      latestPerformance === null
        ? this.samplePerformance({
            mode: process.env.VITEST === 'true' ? 'test' : 'development',
            memoryBudgetMb: 300
          })
        : latestPerformance;
    const includes = ['task_snapshot', 'performance_sample', 'logs', 'recovery_points', 'rtk_status'];
    const rawPayload = {
      id: packageId,
      taskId,
      createdAt,
      taskSnapshot: this.taskService.getSnapshot(),
      performanceSample,
      logs: {
        directory: this.paths.logsDir
      },
      recoveryPoints: {
        directory: join(this.paths.tasksDir, 'recovery')
      },
      rtkStatus: this.rtkService.getStatus(),
      errorSummary: request.errorSummary
    };
    const redactedPayload = this.redactText(JSON.stringify(rawPayload, null, 2));
    const filePath = join(diagnosticsDir, `${packageId}.json`);
    writeFileSync(filePath, `${redactedPayload}\n`, 'utf8');

    const diagnosticPackage: DiagnosticPackage = {
      id: packageId,
      taskId,
      path: filePath,
      createdAt,
      includes,
      redacted: true
    };
    this.database.db
      .prepare(
        `INSERT INTO diagnostic_packages (id, task_id, path, created_at, includes_json, redacted)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(packageId, taskId, filePath, createdAt, JSON.stringify(includes), 1);

    return diagnosticPackage;
  }

  private redactText(value: string): string {
    return value
      .replace(/Bearer\s+sk-[A-Za-z0-9_-]+/g, 'Bearer [REDACTED]')
      .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/(Authorization:\s*)[^\n",]+/gi, '$1[REDACTED]')
      .replace(/("(?:apiKey|api_key|token|password|credentialRef|cookie)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
  }

  private bytesToMb(value: number): number {
    return Math.round((value / 1024 / 1024) * 10) / 10;
  }

  private kbToMb(value: number): number {
    return Math.round((value / 1024) * 10) / 10;
  }

  private readElectronMetrics(): PerformanceElectronMetrics {
    const processMetrics = this.runtimeMetricsProvider.getProcessMetrics().map((metric) =>
      this.toPerformanceProcessMetric(metric)
    );
    return {
      browserWindowCount: this.runtimeMetricsProvider.getBrowserWindowCount(),
      processCount: processMetrics.length,
      processMetrics
    };
  }

  private toPerformanceProcessMetric(metric: RuntimeProcessMetric): PerformanceProcessMetric {
    return {
      pid: metric.pid,
      type: metric.type,
      name: metric.name ?? null,
      serviceName: metric.serviceName ?? null,
      cpuPercent: metric.cpuPercent,
      sandboxed: metric.sandboxed ?? null,
      integrityLevel: metric.integrityLevel ?? null,
      memory: {
        workingSetSizeMb: this.kbToMb(metric.memory.workingSetSizeKb),
        peakWorkingSetSizeMb: this.kbToMb(metric.memory.peakWorkingSetSizeKb),
        privateBytesMb:
          metric.memory.privateBytesKb === undefined ? null : this.kbToMb(metric.memory.privateBytesKb),
        sharedBytesMb: metric.memory.sharedBytesKb === undefined ? null : this.kbToMb(metric.memory.sharedBytesKb)
      }
    };
  }

  private countScheduledRunningTasks(): number {
    const row = this.database.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM background_tasks
         WHERE scheduled = 1
           AND status = 'running'`
      )
      .get() as { count: number };
    return row.count;
  }

  private countInvalidCronExpressions(): number {
    const rows = this.database.db
      .prepare(
        `SELECT cron_expression
         FROM background_tasks
         WHERE trigger_type = 'cron'
           AND cron_expression IS NOT NULL`
      )
      .all() as Array<{ cron_expression: string }>;
    let invalidCount = 0;
    for (const row of rows) {
      try {
        parseCronExpression(row.cron_expression);
      } catch {
        invalidCount += 1;
      }
    }
    return invalidCount;
  }

}
