import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocPluginContext } from '../../../../src/main/kernel/types';
import { createMcpPlugin } from '../../../../src/main/plugins/mcp';
import type { McpClientAdapter } from '../../../../src/main/plugins/mcp/mcp-client-adapter';
import type { McpServerConfig } from '../../../../src/shared/types';

const mcpCapabilities = [
  'mcp.listServers',
  'mcp.upsertServer',
  'mcp.setServerEnabled',
  'mcp.deleteServer',
  'mcp.testServer',
  'mcp.tools.get'
];

let db: Database.Database;
let mcpConfig: { schemaVersion: 1; servers: McpServerConfig[] };

beforeEach(() => {
  db = new Database(':memory:');
  mcpConfig = { schemaVersion: 1, servers: [] };
});

afterEach(() => {
  db.close();
});

describe('MCP plugin', () => {
  it('declares the Phase 3 MCP plugin contract', () => {
    const plugin = createMcpPlugin();

    expect(plugin.manifest.id).toBe('@roc/plugin-mcp');
    expect(plugin.manifest.dependencies).toEqual([]);
    expect(plugin.manifest.loadPhase).toBe('critical');
    expect(plugin.manifest.required).toBe(true);
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(mcpCapabilities);
  });

  it('preserves current MCP config, Exa preset, validation, and server inspection behavior', async () => {
    const capabilities = await initializePlugin();

    const initialSnapshots = await capabilities.invoke('mcp.listServers', {});
    const enabled = await capabilities.invoke<{ id: string; enabled: boolean }, McpServerConfig>('mcp.setServerEnabled', {
      id: 'exa-hosted',
      enabled: true
    });
    const stdioServer = await capabilities.invoke<McpServerConfig, McpServerConfig>('mcp.upsertServer', {
      id: 'docs',
      name: 'Docs',
      enabled: true,
      transport: 'stdio',
      preset: false,
      riskLevel: 'low',
      command: 'node ./server.js --stdio',
      allowedTools: ['search_docs']
    });
    const snapshots = await capabilities.invoke('mcp.listServers', {});
    const testResult = await capabilities.invoke<{ id: string }, unknown>('mcp.testServer', { id: stdioServer.id });

    expect(initialSnapshots).toEqual([
      expect.objectContaining({
        id: 'exa-hosted',
        transport: 'http',
        enabled: false,
        url: 'https://mcp.exa.ai/mcp'
      })
    ]);
    expect(mcpConfig.servers[0]).toMatchObject({
      id: 'exa-hosted',
      transport: 'http',
      enabled: true,
      url: 'https://mcp.exa.ai/mcp'
    });
    expect(enabled.enabled).toBe(true);
    expect(snapshots).toEqual([
      expect.objectContaining({
        id: 'exa-hosted',
        enabled: true,
        status: 'not_connected',
        tools: 2
      }),
      expect.objectContaining({
        id: 'docs',
        transport: 'stdio',
        command: 'node ./server.js --stdio',
        tools: 1
      })
    ]);
    expect(testResult).toEqual({
      serverId: 'docs',
      status: 'ready',
      checked: ['id', 'name', 'transport', 'command'],
      error: null
    });
    expect(mcpConfig.servers.map((server) => server.id)).toEqual(['exa-hosted', 'docs']);
  });

  it('keeps transport field validation for stdio and HTTP/SSE servers', async () => {
    const capabilities = await initializePlugin();

    await expect(
      capabilities.invoke('mcp.upsertServer', {
        id: 'bad-stdio',
        name: 'Bad stdio',
        enabled: true,
        transport: 'stdio',
        preset: false,
        riskLevel: 'low',
        allowedTools: []
      })
    ).rejects.toMatchObject({
      code: 'mcp_stdio_command_missing'
    });

    await expect(
      capabilities.invoke('mcp.upsertServer', {
        id: 'bad-http',
        name: 'Bad HTTP',
        enabled: true,
        transport: 'http',
        preset: false,
        riskLevel: 'low',
        allowedTools: []
      })
    ).rejects.toMatchObject({
      code: 'mcp_url_missing'
    });
  });

  it('loads tools from the currently enabled config servers', async () => {
    const loadedServers: McpServerConfig[][] = [];
    const capabilities = await initializePlugin({
      loadTools: async (servers) => {
        loadedServers.push([...servers]);
        return [{ name: 'search_docs' }];
      },
      close: async () => {}
    });
    await capabilities.invoke<McpServerConfig, McpServerConfig>('mcp.upsertServer', {
      id: 'docs',
      name: 'Docs',
      enabled: true,
      transport: 'stdio',
      preset: false,
      riskLevel: 'low',
      command: 'node ./server.js --stdio',
      allowedTools: ['search_docs']
    });

    const tools = await capabilities.invoke('mcp.tools.get', {});

    expect(tools).toEqual([{ name: 'search_docs' }]);
    expect(loadedServers).toEqual([
      [
        expect.objectContaining({
          id: 'docs',
          enabled: true
        })
      ]
    ]);
  });
});

async function initializePlugin(clientAdapter?: McpClientAdapter): Promise<CapabilityRegistry> {
  const plugin = createMcpPlugin({ clientAdapter });
  const capabilities = new CapabilityRegistry();
  for (const descriptor of plugin.manifest.capabilities) {
    capabilities.declare(plugin.manifest.id, descriptor);
  }
  await plugin.initialize(createContext(capabilities));
  return capabilities;
}

function createContext(capabilities: CapabilityRegistry): RocPluginContext {
  return {
    pluginId: '@roc/plugin-mcp',
    eventBus: createEventBus(),
    capabilities,
    database: { getConnection: () => db },
    config: {
      get: <T>(key: string) => {
        if (key !== 'mcp') {
          return null;
        }
        return mcpConfig as T;
      },
      set: <T>(key: string, value: T) => {
        if (key !== 'mcp') {
          throw new Error(`unexpected config key: ${key}`);
        }
        mcpConfig = value as typeof mcpConfig;
      }
    },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  };
}

function createEventBus(): RocEventBus {
  return {
    publish: async () => {},
    subscribe: () => () => {}
  };
}
