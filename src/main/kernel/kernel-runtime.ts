import { join } from 'node:path';

import { ConfigStore } from '../infrastructure/config-store';
import { DatabasePool } from '../infrastructure/database-pool';
import { InfrastructureLogger } from '../infrastructure/logger';
import { SecretManager, type SafeStorageBackend } from '../infrastructure/secret-manager';
import { CapabilityRegistry } from './capability-registry';
import { EventBus } from './event-bus';
import { PluginLoader } from './plugin-loader';
import type { EventSubscription, RocEventEnvelope, RocPlugin, RocPluginHealth } from './types';

export type KernelRuntimeOptions = {
  rootDir: string;
  plugins: readonly RocPlugin[];
  safeStorage: SafeStorageBackend;
  activateMigration?: () => Promise<void> | void;
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
};

export class KernelRuntime {
  private infrastructure: KernelInfrastructure | null = null;
  private started = false;

  constructor(private readonly options: KernelRuntimeOptions) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('kernel_runtime_already_started');
    }

    if (this.options.activateMigration !== undefined) {
      await this.options.activateMigration();
    }

    const databasePool = new DatabasePool(this.options.rootDir);
    const configStore = new ConfigStore(databasePool, join(this.options.rootDir, 'config'));
    const secretManager = new SecretManager(databasePool, this.options.safeStorage);
    const logger = new InfrastructureLogger(join(this.options.rootDir, 'logs'));
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

    this.infrastructure = { capabilities, databasePool, eventBus, loader, logger };
    try {
      await loader.load(this.options.plugins);
      this.started = true;
    } catch (error) {
      await logger.close();
      databasePool.closeAll();
      this.infrastructure = null;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.infrastructure === null) {
      this.started = false;
      return;
    }
    await this.infrastructure.loader.shutdown();
    await this.infrastructure.logger.close();
    this.infrastructure.databasePool.closeAll();
    this.infrastructure = null;
    this.started = false;
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
