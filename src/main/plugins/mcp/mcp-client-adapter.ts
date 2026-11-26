import { type StructuredToolInterface } from '@langchain/core/tools';
import { loadMcpTools } from '@langchain/mcp-adapters';
import {
  Client,
  fromJsonSchema,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type JsonSchemaType
} from '@modelcontextprotocol/client';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/client/_shims';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';

import type { McpToolContractV1 } from '../../../shared/types/agent';
import type { McpServerConfig } from '../../../shared/types';
import {
  DEFAULT_MCP_MAX_INBOUND_MESSAGE_BYTES,
  createBoundedMcpFetch
} from './mcp-bounded-fetch';
import { createMcpToolContract } from './mcp-tool-contract';

const MCP_INITIALIZATION_TIMEOUT_MS = 15_000;
const MCP_TOOL_TIMEOUT_MS = 30_000;
const MCP_MAX_CONCURRENT_CALLS_PER_SERVER = 2;

export type McpClientAdapter = {
  loadTools(runId: string, servers: readonly McpServerConfig[], signal: AbortSignal): Promise<unknown[]>;
  release(runId: string): Promise<void>;
  close(): Promise<void>;
};

type McpRemoteTool = Awaited<ReturnType<InstanceType<typeof Client>['listTools']>>['tools'][number];
type McpCallToolResult = Awaited<ReturnType<InstanceType<typeof Client>['callTool']>>;
type McpTransport = Parameters<InstanceType<typeof Client>['connect']>[0];
type ClientSession = {
  clients: Map<string, InstanceType<typeof Client>>;
};
type HttpResponseTracker = {
  lastStatus: number | null;
  sizeLimitExceeded: boolean;
};

export function createMcpClientAdapter(): McpClientAdapter {
  return new BoundedMcpClientAdapter();
}

class BoundedMcpClientAdapter implements McpClientAdapter {
  private readonly sessions = new Map<string, ClientSession>();
  private readonly semaphores = new Map<string, Semaphore>();

  async loadTools(runId: string, servers: readonly McpServerConfig[], signal: AbortSignal): Promise<unknown[]> {
    signal.throwIfAborted();
    if (this.sessions.has(runId)) throw new Error('mcp_run_already_loaded');
    const session: ClientSession = { clients: new Map() };
    this.sessions.set(runId, session);
    try {
      const enabledServers = servers.filter((server) => server.enabled);
      const tools: StructuredToolInterface[] = [];
      for (const server of enabledServers) {
        signal.throwIfAborted();
        const connected = await this.connectServer(server, signal);
        session.clients.set(server.id, connected.client);
        const result = await connected.client.listTools({}, {
          cacheMode: 'bypass',
          signal: connected.signal,
          timeout: MCP_INITIALIZATION_TIMEOUT_MS
        });
        const allowed = selectAllowedRemoteTools(server, result.tools);
        for (const remoteTool of allowed) {
          const runtimeToolName = `${server.id}_${remoteTool.name}`;
          const description = remoteTool.description ?? '';
          const contract = createMcpToolContract({
            description,
            inputSchema: remoteTool.inputSchema,
            outputSchema: remoteTool.outputSchema,
            remoteToolName: remoteTool.name,
            runtimeToolName,
            serverId: server.id,
            transport: server.transport
          });
          tools.push(await createLangChainTool({
            client: connected.client,
            contract,
            description,
            remoteTool,
            runtimeToolName,
            // Initialization's deadline ends with discovery, not with the run.
            runSignal: signal,
            semaphore: this.getSemaphore(server.id)
          }));
        }
      }
      return tools;
    } catch (error) {
      try {
        await this.release(runId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'mcp_load_cleanup_failed');
      }
      throw error;
    }
  }

