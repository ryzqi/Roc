import { statfs } from 'node:fs/promises';
import type { HealthCheck, HealthCheckResult } from '../../shared/types';
import type { ConfigService } from './config-service';
import type { DatabaseService } from './database-service';
import type { MemoryService } from './memory-service';
import type { RocPaths } from './paths';
import type { TaskSchedulerService } from './task-scheduler-service';

const diskWarnThresholdMb = 1024;
const diskFailThresholdMb = 128;
const memoryWarnThresholdMb = 800;

export class HealthCheckService {
  constructor(
    private readonly paths: RocPaths,
    private readonly database: DatabaseService,
    private readonly taskScheduler: TaskSchedulerService,
    private readonly memoryService: MemoryService,
    private readonly configService: ConfigService
  ) {}

  async check(): Promise<HealthCheckResult> {
    const checks = await Promise.all([
      this.checkDatabase(),
      this.checkTaskScheduler(),
      this.checkDiskSpace(),
      this.checkMemoryUsage(),
      this.checkMemoryService(),
      this.checkProviderConnectivity()
    ]);
    const hasFail = checks.some((check) => check.status === 'fail');
    const hasWarn = checks.some((check) => check.status === 'warn');
    return {
      status: hasFail ? 'unhealthy' : hasWarn ? 'degraded' : 'healthy',
      checks
    };
  }

  private async checkDatabase(): Promise<HealthCheck> {
    const lastChecked = new Date().toISOString();
    try {
      const result = this.database.db.prepare('SELECT 1 as value').get() as { value: number };
      if (result.value !== 1) {
        return { name: 'database', status: 'fail', message: 'Database probe returned an unexpected value.', lastChecked };
      }
      return { name: 'database', status: 'pass', lastChecked };
    } catch (error) {
      return { name: 'database', status: 'fail', message: this.formatError(error), lastChecked };
    }
  }

  private async checkTaskScheduler(): Promise<HealthCheck> {
    const lastChecked = new Date().toISOString();
    const status = this.taskScheduler.getStatus();
    if (!status.running) {
      return {
        name: 'task_scheduler',
        status: 'fail',
        message: status.lastError ?? 'Task scheduler is not running.',
        lastChecked
      };
    }
    return { name: 'task_scheduler', status: 'pass', lastChecked };
  }

  private async checkDiskSpace(): Promise<HealthCheck> {
    const lastChecked = new Date().toISOString();
    try {
      const stats = await statfs(this.paths.root);
      const freeMb = (stats.bavail * stats.bsize) / 1024 / 1024;
      if (freeMb < diskFailThresholdMb) {
        return {
          name: 'disk_space',
          status: 'fail',
          message: `Free disk space is ${freeMb.toFixed(0)}MB.`,
          lastChecked
        };
      }
      if (freeMb < diskWarnThresholdMb) {
        return {
          name: 'disk_space',
          status: 'warn',
          message: `Free disk space is ${freeMb.toFixed(0)}MB.`,
          lastChecked
        };
      }
      return { name: 'disk_space', status: 'pass', lastChecked };
    } catch (error) {
      return { name: 'disk_space', status: 'fail', message: this.formatError(error), lastChecked };
    }
  }

  private async checkMemoryUsage(): Promise<HealthCheck> {
    const lastChecked = new Date().toISOString();
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    if (rssMb > memoryWarnThresholdMb) {
      return {
        name: 'memory_usage',
        status: 'warn',
        message: `RSS: ${rssMb.toFixed(0)}MB exceeds ${memoryWarnThresholdMb}MB.`,
        lastChecked
      };
    }
    return { name: 'memory_usage', status: 'pass', lastChecked };
  }

  private async checkMemoryService(): Promise<HealthCheck> {
    const lastChecked = new Date().toISOString();
    try {
      this.memoryService.status();
      return { name: 'memory_service', status: 'pass', lastChecked };
    } catch (error) {
      return { name: 'memory_service', status: 'fail', message: this.formatError(error), lastChecked };
    }
  }

  private async checkProviderConnectivity(): Promise<HealthCheck> {
    const lastChecked = new Date().toISOString();
    try {
      const providers = this.configService.getProviders().providers;
      const enabledProviderCount = providers.filter((provider) => provider.enabled).length;
      const enabledModelCount = providers
        .filter((provider) => provider.enabled)
        .reduce((total, provider) => total + provider.models.filter((model) => model.enabled).length, 0);
      if (enabledProviderCount === 0) {
        return { name: 'provider_connectivity', status: 'fail', message: 'No enabled providers configured.', lastChecked };
      }
      if (enabledModelCount === 0) {
        return { name: 'provider_connectivity', status: 'warn', message: 'No enabled provider models configured.', lastChecked };
      }
      return { name: 'provider_connectivity', status: 'pass', lastChecked };
    } catch (error) {
      return { name: 'provider_connectivity', status: 'fail', message: this.formatError(error), lastChecked };
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
