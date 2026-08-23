import { describe, expect, it } from 'vitest';

import { buildPromptBlocks } from '../../../../../src/main/services/deep-agent/context/prompt-blocks';
import { serializePromptBlocks } from '../../../../../src/main/services/deep-agent/context/prompt-blocks';

const enabledCapabilities = {
  mcpServers: ['filesystem'],
  skills: ['typescript']
};

describe('prompt blocks', () => {
  it('builds production blocks in stable order', () => {
    const blocks = buildPromptBlocks({
      mode: 'run',
      enabledCapabilities,
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [
        {
          name: 'session_search',
          description: 'Search prior conversations'
        }
      ],
      explicitSkillContexts: [],
      referencedFileContexts: []
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

  it('keeps stable prompt block ordering independent of runtime context summaries', () => {
    const blocks = buildPromptBlocks({
      mode: 'run',
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [{ name: 'session_search', description: 'Search prior conversations' }],
      explicitSkillContexts: [],
      referencedFileContexts: []
    });

    expect(blocks.map((block) => block.type)).toEqual([
      'static',
      'workspace',
      'tools',
      'capability',
      'context_recall',
      'workflow'
    ]);
    expect(blocks.some((block) => block.content.includes('roc_context_digest'))).toBe(false);
  });

  it('serializes production prompt with block markers', () => {
    const prompt = serializePromptBlocks(
      buildPromptBlocks({
        mode: 'run',
        enabledCapabilities,
        workspacePath: 'F:\\Code\\Roc',
        workflowHint: null,
        tools: [
        {
          name: 'session_search',
          description: 'Search prior conversations'
        }
      ],
      explicitSkillContexts: [],
      referencedFileContexts: []
      })
    );

    expect(prompt).toContain('<!-- BLOCK:static:static:');
    expect(prompt).toContain('<!-- BLOCK:workspace:workspace:');
    expect(prompt).toContain('<!-- BLOCK:tools:capability:');
    expect(prompt).toContain('<!-- BLOCK:context_recall:workspace:');
    expect(prompt).toContain('session_search');
    expect(prompt).toContain('F:\\Code\\Roc');
    expect(prompt).toContain('write_file creates new files or fully replaces existing files. Use edit_file for targeted changes to existing files.');
  });

  it('formats tools without descriptions without leaking undefined into the prompt', () => {
    const prompt = serializePromptBlocks(
      buildPromptBlocks({
        mode: 'run',
        enabledCapabilities,
        workspacePath: 'F:\\Code\\Roc',
        workflowHint: null,
        tools: [
        {
          name: 'runtime_tool'
        }
      ],
      explicitSkillContexts: [],
      referencedFileContexts: []
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
      explicitSkillContexts: [],
      referencedFileContexts: []
    });

    const prompt = blocks.map((block) => block.content).join('\n');

    expect(prompt).toContain('Plan Mode');
    expect(prompt).toContain('Plan Mode blocks local mutation, execution, and task-commit tools while keeping read, search, and selected MCP tools available under MCP authorization policy.');
    expect(prompt).toContain('Use ls, read_file, glob, and grep for local inspection in Plan Mode.');
    expect(prompt).toContain('Use web_read for public web pages and web_search for current public search.');
    expect(prompt).toContain('Use selected MCP tools when the enabled MCP configuration provides relevant context or search capabilities.');
    expect(prompt).toContain('Use ask_user only for concise clarifying questions when needed.');
    expect(prompt).toContain('<proposed_plan>');
    expect(prompt).toContain('</proposed_plan>');
    expect(prompt).not.toContain('Use run_shell_command');
    expect(prompt).not.toContain('Do not call write_file');
    expect(prompt).not.toContain('Do not call edit_file');
    expect(prompt).not.toContain('Do not call delete_file');
    expect(prompt).not.toContain('Do not call run_shell_command');
    expect(prompt).not.toContain('write_file creates new files or fully replaces existing files.');
    expect(prompt).not.toContain('After write_file or edit_file');
  });

  it('does not add plan mode instructions for normal chat', () => {
    const blocks = buildPromptBlocks({
      mode: 'run',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      workflowHint: null,
      workspacePath: 'F:\\Code\\Roc',
      tools: [],
      explicitSkillContexts: [],
      referencedFileContexts: []
    });

    const prompt = blocks.map((block) => block.content).join('\n');

    expect(prompt).not.toContain('<proposed_plan>');
  });

  it('serializes explicit skills as an index without SKILL.md content', () => {
    const blocks = buildPromptBlocks({
      mode: 'run',
      enabledCapabilities: { mcpServers: [], skills: ['typescript'] },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [],
      explicitSkillContexts: [
        {
          id: 'typescript',
          name: 'typescript',
          path: '/skills/typescript/SKILL.md'
        }
      ],
      referencedFileContexts: []
    });

    const skillBlock = blocks.find((block) => block.type === 'explicit_skills');
    expect(skillBlock?.content).toContain('<skill_index>');
    expect(skillBlock?.content).toContain('<id>typescript</id>');
    expect(skillBlock?.content).toContain('<path>/skills/typescript/SKILL.md</path>');
    expect(skillBlock?.content).toContain('Read the SKILL.md file through the /skills/ route before applying it.');
    expect(skillBlock?.content).not.toContain('# TypeScript Skill');
  });

  it('keeps memory prompt model-actionable without explaining storage internals', () => {
    const blocks = buildPromptBlocks({
      mode: 'run',
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [],
      explicitSkillContexts: [],
      referencedFileContexts: []
    });
    const staticBlock = blocks.find((block) => block.type === 'static');

    expect(staticBlock?.content).toContain('/memory/global/USER.md');
    expect(staticBlock?.content).toContain('/memory/workspaces/current/MEMORY.md');
    expect(staticBlock?.content).toContain(
      'When the injected memory does not answer the question, call memory_search before guessing a memory path.'
    );
    expect(staticBlock?.content).toContain(
      'remember routes high-confidence direct user preferences to USER.md and every other accepted fact to the scoped MEMORY.md.'
    );
    expect(staticBlock?.content).toContain('AGENTS.md changes only through explicit file edits.');
    expect(staticBlock?.content).not.toContain('Roc SQLite');
    expect(staticBlock?.content).not.toContain('DeepAgents memory');
  });
});
