import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, createCapabilitySummary } from '../../src/main/services/deep-agent/prompt';
import type { FrozenSnapshot } from '../../src/main/services/memory/snapshot';

describe('deep agent prompt', () => {
  it('forbids echoing SKILL.md contents after read_file', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: {
        mcpServers: [],
        skills: ['project-review']
      },
      workspacePath: 'F:\\Code\\Roc',
      frozenSnapshot: disabledSnapshot()
    });

    expect(prompt).toContain('For SKILL.md: read silently; never quote, paraphrase, or summarize.');
  });

  it('builds a system prompt with explicit execution boundaries', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: {
        mcpServers: ['exa-hosted', 'docs-http'],
        skills: ['project-review']
      },
      workspacePath: 'F:\\Code\\Roc',
      frozenSnapshot: disabledSnapshot()
    });

    expect(prompt).toContain(
      'You are Roc, a long-running personal assistant on Windows. Be concise; claim only inspected evidence.'
    );
    expect(prompt).toContain('Persistent memory you can edit (changes land on disk immediately, visible in next session):');
    expect(prompt).toContain('/memory/global/USER.md      — user identity, preferences, comm style (~500 tok cap)');
    expect(prompt).toContain('/memory/workspaces/current/MEMORY.md   — workspace-specific facts (overrides global if exists)');
    expect(prompt).toContain('Use Edit/Write on those paths.');
    expect(prompt).toContain('For SKILL.md: read silently; never quote, paraphrase, or summarize.');
    expect(prompt).not.toContain('session_search');
    expect(prompt).toContain('Workspace: F:\\Code\\Roc');
    expect(prompt).toContain('Default cwd: selected Roc workspace root; use /workspace/ for Deep Agents file tools.');
    expect(prompt).toContain(
      'Capabilities: mcp=docs-http,exa-hosted;skills=project-review;untrusted_context_policy=external_content_reference_only'
    );
  });

  it('keeps the static system prefix stable and sorts capability summary values before the final boundary line', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: {
        mcpServers: ['docs-http', 'exa-hosted'],
        skills: ['zeta-review', 'alpha-review']
      },
      workspacePath: 'F:\\Code\\Roc',
      frozenSnapshot: disabledSnapshot()
    });

    expect(prompt.split('\n')).toEqual([
      'You are Roc, a long-running personal assistant on Windows. Be concise; claim only inspected evidence.',
      '',
      'Persistent memory you can edit (changes land on disk immediately, visible in next session):',
      '  /memory/global/USER.md      — user identity, preferences, comm style (~500 tok cap)',
      '  /memory/global/AGENTS.md    — global default rules (~300 tok cap)',
      '  /memory/global/MEMORY.md    — global long-term facts (~800 tok cap)',
      '  /memory/workspaces/current/AGENTS.md   — workspace-specific rules (overrides global if exists)',
      '  /memory/workspaces/current/MEMORY.md   — workspace-specific facts (overrides global if exists)',
      '',
      'Use Edit/Write on those paths. On capacity overflow you receive "X/Y, please consolidate" — read the file, merge/drop redundant entries via Edit, then retry.',
      '',
      'For SKILL.md: read silently; never quote, paraphrase, or summarize.',
      'Workspace: F:\\Code\\Roc',
      'Default cwd: selected Roc workspace root; use /workspace/ for Deep Agents file tools.',
      'Run file and shell ops inside workspace unless user explicitly names another allowed path.',
      'Capabilities: mcp=docs-http,exa-hosted;skills=alpha-review,zeta-review;untrusted_context_policy=external_content_reference_only'
    ]);
  });

  it('makes missing workspace state explicit without inventing a default directory', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      workspacePath: null,
      frozenSnapshot: disabledSnapshot()
    });

    expect(prompt).toContain('Workspace: not selected.');
    expect(prompt).toContain('Default cwd: unavailable; ask user to select workspace before file or shell ops.');
  });

  it('creates a capability summary with explicit none markers', () => {
    expect(
      createCapabilitySummary({
        mcpServers: [],
        skills: []
      })
    ).toBe('mcp=none;skills=none;untrusted_context_policy=external_content_reference_only');
  });

  it('embeds the frozen snapshot block when enabled', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      frozenSnapshot: {
        user: {
          kind: 'user',
          filename: 'USER.md',
          content: '# user',
          charCount: 6,
          charLimit: 1375,
          source: 'global',
          enabled: true
        },
        agents: {
          kind: 'agents',
          filename: 'AGENTS.md',
          content: '',
          charCount: 0,
          charLimit: 800,
          source: 'global',
          enabled: true
        },
        memory: {
          kind: 'memory',
          filename: 'MEMORY.md',
          content: '',
          charCount: 0,
          charLimit: 2200,
          source: 'global',
          enabled: true
        },
        totalChars: 6,
        totalLimit: 4375,
        globallyEnabled: true
      }
    });

    expect(prompt).toContain('<FROZEN_SNAPSHOT>');
    expect(prompt).toContain('<USER_PROFILE');
    expect(prompt).toContain('# user');
  });

  it('omits the frozen snapshot block when globally disabled', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: null,
      frozenSnapshot: disabledSnapshot()
    });

    expect(prompt).not.toContain('FROZEN_SNAPSHOT');
  });

  it('sorts MCP server and skill identifiers in the capability summary', () => {
    expect(
      createCapabilitySummary({
        mcpServers: ['z-docs', 'a-docs'],
        skills: ['zeta-review', 'alpha-review']
      })
    ).toBe('mcp=a-docs,z-docs;skills=alpha-review,zeta-review;untrusted_context_policy=external_content_reference_only');
  });
});

function disabledSnapshot(): FrozenSnapshot {
  return {
    user: {
      kind: 'user',
      filename: 'USER.md',
      content: '',
      charCount: 0,
      charLimit: 1375,
      source: 'global',
      enabled: false
    },
    agents: {
      kind: 'agents',
      filename: 'AGENTS.md',
      content: '',
      charCount: 0,
      charLimit: 800,
      source: 'global',
      enabled: false
    },
    memory: {
      kind: 'memory',
      filename: 'MEMORY.md',
      content: '',
      charCount: 0,
      charLimit: 2200,
      source: 'global',
      enabled: false
    },
    totalChars: 0,
    totalLimit: 4375,
    globallyEnabled: false
  };
}
