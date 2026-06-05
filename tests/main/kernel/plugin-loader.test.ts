import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../src/main/kernel/capability-registry';
import { EventBus } from '../../../src/main/kernel/event-bus';
import { PluginLoader } from '../../../src/main/kernel/plugin-loader';
import type { CapabilityDescriptor, RocPlugin, RocPluginContext, RocPluginManifest } from '../../../src/main/kernel/types';

const inputSchema = z.object({ value: z.string() });
const outputSchema = z.object({ echoed: z.string() });

function createManifest(input: Partial<RocPluginManifest> & Pick<RocPluginManifest, 'id'>): RocPluginManifest {
  return {
    version: '1.0.0',
    displayName: input.id,
    description: `${input.id} test plugin`,
    loadPhase: 'critical',
    required: true,
    order: 0,
    dependencies: [],
    capabilities: [],
    ...input
  };
}

function createPlugin(
  manifest: RocPluginManifest,
  initialize: (context: RocPluginContext) => Promise<void> = async () => {}
): RocPlugin {
  return {
    manifest,
    initialize,
    shutdown: async () => {},
    healthCheck: async () => ({ status: 'healthy' })
  };
}

function createLoader(): PluginLoader {
  return new PluginLoader({
    eventBus: new EventBus({ error: () => {} }),
    capabilities: new CapabilityRegistry(),
    createContext: (plugin, capabilities) => ({
      pluginId: plugin.manifest.id,
      eventBus: new EventBus({ error: () => {} }),
      capabilities,
      database: { getConnection: () => undefined as never },
      config: { get: () => null, set: () => {} },
      secrets: { get: () => null, set: () => {}, clear: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    })
  });
}

describe('PluginLoader', () => {
  it('loads dependencies before dependents and critical plugins before deferred plugins', async () => {
    const calls: string[] = [];
    const alpha = createPlugin(createManifest({ id: '@roc/plugin-alpha', order: 100 }), async () => {
      calls.push('alpha');
    });
    const beta = createPlugin(
      createManifest({ id: '@roc/plugin-beta', order: 1, dependencies: ['@roc/plugin-alpha'] }),
      async () => {
        calls.push('beta');
      }
    );
    const deferred = createPlugin(
      createManifest({ id: '@roc/plugin-deferred', loadPhase: 'deferred', order: 0 }),
      async () => {
        calls.push('deferred');
      }
    );

    await createLoader().load([deferred, beta, alpha]);

    expect(calls).toEqual(['alpha', 'beta', 'deferred']);
  });

  it('aborts bootstrap when a required plugin fails', async () => {
    const calls: string[] = [];
    const required = createPlugin(createManifest({ id: '@roc/plugin-required', required: true }), async () => {
      calls.push('required');
      throw new Error('required failed');
    });
    const later = createPlugin(createManifest({ id: '@roc/plugin-later', order: 1 }), async () => {
      calls.push('later');
    });

    await expect(createLoader().load([required, later])).rejects.toThrow(/required_plugin_failed:@roc\/plugin-required/u);
    expect(calls).toEqual(['required']);
  });

  it('marks optional plugin failures degraded and continues', async () => {
    const calls: string[] = [];
    const loader = createLoader();
    const optional = createPlugin(createManifest({ id: '@roc/plugin-optional', required: false }), async () => {
      calls.push('optional');
      throw new Error('optional failed');
    });
    const later = createPlugin(createManifest({ id: '@roc/plugin-later', order: 1 }), async () => {
      calls.push('later');
    });

    await loader.load([optional, later]);

    expect(calls).toEqual(['optional', 'later']);
    expect(loader.getStatus().plugins['@roc/plugin-optional']).toEqual({
      status: 'degraded',
      reason: 'optional failed'
    });
    expect(loader.getStatus().plugins['@roc/plugin-later']).toEqual({ status: 'healthy' });
  });

  it('declares manifest capabilities before initialize and allows initialized dependency capabilities', async () => {
    const calls: string[] = [];
    const descriptor: CapabilityDescriptor<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
      name: 'alpha.echo',
      version: '1.0.0',
      inputSchema,
      outputSchema
    };
    const provider = createPlugin(
      createManifest({ id: '@roc/plugin-alpha', capabilities: [descriptor] }),
      async (context) => {
        expect(context.capabilities.list()).toEqual([descriptor]);
        context.capabilities.register('@roc/plugin-alpha', descriptor, async (input) => ({
          echoed: (input as { value: string }).value
        }));
        calls.push('provider');
      }
    );
    const consumer = createPlugin(
      createManifest({ id: '@roc/plugin-consumer', dependencies: ['@roc/plugin-alpha'], order: 10 }),
      async (context) => {
        const output = await context.capabilities.invoke<{ value: string }, { echoed: string }>('alpha.echo', {
          value: 'hello'
        });
        calls.push(output.echoed);
      }
    );

    await createLoader().load([consumer, provider]);

    expect(calls).toEqual(['provider', 'hello']);
  });

  it('allows a plugin to invoke its own registered capability', async () => {
    const calls: string[] = [];
    const descriptor: CapabilityDescriptor<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
      name: 'self.echo',
      version: '1.0.0',
      inputSchema,
      outputSchema
    };
    const plugin = createPlugin(
      createManifest({ id: '@roc/plugin-self', capabilities: [descriptor] }),
      async (context) => {
        context.capabilities.register('@roc/plugin-self', descriptor, async (input) => ({
          echoed: (input as { value: string }).value
        }));
        const output = await context.capabilities.invoke<{ value: string }, { echoed: string }>('self.echo', {
          value: 'hello'
        });
        calls.push(output.echoed);
      }
    );

    await createLoader().load([plugin]);

    expect(calls).toEqual(['hello']);
  });

  it('blocks capability invocation from plugins that do not depend on the provider plugin', async () => {
    const descriptor: CapabilityDescriptor<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
      name: 'alpha.echo',
      version: '1.0.0',
      inputSchema,
      outputSchema
    };
    const provider = createPlugin(
      createManifest({ id: '@roc/plugin-alpha', capabilities: [descriptor] }),
      async (context) => {
        context.capabilities.register('@roc/plugin-alpha', descriptor, async () => ({ echoed: 'hello' }));
      }
    );
    const consumer = createPlugin(createManifest({ id: '@roc/plugin-consumer', order: 10 }), async (context) => {
      await context.capabilities.invoke('alpha.echo', { value: 'hello' });
    });

    await expect(createLoader().load([provider, consumer])).rejects.toThrow(/capability_dependency_not_declared/u);
  });
});
