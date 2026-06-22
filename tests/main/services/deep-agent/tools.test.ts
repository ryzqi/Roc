import { DynamicStructuredTool } from '@langchain/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AsyncSubAgent } from 'deepagents';
import { createRunSubagents, validateRuntimeSubagents } from '../../../../src/main/services/deep-agent/tools';

describe('deep agent runtime subagents', () => {
  it('defines focused prompts for code review and research subagents', () => {
    const webReadTool = new DynamicStructuredTool({
      name: 'web_read',
      description: 'test web read',
      schema: z.object({
        url: z.string()
      }),
      func: async () => ''
    });

    const subagents = createRunSubagents({ webReadTool });
    const codeReview = subagents.find((subagent) => subagent.name === 'code-review');
    const research = subagents.find((subagent) => subagent.name === 'research');

    expect(readSystemPrompt(codeReview)).toContain('只审查当前任务相关改动');
    expect(readSystemPrompt(codeReview)).toContain('没有问题时返回空数组');
    expect(readSystemPrompt(research)).toContain('优先使用 web_read 读取来源原文');
    expect(readSystemPrompt(research)).toContain('区分外部事实和你的判断');
  });

  it('accepts DeepAgents AsyncSubAgent definitions', () => {
    const asyncAgent: AsyncSubAgent = {
      name: 'remote-research',
      description: 'Run long research on an Agent Protocol server.',
      graphId: 'research_graph',
      url: 'http://127.0.0.1:2024'
    };

    expect(() => validateRuntimeSubagents([asyncAgent])).not.toThrow();
  });

  it('rejects async task tool name collisions', () => {
    expect(() =>
      validateRuntimeSubagents([
        {
          name: 'start_async_task',
          description: 'Invalid collision.',
          graphId: 'bad_graph'
        }
      ])
    ).toThrow('subagent_name_reserved:start_async_task');
  });
});

function readSystemPrompt(subagent: unknown): string | null {
  if (typeof subagent !== 'object' || subagent === null || !('systemPrompt' in subagent)) {
    return null;
  }
  const systemPrompt = Reflect.get(subagent, 'systemPrompt');
  return typeof systemPrompt === 'string' ? systemPrompt : null;
}
