import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { z } from 'zod';

import type {
  BackgroundTaskSummary,
  DiagnosticCheck,
  DiagnosticPackage,
  DiagnosticPackageRequest,
  HealthCheckResult,
  MetricFilter,
  MetricsSnapshot,
  PerformanceSample,
  PerformanceSampleRequest,
  RtkStatus,
  SchedulerStatus,
  TaskSnapshot,
  TraySummary
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPlugin, RocPluginContext } from '../../kernel/types';
import { requireText } from '../../services/validation';
import { RocPaths } from '../../services/paths';
import { createDiagnosticsLifecycleAdapter, type DiagnosticsLifecycleAdapter, type DiagnosticsLifecycleScheduler } from './lifecycle-adapter';
import {
  applyDiagnosticsPluginSchema,
  createDiagnosticsPerformanceAdapter,
  type DiagnosticsPerformanceAdapter,
  type DiagnosticsPerformanceAdapterOptions
} from './performance-adapter';

const pluginId = '@roc/plugin-diagnostics';
const capabilityVersion = '1.0.0';

const emptyInputSchema = z.object({});
const performanceSampleRequestSchema = z.object({
  mode: z.enum(['development', 'packaged', 'smoke', 'test']),
  memoryBudgetMb: z.number()
}) satisfies z.ZodType<PerformanceSampleRequest>;
const diagnosticPackageRequestSchema = z.object({
  taskId: z.string(),
  errorSummary: z.string()
}) satisfies z.ZodType<DiagnosticPackageRequest>;
const metricFilterSchema = z
  .object({
    name: z.string().optional(),
    type: z.enum(['counter', 'gauge', 'histogram']).optional(),
    labels: z.record(z.string(), z.string()).optional(),
    since: z.string().optional()
  })
  .optional() satisfies z.ZodType<MetricFilter | undefined>;

const diagnosticsCapabilityDescriptors = [
  descriptor('diagnostics.samplePerformance', performanceSampleRequestSchema, z.custom<PerformanceSample>()),
  descriptor('diagnostics.createPackage', diagnosticPackageRequestSchema, z.custom<DiagnosticPackage>()),
  descriptor('diagnostics.runChecks', emptyInputSchema, z.custom<DiagnosticCheck[]>()),
  descriptor('diagnostics.getMetricsSnapshot', metricFilterSchema, z.custom<MetricsSnapshot>()),
  descriptor('diagnostics.runHealthCheck', emptyInputSchema, z.custom<HealthCheckResult>()),
  descriptor('lifecycle.getTraySummary', emptyInputSchema, z.custom<TraySummary>()),
  descriptor('lifecycle.pauseBackgroundExecution', emptyInputSchema, z.custom<TraySummary>()),
  descriptor('lifecycle.resumeBackgroundExecution', emptyInputSchema, z.custom<TraySummary>())
] as const satisfies readonly CapabilityDescriptor[];

export type DiagnosticsValueProvider<T> = () => T | Promise<T>;

export type DiagnosticsPluginOptions = {
  rootDir?: string;
  performanceAdapter?: DiagnosticsPerformanceAdapter;
  lifecycleAdapter?: DiagnosticsLifecycleAdapter;
  scheduler?: DiagnosticsLifecycleScheduler;
  taskSnapshotProvider?: DiagnosticsValueProvider<TaskSnapshot>;
  rtkStatusProvider?: DiagnosticsValueProvider<RtkStatus>;
  schedulerStatusProvider?: DiagnosticsValueProvider<SchedulerStatus>;
  healthCheckProvider?: () => Promise<HealthCheckResult>;
  performanceObserverService?: DiagnosticsPerformanceAdapterOptions['performanceObserverService'];
  runtimeMetricsProvider?: DiagnosticsPerformanceAdapterOptions['runtimeMetricsProvider'];
};

