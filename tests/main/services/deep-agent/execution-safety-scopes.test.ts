import { describe, expect, it, vi } from 'vitest';
import { tool } from '@langchain/core/tools';
import { createDeepAgent } from 'deepagents';
import { z } from 'zod';

import { compileRunCapabilityManifest } from '../../../../src/main/plugins/agent/run-capability-manifest';
import { createFakePreCompactionFlushRecorder } from './context/pre-compaction-flush-test-helpers';
import { buildDeepAgent, type DeepAgentBuildInput } from '../../../../src/main/services/deep-agent/agent-builder';
import { ensureRocHarnessProfilesRegistered } from '../../../../src/main/services/deep-agent/harness-profiles';
import {
  createDeepAgentTestSnapshot,
  getSubagentMiddleware,
  getSubagentTools,
  isBuiltSubagent
} from '../../deep-agent-test-helpers';

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
    const capabilityManifest = createCapabilityManifest(['inspect_workspace']);
    const input: DeepAgentBuildInput = {
      snapshot: createDeepAgentTestSnapshot({
        capabilityManifest,
        runId: 'run_1',
        threadId: 'thread_1',
        workspacePath: 'F:\\Code\\Roc',
        budget: { contextBudgetTokens: 4096 }
      }),
      model: {} as never,
      systemPrompt: 'system',
      backend: {} as never,
      store: {} as never,
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
      checkpointer: {} as never,
      contextCompaction: {
        artifactStore: {} as never,
        sessionHistory: createFakePreCompactionFlushRecorder(),
        budgetProfile: {
          contextWindowTokens: 4096,
          modelInputTokens: 3000,
          reservedOutputTokens: 512,
          systemToolOverheadTokens: 384,
          summaryInputTokens: 1500,
          safetyMarginTokens: 200
        },
        emitEvent: vi.fn(),
        tokenCounter: {
          countMessages: vi.fn(),
          countText: vi.fn(),
          wasEstimated: vi.fn(() => false)
        }
      },
      toolEffectStore: {} as never
    };

    buildDeepAgent(input);

    expect(ensureRocHarnessProfilesRegistered).toHaveBeenCalledTimes(1);
    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    if (createDeepAgentInput === undefined) {
      throw new Error('Expected DeepAgents input.');
    }
    const expectedSafetyMiddleware = [
      'RocShellPolicyMiddleware',
      'RTKMiddleware',
      'RocToolProtocolMiddleware',
      'RocContextCompactionPipeline',
      'RocToolEffectIdempotencyMiddleware',
      'ForgeErrorBudgetMiddleware',
      'ForgeIterationTrackingMiddleware',
      'RocFilesystemPathPolicyMiddleware',
      'ForgeFilesystemToolErrorMiddleware',
      'RocToolRuntimeErrorMiddleware',
      'ForgeToolResolutionMiddleware'
    ];
    const mainMiddlewareNames = createDeepAgentInput.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(mainMiddlewareNames).toEqual(expect.arrayContaining(expectedSafetyMiddleware));
    for (const subagentName of ['general-purpose', 'research']) {
      const subagent = createDeepAgentInput.subagents?.find((candidate) => candidate.name === subagentName);
      if (!isBuiltSubagent(subagent)) {
        throw new Error(`Expected ${subagentName} subagent.`);
      }
      const middlewareNames = getSubagentMiddleware(subagent).map((middleware) =>
        Reflect.get(middleware as object, 'name')
      );

      expect(middlewareNames).toContain('HumanInTheLoopMiddleware');
      expect(middlewareNames).toEqual(expect.arrayContaining(expectedSafetyMiddleware));
      expect(middlewareNames).not.toContain('SummarizationMiddleware');
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
    }
  });

  it('rejects opaque subagents because Roc cannot attach the required safety contract', () => {
    const input: DeepAgentBuildInput = {
      snapshot: createDeepAgentTestSnapshot({
        capabilityManifest: createCapabilityManifest(),
        workspacePath: 'F:\\Code\\Roc',
        budget: { contextBudgetTokens: 4096 }
      }),
      model: {} as never,
      systemPrompt: 'system',
      backend: {} as never,
      store: {} as never,
      memorySources: [],
      skillSources: [],
      subagents: [
        {
          name: 'compiled',
          description: 'Opaque compiled subagent.',
          runnable: {} as never
        }
      ],
      tools: [],
      checkpointer: undefined
    };

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
    const input: DeepAgentBuildInput = {
      snapshot: createDeepAgentTestSnapshot({
        capabilityManifest: createCapabilityManifest(['inspect_workspace']),
        workspacePath: 'F:\\Code\\Roc',
        budget: { contextBudgetTokens: 4096 }
      }),
      model: {} as never,
      systemPrompt: 'system',
      backend: {} as never,
      store: {} as never,
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
      checkpointer: undefined
    };

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls.at(-1)?.[0];
    for (const subagentName of ['general-purpose', 'research']) {
      const subagent = createDeepAgentInput?.subagents?.find((candidate) => candidate.name === subagentName);
      if (!isBuiltSubagent(subagent)) {
        throw new Error(`Expected ${subagentName} subagent.`);
      }
      expect(getSubagentTools(subagent).map((candidate) => candidate.name)).toEqual(['inspect_workspace']);
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
    deleteFileApprovalMode: 'default',
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
