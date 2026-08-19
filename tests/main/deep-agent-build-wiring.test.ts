import { describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createDeepAgent } from 'deepagents';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { compileRunCapabilityManifest } from '../../src/main/plugins/agent/run-capability-manifest';
import { toChatRunMode } from '../../src/main/plugins/agent/run-execution-snapshot';
import { buildDeepAgent, type DeepAgentBuildInput } from '../../src/main/services/deep-agent/agent-builder';
import { ensureRocHarnessProfilesRegistered } from '../../src/main/services/deep-agent/harness-profiles';
import { getSubagentMiddleware, getSubagentTools, isBuiltSubagent } from './deep-agent-test-helpers';

type BuildFixtureInput = Omit<DeepAgentBuildInput, 'capabilityManifest' | 'modelCallLimit' | 'modelThreadCallLimit' | 'toolCallLimit' | 'toolThreadCallLimit'> &
  Partial<Pick<DeepAgentBuildInput, 'modelCallLimit' | 'modelThreadCallLimit' | 'toolCallLimit' | 'toolThreadCallLimit'>>;

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
      mode: 'run',
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
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, []);

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
      expect.arrayContaining(['RocFilesystemPathPolicyMiddleware', 'RocShellPolicyMiddleware'])
    );
  });

  it('installs native model and tool call limit middleware from the frozen budget', () => {
    const input = {
      mode: 'run',
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
      workflowHint: null,
      contextBudgetTokens: 4096,
      modelCallLimit: 7,
      modelThreadCallLimit: 35,
      toolCallLimit: 11,
      toolThreadCallLimit: 55
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, []);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(middlewareNames).toContain('ModelCallLimitMiddleware');
    expect(middlewareNames).toContain('ToolCallLimitMiddleware');
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
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, []);

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
      mode: 'run',
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
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, []);

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
      mode: 'run',
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
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, []);

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
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, ['mcp_docs_lookup']);

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
      mode: 'run',
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
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, []);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) => Reflect.get(middleware as object, 'name')) ?? [];

    expect(middlewareNames.indexOf('RocShellPolicyMiddleware')).toBeLessThan(middlewareNames.indexOf('RTKMiddleware'));
  });

  it('leaves prompt cache breakpoint injection to DeepAgents native middleware', () => {
    const input = {
      mode: 'run',
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: ['/memory/global/AGENTS.md'],
      skillSources: ['/skills/'],
      subagents: [],
      tools: [],
      filesystemPermissions: undefined,
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, []);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(middlewareNames).not.toContain('PromptCaching');
    expect(createDeepAgentInput).toMatchObject({
      memory: ['/memory/global/AGENTS.md'],
      skills: ['/skills/']
    });
  });

  it('wires hook middleware before Roc guardrails when hook runtime is provided', () => {
    const input = {
      mode: 'run',
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
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, []);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) => Reflect.get(middleware as object, 'name')) ?? [];

    expect(middlewareNames.indexOf('RocHookMiddleware')).toBeGreaterThanOrEqual(0);
    expect(middlewareNames.indexOf('RocHookMiddleware')).toBeLessThan(middlewareNames.indexOf('RocShellPolicyMiddleware'));
  });

  it('wires tool-scoped hook middleware into DeepAgents subagents when hooks are enabled', () => {
    const inspectTool = createNamedTool('inspect_workspace');
    const input = {
      mode: 'run',
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: ['/memory/global/AGENTS.md'],
      skillSources: ['/skills/'],
      subagents: [
        {
          name: 'research',
          description: 'Research context.',
          systemPrompt: 'Research context.',
          tools: [inspectTool]
        }
      ],
      tools: [inspectTool],
      filesystemPermissions: undefined,
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
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
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, ['inspect_workspace']);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const generalPurposeSubagent = createDeepAgentInput?.subagents?.find((subagent) => subagent.name === 'general-purpose');
    const researchSubagent = createDeepAgentInput?.subagents?.find((subagent) => subagent.name === 'research');
    if (!isBuiltSubagent(generalPurposeSubagent)) {
      throw new Error('Expected general-purpose subagent.');
    }
    if (!isBuiltSubagent(researchSubagent)) {
      throw new Error('Expected research subagent.');
    }
    const generalPurposeMiddleware = getSubagentMiddleware(generalPurposeSubagent);
    const researchMiddleware = getSubagentMiddleware(researchSubagent);
    const generalPurposeMiddlewareNames = generalPurposeMiddleware.map((middlewareItem) => Reflect.get(middlewareItem as object, 'name'));
    const researchMiddlewareNames = researchMiddleware.map((middlewareItem) => Reflect.get(middlewareItem as object, 'name'));
    const generalPurposeHookMiddleware = generalPurposeMiddleware.find((middlewareItem) =>
      Reflect.get(middlewareItem as object, 'name') === 'RocHookMiddleware'
    );
    const researchHookMiddleware = researchMiddleware.find((middlewareItem) =>
      Reflect.get(middlewareItem as object, 'name') === 'RocHookMiddleware'
    );

    expect(getSubagentTools(generalPurposeSubagent)).toEqual([inspectTool]);
    expect(generalPurposeMiddlewareNames).toContain('SkillsMiddleware');
    expect(generalPurposeMiddlewareNames).toContain('RocHookMiddleware');
    expect(researchMiddlewareNames).toContain('RocHookMiddleware');
    expect(typeof Reflect.get(generalPurposeHookMiddleware as object, 'beforeModel')).toBe('function');
    expect(typeof Reflect.get(generalPurposeHookMiddleware as object, 'wrapToolCall')).toBe('function');
    expect(Reflect.get(generalPurposeHookMiddleware as object, 'afterModel')).toBeUndefined();
    expect(typeof Reflect.get(researchHookMiddleware as object, 'beforeModel')).toBe('function');
    expect(typeof Reflect.get(researchHookMiddleware as object, 'wrapToolCall')).toBe('function');
    expect(Reflect.get(researchHookMiddleware as object, 'afterModel')).toBeUndefined();
  });

  it('wires tool effects inside product error mapping and outside the tool handler', () => {
    const input = {
      mode: 'run',
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
      workflowHint: null,
      contextBudgetTokens: undefined,
      toolEffectIdempotency: {
        runId: 'run_1',
        threadId: 'thread_1',
        store: {} as never
      }
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, []);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    if (createDeepAgentInput?.middleware === undefined) {
      throw new Error('Expected Deep Agents middleware configuration.');
    }
    const middlewareNames = createDeepAgentInput.middleware.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    );

    expect(middlewareNames).toEqual(expect.arrayContaining([
      'RocToolProtocolMiddleware',
      'ForgeErrorBudgetMiddleware',
      'RocToolRuntimeErrorMiddleware',
      'ForgeToolResolutionMiddleware',
      'RocToolEffectIdempotencyMiddleware'
    ]));
    expect(middlewareNames.indexOf('RocToolProtocolMiddleware')).toBeLessThan(
      middlewareNames.indexOf('ForgeErrorBudgetMiddleware')
    );
    expect(middlewareNames.indexOf('ForgeErrorBudgetMiddleware')).toBeLessThan(
      middlewareNames.indexOf('RocToolRuntimeErrorMiddleware')
    );
    expect(middlewareNames.indexOf('RocToolRuntimeErrorMiddleware')).toBeLessThan(
      middlewareNames.indexOf('ForgeToolResolutionMiddleware')
    );
    expect(middlewareNames.indexOf('ForgeToolResolutionMiddleware')).toBeLessThan(
      middlewareNames.indexOf('RocToolEffectIdempotencyMiddleware')
    );
  });

  it('wires Roc context compaction pipeline in normal runs when context options are provided', () => {
    const input = {
      mode: 'run',
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
      workflowHint: null,
      contextBudgetTokens: 4096,
      contextCompaction: {
        artifactStore: {} as never,
        emitEvent: vi.fn(),
        mode: 'run',
        runId: 'run_context_1',
        threadId: 'thread_context_1',
        workspaceHash: 'workspace_hash_context'
      }
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, []);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(middlewareNames).toContain('RocContextCompactionPipeline');
    expect(middlewareNames.indexOf('ForgeIterationTrackingMiddleware')).toBeLessThan(
      middlewareNames.indexOf('RocContextCompactionPipeline')
    );
    expect(middlewareNames.indexOf('RocContextCompactionPipeline')).toBeLessThan(
      middlewareNames.indexOf('ForgeRescueParsingMiddleware')
    );
    expect(middlewareNames.filter((name) => name === 'ContextEditingMiddleware')).toHaveLength(0);
  });

  it('wires schema-validated bare argument rescue through createDeepAgent middleware', async () => {
    const internetSearchSchema = z.object({
      query: z.string()
    });
    const input = {
      mode: 'run',
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
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, ['internet_search']);

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

  it('builds the general-purpose subagent explicitly with main tools, skills, and middleware', () => {
    const inspectSchema = z.object({
      target: z.string()
    });
    const inspectTool = tool(async ({ target }: z.infer<typeof inspectSchema>) => `seen:${target}`, {
      name: 'mcp_docs_lookup',
      description: 'Lookup docs through selected MCP.',
      schema: inspectSchema
    });
    const input = {
      mode: 'run',
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
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, ['mcp_docs_lookup']);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];

    expect(createDeepAgentInput).toMatchObject({
      memory: ['/memory/global/AGENTS.md', '/memory/workspaces/current/AGENTS.md'],
      skills: ['/skills/'],
      tools: [inspectTool]
    });
    const generalPurposeSubagent = createDeepAgentInput?.subagents?.find((subagent) => subagent.name === 'general-purpose');
    if (!isBuiltSubagent(generalPurposeSubagent)) {
      throw new Error('Expected explicit general-purpose subagent.');
    }
    const middlewareNames = getSubagentMiddleware(generalPurposeSubagent).map((middlewareItem) =>
      Reflect.get(middlewareItem as object, 'name')
    );

    expect(getSubagentTools(generalPurposeSubagent)).toEqual([inspectTool]);
    expect(middlewareNames).toContain('SkillsMiddleware');
    expect(middlewareNames).toEqual(expect.arrayContaining([
      'RocShellPolicyMiddleware',
      'RocToolProtocolMiddleware',
      'ForgeErrorBudgetMiddleware',
      'RocFilesystemPathPolicyMiddleware'
    ]));
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
      workflowHint: null,
      contextBudgetTokens: undefined,
      contextCompaction: {
        artifactStore: {} as never,
        emitEvent: vi.fn(),
        mode: 'plan',
        runId: 'run_plan_context',
        threadId: 'thread_plan_context',
        workspaceHash: 'workspace_hash_plan'
      }
    } as unknown as BuildFixtureInput;

    buildFixtureAgent(input, [
      'web_search',
      'mcp_docs_lookup',
      'filesystem__search',
      'filesystem__write_file',
      'filesystem__edit_file',
      'filesystem__delete_file'
    ]);

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
    if (!isBuiltSubagent(generalPurposeSubagent)) {
      throw new Error('Expected plan general-purpose subagent.');
    }
    if (!isBuiltSubagent(researchSubagent)) {
      throw new Error('Expected plan research subagent.');
    }
    const generalPurposeMiddlewareNames = getSubagentMiddleware(generalPurposeSubagent).map((middlewareItem) =>
      Reflect.get(middlewareItem as object, 'name')
    );
    const generalPurposeToolNames = getSubagentTools(generalPurposeSubagent).map((tool) => tool.name);
    const researchMiddlewareNames = getSubagentMiddleware(researchSubagent).map((middlewareItem) =>
      Reflect.get(middlewareItem as object, 'name')
    );

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
      'RocContextCompactionPipeline',
      'RocFilesystemPathPolicyMiddleware',
      'ForgeFilesystemToolErrorMiddleware'
    ]));
    expect(middlewareNames).toContain('RocContextCompactionPipeline');
    expect(middlewareNames).toContain('RocPlanRuntimeToolGuardMiddleware');
    expect(toolNames).not.toEqual(expect.arrayContaining(['write_file', 'edit_file', 'delete_file']));
    expect(middlewareNames.indexOf('RocPlanFilesystemDefaultPathMiddleware')).toBeLessThan(
      middlewareNames.indexOf('RocFilesystemPathPolicyMiddleware')
    );
    expect(middlewareNames.indexOf('RocFilesystemPathPolicyMiddleware')).toBeLessThan(
      middlewareNames.indexOf('ForgeFilesystemToolErrorMiddleware')
    );
    expect(generalPurposeToolNames).toEqual([
      'web_read',
      'web_search',
      'mcp_docs_lookup',
      'filesystem__search',
      'filesystem__write_file',
      'filesystem__edit_file',
      'filesystem__delete_file'
    ]);
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

