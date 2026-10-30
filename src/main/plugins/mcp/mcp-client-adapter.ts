import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import type { JsonSchema7Type } from '@langchain/core/utils/json_schema';
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
          tools.push(createLangChainTool({
            client: connected.client,
            contract,
            description,
            remoteTool,
            runtimeToolName,
            runSignal: connected.signal,
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

export function createLangChainTool(input: {
  client: InstanceType<typeof Client>;
  contract: McpToolContractV1;
  description: string;
  remoteTool: McpRemoteTool;
  runtimeToolName: string;
  runSignal: AbortSignal;
  semaphore: { acquire(signal: AbortSignal): Promise<() => void> };
  timeoutMs?: number;
}): StructuredToolInterface {
  // SAFETY: the MCP SDK schema is validated immediately by createJsonSchemaParser before the provider schema is exposed.
  const jsonSchema = input.remoteTool.inputSchema as unknown as JsonSchemaType;
  const inputParser = createJsonSchemaParser(jsonSchema);
  const validateOutput = createMcpOutputValidator(input.remoteTool.outputSchema);
  const modelSchema = structuredClone(jsonSchema) as Record<string, unknown>;
  if (!isRecord(modelSchema.properties)) modelSchema.properties = {};
  // SAFETY: the MCP JSON Schema was validated by fromJsonSchema before this provider-facing schema is used.
  const schema = modelSchema as unknown as JsonSchema7Type;
  return new DynamicStructuredTool({
    name: input.runtimeToolName,
    description: input.description,
    schema,
    responseFormat: 'content_and_artifact',
    metadata: { mcpContract: input.contract },
    func: async (args, _runManager, config) => {
      const parsed = await inputParser.safeParseAsync(args);
      if (!parsed.success) {
        throw new Error(`mcp_tool_input_invalid:${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      }
      const argumentsObject = parsed.data as Record<string, unknown>;
      const serializedInput = JSON.stringify(argumentsObject);
      if (serializedInput === undefined || Buffer.byteLength(serializedInput, 'utf8') > input.contract.maxInputBytes) {
        throw new Error('mcp_tool_input_limit');
      }
      const timeoutMs = input.timeoutMs ?? MCP_TOOL_TIMEOUT_MS;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = combineSignals(combineSignals(input.runSignal, config?.signal), timeoutSignal);
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
        if (result.isError) {
          const message = result.content
            .filter((content) => content.type === 'text')
            .map((content) => content.text)
            .join('\\n');
          const toolCallId = getToolCallId(config);
          if (toolCallId !== undefined) {
            return [new ToolMessage({
              content: message || 'mcp_tool_remote_error',
              tool_call_id: toolCallId,
              status: 'error'
            }), []];
          }
          throw new Error(message || 'mcp_tool_remote_error');
        }
        await validateOutput(result.structuredContent);
        const converted = convertCallToolResult(result);
        const serializedOutput = JSON.stringify({ structuredContent: result.structuredContent ?? null, converted });
        if (serializedOutput === undefined || Buffer.byteLength(serializedOutput, 'utf8') > input.contract.maxOutputBytes) {
          throw new Error('mcp_tool_output_limit');
        }
        return converted;
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(`Error calling tool ${input.remoteTool.name}: ${String(error)}`, { cause: error });
      } finally {
        release();
      }
    }
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getToolCallId(config: unknown): string | undefined {
  const toolCall = isRecord(config) ? config.toolCall : undefined;
  return isRecord(toolCall) && typeof toolCall.id === 'string' ? toolCall.id : undefined;
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

function convertCallToolResult(result: McpCallToolResult): [string | Array<Record<string, unknown>>, Record<string, unknown>] {
  const content: Array<Record<string, unknown>> = [];
  const artifacts: unknown[] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      content.push({ type: 'image', source_type: 'base64', data: block.data, mime_type: block.mimeType });
      artifacts.push(block);
    } else if (block.type === 'audio') {
      content.push({ type: 'audio', source_type: 'base64', data: block.data, mime_type: block.mimeType });
      artifacts.push(block);
    } else if (block.type === 'resource') {
      if ('text' in block.resource) {
        content.push({ type: 'text', text: block.resource.text, metadata: { uri: block.resource.uri } });
      } else {
        const mimeType = block.resource.mimeType ?? 'application/octet-stream';
        const contentType = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : 'file';
        content.push({ type: contentType, source_type: 'base64', data: block.resource.blob, mime_type: mimeType });
      }
      artifacts.push(block);
    } else if (block.type === 'resource_link') {
      content.push({ type: 'file', source_type: 'url', url: block.uri, mime_type: block.mimeType, metadata: { name: block.name } });
      artifacts.push(block);
    } else {
      artifacts.push(block);
      content.push({ type: 'text', text: JSON.stringify(block) });
    }
  }
  const hasExtraMetadata = result.structuredContent !== undefined || result._meta !== undefined;
  const artifact: Record<string, unknown> = {};
  if (artifacts.length > 0) artifact.content = artifacts;
  if (result.structuredContent !== undefined) artifact.structuredContent = result.structuredContent;
  if (result._meta !== undefined) artifact._meta = result._meta;
  const renderedContent = content.length === 1 && content[0]?.type === 'text'
    ? String(content[0].text ?? '')
    : content;
  return [renderedContent, hasExtraMetadata || artifacts.length > 0 ? artifact : {}];
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
