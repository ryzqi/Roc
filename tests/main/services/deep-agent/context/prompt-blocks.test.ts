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
      mode: 'chat',
      enabledCapabilities,
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [
        {
          name: 'session_search',
          description: 'Search prior conversations'
        }
      ],
      explicitSkillContexts: []
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
        mode: 'chat',
        enabledCapabilities,
        workspacePath: 'F:\\Code\\Roc',
        workflowHint: null,
        tools: [
        {
          name: 'session_search',
          description: 'Search prior conversations'
        }
      ],
      explicitSkillContexts: []
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
        mode: 'chat',
        enabledCapabilities,
        workspacePath: 'F:\\Code\\Roc',
        workflowHint: null,
        tools: [
        {
          name: 'runtime_tool'
        }
      ],
      explicitSkillContexts: []
    })
    );

    expect(prompt).toContain('- runtime_tool');
    expect(prompt).not.toContain('undefined');
  });

  it('adds plan mode instructions when request mode is plan', () => {
    const blocks = buildPromptBlocks({
      mode: 'plan',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      workflowHint: null,
      workspacePath: 'F:\\Code\\Roc',
      tools: [],
      explicitSkillContexts: []
    });

    const prompt = blocks.map((block) => block.content).join('\n');

    expect(prompt).toContain('Plan Mode');
    expect(prompt).toContain('<proposed_plan>');
    expect(prompt).toContain('</proposed_plan>');
    expect(prompt).not.toContain('Use run_shell_command');
    expect(prompt).not.toContain('After write_file or edit_file');
  });

  it('does not add plan mode instructions for normal chat', () => {
    const blocks = buildPromptBlocks({
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      workflowHint: null,
      workspacePath: 'F:\\Code\\Roc',
      tools: [],
      explicitSkillContexts: []
    });

    const prompt = blocks.map((block) => block.content).join('\n');

    expect(prompt).not.toContain('<proposed_plan>');
  });
});