  async release(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (session === undefined) return;
    this.sessions.delete(runId);
    const results = await Promise.allSettled([...session.clients.values()].map((client) => client.close()));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'mcp_release_failed');
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions.keys()].map((runId) => this.release(runId)));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'mcp_shutdown_failed');
  }

  private getSemaphore(serverId: string): Semaphore {
    let semaphore = this.semaphores.get(serverId);
    if (semaphore === undefined) {
      semaphore = new Semaphore(MCP_MAX_CONCURRENT_CALLS_PER_SERVER);
      this.semaphores.set(serverId, semaphore);
    }
    return semaphore;
  }

  private async connectServer(server: McpServerConfig, parentSignal: AbortSignal): Promise<{
    client: InstanceType<typeof Client>;
    signal: AbortSignal;
  }> {
    const timeoutSignal = AbortSignal.timeout(MCP_INITIALIZATION_TIMEOUT_MS);
    const signal = AbortSignal.any([parentSignal, timeoutSignal]);
    try {
      if (server.transport === 'stdio') {
        return await this.connectTransport(signal, this.createStdioTransport(server), 'auto');
      }
      if (server.url === undefined) throw new Error('mcp_url_missing');
      if (server.transport === 'sse') {
        return await this.connectTransport(signal, this.createSseTransport(server.url, {
          lastStatus: null,
          sizeLimitExceeded: false
        }), 'legacy');
      }
      return await this.connectHttpWithFallback(server.url, signal);
    } catch (error) {
      if (parentSignal.aborted) throw new Error('mcp_initialization_aborted', { cause: error });
      if (timeoutSignal.aborted) throw new Error('mcp_initialization_timeout', { cause: error });
      throw error;
    }
  }

  private async connectHttpWithFallback(
    url: string,
    signal: AbortSignal
  ): Promise<{ client: InstanceType<typeof Client>; signal: AbortSignal }> {
    const tracker: HttpResponseTracker = { lastStatus: null, sizeLimitExceeded: false };
    try {
      return await this.connectTransport(signal, this.createHttpTransport(url, tracker), 'auto');
    } catch (error) {
      if (tracker.sizeLimitExceeded || !isHttpSseFallbackStatus(tracker.lastStatus)) throw error;
      const fallbackUrls = createSseFallbackUrls(url);
      let lastError: unknown = error;
      for (const fallbackUrl of fallbackUrls) {
        const fallbackTracker: HttpResponseTracker = { lastStatus: null, sizeLimitExceeded: false };
        try {
          return await this.connectTransport(signal, this.createSseTransport(fallbackUrl, fallbackTracker), 'legacy');
        } catch (fallbackError) {
          lastError = fallbackError;
          if (fallbackTracker.sizeLimitExceeded || !isHttpSseFallbackStatus(fallbackTracker.lastStatus)) break;
        }
      }
      throw new AggregateError([error, lastError], 'mcp_http_sse_fallback_failed');
    }
  }

  private async connectTransport(
    signal: AbortSignal,
    transport: McpTransport,
    versionNegotiation: 'auto' | 'legacy'
  ): Promise<{ client: InstanceType<typeof Client>; signal: AbortSignal }> {
    const client = new Client(
      { name: '@roc/mcp-client', version: '1.0.0' },
      { versionNegotiation: { mode: versionNegotiation } }
    );
    try {
      await client.connect(transport, { signal, timeout: MCP_INITIALIZATION_TIMEOUT_MS });
      return { client, signal };
    } catch (error) {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  private createStdioTransport(server: McpServerConfig): McpTransport {
    if (server.command === undefined) throw new Error('mcp_stdio_command_missing');
    const command = parseCommandLine(server.command);
    return new StdioClientTransport({
      command: command.executable,
      args: command.args,
      // Preserve the host's explicit empty OpenSSL config in isolated Node
      // peers without forwarding arbitrary config paths or other environment.
      ...(process.env.OPENSSL_CONF === '/dev/null' ? { env: { OPENSSL_CONF: '/dev/null' } } : {}),
      maxBufferSize: DEFAULT_MCP_MAX_INBOUND_MESSAGE_BYTES
    });
  }

  private createHttpTransport(url: string, tracker: HttpResponseTracker): McpTransport {
    return new StreamableHTTPClientTransport(parseMcpUrl(url), {
      fetch: this.createTrackedFetch(url, tracker),
      redirectPolicy: 'same-origin',
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 10_000,
        reconnectionDelayGrowFactor: 1.5
      }
    });
  }

  private createSseTransport(url: string, tracker: HttpResponseTracker): McpTransport {
    return new SSEClientTransport(parseMcpUrl(url), {
      fetch: this.createTrackedFetch(url, tracker)
    });
  }

  private createTrackedFetch(serverUrl: string, tracker: HttpResponseTracker): typeof fetch {
    return createBoundedMcpFetch({
      maxMessageBytes: DEFAULT_MCP_MAX_INBOUND_MESSAGE_BYTES,
      onLimitExceeded: () => { tracker.sizeLimitExceeded = true; },
      onResponse: (requestUrl, status) => {
        if (isSameEndpoint(requestUrl, serverUrl)) tracker.lastStatus = status;
      }
    });
  }
}

