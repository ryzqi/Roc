import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RocDatabaseHealthReport } from '../../../src/main/infrastructure/database-health';
import {
  DatabaseMaintenanceService,
  type DatabaseMaintenanceJobs
} from '../../../src/main/infrastructure/database-maintenance';
import type { RocDatabaseRetentionResult } from '../../../src/main/infrastructure/database-retention';
import { applyCoreDatabaseSchema } from '../../../src/main/infrastructure/database-schemas';
import type { DatabasePool } from '../../../src/main/infrastructure/database-pool';

let coreDb: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-07-10T00:00:00.000Z') });
  coreDb = new Database(':memory:');
  applyCoreDatabaseSchema(coreDb, () => '2026-07-10T00:00:00.000Z');
});

afterEach(() => {
  coreDb.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DatabaseMaintenanceService', () => {
  it('runs full health and retention after fixed initial delays and every 24 hours', async () => {
    const { jobs, service } = createService();

    service.start();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(jobs.runFullHealthCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(jobs.runFullHealthCheck).toHaveBeenCalledTimes(1);
    expect(jobs.runRetention).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(jobs.runRetention).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(jobs.runFullHealthCheck).toHaveBeenCalledTimes(2);
    expect(jobs.runRetention).toHaveBeenCalledTimes(2);

    expect(
      coreDb.prepare('SELECT kind, status FROM database_maintenance_runs ORDER BY rowid').all()
    ).toEqual([
      { kind: 'full_health_check', status: 'complete' },
      { kind: 'retention', status: 'complete' },
      { kind: 'full_health_check', status: 'complete' },
      { kind: 'retention', status: 'complete' }
    ]);
    await service.stopAndWait();
  });

  it('prevents reentry across job kinds and waits for the active job during stop', async () => {
    const pending = createDeferred<RocDatabaseHealthReport>();
    const { jobs, service } = createService({
      runFullHealthCheck: vi.fn(() => pending.promise)
    });

    service.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(jobs.runFullHealthCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(jobs.runRetention).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(jobs.runFullHealthCheck).toHaveBeenCalledTimes(1);
    expect(jobs.runRetention).not.toHaveBeenCalled();
    expect(coreDb.prepare('SELECT status FROM database_maintenance_runs').pluck().get()).toBe('running');

    const stopping = service.stopAndWait();
    pending.resolve(healthReport('healthy'));
    await stopping;
    expect(coreDb.prepare('SELECT status FROM database_maintenance_runs').pluck().get()).toBe('complete');
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
    expect(jobs.runFullHealthCheck).toHaveBeenCalledTimes(1);
    expect(jobs.runRetention).not.toHaveBeenCalled();
  });

  it('persists thrown failures, logs them, and allows the next interval run', async () => {
    const warn = vi.fn<(message: string, metadata?: Record<string, unknown>) => void>();
    const runFullHealthCheck = vi
      .fn<DatabaseMaintenanceJobs['runFullHealthCheck']>()
      .mockImplementationOnce(() => {
        throw new Error('full_health_injected');
      })
      .mockImplementation(() => healthReport('healthy'));
    const { jobs, service } = createService({ runFullHealthCheck, warn });

    service.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(warn).toHaveBeenCalledWith('Database maintenance job failed.', {
      kind: 'full_health_check',
      error: 'full_health_injected'
    });
    expect(
      coreDb
        .prepare("SELECT status, error_message FROM database_maintenance_runs WHERE kind = 'full_health_check'")
        .get()
    ).toEqual({ status: 'failed', error_message: 'full_health_injected' });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(jobs.runFullHealthCheck).toHaveBeenCalledTimes(2);
    expect(
      coreDb
        .prepare("SELECT status FROM database_maintenance_runs WHERE kind = 'full_health_check' ORDER BY rowid")
        .pluck()
        .all()
    ).toEqual(['failed', 'complete']);
    await service.stopAndWait();
  });

  it('records an unhealthy full check as failed without throwing into the timer loop', async () => {
    const warn = vi.fn<(message: string, metadata?: Record<string, unknown>) => void>();
    const { service } = createService({
      runFullHealthCheck: vi.fn(() => healthReport('unhealthy')),
      warn
    });

    service.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(
      coreDb
        .prepare("SELECT status, error_message, detail_json FROM database_maintenance_runs WHERE kind = 'full_health_check'")
        .get()
    ).toEqual({
      status: 'failed',
      error_message: 'database_full_health_unhealthy',
      detail_json: JSON.stringify(healthReport('unhealthy'))
    });
    expect(warn).toHaveBeenCalledWith('Database maintenance job failed.', {
      kind: 'full_health_check',
      error: 'database_full_health_unhealthy'
    });
    await service.stopAndWait();
  });
});

function createService(input: {
  runFullHealthCheck?: DatabaseMaintenanceJobs['runFullHealthCheck'];
  runRetention?: DatabaseMaintenanceJobs['runRetention'];
  warn?: (message: string, metadata?: Record<string, unknown>) => void;
} = {}): {
  jobs: {
    runFullHealthCheck: ReturnType<typeof vi.fn<DatabaseMaintenanceJobs['runFullHealthCheck']>>;
    runRetention: ReturnType<typeof vi.fn<DatabaseMaintenanceJobs['runRetention']>>;
  };
  service: DatabaseMaintenanceService;
} {
  const jobs = {
    runFullHealthCheck: vi.fn(input.runFullHealthCheck === undefined ? () => healthReport('healthy') : input.runFullHealthCheck),
    runRetention: vi.fn(input.runRetention === undefined ? () => retentionResult() : input.runRetention)
  };
  return {
    jobs,
    service: new DatabaseMaintenanceService({
      pool: { getCoreConnection: () => coreDb } as DatabasePool,
      jobs,
      logger: {
        warn: input.warn === undefined ? () => {} : input.warn
      },
      now: () => new Date().toISOString()
    })
  };
}

function healthReport(status: RocDatabaseHealthReport['status']): RocDatabaseHealthReport {
  return {
    status,
    databases: [],
    checkedAt: new Date().toISOString()
  };
}

function retentionResult(): RocDatabaseRetentionResult {
  return {
    deleted: {
      agentEvents: 0,
      agentRunEvents: 0,
      agentOutbox: 0,
      runTelemetry: 0,
      checkpoints: 0,
      checkpointWrites: 0,
      toolEffects: 0,
      contextArtifacts: 0,
      memoryAudit: 0
    }
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise
  };
}
