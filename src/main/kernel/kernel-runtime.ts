import { join } from 'node:path';

import { checkRocDatabases } from '../infrastructure/database-health';
import {
  acquireDatabaseMaintenanceLease,
  type DatabaseMaintenanceLease
} from '../infrastructure/database-maintenance-lease';
import { DatabaseMaintenanceService } from '../infrastructure/database-maintenance';
import { ConfigStore } from '../infrastructure/config-store';
import { runDatabaseFastProbe } from '../infrastructure/database-fast-probe';
import { DatabasePool } from '../infrastructure/database-pool';
import { runDatabaseRetention, type RocDatabaseRetentionPolicy } from '../infrastructure/database-retention';
import { InfrastructureLogger } from '../infrastructure/logger';
import { SecretManager } from '../infrastructure/secret-manager';
import type { SafeStorageBackend } from '../infrastructure/safe-storage-backend';
import { CapabilityRegistry } from './capability-registry';
import { EventBus } from './event-bus';
import { PluginLoader } from './plugin-loader';
import type { EventSubscription, RocEventEnvelope, RocPlugin, RocPluginHealth } from './types';

export type KernelRuntimeOptions = {
  rootDir: string;
  createPlugins(databasePool: DatabasePool): readonly RocPlugin[];
  safeStorage: SafeStorageBackend;
  /**
   * The two retention windows that are user settings (`settings.memory`). They override the fixed
   * defaults at run time instead of replacing the policy wholesale, so the run/checkpoint limits
   * keep living in one place.
   */
  memoryRetentionPolicy?: () => Pick<
    RocDatabaseRetentionPolicy,
    'autoMemoryAuditRetentionDays' | 'sessionMessageRetentionDays'
  >;
};

export type KernelRuntimeStatus = {
  started: boolean;
  plugins: Record<string, RocPluginHealth>;
};

type KernelInfrastructure = {
  capabilities: CapabilityRegistry;
  databasePool: DatabasePool;
  eventBus: EventBus;
  loader: PluginLoader;
  logger: InfrastructureLogger;
  maintenanceLease: DatabaseMaintenanceLease;
  maintenanceService: DatabaseMaintenanceService;
};

const productionRetentionPolicy: RocDatabaseRetentionPolicy = {
  terminalRunRetentionDays: 90,
  maxCheckpointsPerThread: 100,
  autoMemoryAuditRetentionDays: 180,
  sessionMessageRetentionDays: 90
};

export class KernelRuntime {
  private infrastructure: KernelInfrastructure | null = null;
  private started = false;

