import { z } from 'zod';

import { enabledCapabilitiesSchema } from './agent';
import { persistedTaskEventSchema, taskEventSchema } from './task-event';

export const rocRunModeSchema = z.enum(['development', 'packaged', 'smoke', 'test']);
export const rocErrorCategorySchema = z.enum([
  'validation',
  'permission',
  'not_found',
  'conflict',
  'external',
  'degraded',
  'internal'
]);
export const rocErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    category: rocErrorCategorySchema,
    retryable: z.boolean(),
    userAction: z.string().optional(),
    auditEventId: z.string().optional()
  })
  .strict();

export function ipcResultSchema<TDataSchema extends z.ZodType>(dataSchema: TDataSchema) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    z.object({ ok: z.literal(false), error: rocErrorSchema }).strict()
  ]);
}

export const serviceStatusSchema = z.enum(['ready', 'blocked', 'degraded']);

export const rocPathsSnapshotSchema = z
  .object({
    root: z.string(),
    configDir: z.string(),
    memoryDir: z.string(),
    logsDir: z.string(),
    diagnosticsDir: z.string(),
    skillsDir: z.string(),
    artifactsDir: z.string()
  })
  .strict();

const performanceTimingSampleSchema = z
  .object({
    id: z.string(),
    phase: z.enum([
      'main_ready',
      'services_created',
      'services_initialized',
      'services_critical_initialized',
      'services_deferred_initialized',
      'window_created',
      'renderer_loaded',
      'ready_to_show',
      'renderer_first_paint',
      'renderer_interactive',
      'ipc_call',
      'db_query',
      'file_io',
      'provider_first_token',
      'provider_failed',
      'provider_completed'
    ]),
    label: z.string(),
    startedAtMs: z.number(),
    durationMs: z.number(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  })
  .strict();

const performanceSnapshotSchema = z
  .object({
    generatedAt: z.string(),
    samples: z.array(performanceTimingSampleSchema)
  })
  .strict();

const performanceIpcChannelSummarySchema = z
  .object({
    channel: z.string(),
    count: z.number(),
    totalDurationMs: z.number(),
    averageDurationMs: z.number(),
    maxDurationMs: z.number(),
    lastOk: z.boolean().nullable()
  })
  .strict();

const performanceIpcSummarySchema = z
  .object({
    generatedFromSamples: z.number(),
    totalCalls: z.number(),
    topLimit: z.number(),
    topSlowCalls: z.array(performanceIpcChannelSummarySchema),
    topFrequentCalls: z.array(performanceIpcChannelSummarySchema),
    windowSetBoundsCalls: z.number()
  })
  .strict();

export const systemAppearanceSnapshotSchema = z
  .object({
    accentColor: z.string(),
    inForcedColorsMode: z.boolean(),
    prefersReducedTransparency: z.boolean(),
    resolvedTheme: z.enum(['light', 'dark']),
    shouldUseHighContrastColors: z.boolean(),
    shouldUseInvertedColorScheme: z.boolean(),
    themeSource: z.enum(['system', 'light', 'dark'])
  })
  .strict();

export const appStatusSchema = z
  .object({
    appName: z.string(),
    version: z.string(),
    mode: rocRunModeSchema,
    startedAt: z.string(),
    appearance: systemAppearanceSnapshotSchema,
    workspace: z.object({ selectedPath: z.string().nullable(), label: z.string() }).strict(),
    paths: rocPathsSnapshotSchema,
    services: z.record(z.string(), serviceStatusSchema),
    defaultModelConfigured: z.boolean(),
    rendererBoundary: z
      .object({
        contextIsolation: z.boolean(),
        nodeIntegration: z.boolean(),
        sandbox: z
          .object({
            enabled: z.boolean(),
            evaluated: z.boolean(),
            reason: z.string().nullable(),
            compensatingControls: z.array(z.string())
          })
          .strict()
      })
      .strict()
  })
  .strict();

export const windowStateSnapshotSchema = z
  .object({ maximized: z.boolean(), minimized: z.boolean(), fullscreen: z.boolean() })
  .strict();

export const windowBoundsSnapshotSchema = z
  .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
  .strict();

export const openedResultSchema = z.object({ opened: z.literal(true) }).strict();
export const openedPageResultSchema = z
  .object({ opened: z.literal(true), page: z.string() })
  .strict();
export const closedResultSchema = z.object({ closed: z.literal(true) }).strict();
export const deliveredResultSchema = z.object({ delivered: z.literal(true) }).strict();
export const deletedResultSchema = z.object({ deleted: z.literal(true) }).strict();

const performanceProcessMetricSchema = z
  .object({
    pid: z.number(),
    type: z.string(),
    name: z.string().nullable(),
    serviceName: z.string().nullable(),
    cpuPercent: z.number(),
    sandboxed: z.boolean().nullable(),
    integrityLevel: z.string().nullable(),
    memory: z
      .object({
        workingSetSizeMb: z.number(),
        peakWorkingSetSizeMb: z.number(),
        privateBytesMb: z.number().nullable(),
        sharedBytesMb: z.number().nullable()
      })
      .strict()
  })
  .strict();

export const performanceSampleSchema = z
  .object({
    id: z.string(),
    sampledAt: z.string(),
    mode: rocRunModeSchema,
    uptimeSeconds: z.number(),
    rssMb: z.number(),
    heapUsedMb: z.number(),
    heapTotalMb: z.number(),
    memoryBudgetMb: z.number(),
    totalPrivateBytesMb: z.number().nullable(),
    totalWorkingSetMb: z.number(),
    memoryMeasurement: z.enum(['complete', 'private_bytes_unavailable']),
    exceedsBudget: z.boolean(),
    timing: performanceSnapshotSchema,
    ipc: performanceIpcSummarySchema,
    electron: z
      .object({
        browserWindowCount: z.number(),
        processCount: z.number(),
        processMetrics: z.array(performanceProcessMetricSchema)
      })
      .strict()
  })
  .strict();

export const performanceSampleRequestSchema = z
  .object({ mode: rocRunModeSchema, memoryBudgetMb: z.number() })
  .strict();

export const taskStatusSchema = z.enum([
  'draft',
  'pending_confirmation',
  'dispatch_pending',
  'running',
  'recovering',
  'paused',
  'waiting_user',
  'waiting_next_turn',
  'failed',
  'cancelled',
  'completed',
  'interrupted',
  'archived'
]);

export const taskThreadSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['chat', 'background']),
    title: z.string(),
    goal: z.string(),
    status: taskStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();