/**
 * Use LangChain's official tool conversion, but keep the frozen Roc MCP contract
 * and the bounded per-run transport. The facade contains only the tools admitted
 * by the user's server allowlist, not every remote-advertised tool.
 */
export async function createLangChainTool(input: {
  client: InstanceType<typeof Client>;
  contract: McpToolContractV1;
  description: string;
  remoteTool: McpRemoteTool;
  runtimeToolName: string;
  runSignal: AbortSignal;
  semaphore: { acquire(signal: AbortSignal): Promise<() => void> };
  timeoutMs?: number;
}): Promise<StructuredToolInterface> {
  const validateOutput = createMcpOutputValidator(input.remoteTool.outputSchema);
  const timeoutMs = input.timeoutMs ?? MCP_TOOL_TIMEOUT_MS;
  const facade = {
    getProtocolEra: () => input.client?.getProtocolEra?.() ?? 'legacy',
    // Keep the already size-checked, contract-frozen provider description. Do not
    // re-read the remote server's descriptor when the official adapter loads it.
    listTools: async () => ({ tools: [{ ...input.remoteTool, description: input.description }] }),
    callTool: async (request: { name: string; arguments?: Record<string, unknown> }, options?: {
      signal?: AbortSignal;
      timeout?: number;
      toolDefinition?: McpRemoteTool;
    }): Promise<McpCallToolResult> => {
      if (request.name !== input.remoteTool.name) throw new Error('mcp_tool_not_in_run_allowlist');
      const argumentsObject = request.arguments ?? {};
      const serializedInput = JSON.stringify(argumentsObject);
      if (serializedInput === undefined || Buffer.byteLength(serializedInput, 'utf8') > input.contract.maxInputBytes) {
        throw new Error('mcp_tool_input_limit');
      }
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = combineSignals(combineSignals(input.runSignal, options?.signal), timeoutSignal);
      const release = await input.semaphore.acquire(signal);
      try {
        const result = await input.client.callTool(
          { name: input.remoteTool.name, arguments: argumentsObject },
          {
            signal,
            timeout: timeoutMs,
            toolDefinition: input.remoteTool
          }
        );
        if (!result.isError) await validateOutput(result.structuredContent);
        // Apply the bound before the official adapter materializes multimodal content.
        const serializedOutput = JSON.stringify(result);
        if (serializedOutput === undefined || Buffer.byteLength(serializedOutput, 'utf8') > input.contract.maxOutputBytes) {
          throw new Error('mcp_tool_output_limit');
        }
        return result;
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(`Error calling tool ${input.remoteTool.name}: ${String(error)}`, { cause: error });
      } finally {
        release();
      }
    }
  };
  // loadMcpTools accepts an already-owned MCP Client. Its invocation only needs
  // listTools/getProtocolEra/callTool, which this constrained, run-scoped facade supplies.
  const tools = await loadMcpTools(input.contract.serverId, facade as unknown as InstanceType<typeof Client>, {
    prefixToolNameWithServerName: true,
    throwOnLoadError: true,
    defaultToolTimeout: timeoutMs
  });
  const tool = tools[0];
  if (tools.length !== 1 || tool === undefined || tool.name !== input.runtimeToolName) {
    throw new Error('mcp_tool_adapter_name_mismatch');
  }
  tool.metadata = { ...tool.metadata, mcpContract: input.contract };
  return tool;
}