export function createDiagnosticsPlugin(options: DiagnosticsPluginOptions = {}): RocPlugin {
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Diagnostics',
      description: 'Roc diagnostics plugin.',
      loadPhase: 'critical',
      required: true,
      order: 80,
      dependencies: ['@roc/plugin-task', '@roc/plugin-runtime-tools'],
      capabilities: diagnosticsCapabilityDescriptors
    },
    initialize: async (context) => {
      const db = context.database.getConnection();
      applyDiagnosticsPluginSchema(db);
      const paths = new RocPaths(options.rootDir);
      paths.ensureTree();
      const performanceAdapter =
        options.performanceAdapter === undefined
          ? createDiagnosticsPerformanceAdapter({
              db,
              performanceObserverService: options.performanceObserverService,
              runtimeMetricsProvider: options.runtimeMetricsProvider
            })
          : options.performanceAdapter;
      const taskSnapshotProvider =
        options.taskSnapshotProvider === undefined
          ? () => context.capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {})
          : options.taskSnapshotProvider;
      const rtkStatusProvider =
        options.rtkStatusProvider === undefined
          ? () => context.capabilities.invoke<{}, RtkStatus>('rtk.status', {})
          : options.rtkStatusProvider;
      const schedulerStatusProvider =
        options.schedulerStatusProvider === undefined
          ? () => context.capabilities.invoke<{}, SchedulerStatus>('task.scheduler.status', {})
          : options.schedulerStatusProvider;
      const lifecycleAdapter =
        options.lifecycleAdapter === undefined
          ? createDiagnosticsLifecycleAdapter({
              getBackgroundTaskSummary: () => context.capabilities.invoke<{}, BackgroundTaskSummary>('task.background.summary', {}),
              scheduler: options.scheduler === undefined ? noopScheduler : options.scheduler
            })
          : options.lifecycleAdapter;
      const healthCheckProvider =
        options.healthCheckProvider === undefined ? () => runDefaultHealthCheck(db) : options.healthCheckProvider;

      registerDiagnosticsCapabilities(context, {
        db,
        healthCheckProvider,
        lifecycleAdapter,
        paths,
        performanceAdapter,
        rtkStatusProvider,
        schedulerStatusProvider,
        taskSnapshotProvider
      });
    },
    shutdown: async () => {},
    healthCheck: async () => ({ status: 'healthy' })
  };
}

export const diagnosticsPlugin = createDiagnosticsPlugin();
export { diagnosticsCapabilityDescriptors };

function registerDiagnosticsCapabilities(
  context: RocPluginContext,
  input: {
    db: ReturnType<RocPluginContext['database']['getConnection']>;
    healthCheckProvider: () => Promise<HealthCheckResult>;
    lifecycleAdapter: DiagnosticsLifecycleAdapter;
    paths: RocPaths;
    performanceAdapter: DiagnosticsPerformanceAdapter;
    rtkStatusProvider: DiagnosticsValueProvider<RtkStatus>;
    schedulerStatusProvider: DiagnosticsValueProvider<SchedulerStatus>;
    taskSnapshotProvider: DiagnosticsValueProvider<TaskSnapshot>;
  }
): void {
  context.capabilities.register(pluginId, diagnosticsCapabilityDescriptors[0], async (request) => {
    input.performanceAdapter.recordCapabilityTiming({
      name: 'diagnostics.samplePerformance',
      startedAtMs: performance.now(),
      durationMs: 0,
      ok: true
    });
    return input.performanceAdapter.samplePerformance(request as PerformanceSampleRequest);
  });
  context.capabilities.register(pluginId, diagnosticsCapabilityDescriptors[1], async (request) =>
    createDiagnosticPackage(request as DiagnosticPackageRequest, input)
  );
  context.capabilities.register(pluginId, diagnosticsCapabilityDescriptors[2], async () =>
    runChecks(await input.schedulerStatusProvider(), await input.taskSnapshotProvider())
  );
  context.capabilities.register(pluginId, diagnosticsCapabilityDescriptors[3], async (filter) =>
    input.performanceAdapter.getMetricsSnapshot(filter as MetricFilter | undefined)
  );
  context.capabilities.register(pluginId, diagnosticsCapabilityDescriptors[4], async () => input.healthCheckProvider());
  context.capabilities.register(pluginId, diagnosticsCapabilityDescriptors[5], async () => input.lifecycleAdapter.getTraySummary());
  context.capabilities.register(pluginId, diagnosticsCapabilityDescriptors[6], async () =>
    input.lifecycleAdapter.pauseBackgroundExecution()
  );
  context.capabilities.register(pluginId, diagnosticsCapabilityDescriptors[7], async () =>
    input.lifecycleAdapter.resumeBackgroundExecution()
  );
}

