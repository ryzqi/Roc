import { describe, expect, it } from 'vitest';

import { assembleContextHarness } from '../../../../../src/main/services/deep-agent/context/context-assembler';

describe('assembleContextHarness', () => {
  it('adds recall and remember tools and serializes prompt markers', () => {
    const harness = assembleContextHarness({
      artifactStore: {} as never,
      mode: 'run',
      enabledCapabilities: { mcpServers: [], skills: [] },
      workflowHint: null,
      workspacePath: 'F:\\Code\\Roc',
      memorySources: ['/memory/global/AGENTS.md'],
      baseTools: [],
      searchSessions: () => ({ query: 'x', total: 0, items: [] }),
      searchMemory: () => ({ query: 'x', hits: [], scannedDocuments: 0, scannedEntries: 0 }),
      remember: () => ({
        status: 'accepted' as const,
        reason: 'accepted',
        scope: 'global' as const,
        targetPath: '/memory/global/USER.md',
        archivedTo: []
      }),
      runId: 'run_context_assembler',
      threadId: 'thread_context_assembler',
      explicitSkillContexts: [],
      referencedFileContexts: []
    });

    expect(harness.tools.map(tool => tool.name)).toEqual([
      'session_search',
      'memory_search',
      'remember',
      'read_context_artifact'
    ]);
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
      searchMemory: () => ({ query: 'x', hits: [], scannedDocuments: 0, scannedEntries: 0 }),
      remember: () => ({
        status: 'accepted' as const,
        reason: 'accepted',
        scope: 'global' as const,
        targetPath: '/memory/global/USER.md',
        archivedTo: []
      }),
      runId: 'run_context_assembler',
      threadId: 'thread_context_assembler_skills',
      explicitSkillContexts: [],
      referencedFileContexts: []
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
      searchMemory: () => ({ query: 'x', hits: [], scannedDocuments: 0, scannedEntries: 0 }),
      remember: () => ({
        status: 'accepted' as const,
        reason: 'accepted',
        scope: 'global' as const,
        targetPath: '/memory/global/USER.md',
        archivedTo: []
      }),
      runId: 'run_context_assembler',
      threadId: 'thread_context_assembler_explicit',
      explicitSkillContexts: [
        {
          id: 'typescript',
          name: 'typescript',
          path: '/skills/typescript/SKILL.md'
        }
      ],
      referencedFileContexts: []
    });

    expect(harness.skillSources).toEqual(['/skills/']);
    expect(harness.systemPrompt).toContain('<skill_index>');
    expect(harness.systemPrompt).toContain('/skills/typescript/SKILL.md');
    expect(harness.systemPrompt).not.toContain('# TypeScript Skill');
  });

  it('exposes /skills/ for explicit skills even when no capability skill is selected', () => {
    const harness = assembleContextHarness({
      artifactStore: {} as never,
      mode: 'run',
      enabledCapabilities: { mcpServers: [], skills: [] },
      workflowHint: null,
      workspacePath: 'F:\\Code\\Roc',
      memorySources: [],
      baseTools: [],
      searchSessions: () => ({ query: 'x', total: 0, items: [] }),
      searchMemory: () => ({ query: 'x', hits: [], scannedDocuments: 0, scannedEntries: 0 }),
      remember: () => ({
        status: 'accepted' as const,
        reason: 'accepted',
        scope: 'global' as const,
        targetPath: '/memory/global/USER.md',
        archivedTo: []
      }),
      runId: 'run_context_assembler',
      threadId: 'thread_context_assembler_explicit_only',
      explicitSkillContexts: [
        {
          id: 'tdd',
          name: 'tdd',
          path: '/skills/tdd/SKILL.md'
        }
      ],
      referencedFileContexts: []
    });

    expect(harness.skillSources).toEqual(['/skills/']);
  });

  it('injects a referenced files block only when the request carries @ references', () => {
    const withReferences = assembleContextHarness({
      artifactStore: {} as never,
      mode: 'run',
      enabledCapabilities: { mcpServers: [], skills: [] },
      workflowHint: null,
      workspacePath: 'F:\\Code\\Roc',
      memorySources: [],
      baseTools: [],
      searchSessions: () => ({ query: 'x', total: 0, items: [] }),
      searchMemory: () => ({ query: 'x', hits: [], scannedDocuments: 0, scannedEntries: 0 }),
      remember: () => ({
        status: 'accepted' as const,
        reason: 'accepted',
        scope: 'global' as const,
        targetPath: '/memory/global/USER.md',
        archivedTo: []
      }),
      runId: 'run_context_assembler',
      threadId: 'thread_context_assembler_referenced',
      explicitSkillContexts: [],
      referencedFileContexts: [{ path: 'src/renderer/chat/chat-composer.tsx' }]
    });

    expect(withReferences.systemPrompt).toContain('<!-- BLOCK:referenced_files:request:');
    expect(withReferences.systemPrompt).toContain('<path>src/renderer/chat/chat-composer.tsx</path>');
  });
});
