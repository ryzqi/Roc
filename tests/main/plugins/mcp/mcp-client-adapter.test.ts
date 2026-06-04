import { describe, expect, it, vi } from 'vitest';

const constructorCalls: unknown[] = [];
const getTools = vi.fn(async () => [{ name: 'exa_search' }]);
const close = vi.fn(async () => {});

vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: class FakeMultiServerMCPClient {
    constructor(config: unknown) {
      constructorCalls.push(config);
    }

    getTools = getTools;
    close = close;
  }
}));

import { createMcpClientAdapter } from '../../../../src/main/plugins/mcp/mcp-client-adapter';
import type { McpServerConfig } from '../../../../src/shared/types';

const stdioServer: McpServerConfig = {
  id: 'local-docs',
  name: 'Local Docs',
  enabled: true,
  transport: 'stdio',
  preset: false,
  riskLevel: 'low',
  command: 'node ./server.js --stdio',
  allowedTools: ['search_docs']
};

const httpServer: McpServerConfig = {
  id: 'exa-hosted',
  name: 'Exa Hosted MCP',
  enabled: true,
  transport: 'http',
  preset: true,
  riskLevel: 'medium',
  url: 'https://mcp.exa.ai/mcp',
  allowedTools: ['web_search_exa']
};

describe('MCP client adapter', () => {
  it('uses MultiServerMCPClient with installed mcpServers shape and cleans up with close', async () => {
    const adapter = createMcpClientAdapter();

    const tools = await adapter.loadTools([stdioServer, httpServer]);
    await adapter.close();

    expect(tools).toEqual([{ name: 'exa_search' }]);
    expect(constructorCalls).toEqual([
      expect.objectContaining({
        mcpServers: {
          'local-docs': {
            transport: 'stdio',
            command: 'node',
            args: ['./server.js', '--stdio']
          },
          'exa-hosted': {
            transport: 'http',
            url: 'https://mcp.exa.ai/mcp'
          }
        }
      })
    ]);
    expect(getTools).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