  constructor(private readonly options: KernelRuntimeOptions) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('kernel_runtime_already_started');
    }
    const maintenanceLease = acquireDatabaseMaintenanceLease({
      rootDir: this.options.rootDir,
      owner: { kind: 'app', pid: process.pid }
    });
    let databasePoolToClose: DatabasePool | null = null;
    let loggerToClose: InfrastructureLogger | null = null;
    try {
      const databasePool = new DatabasePool(this.options.rootDir);
      databasePoolToClose = databasePool;
      const fastProbe = runDatabaseFastProbe({
        pool: databasePool,
        now: () => new Date().toISOString()
      });
      if (fastProbe.status === 'unhealthy') {
        throw new Error('database_fast_probe_unhealthy');
      }

      const coreDb = databasePool.getCoreConnection();
      const configStore = new ConfigStore(coreDb, join(this.options.rootDir, 'config'));
      const logger = new InfrastructureLogger(join(this.options.rootDir, 'logs'));
      loggerToClose = logger;
      const secretManager = new SecretManager(
        coreDb,
        this.options.safeStorage,
        logger.createPluginLogger('@roc/plugin-kernel')
      );
      const maintenanceService = new DatabaseMaintenanceService({
        pool: databasePool,
        jobs: {
          runFullHealthCheck: () =>
            checkRocDatabases({
              pool: databasePool,
              now: () => new Date().toISOString()
            }),
          runRetention: () =>
            runDatabaseRetention({
              agentDb: databasePool.getConnection('@roc/plugin-agent'),
              memoryDb: databasePool.getConnection('@roc/plugin-memory'),
              policy: this.resolveRetentionPolicy(),
              now: new Date()
            })
        },
        logger: logger.createPluginLogger('@roc/plugin-kernel'),
        now: () => new Date().toISOString()
      });
      const eventBus = new EventBus(logger.createPluginLogger('@roc/plugin-kernel'));
      const capabilities = new CapabilityRegistry();
      const loader = new PluginLoader({
        eventBus,
        capabilities,
        createContext: (plugin, scopedCapabilities) => ({
          pluginId: plugin.manifest.id,
          eventBus,
          capabilities: scopedCapabilities,
          database: databasePool.createPluginDatabaseFacade(plugin.manifest.id),
          config: configStore.createPluginConfigFacade(plugin.manifest.id),
          secrets: secretManager.createPluginSecretFacade(plugin.manifest.id),
          logger: logger.createPluginLogger(plugin.manifest.id)
        })
      });

      this.infrastructure = {
        capabilities,
        databasePool,
        eventBus,
        loader,
        logger,
        maintenanceLease,
        maintenanceService
      };
      await loader.load(this.options.createPlugins(databasePool));
      this.started = true;
    } catch (error) {
      if (loggerToClose !== null) {
        await loggerToClose.close();
      }
      if (databasePoolToClose !== null) {
        databasePoolToClose.closeAll();
      }
      this.infrastructure = null;
      maintenanceLease.release();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.infrastructure === null) {
      this.started = false;
      return;
    }
    const infrastructure = this.infrastructure;
    try {
      await infrastructure.maintenanceService.stopAndWait();
    } finally {
      try {
        await infrastructure.loader.shutdown();
      } finally {
        try {
          await infrastructure.logger.close();
        } finally {
          try {
            infrastructure.databasePool.closeAll();
          } finally {
            try {
              infrastructure.maintenanceLease.release();
            } finally {
              this.infrastructure = null;
              this.started = false;
            }
          }
        }
      }
    }
  }

  /** Settings-backed overrides for the fixed retention defaults (see `productionRetentionPolicy`). */
  private resolveRetentionPolicy(): RocDatabaseRetentionPolicy {
    const overrides = this.options.memoryRetentionPolicy?.();
    return overrides === undefined ? productionRetentionPolicy : { ...productionRetentionPolicy, ...overrides };
  }

  startDatabaseMaintenance(): void {
    if (this.infrastructure === null || !this.started) {
      throw new Error('kernel_runtime_not_started');
    }
    this.infrastructure.maintenanceService.start();
  }

  getStatus(): KernelRuntimeStatus {
    if (this.infrastructure === null) {
      return {
        started: this.started,
        plugins: {}
      };
    }
    return {
      started: this.started,
      plugins: this.infrastructure.loader.getStatus().plugins
    };
  }

  async invokeCapability<TInput, TOutput>(name: string, input: TInput): Promise<TOutput> {
    if (this.infrastructure === null) {
      throw new Error('kernel_runtime_not_started');
    }
    return await this.infrastructure.capabilities.invoke<TInput, TOutput>(name, input);
  }

  async publishEvent<TPayload>(event: RocEventEnvelope<TPayload>): Promise<void> {
    if (this.infrastructure === null) {
      throw new Error('kernel_runtime_not_started');
    }
    await this.infrastructure.eventBus.publish(event);
  }

  subscribeEvent<TPayload>(
    type: string,
    handler: (event: RocEventEnvelope<TPayload>) => void | Promise<void>
  ): EventSubscription {
    if (this.infrastructure === null) {
      throw new Error('kernel_runtime_not_started');
    }
    return this.infrastructure.eventBus.subscribe(type, handler);
  }
}