export const taskSnapshotSchema = z
  .object({
    generatedAt: z.string(),
    counts: z
      .object({
        total: z.number(),
        running: z.number(),
        failed: z.number(),
        pendingConfirmation: z.number()
      })
      .strict(),
    threads: z.array(taskThreadSchema),
    recentEvents: z.array(taskEventSchema)
  })
  .strict();

const taskMessageHistoryCursorSchema = z.union([
  z.null(),
  z.object({ direction: z.literal('before'), sequence: z.number().int().positive() }).strict(),
  z.object({ direction: z.literal('after'), sequence: z.number().int().positive() }).strict()
]);

export const taskMessageHistoryRequestSchema = z
  .object({
    threadId: z.string().trim().min(1),
    limit: z.number().int().min(1).max(200),
    cursor: taskMessageHistoryCursorSchema
  })
  .strict();

export const taskMessageHistoryPageSchema = z
  .object({
    items: z.array(persistedTaskEventSchema),
    oldestSequence: z.number().int().positive().nullable(),
    newestSequence: z.number().int().positive().nullable(),
    hasMoreBefore: z.boolean(),
    hasMoreAfter: z.boolean()
  })
  .strict();

export const taskRunSchema = z
  .object({
    id: z.string(),
    threadId: z.string(),
    runNumber: z.number(),
    userInput: z.string(),
    status: taskStatusSchema,
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    modelId: z.string().nullable(),
    enabledCapabilities: enabledCapabilitiesSchema
  })
  .strict();

export const taskDeleteThreadRequestSchema = z.object({ threadId: z.string() }).strict();
export const taskDeleteThreadResultSchema = z
  .object({ deleted: z.literal(true), threadId: z.string() })
  .strict();

