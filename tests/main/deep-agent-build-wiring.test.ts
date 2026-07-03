import { describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createDeepAgent } from 'deepagents';
import type { SubAgent } from 'deepagents';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { buildDeepAgent, type DeepAgentBuildInput } from '../../src/main/services/deep-agent/agent-builder';
import { ensureRocHarnessProfilesRegistered } from '../../src/main/services/deep-agent/harness-profiles';

vi.mock('deepagents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('deepagents')>();
  return { ...actual, createDeepAgent: vi.fn(() => ({ __stubAgent: true })) };
});

vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>();
  return { ...actual, createAgent: vi.fn(() => ({ __stubPlanAgent: true })) };
});

vi.mock('../../src/main/services/deep-agent/harness-profiles', () => ({
  ensureRocHarnessProfilesRegistered: vi.fn()
}));

describe('buildDeepAgent harness profile wiring', () => {
  beforeEach(() => {
    vi.mocked(createDeepAgent).mockClear();
    vi.mocked(createAgent).mockClear();
    vi.mocked(ensureRocHarnessProfilesRegistered).mockClear();
  });

  it('registers Roc harness profiles before assembling the agent', () => {
    const input = {
      mode: 'chat',
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

  it('adds plan model tool exposure middleware only for plan mode', () => {
    const input = {
      mode: 'plan',
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
        { operations: ['write'], paths: ['/**'], mode: 'deny' }
      ],
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      providerType: 'openai_compatible',
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(createDeepAgent).toHaveBeenCalledTimes(1);
    expect(createAgent).not.toHaveBeenCalled();
    expect(middlewareNames).toContain('RocPlanToolExposureMiddleware');
    expect(middlewareNames).toContain('RocPlanRuntimeToolGuardMiddleware');
    expect(middlewareNames.indexOf('RocPlanRuntimeToolGuardMiddleware')).toBeLessThan(
      middlewareNames.indexOf('RocFilesystemPathPolicyMiddleware')
    );
  });

  it('keeps Roc filesystem path policy before filesystem tool error classification', () => {
    const input = {
      mode: 'chat',
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: ['/memory/global/AGENTS.md'],
      skillSources: [],
      subagents: [],
      tools: [],
      filesystemPermissions: [
        { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
        { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
        { operations: ['write'], paths: ['/skills/**'], mode: 'deny' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
      ],
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      providerType: 'openai_compatible',
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    if (createDeepAgentInput === undefined) {
      throw new Error('Expected DeepAgents input.');
    }
    const middlewareNames = createDeepAgentInput.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(middlewareNames).toContain('RocFilesystemPathPolicyMiddleware');
    expect(middlewareNames).toContain('ForgeFilesystemToolErrorMiddleware');
    expect(middlewareNames.indexOf('RocFilesystemPathPolicyMiddleware')).toBeLessThan(
      middlewareNames.indexOf('ForgeFilesystemToolErrorMiddleware')
    );
  });

  it('does not add plan model tool exposure middleware for chat mode', () => {
    const input = {
      mode: 'chat',
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
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(middlewareNames).not.toContain('RocPlanToolExposureMiddleware');
    expect(middlewareNames).not.toContain('RocPlanRuntimeToolGuardMiddleware');
  });

  it('limits plan rescue candidates to plan-visible tools', async () => {
    const input = {
      mode: 'plan',
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: [],
      skillSources: [],
      subagents: [],
      tools: [createNamedTool('mcp_docs_lookup')],
      filesystemPermissions: [
        { operations: ['read'], paths: ['/workspace/**'], mode: 'allow' },
        { operations: ['write'], paths: ['/**'], mode: 'deny' }
      ],
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      providerType: 'openai_compatible',
      workflowHint: null,
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

    const hiddenUpdate = await rescue.afterModel(
      {
        messages: [
          new AIMessage({
            id: 'ai-plan-write',
            content: '{"tool":"write_file","args":{"file_path":"/workspace/a.txt","content":"x"}}'
          })
        ]
      },
      {}
    );
    expect(hiddenUpdate).toBeUndefined();

    const allowedUpdate = await rescue.afterModel(
      {
        messages: [
          new AIMessage({
            id: 'ai-plan-read',
            content: '{"tool":"read_file","args":{"file_path":"/workspace/a.txt"}}'
          })
        ]
      },
      {}
    );
    const rebuilt = allowedUpdate?.messages?.[1] as AIMessage;

    expect(rebuilt.tool_calls).toEqual([
      {
        name: 'read_file',
        args: { file_path: '/workspace/a.txt' },
        id: 'call_rescued_ai-plan-read_0',
        type: 'tool_call'
      }
    ]);

    const mcpUpdate = await rescue.afterModel(
      {
        messages: [
          new AIMessage({
            id: 'ai-plan-mcp',
            content: '{"tool":"mcp_docs_lookup","args":{"query":"plan mode"}}'
          })
        ]
      },
      {}
    );
    const rebuiltMcp = mcpUpdate?.messages?.[1] as AIMessage;

    expect(rebuiltMcp.tool_calls).toEqual([
      {
        name: 'mcp_docs_lookup',
        args: { query: 'plan mode' },
        id: 'call_rescued_ai-plan-mcp_0',
        type: 'tool_call'
      }
    ]);
  });

  it('runs Roc shell path policy before RTK can rewrite or deny shell commands', () => {
    const input = {
      mode: 'chat',
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

  it('wires hook middleware before Roc guardrails when hook runtime is provided', () => {
    const input = {
      mode: 'chat',
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
      workflowHint: null,
      contextBudgetTokens: undefined,
      hookMiddleware: {
        hookRuntime: {
          runEvent: vi.fn(async () => ({
            blocked: false,
            blockReason: null,
            updatedInput: undefined,
            additionalContexts: [],
            requestContinue: null,
            runs: [],
            events: []
          }))
        },
        runContext: {
          runId: 'run_1',
          threadId: 'thread_1',
          workspacePath: 'F:\\Code\\Roc',
          cwd: 'F:\\Code\\Roc',
          source: 'chat',
          modelId: 'model_1',
          workflowHint: null
        },
        emitHookEvent: vi.fn()
      }
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) => Reflect.get(middleware as object, 'name')) ?? [];

    expect(middlewareNames.indexOf('RocHookMiddleware')).toBeGreaterThanOrEqual(0);
    expect(middlewareNames.indexOf('RocHookMiddleware')).toBeLessThan(middlewareNames.indexOf('RocShellPathPolicyMiddleware'));
  });

  it('wires tool effect idempotency after tool protocol normalization when run context is provided', () => {
    const input = {
      mode: 'chat',
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
      workflowHint: null,
      contextBudgetTokens: undefined,
      toolEffectIdempotency: {
        runId: 'run_1',
        threadId: 'thread_1',
        store: {} as never
      }
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(middlewareNames).toContain('RocToolEffectIdempotencyMiddleware');
    expect(middlewareNames.indexOf('RocToolProtocolMiddleware')).toBeLessThan(
      middlewareNames.indexOf('RocToolEffectIdempotencyMiddleware')
    );
    expect(middlewareNames.indexOf('RocToolEffectIdempotencyMiddleware')).toBeLessThan(
      middlewareNames.indexOf('RocToolRuntimeErrorMiddleware')
    );
  });

  it('wires schema-validated bare argument rescue through createDeepAgent middleware', async () => {
    const internetSearchSchema = z.object({
      query: z.string()
    });
    const input = {
      mode: 'chat',
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
      mode: 'chat',
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

  it('builds plan mode without file mutation tools while preserving non-file tools', () => {
    const input = {
      mode: 'plan',
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: ['/memory/global/AGENTS.md'],
      skillSources: ['/skills/'],
      subagents: [
        {
          name: 'research',
          description: 'Research current context.',
          systemPrompt: 'Research current context.',
          tools: [createNamedTool('web_read')]
        }
      ],
      tools: [
        createNamedTool('web_read'),
        createNamedTool('web_search'),
        createNamedTool('ask_user'),
        createNamedTool('session_search'),
        createNamedTool('mcp_docs_lookup'),
        createNamedTool('filesystem__search'),
        createNamedTool('filesystem__write_file'),
        createNamedTool('filesystem__edit_file'),
        createNamedTool('filesystem__delete_file'),
        createNamedTool('write_file'),
        createNamedTool('edit_file'),
        createNamedTool('delete_file')
      ],
      filesystemPermissions: [
        { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
        { operations: ['write'], paths: ['/**'], mode: 'deny' }
      ],
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      providerType: 'openai_compatible',
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    expect(createDeepAgent).toHaveBeenCalledTimes(1);
    expect(createAgent).not.toHaveBeenCalled();
    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    if (createDeepAgentInput === undefined) {
      throw new Error('Expected plan DeepAgents input.');
    }
    const toolNames = createDeepAgentInput.tools === undefined ? [] : createDeepAgentInput.tools.map((tool) => tool.name);
    const middleware = createDeepAgentInput.middleware === undefined ? [] : createDeepAgentInput.middleware;
    const middlewareNames = middleware.map((middlewareItem) => Reflect.get(middlewareItem as object, 'name'));
    const generalPurposeSubagent = createDeepAgentInput.subagents?.find((subagent) => subagent.name === 'general-purpose');
    const researchSubagent = createDeepAgentInput.subagents?.find((subagent) => subagent.name === 'research');
    if (!isSubAgent(generalPurposeSubagent)) {
      throw new Error('Expected plan general-purpose subagent.');
    }
    if (!isSubAgent(researchSubagent)) {
      throw new Error('Expected plan research subagent.');
    }
    const generalPurposeMiddlewareNames = generalPurposeSubagent?.middleware?.map((middlewareItem) =>
      Reflect.get(middlewareItem as object, 'name')
    ) ?? [];
    const generalPurposeToolNames = generalPurposeSubagent?.tools?.map((tool) => tool.name) ?? [];
    const researchMiddlewareNames = researchSubagent?.middleware?.map((middlewareItem) =>
      Reflect.get(middlewareItem as object, 'name')
    ) ?? [];

    expect(toolNames).toEqual([
      'web_read',
      'web_search',
      'ask_user',
      'session_search',
      'mcp_docs_lookup',
      'filesystem__search',
      'filesystem__write_file',
      'filesystem__edit_file',
      'filesystem__delete_file'
    ]);
    expect(toolNames).not.toEqual(expect.arrayContaining(['ls', 'read_file', 'glob', 'grep', 'write_file', 'edit_file', 'delete_file']));
    expect(middlewareNames).toEqual(expect.arrayContaining([
      'RocPlanReadOnlyMemoryMiddleware',
      'RocPlanToolExposureMiddleware',
      'RocPlanRuntimeToolGuardMiddleware',
      'RocPlanFilesystemDefaultPathMiddleware',
      'RocFilesystemPathPolicyMiddleware',
      'ForgeFilesystemToolErrorMiddleware'
    ]));
    expect(middlewareNames.indexOf('RocPlanFilesystemDefaultPathMiddleware')).toBeLessThan(
      middlewareNames.indexOf('RocFilesystemPathPolicyMiddleware')
    );
    expect(middlewareNames.indexOf('RocFilesystemPathPolicyMiddleware')).toBeLessThan(
      middlewareNames.indexOf('ForgeFilesystemToolErrorMiddleware')
    );
    expect(generalPurposeToolNames).toEqual(toolNames);
    expect(generalPurposeMiddlewareNames).toEqual(expect.arrayContaining([
      'RocPlanReadOnlyMemoryMiddleware',
      'RocPlanToolExposureMiddleware',
      'RocPlanRuntimeToolGuardMiddleware',
      'RocPlanFilesystemDefaultPathMiddleware',
      'RocFilesystemPathPolicyMiddleware',
      'ForgeFilesystemToolErrorMiddleware'
    ]));
    expect(researchMiddlewareNames).toEqual(expect.arrayContaining([
      'RocPlanReadOnlyMemoryMiddleware',
      'RocPlanToolExposureMiddleware',
      'RocPlanRuntimeToolGuardMiddleware',
      'RocPlanFilesystemDefaultPathMiddleware',
      'RocFilesystemPathPolicyMiddleware',
      'ForgeFilesystemToolErrorMiddleware'
    ]));
    expect(createDeepAgentInput).toMatchObject({
      memory: [],
      skills: ['/skills/']
    });
  });
});

function createNamedTool(name: string) {
  return tool(async () => '', {
    name,
    description: `${name} tool`,
    schema: z.object({})
  });
}

function isSubAgent(value: unknown): value is SubAgent {
  return value !== null && typeof value === 'object' && Reflect.has(value, 'systemPrompt');
}
