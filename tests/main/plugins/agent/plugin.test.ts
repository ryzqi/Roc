import Database from 'better-sqlite3';
import type { BaseStore } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';

import { createAgentPlugin } from '../../../../src/main/plugins/agent';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocPluginContext } from '../../../../src/main/kernel/types';
import { RocPaths } from '../../../../src/main/services/paths';

const mocked = vi.hoisted(() => ({
  createAgentDeepAgentExecutor: vi.fn((_options: { store: BaseStore }) => ({
    execute: async function* () {}
  }))
}));

vi.mock('../../../../src/main/plugins/agent/deep-agent-executor', () => ({
  createAgentDeepAgentExecutor: mocked.createAgentDeepAgentExecutor
}));

const agentCapabilities = [
  'agent.status.get',
  'agent.config.preview',
  'agent.run.start',
  'agent.run.cancel',
  'agent.run.resume',
  'agent.sessions.list',
  'agent.sessions.search'
];

const agentCapabilitiesWithPreview = [...agentCapabilities, 'agent.capability.preview'];

describe('agent plugin manifest', () => {
  it('declares the Phase 2 critical agent plugin contract', () => {
    const plugin = createAgentPlugin();

    expect(plugin.manifest.id).toBe('@roc/plugin-agent');
    expect(plugin.manifest.loadPhase).toBe('critical');
    expect(plugin.manifest.required).toBe(true);
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(agentCapabilities);
  });

  it('declares plugin dependencies when the capability preview API is enabled', () => {
    const plugin = createAgentPlugin({
      capabilityPreview: {
        deleteFileApprovalModeProvider: () => 'fully_automatic',
        mcpApprovalModeProvider: () => 'fully_automatic'
      }
    });

    expect(plugin.manifest.dependencies).toEqual(['@roc/plugin-mcp', '@roc/plugin-skills']);
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(agentCapabilitiesWithPreview);
  });

  it('declares plugin dependencies when the DeepAgent executor is enabled', () => {
    const plugin = createAgentPlugin({
      deepAgentExecutor: {
        paths: new RocPaths('F:\\Code\\Roc')
      }
    });

    expect(plugin.manifest.dependencies).toEqual([
      '@roc/plugin-mcp',
      '@roc/plugin-skills',
      '@roc/plugin-workspace',
      '@roc/plugin-runtime-tools'
    ]);
    expect(Reflect.get(plugin.manifest, 'capabilityDependencies')).toEqual(['@roc/plugin-task']);
  });

  it('creates the DeepAgent executor with a SQLite store on core.db', async () => {
    const pluginDb = new Database(':memory:');
    const coreDb = new Database(':memory:');
    try {
      const plugin = createAgentPlugin({
        deepAgentExecutor: {
          paths: new RocPaths('F:\\Code\\Roc')
        }
      });

      const context = createContext(pluginDb, coreDb);
      for (const capability of plugin.manifest.capabilities) {
        context.capabilities.declare(plugin.manifest.id, capability);
      }
      await plugin.initialize(context);

      const options = mocked.createAgentDeepAgentExecutor.mock.calls[0]?.[0] as { store: BaseStore } | undefined;
      expect(options?.store.constructor.name).toBe('RocSqliteStore');
      await options?.store.put(['roc', 'memory', 'global'], '/MEMORY.md', { content: 'core' });
      expect(coreDb.prepare('SELECT value_json FROM langgraph_store_items WHERE key = ?').pluck().get('/MEMORY.md')).toBe(
        '{"content":"core"}'
      );
    } finally {
      pluginDb.close();
      coreDb.close();
    }
  });
});

describe('agent run schema explicit skills', () => {
  it('accepts explicit skill ids on chat start requests', () => {
    const plugin = createAgentPlugin();
    const startDescriptor = plugin.manifest.capabilities.find((capability) => capability.name === 'agent.run.start');
    const parsed = startDescriptor?.inputSchema.safeParse({
      input: '优化这段代码',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: ['existing-skill']
      },
      explicitSkillIds: ['python-expert']
    });

    expect(parsed?.success).toBe(true);
  });

  it('rejects empty explicit skill ids', () => {
    const plugin = createAgentPlugin();
    const startDescriptor = plugin.manifest.capabilities.find((capability) => capability.name === 'agent.run.start');
    const parsed = startDescriptor?.inputSchema.safeParse({
      input: '优化这段代码',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      explicitSkillIds: ['']
    });

    expect(parsed?.success).toBe(false);
  });
});

function createContext(pluginDb: Database.Database, coreDb: Database.Database): RocPluginContext {
  return {
    pluginId: '@roc/plugin-agent',
    eventBus: {
      publish: async () => {},
      subscribe: () => () => {}
    },
    capabilities: new CapabilityRegistry(),
    database: {
      getConnection: () => pluginDb,
      getCoreConnection: () => coreDb
    },
    config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  };
}
