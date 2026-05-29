import { describe, expect, it } from 'vitest';
import { createRespondTool, RESPOND_TOOL_NAME } from '../../../../src/main/services/forge-guardrails/respond-tool';

describe('forge respond tool', () => {
  it('creates a synthetic respond tool', () => {
    const tool = createRespondTool();

    expect(tool.name).toBe(RESPOND_TOOL_NAME);
    expect(tool.description).toContain('自由文本');
  });

  it('validates message input', () => {
    const tool = createRespondTool();

    expect(tool.schema.parse({ message: 'x' })).toEqual({ message: 'x' });
    expect(() => tool.schema.parse({ message: '' })).toThrow();
    expect(() => tool.schema.parse({})).toThrow();
  });

  it('returns the original response message', async () => {
    const tool = createRespondTool();

    await expect(tool.invoke({ message: '完成' })).resolves.toBe('完成');
  });
});
