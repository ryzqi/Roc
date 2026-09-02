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
    expect(prompt).toContain('write_file creates or replaces a file; use edit_file for targeted changes.');
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
    expect(prompt).toContain('Plan Mode is read-only: no local mutation, execution, or task commits. Read/search and authorized MCP remain available.');
    expect(prompt).toContain('Use ls, read_file, glob, grep, web_read, web_search, and authorized MCP tools as applicable.');
    expect(prompt).toContain('Use ask_user only for a concise clarification.');
    expect(prompt).toContain('<proposed_plan>');
    expect(prompt).toContain('</proposed_plan>');
    expect(prompt).not.toContain('Use run_shell_command');
    expect(prompt).not.toContain('Do not call write_file');
    expect(prompt).not.toContain('Do not call edit_file');
    expect(prompt).not.toContain('Do not call delete_file');
    expect(prompt).not.toContain('Do not call run_shell_command');
    expect(prompt).not.toContain('write_file creates or replaces a file; use edit_file for targeted changes.');
    expect(prompt).not.toContain('After write_file or edit_file');
    // Plan Mode 不绑定 remember / write_file / edit_file：提示模型使用未绑定工具会诱发工具名幻觉。
    expect(prompt).not.toContain('Use remember for one durable fact.');
    expect(prompt).not.toContain('High-confidence user preferences go to USER.md');
    expect(prompt).not.toContain('Use edit_file/write_file on memory paths for manual restructuring');
    expect(prompt).not.toContain('On capacity overflow, read the file');
    expect(prompt).not.toContain('Change AGENTS.md only through explicit file edits.');
    // 只读的记忆检索指令必须保留：Plan Mode 仍绑定 memory_search。
    expect(prompt).toContain('If injected memory is insufficient, call memory_search before guessing a path.');
    expect(prompt).toContain('Read SKILL.md silently; never quote, paraphrase, or summarize it.');
  });

  it('keeps memory write instructions in run mode where the write tools are actually bound', () => {
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

    expect(prompt).toContain('Use remember for one durable fact.');
    expect(prompt).toContain(
      'Use edit_file/write_file for memory restructuring or corrections. On capacity overflow, merge entries or move detail to a topic file and keep one index line.'
    );
    expect(prompt).toContain(
      'Use edit_file/write_file for memory restructuring or corrections. On capacity overflow, merge entries or move detail to a topic file and keep one index line.'
    );
    expect(prompt).toContain('Change AGENTS.md only through explicit file edits.');
    // Roc 里不存在名为 Edit / Write 的工具，提示词不得再出现这些名字。
    expect(prompt).not.toContain('Use Edit/Write on memory paths');
    expect(prompt).not.toContain('merge redundant entries via Edit ');
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
    expect(skillBlock?.content).toContain('Read SKILL.md through /skills/ before applying it.');
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
      'If injected memory is insufficient, call memory_search before guessing a path.'
    );
    expect(staticBlock?.content).toContain(
      'High-confidence user preferences go to USER.md; other accepted facts go to scoped MEMORY.md.'
    );
    expect(staticBlock?.content).toContain('Change AGENTS.md only through explicit file edits.');
    expect(staticBlock?.content).not.toContain('Roc SQLite');
    expect(staticBlock?.content).not.toContain('DeepAgents memory');
  });

  it('adds the self config block only when roc_self_config is bound', () => {
    const withTool = buildPromptBlocks({
      mode: 'run',
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [{ name: 'roc_self_config', description: 'Inspect Roc own configuration' }],
      explicitSkillContexts: [],
      referencedFileContexts: []
    });
    const withoutTool = buildPromptBlocks({
      mode: 'run',
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [{ name: 'session_search', description: 'Search prior conversations' }],
      explicitSkillContexts: [],
      referencedFileContexts: []
    });

    expect(withTool.map((block) => block.type)).toEqual([
      'static',
      'workspace',
      'tools',
      'capability',
      'self_config',
      'context_recall',
      'workflow'
    ]);
    const selfConfigBlock = withTool.find((block) => block.type === 'self_config');
    expect(selfConfigBlock?.stability).toBe('capability');
    expect(selfConfigBlock?.content).toContain('%USERPROFILE%\\.roc');
    expect(selfConfigBlock?.content).toContain('hooks.json');
    expect(selfConfigBlock?.content).toContain('timeoutSeconds');
    expect(selfConfigBlock?.content).toContain('cmd.exe');
    expect(selfConfigBlock?.content).toContain('roc_self_config never writes configuration.');
    expect(withoutTool.some((block) => block.type === 'self_config')).toBe(false);
  });
});