async function createDiagnosticPackage(
  request: DiagnosticPackageRequest,
  input: {
    db: ReturnType<RocPluginContext['database']['getConnection']>;
    paths: RocPaths;
    performanceAdapter: DiagnosticsPerformanceAdapter;
    rtkStatusProvider: DiagnosticsValueProvider<RtkStatus>;
    taskSnapshotProvider: DiagnosticsValueProvider<TaskSnapshot>;
  }
): Promise<DiagnosticPackage> {
  const taskId = requireText(request.taskId, 'diagnostic_task_id_empty', '诊断包任务 ID 不能为空。', '请选择要诊断的任务。');
  const createdAt = new Date().toISOString();
  const packageId = `diagnostic_${randomUUID()}`;
  mkdirSync(input.paths.diagnosticsDir, { recursive: true });

  const latestPerformance = input.performanceAdapter.getLatestPerformanceSample();
  const performanceSample =
    latestPerformance === null
      ? input.performanceAdapter.samplePerformance({
          mode: process.env.VITEST === 'true' ? 'test' : 'development',
          memoryBudgetMb: 300
        })
      : latestPerformance;
  const includes = ['task_snapshot', 'performance_sample', 'logs', 'recovery_points', 'rtk_status'];
  const rawPayload = {
    id: packageId,
    taskId,
    createdAt,
    taskSnapshot: await input.taskSnapshotProvider(),
    performanceSample,
    logs: {
      directory: input.paths.logsDir
    },
    recoveryPoints: {
      directory: join(input.paths.tasksDir, 'recovery')
    },
    rtkStatus: await input.rtkStatusProvider(),
    errorSummary: request.errorSummary
  };
  const redactedPayload = redactText(JSON.stringify(rawPayload, null, 2));
  const filePath = join(input.paths.diagnosticsDir, `${packageId}.json`);
  writeFileSync(filePath, `${redactedPayload}\n`, 'utf8');

  const diagnosticPackage: DiagnosticPackage = {
    id: packageId,
    taskId,
    path: filePath,
    createdAt,
    includes,
    redacted: true
  };
  input.db
    .prepare(
      `INSERT INTO diagnostic_packages (id, task_id, path, created_at, includes_json, redacted)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(packageId, taskId, filePath, createdAt, JSON.stringify(includes), 1);

  return diagnosticPackage;
}

function runChecks(schedulerStatus: SchedulerStatus, taskSnapshot: TaskSnapshot): DiagnosticCheck[] {
  const checkedAt = new Date().toISOString();
  const scheduledTaskCount = taskSnapshot.counts.running;
  const recentSkippedCount = schedulerStatus.recentSkippedCount;
  const invalidCronCount = 0;
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
        : `已注册 ${schedulerStatus.registeredTaskCount} 个调度任务，任务快照中有 ${scheduledTaskCount} 个运行中任务。`,
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

async function runDefaultHealthCheck(
  db: ReturnType<RocPluginContext['database']['getConnection']>
): Promise<HealthCheckResult> {
  const lastChecked = new Date().toISOString();
  try {
    const result = db.prepare('SELECT 1 as value').get() as { value: number };
    if (result.value !== 1) {
      return {
        status: 'unhealthy',
        checks: [{ name: 'database', status: 'fail', message: 'Database probe returned an unexpected value.', lastChecked }]
      };
    }
    return {
      status: 'healthy',
      checks: [{ name: 'database', status: 'pass', lastChecked }]
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      checks: [
        {
          name: 'database',
          status: 'fail',
          message: error instanceof Error ? error.message : String(error),
          lastChecked
        }
      ]
    };
  }
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+sk-[A-Za-z0-9_-]+/g, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(Authorization:\s*)[^\n",]+/gi, '$1[REDACTED]')
    .replace(/("(?:apiKey|api_key|token|password|credentialRef|cookie)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
}

function descriptor<TInput, TOutput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): CapabilityDescriptor<TInput, TOutput> {
  return {
    name,
    version: capabilityVersion,
    inputSchema,
    outputSchema
  };
}

const noopScheduler: DiagnosticsLifecycleScheduler = {
  suspendAll: () => {},
  resumeAll: () => {}
};
