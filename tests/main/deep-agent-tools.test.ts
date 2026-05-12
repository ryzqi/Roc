import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createMemoryGetTool,
  createMemorySearchTool,
  createRunSubagents,
  createWebReadTool
} from '../../src/main/services/deep-agent/tools';

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
});