export const backgroundTaskTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual'), description: z.string().trim().min(1) }).strict(),
  z
    .object({
      type: z.literal('once'),
      description: z.string().trim().min(1),
      nextRunAt: z.string().datetime({ offset: true })
    })
    .strict(),
  z
    .object({
      type: z.literal('cron'),
      description: z.string().trim().min(1),
      cronExpression: z.string().trim().min(1),
      nextRunAt: z.string().datetime({ offset: true })
    })
    .strict()
]);

export const backgroundTaskRiskSchema = z.enum(['low', 'medium', 'high']);
const backgroundTaskStatusSchema = z.enum([
  'draft',
  'pending_confirmation',
  'running',
  'paused',
  'waiting_user',
  'waiting_next_turn',
  'failed',
  'cancelled',
  'completed',
  'archived'
]);

export const backgroundTaskPreviewRequestSchema = z
  .object({
    goal: z.string().trim().min(1),
    trigger: backgroundTaskTriggerSchema,
    workspacePath: z.string().trim().min(1),
    allowedActions: z.array(z.string().trim().min(1)),
    forbiddenActions: z.array(z.string().trim().min(1)),
    failurePolicy: z.literal('pause_and_report'),
    notificationPolicy: z.literal('failures_and_confirmations'),
    enabledCapabilities: enabledCapabilitiesSchema.nullable().optional()
  })
  .strict();

export const backgroundTaskPreviewSchema = backgroundTaskPreviewRequestSchema.extend({
  scheduled: z.boolean(),
  nextRunAt: z.string().datetime({ offset: true }).nullable(),
  cronExpression: z.string().nullable(),
  riskLevel: backgroundTaskRiskSchema,
  requiresConfirmation: z.boolean(),
  enabledCapabilities: enabledCapabilitiesSchema.nullable()
}).strict();

export const backgroundTaskSchema = z
  .object({
    id: z.string().trim().min(1),
    threadId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    status: backgroundTaskStatusSchema,
    scheduled: z.boolean(),
    triggerType: z.enum(['manual', 'once', 'cron']),
    triggerDescription: z.string().trim().min(1),
    nextRunAt: z.string().datetime({ offset: true }).nullable(),
    cronExpression: z.string().nullable(),
    workspacePath: z.string().trim().min(1),
    allowedActions: z.array(z.string().trim().min(1)),
    forbiddenActions: z.array(z.string().trim().min(1)),
    failurePolicy: z.literal('pause_and_report'),
    notificationPolicy: z.literal('failures_and_confirmations'),
    riskLevel: backgroundTaskRiskSchema,
    requiresConfirmation: z.boolean(),
    lastRunAt: z.string().datetime({ offset: true }).nullable(),
    lastRunStatus: z.enum(['success', 'failed', 'cancelled']).nullable(),
    runCount: z.number().int().min(0),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    enabledCapabilities: enabledCapabilitiesSchema.nullable()
  })
  .strict();

