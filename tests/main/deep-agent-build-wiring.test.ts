import { describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createDeepAgent } from 'deepagents';
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

    const createAgentInput = vi.mocked(createAgent).mock.calls[0]?.[0];
    const middlewareNames = createAgentInput?.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(createDeepAgent).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(middlewareNames).toContain('RocPlanToolExposureMiddleware');
    expect(middlewareNames).toContain('RocPlanRuntimeToolGuardMiddleware');
    expect(middlewareNames.indexOf('RocPlanRuntimeToolGuardMiddleware')).toBeLessThan(
      middlewareNames.indexOf('RocFilesystemPathPolicyMiddleware')
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

    const createAgentInput = vi.mocked(createAgent).mock.calls[0]?.[0] as
      | { middleware?: unknown[] }
      | undefined;
    const rescue = createAgentInput?.middleware?.find((middleware) => Reflect.get(middleware as object, 'name') === 'ForgeRescueParsingMiddleware') as
      | { afterModel?: (state: unknown, runtime: unknown) => Promise<{ messages?: unknown[] } | undefined> | { messages?: unknown[] } | undefined }
      | undefined;
    if (typeof rescue?.afterModel !== 'function') {
      throw new Error('Expected ForgeRescueParsingMiddleware to be passed into createAgent.');
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
      subagents: [],
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

    expect(createDeepAgent).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledTimes(1);
    const createAgentInput = vi.mocked(createAgent).mock.calls[0]?.[0];
    if (createAgentInput === undefined) {
      throw new Error('Expected plan agent input.');
    }
    const toolNames = createAgentInput.tools === undefined ? [] : createAgentInput.tools.map((tool) => tool.name);
    const middleware = createAgentInput.middleware === undefined ? [] : createAgentInput.middleware;
    const middlewareNames = middleware.map((middlewareItem) => Reflect.get(middlewareItem as object, 'name'));
    const middlewareToolNames = middleware.flatMap((middlewareItem) => {
      const middlewareTools = Reflect.get(middlewareItem as object, 'tools');
      if (!Array.isArray(middlewareTools)) {
        return [];
      }
      return middlewareTools
        .map((toolItem) => Reflect.get(toolItem as object, 'name'))
        .filter((name): name is string => typeof name === 'string');
    });

    expect(toolNames).toEqual([
      'web_read',
      'web_search',
      'ask_user',
      'session_search',
      'mcp_docs_lookup',
      'filesystem__search',
      'filesystem__write_file',
      'filesystem__edit_file',
      'filesystem__delete_file',
      'ls',
      'read_file',
      'glob',
      'grep'
    ]);
    expect(toolNames).not.toEqual(expect.arrayContaining(['write_file', 'edit_file', 'delete_file']));
    expect(middlewareNames).not.toContain('FilesystemMiddleware');
    expect(middlewareNames).toEqual(expect.arrayContaining(['todoListMiddleware', 'subAgentMiddleware']));
    expect(middlewareToolNames).toEqual(expect.arrayContaining(['write_todos', 'task']));
    expect(middlewareToolNames).not.toEqual(expect.arrayContaining(['write_file', 'edit_file', 'delete_file']));
    expect(middlewareNames).toContain('SkillsMiddleware');
  });
});

function createNamedTool(name: string) {
  return tool(async () => '', {
    name,
    description: `${name} tool`,
    schema: z.object({})
  });
}
