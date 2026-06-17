import { DynamicStructuredTool } from '@langchain/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRunSubagents } from '../../../../src/main/services/deep-agent/tools';

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

    expect(codeReview?.systemPrompt).toContain('只审查当前任务相关改动');
    expect(codeReview?.systemPrompt).toContain('没有问题时返回空数组');
    expect(research?.systemPrompt).toContain('优先使用 web_read 读取来源原文');
    expect(research?.systemPrompt).toContain('区分外部事实和你的判断');
  });
});
