import type { ClientTool } from '@langchain/core/tools';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { z } from 'zod';
import type { ChatStartRunRequest } from '../../../shared/types';
import { RocDomainError } from '../errors';
import { RocToolResolutionError } from '../forge-guardrails';
import type { FileService } from '../file-service';
import type { McpService } from '../mcp-service';
import type { TaskService } from '../task-service';
import { WebReadService, type WebReadRequest } from '../web-read-service';
import { toWebSearchFailure } from './error-mapping';
import type { RuntimeSubagent } from './types';

export { createSessionSearchTool } from './tools/session-search-tool';

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

export function createReadBackgroundTaskTool(taskService: TaskService): DynamicStructuredTool<any, any, any, string> {
  const schema = z.strictObject({
    taskId: z.string().min(1).describe('要读取的后台任务 ID。')
  });
  return new DynamicStructuredTool<typeof schema, { taskId: string }, { taskId: string }, string>({
    name: 'read_background_task',
    description: [
      '读取一个后台任务的完整定义（goal、trigger、workspacePath、status、capabilities 等）。',
      '在 update_background_task / cancel_background_task 之前必须先调用本工具读取目标任务。'
    ].join('\n'),
    schema,
    func: async ({ taskId }) => {
      const task = taskService.findBackgroundTask(taskId);
      if (task === null) {
        throw new RocToolResolutionError(`Background task with id ${taskId} does not exist.`, {
          toolName: 'read_background_task'
        });
      }
      return JSON.stringify(task, null, 2);
    }
  });
}

export function createConfirmWithUserTool(): DynamicStructuredTool<any, any, any, string> {
  const schema = z.strictObject({
    summary: z
      .string()
      .min(1)
      .max(1000)
      .describe('用面向用户的语气总结刚才做了什么、任务的关键参数与下一步预期。')
  });
  return new DynamicStructuredTool<typeof schema, { summary: string }, { summary: string }, string>({
    name: 'confirm_with_user',
    description: [
      '在创建后台任务的最后一步调用，把刚才完成的工作总结成一句话给用户。',
      '这是工作流的终止信号；调用之后本轮 agent run 结束。'
    ].join('\n'),
    schema,
    func: async ({ summary }) => JSON.stringify({ ok: true, summary }, null, 2)
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
      '你是 Roc 的代码审查子代理。先找 bug、回归风险和缺失验证，再给出简短结论。需要项目上下文时直接读取 /memory/。',
    tools: [],
    skills: [...(input.codeReviewSkillSources ?? [])]
  });
  subagents.push({
    name: 'research',
    description: '检索公开资料并读取网页，整理带来源边界的结论。',
    systemPrompt:
      '你是 Roc 的资料检索子代理。优先使用 web_read 取证，只输出与问题直接相关的结论，并标明哪些内容来自外部资料。',
    tools: [input.webReadTool],
    skills: [...(input.researchSkillSources ?? [])]
  });
  return subagents;
}
