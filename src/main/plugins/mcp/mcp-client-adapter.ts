import { MultiServerMCPClient } from '@langchain/mcp-adapters';

import type { McpServerConfig } from '../../../shared/types';

type LangChainMcpClient = {
  getTools(): Promise<unknown[]>;
  close(): Promise<void>;
};

type McpServerConnectionConfig =
  | {
      transport: 'stdio';
      command: string;
      args: string[];
    }
  | {
      transport: 'http' | 'sse';
      url: string;
    };

type MultiServerMcpClientConfig = {
  throwOnLoadError: boolean;
  onConnectionError: 'ignore';
  useStandardContentBlocks: boolean;
  mcpServers: Record<string, McpServerConnectionConfig>;
};

export type McpClientAdapter = {
  loadTools(servers: readonly McpServerConfig[]): Promise<unknown[]>;
  close(): Promise<void>;
};

export function createMcpClientAdapter(): McpClientAdapter {
  return new LangChainMcpClientAdapter();
}

class LangChainMcpClientAdapter implements McpClientAdapter {
  private client: LangChainMcpClient | null = null;

  async loadTools(servers: readonly McpServerConfig[]): Promise<unknown[]> {
    await this.close();
    const enabledServers = servers.filter((server) => server.enabled);
    if (enabledServers.length === 0) {
      return [];
    }
    const config: MultiServerMcpClientConfig = {
      throwOnLoadError: false,
      onConnectionError: 'ignore',
      useStandardContentBlocks: true,
      mcpServers: Object.fromEntries(enabledServers.map((server) => [server.id, toConnectionConfig(server)]))
    };
    this.client = new MultiServerMCPClient(config);
    return await this.client.getTools();
  }

  async close(): Promise<void> {
    if (this.client === null) {
      return;
    }
    await this.client.close();
    this.client = null;
  }
}

function toConnectionConfig(server: McpServerConfig): McpServerConnectionConfig {
  if (server.transport === 'stdio') {
    if (server.command === undefined) {
      throw new Error('mcp_stdio_command_missing');
    }
    const command = parseCommandLine(server.command);
    return {
      transport: 'stdio',
      command: command.executable,
      args: command.args
    };
  }
  if (server.url === undefined) {
    throw new Error('mcp_url_missing');
  }
  return {
    transport: server.transport,
    url: server.url
  };
}

function parseCommandLine(commandLine: string): { executable: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of commandLine.trim()) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (quote !== null) {
    throw new Error('mcp_command_quote_unclosed');
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  const [executable, ...args] = tokens;
  if (executable === undefined) {
    throw new Error('mcp_command_empty');
  }
  return { executable, args };
}
