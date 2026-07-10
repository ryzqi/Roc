import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type { RocDatabaseHealthReport } from './database-health';
import type { RocDatabaseRetentionResult } from './database-retention';

const fullCheckInitialDelayMs = 2 * 60 * 1000;
const retentionInitialDelayMs = 5 * 60 * 1000;
const maintenanceIntervalMs = 24 * 60 * 60 * 1000;

type DatabaseMaintenanceKind = 'retention' | 'full_health_check';
type DatabaseMaintenanceResult = RocDatabaseHealthReport | RocDatabaseRetentionResult;

export type DatabaseMaintenanceJobs = {
  runFullHealthCheck(): RocDatabaseHealthReport | Promise<RocDatabaseHealthReport>;
  runRetention(): RocDatabaseRetentionResult | Promise<RocDatabaseRetentionResult>;
};

export type DatabaseMaintenanceServiceInput = {
  coreDb: DatabaseConnection;
  logger: {
    warn(message: string, metadata?: Record<string, unknown>): void;
  };
  jobs: DatabaseMaintenanceJobs;
  now: () => string;
};

export class DatabaseMaintenanceService {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private activeJob: Promise<void> | null = null;
  private started = false;

  constructor(private readonly input: DatabaseMaintenanceServiceInput) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.schedule('full_health_check', fullCheckInitialDelayMs, () => this.input.jobs.runFullHealthCheck());
    this.schedule('retention', retentionInitialDelayMs, () => this.input.jobs.runRetention());
  }

  async stopAndWait(): Promise<void> {
    this.started = false;
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.clear();
    if (this.activeJob !== null) {
      await this.activeJob;
    }
  }

  private schedule(
    kind: DatabaseMaintenanceKind,
    initialDelayMs: number,
    job: () => DatabaseMaintenanceResult | Promise<DatabaseMaintenanceResult>
  ): void {
    const initialTimer = setTimeout(() => {
      this.timers.delete(initialTimer);
      if (!this.started) {
        return;
      }
      void this.runExclusive(kind, job);
      const intervalTimer = setInterval(() => {
        void this.runExclusive(kind, job);
      }, maintenanceIntervalMs);
      this.timers.add(intervalTimer);
    }, initialDelayMs);
    this.timers.add(initialTimer);
  }

  private async runExclusive(
    kind: DatabaseMaintenanceKind,
    job: () => DatabaseMaintenanceResult | Promise<DatabaseMaintenanceResult>
  ): Promise<void> {
    if (!this.started || this.activeJob !== null) {
      return;
    }
    const activeJob = this.executeJob(kind, job);
    this.activeJob = activeJob;
    try {
      await activeJob;
    } finally {
      if (this.activeJob === activeJob) {
        this.activeJob = null;
      }
    }
  }

  private async executeJob(
    kind: DatabaseMaintenanceKind,
    job: () => DatabaseMaintenanceResult | Promise<DatabaseMaintenanceResult>
  ): Promise<void> {
    const id = `maintenance_${randomUUID()}`;
    const startedAt = this.input.now();
    let runningPersisted = false;
    try {
      this.input.coreDb
        .prepare(
          `INSERT INTO database_maintenance_runs
           (id, kind, status, started_at, finished_at, detail_json, error_message)
           VALUES (?, ?, 'running', ?, NULL, ?, NULL)`
        )
        .run(id, kind, startedAt, '{}');
      runningPersisted = true;
      const result = await job();
      const detailJson = JSON.stringify(result);
      if (kind === 'full_health_check' && resultIsUnhealthyHealthReport(result)) {
        this.finishFailed(id, detailJson, 'database_full_health_unhealthy');
        this.warnFailure(kind, 'database_full_health_unhealthy');
        return;
      }
      this.input.coreDb
        .prepare(
          `UPDATE database_maintenance_runs
           SET status = 'complete', finished_at = ?, detail_json = ?, error_message = NULL
           WHERE id = ? AND status = 'running'`
        )
        .run(this.input.now(), detailJson, id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runningPersisted) {
        this.finishFailed(id, '{}', message);
      }
      this.warnFailure(kind, message);
    }
  }

  private finishFailed(id: string, detailJson: string, errorMessage: string): void {
    this.input.coreDb
      .prepare(
        `UPDATE database_maintenance_runs
         SET status = 'failed', finished_at = ?, detail_json = ?, error_message = ?
         WHERE id = ? AND status = 'running'`
      )
      .run(this.input.now(), detailJson, errorMessage, id);
  }

  private warnFailure(kind: DatabaseMaintenanceKind, error: string): void {
    this.input.logger.warn('Database maintenance job failed.', {
      kind,
      error
    });
  }
}

function resultIsUnhealthyHealthReport(result: DatabaseMaintenanceResult): result is RocDatabaseHealthReport {
  return 'status' in result && result.status === 'unhealthy';
}
