import { createDeepAgent, createSkillsMiddleware, createSubAgentMiddleware } from 'deepagents';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ClientTool } from '@langchain/core/tools';
import type { CompiledSubAgent, FilesystemPermission, SubAgent, SubAgentMiddlewareOptions } from 'deepagents';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import { createAgent, todoListMiddleware, toolRetryMiddleware } from 'langchain';
import { z } from 'zod';
import type { ChatStartRunRequest, ProviderType, WorkflowHint } from '../../../shared/types';
import { RTKBinaryManager, createRTKMiddleware } from '../../../rtk-integration';
import { createRocHookMiddleware } from '../hooks';
import type { RocHookMiddlewareOptions } from '../hooks';
import {
  createForgeTieredCompactionMiddleware,
  createForgeCleanupMiddleware,
  createErrorBudgetMiddleware,
  createForgeIterationTrackingMiddleware,
  createRescueParsingMiddleware,
  createFilesystemToolErrorMiddleware,
  createToolResolutionMiddleware,
  createToolRuntimeErrorMiddleware,
  createPromptCachingMiddleware
} from '../forge-guardrails';
import type { RescueToolCandidate } from '../forge-guardrails';
import type { RocCompositeBackend } from './backend';
import { createRocFilesystemPathPolicyMiddleware } from './filesystem-path-policy';
import { ensureRocHarnessProfilesRegistered } from './harness-profiles';
import {
  createRocPlanRuntimeToolGuardMiddleware,
  createRocPlanToolExposureMiddleware,
  isPlanModeModelVisibleToolName
} from './model-tool-exposure';
import { createRocPlanReadOnlyFilesystemTools, createRocPlanReadOnlyMemoryMiddleware } from './plan-readonly-tools';
import { createRocShellPathPolicyMiddleware } from './shell-path-policy';
import { createToolProtocolMiddleware } from './tool-protocol';
import { DEEP_AGENT_BUILT_IN_TOOLS, type RuntimeSubagent } from './types';

export type DeepAgentBuildInput = {
  mode: ChatStartRunRequest['mode'];
  model: BaseChatModel;
  systemPrompt: string;
  backend: RocCompositeBackend;
  store: BaseStore;
  memorySources: string[];
  skillSources: string[];
  subagents: RuntimeSubagent[];
  tools: ClientTool[];
  filesystemPermissions: FilesystemPermission[] | undefined;
  workspacePath: string | null;
  interruptOn: NonNullable<Parameters<typeof createDeepAgent>[0]>['interruptOn'];
  checkpointer: BaseCheckpointSaver | undefined;
  providerType: ProviderType;
  workflowHint: WorkflowHint;
  contextBudgetTokens: number | undefined;
  hookMiddleware?: RocHookMiddlewareOptions;
};

const NETWORK_SENSITIVE_TOOLS = ['web_read', 'web_search'] as const;
const PLAN_MODE_READ_ONLY_FILESYSTEM_TOOL_NAMES = new Set(['ls', 'read_file', 'glob', 'grep']);
type PlanModeSubagent = SubAgent | CompiledSubAgent;
type SubAgentMiddlewareTools = NonNullable<SubAgentMiddlewareOptions['defaultTools']>;

