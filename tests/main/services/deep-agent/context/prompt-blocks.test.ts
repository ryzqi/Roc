import { describe, expect, it } from 'vitest';

import { buildPromptBlocks } from '../../../../../src/main/services/deep-agent/context/prompt-blocks';
import { serializePromptBlocks } from '../../../../../src/main/services/deep-agent/context/prompt-serialization';

const enabledCapabilities = {
  mcpServers: ['filesystem'],
  skills: ['typescript']
};

describe('prompt blocks', () => {
  it('builds production blocks in stable order', () => {
    const blocks = buildPromptBlocks({
      enabledCapabilities,
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [
        {
          name: 'session_search',
          description: 'Search prior conversations'
        }
      ]
    });

    expect(blocks.map((block) => block.type)).toEqual([
      'static',
      'workspace',
      'tools',
      'capability',
      'context_recall',
      'workflow'
    ]);
  });

  it('serializes production prompt with block markers', () => {
    const prompt = serializePromptBlocks(
      buildPromptBlocks({
        enabledCapabilities,
        workspacePath: 'F:\\Code\\Roc',
        workflowHint: null,
        tools: [
          {
            name: 'session_search',
            description: 'Search prior conversations'
          }
        ]
      })
    );

    expect(prompt).toContain('<!-- BLOCK:static:static:');
    expect(prompt).toContain('<!-- BLOCK:workspace:workspace:');
    expect(prompt).toContain('<!-- BLOCK:tools:capability:');
    expect(prompt).toContain('<!-- BLOCK:context_recall:workspace:');
    expect(prompt).toContain('session_search');
    expect(prompt).toContain('F:\\Code\\Roc');
  });

  it('formats tools without descriptions without leaking undefined into the prompt', () => {
    const prompt = serializePromptBlocks(
      buildPromptBlocks({
        enabledCapabilities,
        workspacePath: 'F:\\Code\\Roc',
        workflowHint: null,
        tools: [
          {
            name: 'runtime_tool'
          }
        ]
      })
    );

    expect(prompt).toContain('- runtime_tool');
    expect(prompt).not.toContain('undefined');
  });
});
