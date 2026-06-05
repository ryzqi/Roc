import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocPluginContext } from '../../../../src/main/kernel/types';
import { createDiagnosticsPlugin } from '../../../../src/main/plugins/diagnostics';
import {
  applyDiagnosticsPluginSchema,
  createDiagnosticsPerformanceAdapter
} from '../../../../src/main/plugins/diagnostics/performance-adapter';
import type {
  DiagnosticPackage,
  DiagnosticPackageRequest,
  HealthCheckResult,
  PerformanceSample,
  PerformanceSampleRequest,
  TaskSnapshot
} from '../../../../src/shared/types';

const diagnosticsCapabilities = [
  'diagnostics.samplePerformance',
  'diagnostics.createPackage',
  'diagnostics.runChecks',
  'diagnostics.getMetricsSnapshot',
  'diagnostics.runHealthCheck',
  'lifecycle.getTraySummary',
  'lifecycle.pauseBackgroundExecution',
  'lifecycle.resumeBackgroundExecution'
];

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-diagnostics-plugin-'));
  mkdirSync(join(root, 'logs'), { recursive: true });
  mkdirSync(join(root, 'tasks', 'recovery'), { recursive: true });
  db = new Database(':memory:');
  applyDiagnosticsPluginSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('diagnostics plugin', () => {
  it('declares the Phase 3 diagnostics plugin contract', () => {
    const plugin = createDiagnosticsPlugin({ rootDir: root });

    expect(plugin.manifest.id).toBe('@roc/plugin-diagnostics');
    expect(plugin.manifest.dependencies).toEqual(['@roc/plugin-task', '@roc/plugin-runtime-tools']);
    expect(plugin.manifest.loadPhase).toBe('critical');
    expect(plugin.manifest.required).toBe(true);
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(diagnosticsCapabilities);
  });

  it('preserves diagnostics package, checks, health, metrics, and lifecycle behavior through capabilities', async () => {
    const performanceAdapter = createDiagnosticsPerformanceAdapter({ db });
    performanceAdapter.metrics.setGauge('scheduler.registered_tasks', 1, { state: 'active' });
    const scheduler = {
      suspendAll: vi.fn(),
      resumeAll: vi.fn()
    };
    const healthCheck: HealthCheckResult = {
      status: 'healthy',
      checks: [
        {
          name: 'database',
          status: 'pass',
          lastChecked: '2026-06-04T00:00:00.000Z'
        }
      ]
    };
    const capabilities = await initializePlugin({
      performanceAdapter,
      scheduler,
      healthCheckProvider: async () => healthCheck
    });

    const sample = await capabilities.invoke<PerformanceSampleRequest, PerformanceSample>('diagnostics.samplePerformance', {
      mode: 'test',
      memoryBudgetMb: 2048
    });
    const diagnosticPackage = await capabilities.invoke<DiagnosticPackageRequest, DiagnosticPackage>(
      'diagnostics.createPackage',
      {
        taskId: 'task_123',
        errorSummary: 'Authorization: Bearer sk-secret-token'
      }
    );
    const packageContent = readFileSync(diagnosticPackage.path, 'utf8');
    const checks = await capabilities.invoke('diagnostics.runChecks', {});
    const metrics = await capabilities.invoke('diagnostics.getMetricsSnapshot', { name: 'scheduler.registered_tasks' });
    const health = await capabilities.invoke('diagnostics.runHealthCheck', {});
    const paused = await capabilities.invoke('lifecycle.pauseBackgroundExecution', {});
    const resumed = await capabilities.invoke('lifecycle.resumeBackgroundExecution', {});

    expect(sample.ipc.topSlowCalls).toContainEqual(
      expect.objectContaining({
        channel: 'diagnostics.samplePerformance',
        count: 1,
        lastOk: true
      })
    );
    expect(diagnosticPackage).toMatchObject({
      taskId: 'task_123',
      includes: ['task_snapshot', 'performance_sample', 'logs', 'recovery_points', 'rtk_status'],
      redacted: true
    });
    expect(packageContent).toContain('"taskSnapshot"');
    expect(packageContent).toContain('"title": "Task 123"');
    expect(packageContent).toContain('"performanceSample"');
    expect(packageContent).toContain('"logs"');
    expect(packageContent).toContain('"recoveryPoints"');
    expect(packageContent).toContain('"resourceState": "ready"');
    expect(packageContent).toContain('Authorization: [REDACTED]');
    expect(packageContent).not.toContain('sk-secret-token');
    expect(checks).toEqual([
      expect.objectContaining({ id: 'scheduler_running', status: 'pass' }),
      expect.objectContaining({ id: 'scheduler_tasks_registered', status: 'pass' }),
      expect.objectContaining({ id: 'scheduler_missed_runs_recent', status: 'pass' }),
      expect.objectContaining({ id: 'cron_expressions_valid', status: 'pass' })
    ]);
    expect(metrics).toMatchObject({
      summary: { totalMetrics: 1, gaugeCount: 1 }
    });
    expect(health).toEqual(healthCheck);
    expect(scheduler.suspendAll).toHaveBeenCalledTimes(1);
    expect(scheduler.resumeAll).toHaveBeenCalledTimes(1);
    expect(paused).toMatchObject({
      backgroundPaused: true,
      backgroundTasks: {
        total: 1,
        running: 1,
        failed: 0,
        pendingConfirmation: 0,
        nextRunAt: '2026-05-22T01:00:00.000Z'
      },
      nextRunAt: '2026-05-22T01:00:00.000Z'
    });
    expect(resumed).toMatchObject({ backgroundPaused: false });
  });

  it('routes default lifecycle pause and resume through task scheduler capabilities', async () => {
    const plugin = createDiagnosticsPlugin({
      rootDir: root,
      performanceAdapter: createDiagnosticsPerformanceAdapter({ db }),
      taskSnapshotProvider: () => taskSnapshot,
      rtkStatusProvider: () => ({
        enabledForAgentCommands: true,
        binaryPath: join(root, 'rtk', 'roc-task'),
        configPath: join(root, 'rtk', 'config.json'),
        teeDir: join(root, 'rtk', 'tee'),
        resourceState: 'ready'
      }),
      schedulerStatusProvider: () => ({
        running: true,
        registeredTaskCount: 1,
        nextFireAt: '2026-06-04T10:00:00.000Z',
        recentSkippedCount: 0,
        lastError: null
      }),
      healthCheckProvider: async () => ({ status: 'healthy', checks: [] })
    });
    const capabilities = new CapabilityRegistry();
    const calls: string[] = [];
    registerTaskLifecycleCapabilities(capabilities, calls);
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext(capabilities));

    await capabilities.invoke('lifecycle.pauseBackgroundExecution', {});
    await capabilities.invoke('lifecycle.resumeBackgroundExecution', {});

    expect(calls).toEqual(['suspend', 'resume']);
  });
});

