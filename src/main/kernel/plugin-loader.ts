import type {
  CapabilityDescriptor,
  RocCapabilityRegistry,
  RocEventBus,
  RocPlugin,
  RocPluginContext,
  RocPluginHealth
} from './types';

type PluginLoaderStatus = {
  plugins: Record<string, RocPluginHealth>;
};

type PluginLoaderOptions = {
  eventBus: RocEventBus;
  capabilities: RocCapabilityRegistry;
  createContext(plugin: RocPlugin, capabilities: RocCapabilityRegistry): RocPluginContext;
};

export class PluginLoader {
  private readonly status: PluginLoaderStatus = { plugins: {} };
  private readonly initializedPlugins: RocPlugin[] = [];
  private readonly initializedPluginIds = new Set<string>();
  private readonly cleanups = new Map<string, () => void>();
  private readonly capabilityOwners = new Map<string, string>();

  constructor(private readonly options: PluginLoaderOptions) {
    void this.options.eventBus;
  }

  async load(plugins: readonly RocPlugin[]): Promise<void> {
    const sortedPlugins = sortPlugins(plugins);
    this.declareManifestCapabilities(sortedPlugins);

    for (const plugin of sortedPlugins) {
      if (!this.dependenciesInitialized(plugin)) {
        const reason = `plugin_dependency_not_ready:${plugin.manifest.id}`;
        await this.recordFailure(plugin, new Error(reason));
        continue;
      }
      try {
        const capabilities = new ScopedCapabilityRegistry({
          plugin,
          root: this.options.capabilities,
          capabilityOwners: this.capabilityOwners,
          initializedPluginIds: this.initializedPluginIds
        });
        const baseContext = this.options.createContext(plugin, capabilities);
        const subscriptions = new Set<() => void>();
        this.cleanups.set(plugin.manifest.id, () => { for (const unsubscribe of subscriptions) unsubscribe(); subscriptions.clear(); });
        const eventBus: RocEventBus = {
          publish: event => baseContext.eventBus.publish(event),
          subscribe: (type, handler) => {
            const unsubscribe = baseContext.eventBus.subscribe(type, handler);
            const release = () => { unsubscribe(); subscriptions.delete(release); };
            subscriptions.add(release);
            return release;
          }
        };
        await plugin.initialize({ ...baseContext, eventBus });
        this.initializedPlugins.push(plugin);
        this.initializedPluginIds.add(plugin.manifest.id);
        this.status.plugins[plugin.manifest.id] = await plugin.healthCheck();
      } catch (error) {
        this.initializedPluginIds.delete(plugin.manifest.id);
        const index = this.initializedPlugins.indexOf(plugin);
        if (index !== -1) this.initializedPlugins.splice(index, 1);
        let failure: unknown = error;
        try { await plugin.shutdown(); } catch (cleanupError) { failure = new AggregateError([error, cleanupError], 'plugin_initialization_cleanup_failed'); }
        this.dispose(plugin);
        await this.recordFailure(plugin, failure);
      }
    }
  }

  async shutdown(): Promise<void> {
    const failures: unknown[] = [];
    for (const plugin of [...this.initializedPlugins].reverse()) {
      try { await plugin.shutdown(); } catch (error) { failures.push(error); }
      finally { this.dispose(plugin); }
    }
    this.initializedPlugins.length = 0;
    this.initializedPluginIds.clear();
    if (failures.length > 0) throw new AggregateError(failures, 'plugin_shutdown_failed');
  }

  private dispose(plugin: RocPlugin): void {
    this.cleanups.get(plugin.manifest.id)?.();
    this.cleanups.delete(plugin.manifest.id);
    this.options.capabilities.unregister(plugin.manifest.id);
    this.initializedPluginIds.delete(plugin.manifest.id);
  }

  getStatus(): PluginLoaderStatus {
    return {
      plugins: { ...this.status.plugins }
    };
  }

  private declareManifestCapabilities(plugins: readonly RocPlugin[]): void {
    for (const plugin of plugins) {
      for (const descriptor of plugin.manifest.capabilities) {
        this.options.capabilities.declare(plugin.manifest.id, descriptor);
        this.capabilityOwners.set(descriptor.name, plugin.manifest.id);
      }
    }
  }

  private dependenciesInitialized(plugin: RocPlugin): boolean {
    return plugin.manifest.dependencies.every((dependency) => this.initializedPluginIds.has(dependency));
  }