export function createMcpOutputValidator(outputSchema: unknown): (structuredContent: unknown) => Promise<void> {
  if (outputSchema === undefined) return async () => undefined;
  // SAFETY: MCP tools/list defines outputSchema as JSON Schema; fromJsonSchema validates its structure here.
  const parser = createJsonSchemaParser(outputSchema as unknown as JsonSchemaType);
  return async (structuredContent: unknown) => {
    const result = await parser.safeParseAsync(structuredContent);
    if (!result.success) throw new Error('mcp_tool_output_invalid');
  };
}

function createJsonSchemaParser(jsonSchema: JsonSchemaType): z.ZodType {
  const validator = fromJsonSchema(jsonSchema, new DefaultJsonSchemaValidator());
  return z.transform(async (input, context) => {
    const result = await validator['~standard'].validate(input);
    if (result.issues) {
      context.issues.push(...result.issues.map((issue) => ({
        code: 'custom' as const,
        input,
        message: issue.message,
        path: issue.path?.map((segment) => typeof segment === 'object' ? segment.key : segment) ?? []
      })));
      return z.NEVER;
    }
    return result.value;
  });
}

function selectAllowedRemoteTools(server: McpServerConfig, tools: readonly McpRemoteTool[]): McpRemoteTool[] {
  const allowed = new Set(server.allowedTools);
  const selected = tools.filter((remoteTool) => allowed.has(remoteTool.name));
  if (server.id !== 'exa-hosted') {
    return selected.sort((left, right) => left.name.localeCompare(right.name));
  }
  const preferred = selected.find((remoteTool) => remoteTool.name === 'web_search_exa')
    ?? selected.find((remoteTool) => remoteTool.name === 'web_search_advanced_exa');
  return preferred === undefined ? [] : [preferred];
}

function parseMcpUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('mcp_url_protocol_invalid');
    }
    return url;
  } catch (error) {
    throw new Error('mcp_url_invalid', { cause: error });
  }
}

function createSseFallbackUrls(url: string): string[] {
  const original = parseMcpUrl(url);
  const urls = [original.href];
  const rewritten = parseMcpUrl(original.href);
  if (/\/mcp\/?$/u.test(rewritten.pathname)) {
    rewritten.pathname = rewritten.pathname.replace(/\/mcp\/?$/u, '/sse');
    if (rewritten.href !== original.href) urls.push(rewritten.href);
  }
  return urls;
}

function isHttpSseFallbackStatus(status: number | null): boolean {
  return status === 404 || status === 405;
}

function isSameEndpoint(requestUrl: string, serverUrl: string): boolean {
  try {
    const request = new URL(requestUrl);
    const server = new URL(serverUrl);
    return request.origin === server.origin && request.pathname === server.pathname && request.search === server.search;
  } catch {
    return false;
  }
}

function combineSignals(left: AbortSignal, right: AbortSignal | undefined): AbortSignal {
  return right === undefined ? left : AbortSignal.any([left, right]);
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

class Semaphore {
  private active = 0;
  private readonly waiters: Array<{
    reject: (error: Error) => void;
    resolve: (release: () => void) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        reject,
        resolve,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('mcp_tool_call_aborted', { cause: signal.reason }));
        }
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) return;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(new Error('mcp_tool_call_aborted', { cause: waiter.signal.reason }));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}