async function initializePlugin(options: {
  performanceAdapter: ReturnType<typeof createDiagnosticsPerformanceAdapter>;
  scheduler: {
    suspendAll(): void;
    resumeAll(): void;
  };
  healthCheckProvider: () => Promise<HealthCheckResult>;
}): Promise<CapabilityRegistry> {
  const plugin = createDiagnosticsPlugin({
    rootDir: root,
    performanceAdapter: options.performanceAdapter,
    scheduler: options.scheduler,
    taskSnapshotProvider: () => taskSnapshot,
    rtkStatusProvider: () => ({
      enabledForAgentCommands: true,
      binaryPath: join(root, 'rtk', 'roc-task'),
      configPath: join(root, 'rtk', 'config.json'),
      teeDir: join(root, 'rtk', 'tee'),
      resourceState: 'ready'
    }),
    schedulerStatusProvider: () => ({
      running: true,
      registeredTaskCount: 1,
      nextFireAt: '2026-06-04T10:00:00.000Z',
      recentSkippedCount: 0,
      lastError: null
    }),
    healthCheckProvider: options.healthCheckProvider
  });
  const capabilities = new CapabilityRegistry();
  registerTaskLifecycleCapabilities(capabilities, []);
  for (const descriptor of plugin.manifest.capabilities) {
    capabilities.declare(plugin.manifest.id, descriptor);
  }
  await plugin.initialize(createContext(capabilities));
  return capabilities;
}

function registerTaskLifecycleCapabilities(capabilities: CapabilityRegistry, calls: string[]): void {
  const taskSummaryDescriptor = {
    name: 'task.background.summary',
    version: '1.0.0',
    inputSchema: z.object({}),
    outputSchema: z.custom()
  };
  const taskSuspendDescriptor = {
    name: 'task.scheduler.suspend',
    version: '1.0.0',
    inputSchema: z.object({}),
    outputSchema: z.object({ suspended: z.literal(true) })
  };
  const taskResumeDescriptor = {
    name: 'task.scheduler.resume',
    version: '1.0.0',
    inputSchema: z.object({}),
    outputSchema: z.object({ resumed: z.literal(true) })
  };
  capabilities.declare('@roc/plugin-task', taskSummaryDescriptor);
  capabilities.register('@roc/plugin-task', taskSummaryDescriptor, async () => ({
    total: 1,
    running: 1,
    failed: 0,
    pendingConfirmation: 0,
    nextRunAt: '2026-05-22T01:00:00.000Z'
  }));
  capabilities.declare('@roc/plugin-task', taskSuspendDescriptor);
  capabilities.register('@roc/plugin-task', taskSuspendDescriptor, async () => {
    calls.push('suspend');
    return { suspended: true as const };
  });
  capabilities.declare('@roc/plugin-task', taskResumeDescriptor);
  capabilities.register('@roc/plugin-task', taskResumeDescriptor, async () => {
    calls.push('resume');
    return { resumed: true as const };
  });
}

function createContext(capabilities: CapabilityRegistry): RocPluginContext {
  return {
    pluginId: '@roc/plugin-diagnostics',
    eventBus: createEventBus(),
    capabilities,
    database: { getConnection: () => db },
    config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  };
}

function createEventBus(): RocEventBus {
  return {
    publish: async () => {},
    subscribe: () => () => {}
  };
}

const taskSnapshot: TaskSnapshot = {
  generatedAt: '2026-06-04T00:00:00.000Z',
  counts: {
    total: 1,
    running: 1,
    failed: 0,
    pendingConfirmation: 0
  },
  threads: [
    {
      id: 'task_123',
      kind: 'background',
      title: 'Task 123',
      goal: 'Collect diagnostics',
      status: 'running',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z'
    }
  ],
  recentEvents: []
};
