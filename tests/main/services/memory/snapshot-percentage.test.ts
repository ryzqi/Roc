import { describe, it, expect } from 'vitest';
import { renderFrozenSnapshotWithPercentage } from '../../../../src/main/services/memory/snapshot';
import type { FrozenSnapshot } from '../../../../src/main/services/memory/snapshot';

describe('renderFrozenSnapshotWithPercentage', () => {
  it('应使用百分比渲染 usage', () => {
    const snapshot: FrozenSnapshot = {
      user: {
        kind: 'user' as const,
        filename: 'USER.md' as const,
        content: 'User preferences here',
        charCount: 250,
        charLimit: 500,
        source: 'global' as const,
        enabled: true
      },
      agents: {
        kind: 'agents' as const,
        filename: 'AGENTS.md' as const,
        content: '',
        charCount: 0,
        charLimit: 500,
        source: 'global' as const,
        enabled: true
      },
      memory: {
        kind: 'memory' as const,
        filename: 'MEMORY.md' as const,
        content: '',
        charCount: 0,
        charLimit: 1000,
        source: 'global' as const,
        enabled: true
      },
      totalChars: 250,
      totalLimit: 2000,
      globallyEnabled: true
    };

    const rendered = renderFrozenSnapshotWithPercentage(snapshot);
    expect(rendered).toContain('usage="50%"');
    expect(rendered).not.toContain('250/500');
  });

  it('微小字符数变化不应改变百分比', () => {
    const snapshot1: FrozenSnapshot = {
      user: {
        kind: 'user' as const,
        filename: 'USER.md' as const,
        content: 'Test',
        charCount: 234,
        charLimit: 500,
        source: 'global' as const,
        enabled: true
      },
      agents: {
        kind: 'agents' as const,
        filename: 'AGENTS.md' as const,
        content: '',
        charCount: 0,
        charLimit: 500,
        source: 'global' as const,
        enabled: true
      },
      memory: {
        kind: 'memory' as const,
        filename: 'MEMORY.md' as const,
        content: '',
        charCount: 0,
        charLimit: 1000,
        source: 'global' as const,
        enabled: true
      },
      totalChars: 234,
      totalLimit: 2000,
      globallyEnabled: true
    };

    const snapshot2: FrozenSnapshot = {
      user: {
        kind: 'user' as const,
        filename: 'USER.md' as const,
        content: 'Test',
        charCount: 238,
        charLimit: 500,
        source: 'global' as const,
        enabled: true
      },
      agents: {
        kind: 'agents' as const,
        filename: 'AGENTS.md' as const,
        content: '',
        charCount: 0,
        charLimit: 500,
        source: 'global' as const,
        enabled: true
      },
      memory: {
        kind: 'memory' as const,
        filename: 'MEMORY.md' as const,
        content: '',
        charCount: 0,
        charLimit: 1000,
        source: 'global' as const,
        enabled: true
      },
      totalChars: 238,
      totalLimit: 2000,
      globallyEnabled: true
    };

    const rendered1 = renderFrozenSnapshotWithPercentage(snapshot1);
    const rendered2 = renderFrozenSnapshotWithPercentage(snapshot2);

    expect(rendered1).toContain('usage="46%"');
    expect(rendered2).toContain('usage="47%"');
  });

  it('空快照应返回空字符串', () => {
    const snapshot: FrozenSnapshot = {
      user: {
        kind: 'user' as const,
        filename: 'USER.md' as const,
        content: '',
        charCount: 0,
        charLimit: 500,
        source: 'global' as const,
        enabled: false
      },
      agents: {
        kind: 'agents' as const,
        filename: 'AGENTS.md' as const,
        content: '',
        charCount: 0,
        charLimit: 500,
        source: 'global' as const,
        enabled: false
      },
      memory: {
        kind: 'memory' as const,
        filename: 'MEMORY.md' as const,
        content: '',
        charCount: 0,
        charLimit: 1000,
        source: 'global' as const,
        enabled: false
      },
      totalChars: 0,
      totalLimit: 2000,
      globallyEnabled: false
    };
    const rendered = renderFrozenSnapshotWithPercentage(snapshot);
    expect(rendered).toBe('');
  });
});
