import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDeleteFileTool,
  createWebSearchTool,
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

afterEach(async () => {
  await services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('deep agent tools', () => {
  it('exposes clearer runtime tool descriptions', () => {
    const webReadService = {
      read: vi.fn().mockResolvedValue('page body')
    } as never;

    const webReadTool = createWebReadTool(webReadService);
    const deleteFileTool = createDeleteFileTool({
      deleteFile: vi.fn().mockReturnValue({
        relativePath: 'notes.md',
        recoveryPoint: {
          id: 'recovery-1',
          relativePath: 'notes.md',
          snapshotPath: 'snapshot',
          contentSha256: 'sha',
          source: 'agent.delete_file',
          createdAt: '2026-05-14T00:00:00.000Z',
          restored: false
        }
      })
    } as never);

    expect(webReadTool.description).toBe('读取公开网页正文，返回适合继续分析的文本内容。');
    expect(deleteFileTool.description).toContain('仅删除工作区内文件');
  });

  it('creates a delete_file tool that delegates to FileService.deleteFile', async () => {
    const deleteFile = vi.fn().mockReturnValue({
      relativePath: 'notes.md',
      recoveryPoint: {
        id: 'recovery-1',
        relativePath: 'notes.md',
        snapshotPath: 'snapshot',
        contentSha256: 'sha',
        source: 'agent.delete_file',
        createdAt: '2026-05-14T00:00:00.000Z',
        restored: false
      }
    });

    const tool = createDeleteFileTool({ deleteFile } as never);
    const result = await tool.invoke({ relativePath: 'notes.md' });

    expect(deleteFile).toHaveBeenCalledWith('notes.md');
    expect(result).toContain('"relativePath": "notes.md"');
    expect(result).toContain('"source": "agent.delete_file"');
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
      webReadTool: stubTool
    });

    expect(subagents).toContainEqual(
      expect.objectContaining({
        name: 'code-review',
        description: '审查代码改动，优先输出 bug、回归风险、边界条件与缺失验证。',
        systemPrompt:
          '你是 Roc 的代码审查子代理。先找 bug、回归风险和缺失验证，再给出简短结论。需要项目上下文时直接读取 /memory/。'
      })
    );
    expect(subagents).toContainEqual(
      expect.objectContaining({
        name: 'research',
        description: '检索公开资料并读取网页，整理带来源边界的结论。',
        systemPrompt:
          '你是 Roc 的资料检索子代理。优先使用 web_read 取证，只输出与问题直接相关的结论，并标明哪些内容来自外部资料。'
      })
    );
  });

  it('gives the code-review subagent a structured responseFormat schema', () => {
    const stubTool = {
      name: 'stub',
      description: 'stub',
      schema: z.object({}),
      invoke: vi.fn(),
      func: vi.fn()
    } as never;

    const subagents = createRunSubagents({ webReadTool: stubTool });
    const codeReview = subagents.find((subagent) => subagent.name === 'code-review');

    expect(codeReview?.responseFormat).toBeDefined();
    const schema = codeReview?.responseFormat as z.ZodTypeAny;

    // 合法结构：三个字符串数组字段
    expect(
      schema.safeParse({ findings: ['空指针解引用'], risks: ['并发写入未加锁'], missing_verification: ['缺少超时分支测试'] }).success
    ).toBe(true);

    // 非法结构：字段类型错误必须被拒
    expect(schema.safeParse({ findings: 'not-an-array', risks: [], missing_verification: [] }).success).toBe(false);
    // 缺字段必须被拒
    expect(schema.safeParse({ findings: ['x'] }).success).toBe(false);

    // research 子代理保持自由文本（无 responseFormat）
    const research = subagents.find((subagent) => subagent.name === 'research');
    expect(research?.responseFormat).toBeUndefined();
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
