import { describe, expect, it, vi } from 'vitest';
import { createDeepAgent } from 'deepagents';
import { buildDeepAgent, type DeepAgentBuildInput } from '../../src/main/services/deep-agent/agent-builder';
import { ensureRocHarnessProfilesRegistered } from '../../src/main/services/deep-agent/harness-profiles';

vi.mock('deepagents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('deepagents')>();
  return { ...actual, createDeepAgent: vi.fn(() => ({ __stubAgent: true })) };
});

vi.mock('../../src/main/services/deep-agent/harness-profiles', () => ({
  ensureRocHarnessProfilesRegistered: vi.fn()
}));

describe('buildDeepAgent harness profile wiring', () => {
  it('registers Roc harness profiles before assembling the agent', () => {
    const input = {
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: [],
      skillSources: [],
      subagents: [],
      tools: [],
      filesystemPermissions: undefined,
      interruptOn: undefined,
      checkpointer: undefined,
      providerType: 'openai_compatible',
      workflowHint: 'default',
      contextBudgetTokens: undefined
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    expect(ensureRocHarnessProfilesRegistered).toHaveBeenCalledTimes(1);
    expect(createDeepAgent).toHaveBeenCalledTimes(1);
  });
});
