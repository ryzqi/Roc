import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DiagnosticPackage, DiagnosticPackageRequest, PerformanceSample, PerformanceSampleRequest } from '../../shared/types';
import type { DatabaseService } from './database-service';
import { RocDomainError } from './errors';
import type { RocPaths } from './paths';
import type { RtkService } from './rtk-service';
import type { TaskService } from './task-service';
import { requireText } from './validation';

export class DiagnosticsService {
  constructor(
    private readonly paths: RocPaths,
    private readonly database: DatabaseService,
    private readonly taskService: TaskService,
    private readonly rtkService: RtkService
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
      exceedsBudget: this.bytesToMb(memoryUsage.rss) > request.memoryBudgetMb
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
      exceedsBudget: row.exceeds_budget === 1
    };
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

}
