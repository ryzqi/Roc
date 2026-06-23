import { describe, expect, it } from 'vitest';
import { BlockStability, buildPromptBlocks, serializePromptBlocks } from '../../../../src/main/services/deep-agent/prompt-builder';

describe('prompt-builder compatibility exports', () => {
  it('re-exports the production prompt block builder', () => {
    const blocks = buildPromptBlocks({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\TestProject',
      workflowHint: null,
      tools: []
    });

    expect(blocks.map((block) => block.type)).toEqual([
      'static',
      'workspace',
      'tools',
      'capability',
      'context_recall',
      'workflow'
    ]);
    expect(blocks[0].stability).toBe(BlockStability.STATIC);
    expect(blocks[1].stability).toBe(BlockStability.WORKSPACE);
    expect(blocks[2].stability).toBe(BlockStability.CAPABILITY);
    expect(blocks[5].stability).toBe(BlockStability.REQUEST);
  });

  it('serializes block markers through the compatibility export', () => {
    const prompt = serializePromptBlocks(
      buildPromptBlocks({
        enabledCapabilities: { mcpServers: [], skills: [] },
        workspacePath: 'F:\\Code\\Roc',
        workflowHint: null,
        tools: []
      })
    );

    expect(prompt).toContain('<!-- BLOCK:static:static:');
    expect(prompt).toContain('<!-- BLOCK:workspace:workspace:');
    expect(prompt).toContain('DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, and /skills/.');
  });
});
