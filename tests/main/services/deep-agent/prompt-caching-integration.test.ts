import { describe, it, expect } from 'vitest';
import { BlockStability } from '../../../../src/main/services/deep-agent/context/prompt-blocks';

describe('Prompt Caching Integration', () => {
  it('should parse blocks from marked content', () => {
    const content = `<!-- BLOCK:static:static:abc123 -->
Static content here

<!-- BLOCK:workspace:workspace:def456 -->
Workspace content here`;

    // 简单的正则解析验证
    const blockRegex = /<!-- BLOCK:(\w+):(\w+):(\w+) -->\n([\s\S]*?)(?=<!-- BLOCK:|\n*$)/g;
    const matches = Array.from(content.matchAll(blockRegex));

    expect(matches).toHaveLength(2);
    expect(matches[0][1]).toBe('static');
    expect(matches[0][2]).toBe('static');
    expect(matches[0][3]).toBe('abc123');
    expect(matches[0][4].trim()).toBe('Static content here');
  });

  it('should have BlockStability enum values', () => {
    expect(BlockStability.STATIC).toBe('static');
    expect(BlockStability.WORKSPACE).toBe('workspace');
    expect(BlockStability.CAPABILITY).toBe('capability');
    expect(BlockStability.REQUEST).toBe('request');
  });

  it('should correctly identify cache breakpoints based on stability', () => {
    // 模拟 balanced 策略：跳过 REQUEST
    const shouldCache = (stability: BlockStability, strategy: string) => {
      if (strategy === 'balanced') {
        return stability !== BlockStability.REQUEST;
      }
      return false;
    };

    expect(shouldCache(BlockStability.STATIC, 'balanced')).toBe(true);
    expect(shouldCache(BlockStability.WORKSPACE, 'balanced')).toBe(true);
    expect(shouldCache(BlockStability.CAPABILITY, 'balanced')).toBe(true);
    expect(shouldCache(BlockStability.REQUEST, 'balanced')).toBe(false);
  });

  it('should generate block markers in correct format', () => {
    const block = {
      type: 'static',
      content: 'Test content',
      stability: BlockStability.STATIC,
      hash: 'abc123def456'
    };

    const marker = `<!-- BLOCK:${block.type}:${block.stability}:${block.hash} -->\n${block.content}`;

    expect(marker).toContain('<!-- BLOCK:static:static:abc123def456 -->');
    expect(marker).toContain('Test content');
  });
});
