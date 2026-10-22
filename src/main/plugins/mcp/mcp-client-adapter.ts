import { tool, type StructuredToolInterface } from '@langchain/core/tools';
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

export type McpClientAdapter = {
  loadTools(runId: string, servers: readonly McpServerConfig[], signal: AbortSignal): Promise<unknown[]>;
  release(runId: string): Promise<void>;
  close(): Promise<void>;
};

export function createMcpClientAdapter(): McpClientAdapter {
  return new LangChainMcpClientAdapter();
}

class LangChainMcpClientAdapter implements McpClientAdapter {
  private readonly clients = new Map<string, LangChainMcpClient>();

  async loadTools(runId: string, servers: readonly McpServerConfig[], signal: AbortSignal): Promise<unknown[]> {
    signal.throwIfAborted();
    if (this.clients.has(runId)) throw new Error('mcp_run_already_loaded');
    const enabledServers = servers.filter(server => server.enabled);
    if (enabledServers.length === 0) return [];
    const client = new MCPAdapter({
      throwOnLoadError: true,
      onConnectionError: 'ignore',
      servers: Object.fromEntries(enabledServers.map(server => [server.id, { ...toConnectionConfig(server), defaultToolTimeout: 30000, ...(server.transport === 'stdio' ? { restart: { enabled: false } } : {}) }]))
    });
    this.clients.set(runId, client);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error(signal.aborted ? 'mcp_initialization_aborted' : 'mcp_initialization_timeout'));
      deadline.addEventListener('abort', abort, { once: true });
      if (deadline.aborted) abort();
    });
    try {
      const discovered = await Promise.race([client.listTools(), cancelled]);
      if (this.clients.get(runId) !== client) throw new Error('mcp_run_released_during_load');
      return discovered.map(value => {
        if (typeof value !== 'object' || value === null) throw new Error('mcp_tool_contract_invalid');
        // One typed narrowing instead of three Reflect reads: the discovered tool must expose
        // `invoke`, a string `name` and a `schema`.
        const candidate = value as { invoke?: unknown; name?: unknown; schema?: unknown };
        if (typeof candidate.invoke !== 'function' || typeof candidate.name !== 'string' || candidate.schema === undefined) {
          throw new Error('mcp_tool_contract_invalid');
        }
        const source = value as StructuredToolInterface;
        return tool(async (args, config) => {
          const result: unknown = await source.invoke(args, { ...config, signal: config.signal === undefined ? AbortSignal.timeout(30000) : AbortSignal.any([config.signal, AbortSignal.timeout(30000)]) });
          if (Buffer.byteLength(typeof result === 'string' ? result : JSON.stringify(result)) > 128 * 1024) throw new Error('mcp_tool_output_limit');
          return result;
        }, { name: source.name, description: source.description, schema: source.schema });
      });
    }
    catch (error) {
      try { await this.release(runId); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'mcp_load_cleanup_failed'); }
      throw error;
    } finally { deadline.removeEventListener('abort', abort); }
  }

  async release(runId: string): Promise<void> {
    const client = this.clients.get(runId);
    if (client === undefined) return;
    this.clients.delete(runId);
    await client.close();
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.clients.keys()].map(runId => this.release(runId)));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'mcp_shutdown_failed');
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