function buildFixtureAgent(input: BuildFixtureInput, customToolNames: string[]): void {
  const mcpServers = customToolNames.length === 0
    ? []
    : [
        {
          id: 'fixture-mcp',
          name: 'Fixture MCP',
          enabled: true,
          transport: 'stdio' as const,
          status: 'ready' as const,
          tools: customToolNames.length,
          allowedTools: customToolNames
        }
      ];
  const capabilityManifest = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers,
    mode: toChatRunMode(input.mode),
    workflowHint: input.workflowHint,
    requestedCapabilities: {
      mcpServers: customToolNames.length === 0 ? [] : ['fixture-mcp'],
      skills: []
    },
    skills: []
  }).manifest;

  buildDeepAgent({
    ...input,
    capabilityManifest,
    modelCallLimit: input.modelCallLimit === undefined ? 20 : input.modelCallLimit,
    modelThreadCallLimit: input.modelThreadCallLimit === undefined ? 100 : input.modelThreadCallLimit,
    toolCallLimit: input.toolCallLimit === undefined ? 40 : input.toolCallLimit,
    toolThreadCallLimit: input.toolThreadCallLimit === undefined ? 200 : input.toolThreadCallLimit
  });
}

function createNamedTool(name: string) {
  return tool(async () => '', {
    name,
    description: `${name} tool`,
    schema: z.object({})
  });
}
