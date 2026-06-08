import { describe, it, expect } from 'vitest';
import { SystemPromptBuilder, BlockStability } from '../../../../src/main/services/deep-agent/prompt-builder';
import type { FrozenSnapshot, FrozenSnapshotPart } from '../../../../src/main/services/memory/snapshot';

function createFrozenSnapshotPart(input: {
  kind: FrozenSnapshotPart['kind'];
  filename: FrozenSnapshotPart['filename'];
}): FrozenSnapshotPart {
  return {
    kind: input.kind,
    filename: input.filename,
    content: '',
    charCount: 0,
    charLimit: 100,
    source: 'global',
    enabled: true
  };
}

function createFrozenSnapshot(): FrozenSnapshot {
  return {
    user: createFrozenSnapshotPart({ kind: 'user', filename: 'USER.md' }),
    agents: createFrozenSnapshotPart({ kind: 'agents', filename: 'AGENTS.md' }),
    memory: createFrozenSnapshotPart({ kind: 'memory', filename: 'MEMORY.md' }),
    totalChars: 0,
    totalLimit: 300,
    globallyEnabled: true
  };
}

describe('SystemPromptBuilder', () => {
  it('应构建 5 层 Block 结构', () => {
    const blocks = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\TestProject',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    expect(blocks).toHaveLength(5);
    expect(blocks[0].type).toBe('static');
    expect(blocks[1].type).toBe('workspace');
    expect(blocks[2].type).toBe('tools');
    expect(blocks[3].type).toBe('snapshot');
    expect(blocks[4].type).toBe('capability');
  });

  it('应为每个 Block 生成稳定的哈希', () => {
    const blocks1 = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: ['exa'], skills: [] },
      workspacePath: 'F:\\Code\\TestProject',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    const blocks2 = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: ['exa'], skills: [] },
      workspacePath: 'F:\\Code\\TestProject',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    expect(blocks1[0].hash).toBe(blocks2[0].hash);
    expect(blocks1[1].hash).toBe(blocks2[1].hash);
  });

  it('工作区路径变化应改变 WorkspaceBlock 哈希', () => {
    const blocks1 = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Project1',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    const blocks2 = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Project2',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    expect(blocks1[1].hash).not.toBe(blocks2[1].hash);
    expect(blocks1[0].hash).toBe(blocks2[0].hash);
  });

  it('应正确设置稳定性级别', () => {
    const blocks = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\TestProject',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    expect(blocks[0].stability).toBe(BlockStability.STATIC);
    expect(blocks[1].stability).toBe(BlockStability.WORKSPACE);
    expect(blocks[2].stability).toBe(BlockStability.CAPABILITY);
    expect(blocks[3].stability).toBe(BlockStability.SESSION);
    expect(blocks[4].stability).toBe(BlockStability.CAPABILITY);
  });
});
