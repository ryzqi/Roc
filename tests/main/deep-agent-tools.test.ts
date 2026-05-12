import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createWebSearchTool,
  createMemoryGetTool,
  createMemorySearchTool,
  createRunSubagents,
  createWebReadTool
} from '../../src/main/services/deep-agent/tools';
import { createAppServices } from '../../src/main/services/app-service';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RocDomainError } from '../../src/main/services/errors';

const mocked = vi.hoisted(() => ({
  getToolsMock: vi.fn(),
  closeMock: vi.fn()
}));

vi.mock('@langchain/mcp-adapters', () => {
  class MultiServerMCPClientMock {
    getTools = mocked.getToolsMock;
    close = mocked.closeMock;
  }
  return {
    MultiServerMCPClient: MultiServerMCPClientMock
  };
});

let root: string;
let services: ReturnType<typeof createAppServices>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-deep-agent-tools-'));
  services = createAppServices(root);
  services.appService.initialize();
  mocked.getToolsMock.mockReset();
  mocked.closeMock.mockReset();
  mocked.closeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('deep agent tools', () => {
  it('exposes clearer runtime tool descriptions', () => {
    const memoryService = {
      search: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue('# memory')
    } as never;
    const webReadService = {
      read: vi.fn().mockResolvedValue('page body')
    } as never;

    const webReadTool = createWebReadTool(webReadService);
    const memorySearchTool = createMemorySearchTool(memoryService);
    const memoryGetTool = createMemoryGetTool(memoryService);

    expect(webReadTool.description).toBe('读取公开网页正文，返回适合继续分析的文本内容。');
    expect(memorySearchTool.description).toBe('检索 Roc 长期记忆与会话回忆，返回相关条目摘要列表。');
    expect(memoryGetTool.description).toBe('读取指定 Roc 记忆条目的 Markdown 原文。');
  });

  it('builds subagents with explicit operating prompts', () => {
    const stubTool = {
      name: 'stub',
      description: 'stub',
      schema: z.object({}),
      invoke: vi.fn(),
      func: vi.fn()
    } as never;

    const subagents = createRunSubagents({
      memoryGetTool: stubTool,
      memorySearchTool: stubTool,
      webReadTool: stubTool
    });

    expect(subagents).toContainEqual(
      expect.objectContaining({
        name: 'code-review',
        description: '审查代码改动，优先输出 bug、回归风险、边界条件与缺失验证。',
        systemPrompt:
          '你是 Roc 的代码审查子代理。先找 bug、行为回归、风险和缺失验证，再给出简短结论。不要改写需求，不要淡化风险。需要项目上下文时，先使用 memory_search 和 memory_get。'
      })
    );
    expect(subagents).toContainEqual(
      expect.objectContaining({
        name: 'research',
        description: '检索公开资料并读取网页，整理带来源边界的结论。',
        systemPrompt:
          '你是 Roc 的资料检索子代理。优先使用 web_read 收集外部证据，只输出与问题直接相关的结论，并明确哪些信息来自外部资料且仍需核实。'
      })
    );
  });

  it('normalizes the Exa search tool when the server exposes only web_search_exa', async () => {
    services.mcpService.setServerEnabled(services.mcpService.ensureExaPreset().id, true);
    mocked.getToolsMock.mockResolvedValue([
      {
        name: 'web_search_exa',
        description: 'Search the public web via Exa.',
        schema: z.object({ query: z.string() }),
        invoke: vi.fn().mockResolvedValue('exa')
      }
    ]);

    const tool = await createWebSearchTool({
      mcpService: services.mcpService,
      enabledCapabilities: {
        mcpServers: ['exa-hosted'],
        skills: []
      },
      closers: []
    });

    expect(tool).not.toBeNull();
    expect(tool?.name).toBe('web_search');
    expect(tool?.description).toBe('搜索公开网络信息，返回适合继续检索的结果列表。');
  });

  it('normalizes the Exa search tool when the server exposes only web_search_advanced_exa', async () => {
    services.mcpService.setServerEnabled(services.mcpService.ensureExaPreset().id, true);
    mocked.getToolsMock.mockResolvedValue([
      {
        name: 'web_search_advanced_exa',
        description: 'Advanced Exa search.',
        schema: z.object({ query: z.string() }),
        invoke: vi.fn().mockResolvedValue('advanced')
      }
    ]);

    const tool = await createWebSearchTool({
      mcpService: services.mcpService,
      enabledCapabilities: {
        mcpServers: ['exa-hosted'],
        skills: []
      },
      closers: []
    });

    expect(tool?.name).toBe('web_search');
  });

  it('prefers a tool whose name still maps to an allowed Exa search capability when the MCP adapter prefixes it', async () => {
    services.mcpService.setServerEnabled(services.mcpService.ensureExaPreset().id, true);
    mocked.getToolsMock.mockResolvedValue([
      {
        name: 'exa-hosted__web_search_advanced_exa',
        description: 'Prefixed advanced Exa search.',
        schema: z.object({ query: z.string() }),
        invoke: vi.fn().mockResolvedValue('prefixed')
      }
    ]);

    const tool = await createWebSearchTool({
      mcpService: services.mcpService,
      enabledCapabilities: {
        mcpServers: ['exa-hosted'],
        skills: []
      },
      closers: []
    });

    expect(tool?.name).toBe('web_search');
  });

  it('fails with a clear domain error when Exa is enabled but no allowed search tool is exposed', async () => {
    services.mcpService.setServerEnabled(services.mcpService.ensureExaPreset().id, true);
    mocked.getToolsMock.mockResolvedValue([
      {
        name: 'exa-hosted__different_tool',
        description: 'Unexpected tool',
        schema: z.object({}),
        invoke: vi.fn()
      }
    ]);

    await expect(
      createWebSearchTool({
        mcpService: services.mcpService,
        enabledCapabilities: {
          mcpServers: ['exa-hosted'],
          skills: []
        },
        closers: []
      })
    ).rejects.toMatchObject({
      code: 'web_search_tool_missing',
      message: 'Exa Hosted MCP 未暴露 web_search 工具。'
    });
  });
});
