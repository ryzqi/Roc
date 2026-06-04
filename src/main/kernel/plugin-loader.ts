import type {
  CapabilityDescriptor,
  RocCapabilityRegistry,
  RocEventBus,
  RocPlugin,
  RocPluginContext,
  RocPluginHealth,
  RocPluginManifest
} from './types';

type PluginLoaderStatus = {
  plugins: Record<string, RocPluginHealth>;
};

type PluginLoaderOptions = {
  eventBus: RocEventBus;
  capabilities: RocCapabilityRegistry;
  createContext(plugin: RocPlugin, capabilities: RocCapabilityRegistry): RocPluginContext;
};

const loadPhaseRank: Record<RocPluginManifest['loadPhase'], number> = {
  critical: 0,
  deferred: 1,
  on_demand: 2
};

export class PluginLoader {
  private readonly status: PluginLoaderStatus = { plugins: {} };
  private readonly initializedPlugins: RocPlugin[] = [];
  private readonly initializedPluginIds = new Set<string>();
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
        await plugin.initialize(this.options.createContext(plugin, capabilities));
        this.initializedPlugins.push(plugin);
        this.initializedPluginIds.add(plugin.manifest.id);
        this.status.plugins[plugin.manifest.id] = await plugin.healthCheck();
      } catch (error) {
        await this.recordFailure(plugin, error);
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const plugin of [...this.initializedPlugins].reverse()) {
      await plugin.shutdown();
    }
    this.initializedPlugins.length = 0;
    this.initializedPluginIds.clear();
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
    this.options.root.declare(pluginId, descriptor);
  }

  register(pluginId: string, descriptor: CapabilityDescriptor, handler: (input: unknown) => Promise<unknown>): void {
    if (pluginId !== this.options.plugin.manifest.id) {
      throw new Error('capability_plugin_mismatch');
    }
    this.options.root.register(pluginId, descriptor, handler);
  }

  async invoke<TInput, TOutput>(name: string, input: TInput): Promise<TOutput> {
    const ownerPluginId = this.options.capabilityOwners.get(name);
    if (ownerPluginId !== undefined) {
      if (!this.options.plugin.manifest.dependencies.includes(ownerPluginId)) {
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
  const phaseOrder = loadPhaseRank[left.manifest.loadPhase] - loadPhaseRank[right.manifest.loadPhase];
  if (phaseOrder !== 0) {
    return phaseOrder;
  }
  const manifestOrder = left.manifest.order - right.manifest.order;
  if (manifestOrder !== 0) {
    return manifestOrder;
  }
  return left.manifest.id.localeCompare(right.manifest.id);
}
