import { describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createDeepAgent } from 'deepagents';
import { z } from 'zod';
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
  beforeEach(() => {
    vi.mocked(createDeepAgent).mockClear();
    vi.mocked(ensureRocHarnessProfilesRegistered).mockClear();
  });

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
      filesystemPermissions: [
        { operations: ['read'], paths: ['/workspace/**'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
      ],
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      providerType: 'openai_compatible',
      workflowHint: 'default',
      contextBudgetTokens: undefined
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    expect(ensureRocHarnessProfilesRegistered).toHaveBeenCalledTimes(1);
    expect(createDeepAgent).toHaveBeenCalledTimes(1);
    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    expect(createDeepAgentInput).toMatchObject({
      permissions: [
        { operations: ['read'], paths: ['/workspace/**'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
      ]
    });
    expect(createDeepAgentInput?.middleware?.map((middleware) => Reflect.get(middleware as object, 'name'))).toEqual(
      expect.arrayContaining(['RocFilesystemPathPolicyMiddleware', 'RocShellPathPolicyMiddleware'])
    );
  });

  it('runs Roc shell path policy before RTK can rewrite or deny shell commands', () => {
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
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      providerType: 'openai_compatible',
      workflowHint: 'default',
      contextBudgetTokens: undefined
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) => Reflect.get(middleware as object, 'name')) ?? [];

    expect(middlewareNames.indexOf('RocShellPathPolicyMiddleware')).toBeLessThan(middlewareNames.indexOf('RTKMiddleware'));
  });

  it('wires schema-validated bare argument rescue through createDeepAgent middleware', async () => {
    const internetSearchSchema = z.object({
      query: z.string()
    });
    const input = {
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: [],
      skillSources: [],
      subagents: [],
      tools: [
        tool(async ({ query }: z.infer<typeof internetSearchSchema>) => `result:${query}`, {
          name: 'internet_search',
          description: 'Search the internet.',
          schema: internetSearchSchema
        })
      ],
      filesystemPermissions: [
        { operations: ['read'], paths: ['/workspace/**'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
      ],
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      providerType: 'openai_compatible',
      workflowHint: 'default',
      contextBudgetTokens: undefined
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0] as
      | { middleware?: unknown[] }
      | undefined;
    const rescue = createDeepAgentInput?.middleware?.find((middleware) => Reflect.get(middleware as object, 'name') === 'ForgeRescueParsingMiddleware') as
      | { afterModel?: (state: unknown, runtime: unknown) => Promise<{ messages?: unknown[] } | undefined> | { messages?: unknown[] } | undefined }
      | undefined;
    if (typeof rescue?.afterModel !== 'function') {
      throw new Error('Expected ForgeRescueParsingMiddleware to be passed into createDeepAgent.');
    }

    const update = await rescue.afterModel(
      {
        messages: [
          new AIMessage({
            id: 'ai-bare-args',
            content: '{"query":"agnes"}'
          })
        ]
      },
      {}
    );
    const rebuilt = update?.messages?.[1] as AIMessage;

    expect(rebuilt.tool_calls).toEqual([
      {
        name: 'internet_search',
        args: { query: 'agnes' },
        id: 'call_rescued_ai-bare-args_0',
        type: 'tool_call'
      }
    ]);
  });

  it('lets DeepAgents create the native general-purpose subagent with main tools, skills, and memory state', () => {
    const inspectSchema = z.object({
      target: z.string()
    });
    const inspectTool = tool(async ({ target }: z.infer<typeof inspectSchema>) => `seen:${target}`, {
      name: 'mcp_docs_lookup',
      description: 'Lookup docs through selected MCP.',
      schema: inspectSchema
    });
    const input = {
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: ['/memory/global/AGENTS.md', '/memory/workspaces/current/AGENTS.md'],
      skillSources: ['/skills/'],
      subagents: [],
      tools: [inspectTool],
      filesystemPermissions: [
        { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
      ],
      workspacePath: 'F:\\\\Code\\\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      providerType: 'openai_compatible',
      workflowHint: 'default',
      contextBudgetTokens: undefined
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];

    expect(createDeepAgentInput).toMatchObject({
      memory: ['/memory/global/AGENTS.md', '/memory/workspaces/current/AGENTS.md'],
      skills: ['/skills/'],
      tools: [inspectTool]
    });
    expect(createDeepAgentInput?.subagents?.some((subagent) => subagent.name === 'general-purpose')).toBe(false);
  });
});
