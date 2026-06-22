import type { ClientTool } from '@langchain/core/tools';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { z } from 'zod';
import type { ChatStartRunRequest } from '../../../shared/types';
import { RocDomainError } from '../errors';
import type { FileService } from '../file-service';
import type { McpService } from '../mcp-service';
import { WebReadService, type WebReadRequest } from '../web-read-service';
import { webReadToolSchema } from '../web-read-request-schema';
import { toWebSearchFailure } from './error-mapping';
import type { RuntimeSubagent } from './types';

const asyncTaskToolNames = [
  'start_async_task',
  'check_async_task',
  'update_async_task',
  'cancel_async_task',
  'list_async_tasks'
] as const;

const reservedSubagentNames = new Set<string>(asyncTaskToolNames);

export function createWebReadTool(webReadService: WebReadService): DynamicStructuredTool<any, any, any, string> {
  const schema = webReadToolSchema;
  return new DynamicStructuredTool<typeof schema, WebReadRequest, WebReadRequest, string>({
    name: 'web_read',
    description: '读取公开网页正文，返回适合继续分析的文本内容。',
    schema,
    func: async (input: WebReadRequest) => {
      return await webReadService.read(input);
    }
  });
}

export function createDeleteFileTool(fileService: FileService): DynamicStructuredTool<any, any, any, string> {
  const schema = z.object({
    relativePath: z.string().trim().min(1)
  });
  return new DynamicStructuredTool<typeof schema, { relativePath: string }, { relativePath: string }, string>({
    name: 'delete_file',
    description: '仅删除工作区内文件或空目录，会先写入恢复点；仅当确实需要删除目标时使用。',
    schema,
    func: async (input: { relativePath: string }) => {
      return JSON.stringify(fileService.deleteFile(input.relativePath), null, 2);
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
    const allowedTools = exaServer.allowedTools ?? [];
    const searchTool = tools.find((candidate) =>
      allowedTools.some((allowedName) => candidate.name === allowedName || candidate.name.endsWith(`__${allowedName}`))
    );
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
  webReadTool: DynamicStructuredTool<any, any, any, string>;
  researchSkillSources?: readonly string[];
  codeReviewSkillSources?: readonly string[];
}): RuntimeSubagent[] {
  const subagents: RuntimeSubagent[] = [];
  subagents.push({
    name: 'code-review',
    description: '审查代码改动，优先输出 bug、回归风险、边界条件与缺失验证。',
    systemPrompt:
      '你是 Roc 的代码审查子代理。只审查当前任务相关改动；先找 bug、回归风险和缺失验证，再给出简短结论。需要项目上下文时直接读取 /memory/。没有问题时返回空数组。',
    tools: [],
    skills: [...(input.codeReviewSkillSources ?? [])],
    responseFormat: z.object({
      findings: z.array(z.string()).describe('具体的 bug、回归点或缺陷，每条一项'),
      risks: z.array(z.string()).describe('边界条件与回归风险'),
      missing_verification: z.array(z.string()).describe('尚缺失、应补充的验证')
    })
  });
  subagents.push({
    name: 'research',
    description: '检索公开资料并读取网页，整理带来源边界的结论。',
    systemPrompt:
      '你是 Roc 的资料检索子代理。优先使用 web_read 读取来源原文，只输出与问题直接相关的结论，区分外部事实和你的判断，并标明哪些内容来自外部资料。',
    tools: [input.webReadTool],
    skills: [...(input.researchSkillSources ?? [])]
  });
  validateRuntimeSubagents(subagents);
  return subagents;
}

export function validateRuntimeSubagents(subagents: readonly RuntimeSubagent[]): void {
  const seen = new Set<string>();
  for (const subagent of subagents) {
    if (reservedSubagentNames.has(subagent.name)) {
      throw new Error(`subagent_name_reserved:${subagent.name}`);
    }
    if (seen.has(subagent.name)) {
      throw new Error(`subagent_name_duplicate:${subagent.name}`);
    }
    seen.add(subagent.name);
    if (subagent.description.trim().length === 0) {
      throw new Error(`subagent_description_empty:${subagent.name}`);
    }
    if ('graphId' in subagent && subagent.graphId.trim().length === 0) {
      throw new Error(`subagent_graph_id_empty:${subagent.name}`);
    }
  }
}
