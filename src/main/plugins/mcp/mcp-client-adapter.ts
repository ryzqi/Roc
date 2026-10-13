import { MCPAdapter } from '@langchain/mcp-adapters';

import type { McpServerConfig } from '../../../shared/types';

type LangChainMcpClient = {
  listTools(): Promise<unknown[]>;
  close(): Promise<void>;
};

type McpServerConnectionConfig =
  | {
      transport: 'stdio';
      command: string;
      args: string[];
    }
  | {
      transport: 'http';
      url: string;
    }
  | {
      transport: 'sse';
      url: string;
    };

type McpAdapterConfig = {
  throwOnLoadError: boolean;
  onConnectionError: 'ignore';
  // mcp-adapters 2.x 用 servers（1.x 的 mcpServers 已弃用，两者同时传会直接报错）。
  // 2.x 移除了 useStandardContentBlocks：多模态内容默认就是标准 content block。
  servers: Record<string, McpServerConnectionConfig>;
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
    const config: McpAdapterConfig = {
      throwOnLoadError: false,
      onConnectionError: 'ignore',
      servers: Object.fromEntries(enabledServers.map((server) => [server.id, toConnectionConfig(server)]))
    };
    this.client = new MCPAdapter(config);
    return await this.client.listTools();
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
  // mcp-adapters 2.x 把 http 与 sse 拆成两个独立判定联合成员，transport 必须是字面量。
  return server.transport === 'http'
    ? { transport: 'http', url: server.url }
    : { transport: 'sse', url: server.url };
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