export function buildDeepAgent(input: DeepAgentBuildInput): ReturnType<typeof createDeepAgent> | ReturnType<typeof createAgent> {
  ensureRocHarnessProfilesRegistered();
  const rtkMiddleware = createRTKMiddleware(new RTKBinaryManager());
  const knownToolCandidates = (): RescueToolCandidate[] => {
    const candidates = [...input.tools.map((tool) => createRescueToolCandidate(tool)), ...DEEP_AGENT_BUILT_IN_TOOLS];
    if (input.mode !== 'plan') {
      return candidates;
    }
    return candidates.filter((candidate) =>
      isPlanModeModelVisibleToolName(typeof candidate === 'string' ? candidate : candidate.name)
    );
  };
  const hookMiddleware = input.hookMiddleware === undefined ? [] : [createRocHookMiddleware(input.hookMiddleware)];
  const planModeToolExposureMiddleware =
    input.mode === 'plan'
      ? [createRocPlanToolExposureMiddleware(), createRocPlanRuntimeToolGuardMiddleware()]
      : [];
  const guardrails = [
    ...hookMiddleware,
    ...planModeToolExposureMiddleware,
    createRocShellPathPolicyMiddleware({ workspacePath: input.workspacePath }),
    rtkMiddleware,
    createPromptCachingMiddleware({
      enabled: true,
      strategy: 'balanced',
      providerType: input.providerType
    }),
    toolRetryMiddleware({
      maxRetries: 2,
      tools: [...NETWORK_SENSITIVE_TOOLS],
      backoffFactor: 1.5
    }),
    createToolProtocolMiddleware(),
    createErrorBudgetMiddleware(),
    createForgeIterationTrackingMiddleware(),
    createRocFilesystemPathPolicyMiddleware(),
    createFilesystemToolErrorMiddleware(),
    createForgeTieredCompactionMiddleware({
      budgetTokens: input.contextBudgetTokens
    }),
    createRescueParsingMiddleware({ availableTools: knownToolCandidates }),
    createToolResolutionMiddleware(),
    createToolRuntimeErrorMiddleware(),
    createForgeCleanupMiddleware()
  ];

  if (input.mode === 'plan') {
    const planTools = createPlanModeRegisteredTools(input);
    return createAgent({
      model: input.model,
      systemPrompt: input.systemPrompt,
      tools: planTools,
      store: input.store,
      checkpointer: input.checkpointer,
      middleware: [
        todoListMiddleware(),
        createRocPlanReadOnlyMemoryMiddleware({
          backend: input.backend,
          memorySources: input.memorySources
        }),
        ...(
          input.skillSources.length === 0
            ? []
            : [createSkillsMiddleware({ backend: input.backend, sources: input.skillSources })]
        ),
        createPlanModeTaskMiddleware(input, planTools),
        ...guardrails
      ]
    });
  }

  return createDeepAgent({
    model: input.model,
    systemPrompt: input.systemPrompt,
    backend: input.backend,
    store: input.store,
    memory: input.memorySources,
    skills: input.skillSources,
    subagents: input.subagents,
    tools: input.tools,
    permissions: input.filesystemPermissions,
    interruptOn: input.interruptOn,
    checkpointer: input.checkpointer,
    middleware: guardrails
  });
}

function createPlanModeRegisteredTools(input: DeepAgentBuildInput): ClientTool[] {
  const providedTools = input.tools.filter((tool) => {
    if (!isPlanModeModelVisibleToolName(tool.name)) {
      return false;
    }
    return !PLAN_MODE_READ_ONLY_FILESYSTEM_TOOL_NAMES.has(tool.name);
  });
  return [...providedTools, ...createRocPlanReadOnlyFilesystemTools(input.backend)];
}

function createPlanModeTaskMiddleware(input: DeepAgentBuildInput, planTools: ClientTool[]) {
  return createSubAgentMiddleware({
    defaultModel: input.model,
    defaultTools: planTools as unknown as SubAgentMiddlewareTools,
    defaultMiddleware: createPlanModeSubagentMiddleware(input),
    subagents: input.subagents.filter(isPlanModeSubagent),
    generalPurposeAgent: true
  });
}

function createPlanModeSubagentMiddleware(input: DeepAgentBuildInput) {
  return [
    todoListMiddleware(),
    createRocPlanReadOnlyMemoryMiddleware({
      backend: input.backend,
      memorySources: input.memorySources
    }),
    ...(
      input.skillSources.length === 0
        ? []
        : [createSkillsMiddleware({ backend: input.backend, sources: input.skillSources })]
    ),
    createRocPlanToolExposureMiddleware(),
    createRocPlanRuntimeToolGuardMiddleware(),
    createRocShellPathPolicyMiddleware({ workspacePath: input.workspacePath }),
    createRocFilesystemPathPolicyMiddleware(),
    createFilesystemToolErrorMiddleware(),
    createToolProtocolMiddleware(),
    createToolResolutionMiddleware(),
    createToolRuntimeErrorMiddleware()
  ];
}

function isPlanModeSubagent(subagent: RuntimeSubagent): subagent is PlanModeSubagent {
  return !('graphId' in subagent);
}

function createRescueToolCandidate(tool: ClientTool): RescueToolCandidate {
  const schema = Reflect.get(tool, 'schema');
  if (!(schema instanceof z.ZodObject)) {
    return tool.name;
  }
  return {
    name: tool.name,
    acceptsBareArgs: (args) => acceptsBareArgs(schema, args)
  };
}

function acceptsBareArgs(schema: z.ZodObject, args: Record<string, unknown>): boolean {
  const parsed = schema.safeParse(args);
  if (!parsed.success || !isRecord(parsed.data)) {
    return false;
  }
  return Object.keys(args).every((key) => Object.prototype.hasOwnProperty.call(parsed.data, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