  private async recordFailure(plugin: RocPlugin, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    if (plugin.manifest.required) {
      this.status.plugins[plugin.manifest.id] = { status: 'unhealthy', reason };
      throw new Error(`required_plugin_failed:${plugin.manifest.id}: ${reason}`);
    }
    this.status.plugins[plugin.manifest.id] = { status: 'degraded', reason };
  }
}

type ScopedCapabilityRegistryOptions = {
  plugin: RocPlugin;
  root: RocCapabilityRegistry;
  capabilityOwners: ReadonlyMap<string, string>;
  initializedPluginIds: ReadonlySet<string>;
};

class ScopedCapabilityRegistry implements RocCapabilityRegistry {
  constructor(private readonly options: ScopedCapabilityRegistryOptions) {}

  declare(pluginId: string, descriptor: CapabilityDescriptor): void {
    if (pluginId !== this.options.plugin.manifest.id) {
      throw new Error('capability_plugin_mismatch');
    }
    const declared = this.options.plugin.manifest.capabilities.find(item => item.name === descriptor.name);
    if (declared === undefined || declared.version !== descriptor.version || declared.inputSchema !== descriptor.inputSchema || declared.outputSchema !== descriptor.outputSchema) throw new Error('capability_not_in_manifest');
    this.options.root.declare(pluginId, descriptor);
  }

  register(pluginId: string, descriptor: CapabilityDescriptor, handler: (input: unknown) => Promise<unknown>): void {
    if (pluginId !== this.options.plugin.manifest.id) {
      throw new Error('capability_plugin_mismatch');
    }
    this.options.root.register(pluginId, descriptor, handler);
  }

  unregister(pluginId: string): void {
    if (pluginId !== this.options.plugin.manifest.id) throw new Error('capability_plugin_mismatch');
    this.options.root.unregister(pluginId);
  }

  async invoke<TInput, TOutput>(name: string, input: TInput): Promise<TOutput> {
    const ownerPluginId = this.options.capabilityOwners.get(name);
    if (ownerPluginId !== undefined && ownerPluginId !== this.options.plugin.manifest.id) {
      const capabilityDependencies = this.options.plugin.manifest.capabilityDependencies;
      const allowedDependencies =
        capabilityDependencies === undefined
          ? this.options.plugin.manifest.dependencies
          : [...this.options.plugin.manifest.dependencies, ...capabilityDependencies];
      if (!allowedDependencies.includes(ownerPluginId)) {
        throw new Error('capability_dependency_not_declared');
      }
      if (!this.options.initializedPluginIds.has(ownerPluginId)) {
        throw new Error('capability_dependency_not_ready');
      }
    }
    return await this.options.root.invoke<TInput, TOutput>(name, input);
  }

  list(): readonly CapabilityDescriptor[] {
    return this.options.root.list();
  }
}

function sortPlugins(plugins: readonly RocPlugin[]): RocPlugin[] {
  const pluginsById = new Map<string, RocPlugin>();
  for (const plugin of plugins) {
    if (pluginsById.has(plugin.manifest.id)) {
      throw new Error(`plugin_duplicate:${plugin.manifest.id}`);
    }
    pluginsById.set(plugin.manifest.id, plugin);
  }

  const sortedRoots = [...plugins].sort(compareManifestOrder);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: RocPlugin[] = [];

  function visit(plugin: RocPlugin): void {
    if (visited.has(plugin.manifest.id)) {
      return;
    }
    if (visiting.has(plugin.manifest.id)) {
      throw new Error(`plugin_dependency_cycle:${plugin.manifest.id}`);
    }
    visiting.add(plugin.manifest.id);
    for (const dependencyId of plugin.manifest.dependencies) {
      const dependency = pluginsById.get(dependencyId);
      if (dependency === undefined) {
        throw new Error(`plugin_dependency_missing:${plugin.manifest.id}:${dependencyId}`);
      }
      visit(dependency);
    }
    visiting.delete(plugin.manifest.id);
    visited.add(plugin.manifest.id);
    sorted.push(plugin);
  }

  for (const plugin of sortedRoots) {
    visit(plugin);
  }

  return sorted;
}

function compareManifestOrder(left: RocPlugin, right: RocPlugin): number {
  const manifestOrder = left.manifest.order - right.manifest.order;
  if (manifestOrder !== 0) {
    return manifestOrder;
  }
  return left.manifest.id.localeCompare(right.manifest.id);
}
