import { describe, expect, it, vi } from 'vitest';
import { tool } from '@langchain/core/tools';
import { createDeepAgent } from 'deepagents';
import type { SubAgent } from 'deepagents';
import { z } from 'zod';

import { compileRunCapabilityManifest } from '../../../../src/main/plugins/agent/run-capability-manifest';
import { buildDeepAgent, type DeepAgentBuildInput } from '../../../../src/main/services/deep-agent/agent-builder';
import { ensureRocHarnessProfilesRegistered } from '../../../../src/main/services/deep-agent/harness-profiles';

vi.mock('deepagents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('deepagents')>();
  return { ...actual, createDeepAgent: vi.fn(() => ({ __stubAgent: true })) };
});

vi.mock('../../../../src/main/services/deep-agent/harness-profiles', () => ({
  ensureRocHarnessProfilesRegistered: vi.fn()
}));

describe('execution safety middleware scopes', () => {
  it('applies the immutable run safety contract to main and declarative subagents', () => {
    const inspectTool = tool(async () => '', {
      name: 'inspect_workspace',
      description: 'Inspect a permitted workspace resource.',
      schema: z.object({})
    });
    const interruptOn = {
      delete_file: {
        allowedDecisions: ['approve', 'edit', 'reject']
      }
    };
    const input = {
      mode: 'chat',
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: [],
      skillSources: ['/skills/'],
      subagents: [
        {
          name: 'research',
          description: 'Research permitted sources.',
          systemPrompt: 'Research permitted sources.',
          tools: [inspectTool]
        }
      ],
      tools: [inspectTool],
      capabilityManifest: createCapabilityManifest(['inspect_workspace']),
      filesystemPermissions: undefined,
      workspacePath: 'F:\\Code\\Roc',
      interruptOn,
      checkpointer: {} as unknown,
      workflowHint: null,
      contextBudgetTokens: 4096,
      modelCallLimit: 20,
      modelThreadCallLimit: 100,
      toolCallLimit: 40,
      toolThreadCallLimit: 200,
      toolEffectIdempotency: {
        runId: 'run_1',
        threadId: 'thread_1',
        store: {} as never
      }
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    expect(ensureRocHarnessProfilesRegistered).toHaveBeenCalledTimes(1);
    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    if (createDeepAgentInput === undefined) {
      throw new Error('Expected DeepAgents input.');
    }
    const expectedSafetyMiddleware = [
      'RocShellPathPolicyMiddleware',
      'RTKMiddleware',
      'RocToolProtocolMiddleware',
      'RocToolEffectIdempotencyMiddleware',
      'ForgeErrorBudgetMiddleware',
      'ForgeIterationTrackingMiddleware',
      'RocFilesystemPathPolicyMiddleware',
      'ForgeFilesystemToolErrorMiddleware',
      'ForgeToolResolutionMiddleware',
      'RocToolRuntimeErrorMiddleware'
    ];
    const mainMiddlewareNames = createDeepAgentInput.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(mainMiddlewareNames).toEqual(expect.arrayContaining(expectedSafetyMiddleware));
    for (const subagentName of ['general-purpose', 'research']) {
      const subagent = createDeepAgentInput.subagents?.find((candidate) => candidate.name === subagentName);
      if (!isSubAgent(subagent)) {
        throw new Error(`Expected ${subagentName} subagent.`);
      }
      const middlewareNames = subagent.middleware?.map((middleware) => Reflect.get(middleware as object, 'name')) ?? [];

      expect(subagent.interruptOn).toEqual(interruptOn);
      expect(middlewareNames).toEqual(expect.arrayContaining(expectedSafetyMiddleware));
    }
  });

  it('rejects opaque subagents because Roc cannot attach the required safety contract', () => {
    const input = {
      mode: 'chat',
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: [],
      skillSources: [],
      subagents: [
        {
          name: 'compiled',
          description: 'Opaque compiled subagent.',
          runnable: {}
        }
      ],
      tools: [],
      capabilityManifest: createCapabilityManifest(),
      filesystemPermissions: undefined,
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      workflowHint: null,
      contextBudgetTokens: 4096,
      modelCallLimit: 20,
      modelThreadCallLimit: 100,
      toolCallLimit: 40,
      toolThreadCallLimit: 200
    } as unknown as DeepAgentBuildInput;

    expect(() => buildDeepAgent(input)).toThrow('agent_subagent_safety_contract_unsupported:compiled');
  });

  it('does not expose main-only tools to the general-purpose subagent', () => {
    const askUserTool = tool(async () => '', {
      name: 'ask_user',
      description: 'Ask the user for input.',
      schema: z.object({})
    });
    const inspectTool = tool(async () => '', {
      name: 'inspect_workspace',
      description: 'Inspect a permitted workspace resource.',
      schema: z.object({})
    });
    const input = {
      mode: 'chat',
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: [],
      skillSources: [],
      subagents: [
        {
          name: 'research',
          description: 'Research permitted workspace resources.',
          systemPrompt: 'Use only the tools exposed to this execution scope.',
          tools: [askUserTool, inspectTool]
        }
      ],
      tools: [askUserTool, inspectTool],
      capabilityManifest: createCapabilityManifest(['inspect_workspace']),
      filesystemPermissions: undefined,
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      workflowHint: null,
      contextBudgetTokens: 4096,
      modelCallLimit: 20,
      modelThreadCallLimit: 100,
      toolCallLimit: 40,
      toolThreadCallLimit: 200
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls.at(-1)?.[0];
    for (const subagentName of ['general-purpose', 'research']) {
      const subagent = createDeepAgentInput?.subagents?.find((candidate) => candidate.name === subagentName);
      if (!isSubAgent(subagent)) {
        throw new Error(`Expected ${subagentName} subagent.`);
      }
      expect(subagent.tools?.map((candidate) => candidate.name)).toEqual(['inspect_workspace']);
    }
  });
});

function createCapabilityManifest(customToolNames: string[] = []) {
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
  return compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers,
    requestedCapabilities: {
      mcpServers: customToolNames.length === 0 ? [] : ['fixture-mcp'],
      skills: []
    },
    skills: [],
    mode: 'chat',
    workflowHint: null
  }).manifest;
}

function isSubAgent(value: unknown): value is SubAgent {
  return value !== null && typeof value === 'object' && Reflect.has(value, 'systemPrompt');
}
