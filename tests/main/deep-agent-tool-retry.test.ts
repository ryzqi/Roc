import type { ClientTool } from '@langchain/core/tools';
import { describe, expect, it, vi } from 'vitest';
import type { RocCompositeBackend } from '../../src/main/services/deep-agent/backend';
import type { DeepAgentBuildInput } from '../../src/main/services/deep-agent/agent-builder';

const mocked = vi.hoisted(() => ({
  createDeepAgent: vi.fn(() => ({ __agent: true })),
  toolRetryMiddleware: vi.fn(() => ({ name: 'toolRetryMiddleware' }))
}));

vi.mock('deepagents', async () => {
  const actual = await vi.importActual<typeof import('deepagents')>('deepagents');
  return {
    ...actual,
    createDeepAgent: mocked.createDeepAgent
  };
});

vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return {
    ...actual,
    toolRetryMiddleware: mocked.toolRetryMiddleware
  };
});

describe('deep agent tool retry policy', () => {
  it('does not retry background task side-effect tools automatically', async () => {
    const { buildDeepAgent } = await import('../../src/main/services/deep-agent/agent-builder');

    buildDeepAgent(createBuildInput());

    expect(mocked.toolRetryMiddleware).toHaveBeenCalledWith({
      maxRetries: 2,
      tools: ['web_read'],
      backoffFactor: 1.5
    });
  });
});

function createBuildInput(): DeepAgentBuildInput {
  return {
    model: {} as never,
    systemPrompt: 'system',
    backend: { routePrefixes: [] } as unknown as RocCompositeBackend,
    store: {} as never,
    memorySources: [],
    skillSources: [],
    subagents: [],
    tools: [
      fakeTool('web_read'),
      fakeTool('schedule_background_task'),
      fakeTool('update_background_task'),
      fakeTool('cancel_background_task')
    ],
    filesystemPermissions: undefined,
    interruptOn: undefined,
    checkpointer: undefined,
    providerType: 'openai_compatible',
    workflowHint: null,
    contextBudgetTokens: undefined
  };
}

function fakeTool(name: string): ClientTool {
  return {
    name,
    description: `${name} tool`,
    schema: undefined,
    invoke: vi.fn()
  } as unknown as ClientTool;
}
