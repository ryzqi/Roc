import type { ClientTool } from '@langchain/core/tools';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { z } from 'zod';
import type {
  ChatStartRunRequest,
  MemorySearchRequest
} from '../../../shared/types';
import { RocDomainError } from '../errors';
import type { McpService } from '../mcp-service';
import type { MemoryService } from '../memory-service';
import { WebReadService, type WebReadRequest } from '../web-read-service';
import { toWebSearchFailure } from './error-mapping';
import type { MemoryGetRequest, RuntimeSubagent } from './types';

export function createWebReadTool(webReadService: WebReadService): DynamicStructuredTool<any, any, any, string> {
  const schema = z.object({
    url: z.string().url(),
    responseMode: z.enum(['markdown', 'readerlm-v2']).default('markdown'),
    timeoutSeconds: z.number().int().min(1).max(120).default(20),
    noCache: z.boolean().default(false)
  });
  return new DynamicStructuredTool<typeof schema, WebReadRequest, WebReadRequest, string>({
    name: 'web_read',
    description: '读取公开网页正文，返回适合继续分析的文本内容。',
    schema,
    func: async (input: WebReadRequest) => {
      return await webReadService.read(input);
    }
  });
}

export function createMemorySearchTool(memoryService: MemoryService): DynamicStructuredTool<any, any, any, string> {
  const schema = z.object({
    query: z.string().trim().min(1),
    includeCold: z.boolean().default(false),
    source: z.enum(['curated', 'session', 'all']).default('curated'),
    scope: z.string().trim().min(1).optional()
  });
  return new DynamicStructuredTool<typeof schema, MemorySearchRequest, MemorySearchRequest, string>({
    name: 'memory_search',
    description: '检索 Roc 长期记忆与会话回忆，返回相关条目摘要列表。',
    schema,
    func: async (input: MemorySearchRequest) => {
      return JSON.stringify(memoryService.search(input), null, 2);
    }
  });
}

export function createMemoryGetTool(memoryService: MemoryService): DynamicStructuredTool<any, any, any, string> {
  const schema = z.object({
    id: z.string().trim().min(1)
  });
  return new DynamicStructuredTool<typeof schema, MemoryGetRequest, MemoryGetRequest, string>({
    name: 'memory_get',
    description: '读取指定 Roc 记忆条目的 Markdown 原文。',
    schema,
    func: async (input: MemoryGetRequest) => {
      return memoryService.get(input.id);
    }
  });
}

export async function createWebSearchTool(input: {
  mcpService: McpService;
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  closers: Array<() => Promise<void>>;
}): Promise<ClientTool | null> {
  const { mcpService, enabledCapabilities, closers } = input;
  if (!enabledCapabilities.mcpServers.includes('exa-hosted')) {
    return null;
  }
  const exaServer = mcpService.listServers().find((server) => server.id === 'exa-hosted' && server.enabled);
  if (
    exaServer === undefined ||
    exaServer.url === undefined ||
    (exaServer.transport !== 'http' && exaServer.transport !== 'sse')
  ) {
    return null;
  }

  const client = new MultiServerMCPClient({
    throwOnLoadError: true,
    prefixToolNameWithServerName: false,
    useStandardContentBlocks: true,
    onConnectionError: 'throw',
    mcpServers: {
      'exa-hosted': {
        transport: exaServer.transport,
        url: exaServer.url
      }
    }
  });
  closers.push(async () => {
    await client.close();
  });

  try {
    const tools = await client.getTools();
    const searchTool =
      tools.find((candidate) => candidate.name === 'web_search_exa') ??
      tools.find((candidate) => candidate.name === 'web_search_advanced_exa');
    if (searchTool === undefined) {
      throw new RocDomainError({
        code: 'web_search_tool_missing',
        message: 'Exa Hosted MCP 未暴露 web_search 工具。',
        category: 'external',
        retryable: true,
        userAction: '请测试 Exa Hosted MCP 后重试。'
      });
    }
    searchTool.name = 'web_search';
    searchTool.description = '搜索公开网络信息，返回适合继续检索的结果列表。';
    return searchTool;
  } catch (error) {
    throw toWebSearchFailure(error);
  }
}

export function createRunSubagents(input: {
  memoryGetTool: DynamicStructuredTool<any, any, any, string>;
  memorySearchTool: DynamicStructuredTool<any, any, any, string>;
  webReadTool: DynamicStructuredTool<any, any, any, string>;
}): RuntimeSubagent[] {
  const subagents: RuntimeSubagent[] = [];
  subagents.push({
    name: 'code-review',
    description: '审查代码改动，优先输出 bug、回归风险、边界条件与缺失验证。',
    systemPrompt:
      '你是 Roc 的代码审查子代理。先找 bug、行为回归、风险和缺失验证，再给出简短结论。不要改写需求，不要淡化风险。需要项目上下文时，先使用 memory_search 和 memory_get。',
    tools: [input.memorySearchTool, input.memoryGetTool]
  });
  subagents.push({
    name: 'research',
    description: '检索公开资料并读取网页，整理带来源边界的结论。',
    systemPrompt:
      '你是 Roc 的资料检索子代理。优先使用 web_read 收集外部证据，只输出与问题直接相关的结论，并明确哪些信息来自外部资料且仍需核实。',
    tools: [input.webReadTool]
  });
  return subagents;
}
