import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeAppServicesTest, cleanupAppServicesTest, normalizeLineEndings, type AppServicesTestContext } from './app-service-fixtures';
import { createAppServices } from '../../src/main/services/app-service';
import { PerformanceObserverService } from '../../src/main/services/performance-observer-service';

describe('Roc foundation services', () => {
  let context: AppServicesTestContext;

  beforeEach(() => {
    context = initializeAppServicesTest();
  });

  afterEach(async () => {
    await cleanupAppServicesTest(context);
    vi.useRealTimers();
  });

  it('creates the .roc directory tree and config files', () => {
    const { root, services } = context;

    expect(existsSync(join(root, 'config', 'settings.json'))).toBe(true);
    expect(existsSync(join(root, 'config', 'providers.json'))).toBe(false);
    expect(existsSync(join(root, 'config', 'mcp.servers.json'))).toBe(false);
    expect(normalizeLineEndings(readFileSync(join(root, 'config', 'settings.json'), 'utf8'))).toContain('"schemaVersion": 3');
    expect(normalizeLineEndings(readFileSync(join(root, 'config', 'settings.json'), 'utf8'))).toContain('"providers"');
    expect(normalizeLineEndings(readFileSync(join(root, 'config', 'settings.json'), 'utf8'))).toContain('"mcp"');
    expect(existsSync(join(root, 'memory', 'global'))).toBe(true);
    expect(existsSync(join(root, 'memory', 'workspaces'))).toBe(true);
    expect(services.paths.skillsDir).toBe(join(root, 'skills'));
    expect(existsSync(join(root, 'skills'))).toBe(true);
    expect(existsSync(join(root, 'tasks', 'recovery'))).toBe(true);
    expect(existsSync(join(root, 'rtk', 'tee'))).toBe(true);
    expect(services.metricsService.getSnapshot().summary).toEqual({
      totalMetrics: 0,
      counterCount: 0,
      gaugeCount: 0,
      histogramCount: 0
    });
  });

  it('initializes SQLite with WAL and required first-wave tables', () => {
    const { services } = context;
    const journalMode = services.databaseService.db.pragma('journal_mode', { simple: true });
    expect(String(journalMode).toLocaleLowerCase()).toBe('wal');

    const rows = services.databaseService.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = rows.map((row) => row.name);

    expect(tableNames).toContain('task_threads');
    expect(tableNames).toContain('task_events');
    expect(tableNames).not.toContain('memory_entries_index');
    expect(tableNames).not.toContain('memory_candidates');
    expect(tableNames).not.toContain('memory_conflicts');
    expect(tableNames).not.toContain('memory_operations');
    expect(tableNames).toContain('mcp_servers');
    expect(tableNames).toContain('skills');
  });

  it('separates critical and deferred startup initialization', async () => {
    await cleanupAppServicesTest(context);
    context = initializeAppServicesTest({ skipInitialize: true });
    const { root, services } = context;

    services.appService.initializeCritical();
    expect(() => services.databaseService.db).not.toThrow();
    expect(existsSync(join(root, 'memory', 'global'))).toBe(false);

    services.appService.initializeDeferred();
    expect(services.memoryService.status().root).toBe(join(root, 'memory'));
    expect(existsSync(join(root, 'memory', 'global'))).toBe(true);
  });

  it('sweeps expired session messages during deferred startup', async () => {
    await cleanupAppServicesTest(context);
    context = initializeAppServicesTest({ skipInitialize: true });
    const { services } = context;

    services.appService.initializeCritical();
    services.databaseService.db
      .prepare(
        `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES ('t1', 'chat', 'retention', '', 'active', datetime('now'), datetime('now'))`
      )
      .run();
    services.databaseService.db
      .prepare(
        `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, created_at)
         VALUES ('old1', 't1', 'user', 'old message', NULL, 'visible', datetime('now', '-120 days'))`
      )
      .run();
    services.sessionArchiveService.recordUserInput('t1', 'recent message');

    services.appService.initializeDeferred();

    const rows = services.databaseService.db
      .prepare('SELECT content FROM session_messages ORDER BY created_at')
      .all() as Array<{ content: string }>;
    expect(rows).toEqual([{ content: 'recent message' }]);
  });

  it('schedules a daily session retention sweep', async () => {
    await cleanupAppServicesTest(context);
    context = initializeAppServicesTest({ skipInitialize: true });
    vi.useFakeTimers();
    const { services } = context;

    services.appService.initializeCritical();
    const sweep = vi.spyOn(services.sessionArchiveService, 'sweepRetention');

    services.appService.initializeDeferred();
    expect(sweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenLastCalledWith(90);
  });

  it('returns a real empty task snapshot from SQLite', () => {
    const { services } = context;
    const snapshot = services.taskService.getSnapshot();

    expect(snapshot.counts.total).toBe(0);
    expect(snapshot.counts.running).toBe(0);
    expect(snapshot.counts.failed).toBe(0);
    expect(snapshot.counts.pendingConfirmation).toBe(0);
    expect(snapshot.threads).toEqual([]);
    expect(snapshot.recentEvents).toEqual([]);
  });

  it('reports workspace state separately from the Roc data root', () => {
    const { root, services } = context;
    const status = services.appService.getStatus();

    expect(status.appName).toBe('Roc');
    expect(status.workspace).toEqual({
      selectedPath: null,
      label: '未选择工作区'
    });
    expect(status.paths.root).toBe(root);
    expect(status.rendererBoundary).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: {
        enabled: false,
        evaluated: true,
        reason: 'Electron sandbox blocks the current bundled ESM preload; smoke timed out before renderer root appeared.',
        compensatingControls: ['contextIsolation', 'nodeIntegration=false', 'typed preload API', 'external URL scheme allowlist']
      }
    });
  });

  it('records performance samples and exposes the package directory script target', () => {
    const { services } = context;
    services.performanceObserverService.record({
      phase: 'provider_first_token',
      label: 'nvidia:model',
      startedAtMs: 1,
      durationMs: 12,
      metadata: {
        providerId: 'nvidia',
        providerType: 'nvidia',
        modelId: 'model',
        mode: 'chat',
        retryCount: 0
      }
    });
    const sample = services.diagnosticsService.samplePerformance({
      mode: 'test',
      memoryBudgetMb: 300
    });

    expect(sample).toMatchObject({
      mode: 'test',
      memoryBudgetMb: 300
    });
    expect(sample.rssMb).toBeGreaterThan(0);
    expect(sample.heapUsedMb).toBeGreaterThan(0);
    expect(typeof sample.exceedsBudget).toBe('boolean');
    expect(sample.timing.samples).toContainEqual(
      expect.objectContaining({
        phase: 'provider_first_token',
        label: 'nvidia:model'
      })
    );
    expect(existsSync(resolve('scripts/package-dir.mjs'))).toBe(true);
  });

  it('can share an injected performance observer with diagnostics samples', async () => {
    await cleanupAppServicesTest(context);
    const performanceObserverService = new PerformanceObserverService();
    const root = mkdtempSync(join(tmpdir(), 'roc-app-services-shared-performance-'));
    const services = createAppServices(
      root,
      undefined,
      undefined,
      undefined,
      performanceObserverService
    );
    context = {
      root,
      services
    };
    services.appService.initializeCritical();

    performanceObserverService.record({
      phase: 'ipc_call',
      label: 'roc:shell:confirm',
      startedAtMs: 10,
      durationMs: 3,
      metadata: {
        channel: 'roc:shell:confirm',
        ok: true
      }
    });

    const sample = services.diagnosticsService.samplePerformance({
      mode: 'test',
      memoryBudgetMb: 300
    });

    expect(sample.timing.samples).toContainEqual(
      expect.objectContaining({
        label: 'roc:shell:confirm',
        metadata: {
          channel: 'roc:shell:confirm',
          ok: true
        }
      })
    );
  });

  it('includes Electron window and process metrics in performance samples', async () => {
    await cleanupAppServicesTest(context);
    context = initializeAppServicesTest({
      runtimeMetrics: {
        getBrowserWindowCount: () => 3,
        getProcessMetrics: () => [
          {
            pid: 4100,
            type: 'Browser',
            name: 'Roc',
            cpuPercent: 1.25,
            memory: {
              workingSetSizeKb: 204800,
              peakWorkingSetSizeKb: 240000,
              privateBytesKb: 120000,
              sharedBytesKb: 80000
            }
          },
          {
            pid: 4101,
            type: 'GPU',
            name: 'GPU Process',
            cpuPercent: 0.5,
            memory: {
              workingSetSizeKb: 64000,
              peakWorkingSetSizeKb: 70000,
              privateBytesKb: 32000,
              sharedBytesKb: 31000
            }
          }
        ]
      }
    });

    const sample = context.services.diagnosticsService.samplePerformance({
      mode: 'test',
      memoryBudgetMb: 300
    });

    expect(sample.electron.browserWindowCount).toBe(3);
    expect(sample.electron.processCount).toBe(2);
    expect(sample.electron.processMetrics).toEqual([
      expect.objectContaining({
        pid: 4100,
        type: 'Browser',
        cpuPercent: 1.25,
        memory: expect.objectContaining({
          workingSetSizeMb: 200,
          privateBytesMb: 117.2
        })
      }),
      expect.objectContaining({
        pid: 4101,
        type: 'GPU',
        memory: expect.objectContaining({
          workingSetSizeMb: 62.5
        })
      })
    ]);
  });

  it('keeps diagnostics timing snapshots bounded to the newest performance samples', () => {
    const { services } = context;

    for (let index = 0; index < 510; index += 1) {
      services.performanceObserverService.record({
        phase: 'ipc_call',
        label: `channel-${index}`,
        startedAtMs: index,
        durationMs: index + 1,
        metadata: {
          channel: `channel-${index}`,
          ok: true,
          index
        }
      });
    }

    const sample = services.diagnosticsService.samplePerformance({
      mode: 'test',
      memoryBudgetMb: 300
    });

    expect(sample.timing.samples).toHaveLength(500);
    expect(sample.timing.samples[0]?.label).toBe('channel-10');
    expect(sample.timing.samples.at(-1)?.label).toBe('channel-509');
  });

  it('runs scheduler diagnostics checks for Doctor', () => {
    const { root, services } = context;
    vi.spyOn(services.taskSchedulerService, 'getStatus').mockReturnValue({
      running: true,
      registeredTaskCount: 1,
      nextFireAt: '2026-05-21T01:00:00.000Z',
      recentSkippedCount: 1,
      lastError: null
    });
    const preview = services.taskService.createBackgroundTaskPreview({
      goal: 'Doctor scheduler check',
      trigger: {
        type: 'cron',
        description: '每天 09:00',
        cronExpression: '0 9 * * *',
        nextRunAt: '2026-05-21T01:00:00.000Z'
      },
      workspacePath: root,
      allowedActions: ['pnpm test'],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    services.taskService.createBackgroundTask(preview);
    services.taskService.recordScheduledTaskRun({
      backgroundTaskId: services.taskService.listBackgroundTasks()[0]!.id,
      scheduledAt: new Date().toISOString(),
      status: 'skipped',
      skipReason: 'missed_startup'
    });

    const checks = services.diagnosticsService.runChecks(services.taskSchedulerService.getStatus());

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'scheduler_running', status: 'pass', severity: 'info' }),
        expect.objectContaining({ id: 'scheduler_tasks_registered', status: 'pass', severity: 'info' }),
        expect.objectContaining({ id: 'scheduler_missed_runs_recent', status: 'warn', severity: 'warning' }),
        expect.objectContaining({ id: 'cron_expressions_valid', status: 'pass', severity: 'info' })
      ])
    );
  });

  it('reports scheduler diagnostics errors when scheduler is stopped and cron rows are invalid', () => {
    const { services } = context;
    vi.spyOn(services.taskSchedulerService, 'getStatus').mockReturnValue({
      running: false,
      registeredTaskCount: 0,
      nextFireAt: null,
      recentSkippedCount: 0,
      lastError: 'scheduler_not_started'
    });
    services.databaseService.db
      .prepare('INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        'thread-invalid-cron',
        'background',
        'Invalid cron',
        'Invalid cron',
        'running',
        '2026-05-21T00:00:00.000Z',
        '2026-05-21T00:00:00.000Z'
      );
    services.databaseService.db
      .prepare(
        `INSERT INTO task_runs
         (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'run-invalid-cron',
        'thread-invalid-cron',
        1,
        'Invalid cron',
        'running',
        '2026-05-21T00:00:00.000Z',
        null,
        null,
        '{"mcpServers":[],"skills":[]}'
      );
    services.databaseService.db
      .prepare(
        `INSERT INTO background_tasks
         (id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description, next_run_at, cron_expression, workspace_path,
          allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
          requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'background-invalid-cron',
        'thread-invalid-cron',
        'run-invalid-cron',
        'Invalid cron',
        'running',
        1,
        'cron',
        'invalid',
        '2026-05-21T01:00:00.000Z',
        'bad cron',
        'F:\\Code\\Roc',
        '[]',
        '[]',
        'pause_and_report',
        'failures_and_confirmations',
        'low',
        0,
        null,
        null,
        0,
        '2026-05-21T00:00:00.000Z',
        '2026-05-21T00:00:00.000Z'
      );

    const checks = services.diagnosticsService.runChecks(services.taskSchedulerService.getStatus());

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'scheduler_running', status: 'fail', severity: 'error' }),
        expect.objectContaining({ id: 'scheduler_tasks_registered', status: 'warn', severity: 'warning' }),
        expect.objectContaining({ id: 'cron_expressions_valid', status: 'fail', severity: 'error' })
      ])
    );
  });
});
