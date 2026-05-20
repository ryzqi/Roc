import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeAppServicesTest, cleanupAppServicesTest, normalizeLineEndings, type AppServicesTestContext } from './app-service-fixtures';

describe('Roc foundation services', () => {
  let context: AppServicesTestContext;

  beforeEach(() => {
    context = initializeAppServicesTest();
  });

  afterEach(() => {
    cleanupAppServicesTest(context);
  });

  it('creates the .roc directory tree and config files', () => {
    const { root, services } = context;

    expect(existsSync(join(root, 'config', 'settings.json'))).toBe(true);
    expect(existsSync(join(root, 'config', 'providers.json'))).toBe(false);
    expect(existsSync(join(root, 'config', 'mcp.servers.json'))).toBe(false);
    expect(normalizeLineEndings(readFileSync(join(root, 'config', 'settings.json'), 'utf8'))).toContain('"schemaVersion": 3');
    expect(normalizeLineEndings(readFileSync(join(root, 'config', 'settings.json'), 'utf8'))).toContain('"providers"');
    expect(normalizeLineEndings(readFileSync(join(root, 'config', 'settings.json'), 'utf8'))).toContain('"mcp"');
    expect(existsSync(join(root, 'memory', 'hot', 'hot_memory.md'))).toBe(true);
    expect(services.paths.skillsDir).toBe(join(root, 'skills'));
    expect(existsSync(join(root, 'skills'))).toBe(true);
    expect(existsSync(join(root, 'tasks', 'recovery'))).toBe(true);
    expect(existsSync(join(root, 'rtk', 'tee'))).toBe(true);
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
    expect(tableNames).toContain('memory_entries_index');
    expect(tableNames).toContain('memory_candidates');
    expect(tableNames).toContain('memory_conflicts');
    expect(tableNames).toContain('memory_operations');
    expect(tableNames).toContain('mcp_servers');
    expect(tableNames).toContain('skills');
  });

  it('separates critical and deferred startup initialization', () => {
    cleanupAppServicesTest(context);
    context = initializeAppServicesTest({ skipInitialize: true });
    const { root, services } = context;

    services.appService.initializeCritical();
    expect(() => services.databaseService.db).not.toThrow();
    expect(existsSync(join(root, 'memory', 'hot', 'hot_memory.md'))).toBe(false);

    services.appService.initializeDeferred();
    expect(services.memoryService.status().root).toBe(join(root, 'memory'));
    expect(existsSync(join(root, 'memory', 'hot', 'hot_memory.md'))).toBe(true);
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

    expect(status.workspace).toEqual({
      selectedPath: null,
      label: '未选择工作区'
    });
    expect(status.paths.root).toBe(root);
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

  it('keeps diagnostics timing snapshots bounded to the newest performance samples', () => {
    const { services } = context;

    for (let index = 0; index < 510; index += 1) {
      services.performanceObserverService.record({
        phase: 'ipc_call',
        label: `channel-${index}`,
        startedAtMs: index,
        durationMs: index + 1,
        metadata: {
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
});
