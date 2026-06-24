import { describe, expect, it } from 'vitest';

import { assembleContextHarness } from '../../../../../src/main/services/deep-agent/context/context-assembler';

describe('assembleContextHarness', () => {
  it('adds session_search and serializes prompt markers', () => {
    const harness = assembleContextHarness({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workflowHint: null,
      workspacePath: 'F:\\Code\\Roc',
      memorySources: ['/memory/global/AGENTS.md'],
      baseTools: [],
      searchSessions: () => ({ query: 'x', total: 0, items: [] })
    });

    expect(harness.tools.map(tool => tool.name)).toContain('session_search');
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
      enabledCapabilities: { mcpServers: [], skills: ['typescript'] },
      workflowHint: null,
      workspacePath: null,
      memorySources: [],
      baseTools: [],
      searchSessions: () => ({ query: 'x', total: 0, items: [] })
    });

    expect(harness.skillSources).toEqual(['/skills/']);
  });
});
