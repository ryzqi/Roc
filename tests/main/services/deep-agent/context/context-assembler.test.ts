import { describe, expect, it } from 'vitest';

import { assembleContextHarness } from '../../../../../src/main/services/deep-agent/context/context-assembler';

describe('assembleContextHarness', () => {
  it('adds session_search and serializes prompt markers', () => {
    const harness = assembleContextHarness({
      artifactStore: {} as never,
      mode: 'run',
      enabledCapabilities: { mcpServers: [], skills: [] },
      workflowHint: null,
      workspacePath: 'F:\\Code\\Roc',
      memorySources: ['/memory/global/AGENTS.md'],
      baseTools: [],
      searchSessions: () => ({ query: 'x', total: 0, items: [] }),
      threadId: 'thread_context_assembler',
      explicitSkillContexts: []
    });

    expect(harness.tools.map(tool => tool.name)).toEqual(['session_search', 'read_context_artifact']);
    expect(harness.systemPrompt).toContain('<!-- BLOCK:static:static:');
    expect(harness.systemPrompt).toContain('<!-- BLOCK:context_recall:workspace:');
    expect(harness.skillSources).toEqual([]);
    expect(harness.memorySources).toEqual(['/memory/global/AGENTS.md']);
    expect(harness.workspaceIdentity).toMatchObject({
      path: 'F:\\Code\\Roc'
    });
  });

  it('exposes selected skills through /skills/', () => {
    const harness = assembleContextHarness({
      artifactStore: {} as never,
      mode: 'run',
      enabledCapabilities: { mcpServers: [], skills: ['typescript'] },
      workflowHint: null,
      workspacePath: null,
      memorySources: [],
      baseTools: [],
      searchSessions: () => ({ query: 'x', total: 0, items: [] }),
      threadId: 'thread_context_assembler_skills',
      explicitSkillContexts: []
    });

    expect(harness.skillSources).toEqual(['/skills/']);
  });

  it('keeps explicit skill prompt context compact while exposing /skills/', () => {
    const harness = assembleContextHarness({
      artifactStore: {} as never,
      mode: 'run',
      enabledCapabilities: { mcpServers: [], skills: ['typescript'] },
      workflowHint: null,
      workspacePath: 'F:\\Code\\Roc',
      memorySources: [],
      baseTools: [],
      searchSessions: () => ({ query: 'x', total: 0, items: [] }),
      threadId: 'thread_context_assembler_explicit',
      explicitSkillContexts: [
        {
          id: 'typescript',
          name: 'typescript',
          path: '/skills/typescript/SKILL.md'
        }
      ]
    });

    expect(harness.skillSources).toEqual(['/skills/']);
    expect(harness.systemPrompt).toContain('<skill_index>');
    expect(harness.systemPrompt).toContain('/skills/typescript/SKILL.md');
    expect(harness.systemPrompt).not.toContain('# TypeScript Skill');
  });
});