export const activeTaskItemSchema = z
  .object({
    kind: z.literal('background'),
    threadId: z.string(),
    taskId: z.string(),
    title: z.string(),
    goal: z.string(),
    status: taskStatusSchema,
    trigger: backgroundTaskTriggerSchema.nullable(),
    nextRunAt: z.string().nullable(),
    lastRunAt: z.string().nullable(),
    riskLevel: backgroundTaskRiskSchema,
    workspacePath: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();

export const scheduledTaskRunSchema = z
  .object({
    id: z.string(),
    backgroundTaskId: z.string(),
    taskRunId: z.string().nullable(),
    scheduledAt: z.string(),
    triggeredAt: z.string().nullable(),
    status: z.enum([
      'pending',
      'claimed',
      'dispatched',
      'completed',
      'failed',
      'cancelled',
      'skipped',
      'unknown',
      'fired'
    ]),
    skipReason: z.string().nullable()
  })
  .strict();

export const taskDetailSchema = z
  .object({
    threadId: z.string(),
    taskId: z.string().nullable(),
    thread: taskThreadSchema,
    backgroundTask: backgroundTaskSchema.nullable(),
    lastRunId: z.string().nullable(),
    runHistory: z.array(taskRunSchema),
    recentEvents: z.array(taskEventSchema),
    schedulerRegistered: z.boolean()
  })
  .strict();

export const updateBackgroundTaskRequestSchema = z
  .object({
    taskId: z.string().trim().min(1),
    patch: backgroundTaskPreviewRequestSchema.partial().strict(),
    reason: z.string().trim().min(1)
  })
  .strict();

export const taskIdRequestSchema = z.object({ taskId: z.string() }).strict();
export const scheduledTaskRunsRequestSchema = z
  .object({ taskId: z.string(), limit: z.number().int().positive().optional() })
  .strict();
export const taskRunNowResultSchema = z
  .object({ taskId: z.string(), runId: z.string() })
  .strict();
export const taskDeleteBackgroundResultSchema = z
  .object({ deleted: z.literal(true), taskId: z.string() })
  .strict();

export const taskUpdateEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task_created'), taskId: z.string() }).strict(),
  z
    .object({ kind: z.literal('task_status_changed'), taskId: z.string(), status: taskStatusSchema })
    .strict(),
  z.object({ kind: z.literal('task_run_fired'), taskId: z.string(), runId: z.string() }).strict(),
  z.object({ kind: z.literal('thread_deletion_started'), threadId: z.string() }).strict(),
  z.object({ kind: z.literal('scheduler_health_changed'), healthy: z.boolean() }).strict()
]);

export const schedulerStatusSchema = z
  .object({
    running: z.boolean(),
    registeredTaskCount: z.number(),
    nextFireAt: z.string().nullable(),
    recentSkippedCount: z.number(),
    lastError: z.string().nullable()
  })
  .strict();

export const backgroundTaskSummarySchema = z
  .object({
    total: z.number(),
    running: z.number(),
    failed: z.number(),
    pendingConfirmation: z.number(),
    nextRunAt: z.string().nullable()
  })
  .strict();

export const traySummarySchema = z
  .object({
    residentEnabled: z.boolean(),
    backgroundPaused: z.boolean(),
    backgroundTasks: backgroundTaskSummarySchema,
    nextRunAt: z.string().nullable(),
    updatedAt: z.string()
  })
  .strict();

export const diagnosticPackageRequestSchema = z
  .object({ taskId: z.string(), errorSummary: z.string() })
  .strict();

export const diagnosticPackageSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    path: z.string(),
    createdAt: z.string(),
    includes: z.array(z.string()),
    redacted: z.boolean()
  })
  .strict();

export const diagnosticCheckSchema = z
  .object({
    id: z.enum([
      'scheduler_running',
      'scheduler_tasks_registered',
      'scheduler_missed_runs_recent',
      'cron_expressions_valid'
    ]),
    label: z.string(),
    status: z.enum(['pass', 'warn', 'fail']),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string(),
    checkedAt: z.string()
  })
  .strict();

const healthCheckSchema = z
  .object({
    name: z.enum([
      'database',
      'task_scheduler',
      'disk_space',
      'memory_usage',
      'memory_service',
      'provider_connectivity'
    ]),
    status: z.enum(['pass', 'warn', 'fail']),
    message: z.string().optional(),
    lastChecked: z.string()
  })
  .strict();

export const healthCheckResultSchema = z
  .object({
    status: z.enum(['healthy', 'degraded', 'unhealthy']),
    checks: z.array(healthCheckSchema)
  })
  .strict();

const metricTypeSchema = z.enum(['counter', 'gauge', 'histogram']);

export const metricFilterSchema = z
  .object({
    name: z.string().optional(),
    type: metricTypeSchema.optional(),
    labels: z.record(z.string(), z.string()).optional(),
    since: z.string().optional()
  })
  .strict();

const metricSchema = z
  .object({
    name: z.string(),
    type: metricTypeSchema,
    value: z.number(),
    timestamp: z.string(),
    labels: z.record(z.string(), z.string())
  })
  .strict();

export const metricsSnapshotSchema = z
  .object({
    generatedAt: z.string(),
    metrics: z.array(metricSchema),
    summary: z
      .object({
        totalMetrics: z.number(),
        counterCount: z.number(),
        gaugeCount: z.number(),
        histogramCount: z.number()
      })
      .strict()
  })
  .strict();
