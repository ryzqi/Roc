import { GENERAL_PURPOSE_SUBAGENT, createDeepAgent } from 'deepagents';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ClientTool } from '@langchain/core/tools';
import type { FilesystemPermission, SubAgent } from 'deepagents';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import { toolRetryMiddleware } from 'langchain';
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
import { createRocPlanFilesystemDefaultPathMiddleware } from './plan-filesystem-defaults';
import { createRocPlanReadOnlyMemoryMiddleware } from './plan-readonly-tools';
import { createRocShellPathPolicyMiddleware } from './shell-path-policy';
import { createToolEffectIdempotencyMiddleware } from './tool-effect-idempotency';
import type { AgentToolEffectStore } from './tool-effect-store';
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
  toolEffectIdempotency?: {
    runId: string;
    threadId: string;
    store: AgentToolEffectStore;
  };
};

const NETWORK_SENSITIVE_TOOLS = ['web_read', 'web_search'] as const;
const DEEP_AGENT_RESERVED_TOOL_NAMES = new Set<string>([
  ...DEEP_AGENT_BUILT_IN_TOOLS,
  'execute'
]);
type PlanModeSubagentTools = NonNullable<SubAgent['tools']>;

export function buildDeepAgent(input: DeepAgentBuildInput): ReturnType<typeof createDeepAgent> {
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
  const tools = input.mode === 'plan' ? createPlanModeCustomTools(input) : input.tools;
  const subagents = input.mode === 'plan' ? createPlanModeSubagents(input, tools) : input.subagents;
  const hookMiddleware = input.hookMiddleware === undefined ? [] : [createRocHookMiddleware(input.hookMiddleware)];
  const toolEffectMiddleware = createToolEffectMiddleware(input);
  const planModeMiddleware =
    input.mode === 'plan'
      ? [
          createRocPlanReadOnlyMemoryMiddleware({
            backend: input.backend,
            memorySources: input.memorySources
          }),
          createRocPlanToolExposureMiddleware(),
          createRocPlanRuntimeToolGuardMiddleware(),
          createRocPlanFilesystemDefaultPathMiddleware()
        ]
      : [];
  const guardrails = [
    ...hookMiddleware,
    ...planModeMiddleware,
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
    ...toolEffectMiddleware,
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

  return createDeepAgent({
    model: input.model,
    systemPrompt: input.systemPrompt,
    backend: input.backend,
    store: input.store,
    memory: input.mode === 'plan' ? [] : input.memorySources,
    skills: input.skillSources,
    subagents,
    tools,
    permissions: input.filesystemPermissions,
    interruptOn: input.interruptOn,
    checkpointer: input.checkpointer,
    middleware: guardrails
  });
}

function createPlanModeCustomTools(input: DeepAgentBuildInput): ClientTool[] {
  return input.tools.filter((tool) => {
    if (!isPlanModeModelVisibleToolName(tool.name)) {
      return false;
    }
    return !DEEP_AGENT_RESERVED_TOOL_NAMES.has(tool.name);
  });
}

function createPlanModeSubagents(input: DeepAgentBuildInput, planTools: ClientTool[]): RuntimeSubagent[] {
  const generalPurposeSubagent: SubAgent = {
    ...GENERAL_PURPOSE_SUBAGENT,
    tools: planTools as unknown as PlanModeSubagentTools,
    skills: [...input.skillSources],
    middleware: createPlanModeSubagentMiddleware(input)
  };
  return [
    generalPurposeSubagent,
    ...input.subagents.filter(isPlanModeInlineSubagent).map((subagent) => applyPlanModeSubagentMiddleware(input, subagent))
  ];
}

function applyPlanModeSubagentMiddleware(input: DeepAgentBuildInput, subagent: RuntimeSubagent): RuntimeSubagent {
  if (!isSubAgentSpec(subagent)) {
    return subagent;
  }
  const middleware = subagent.middleware === undefined ? [] : [...subagent.middleware];
  return {
    ...subagent,
    middleware: [...middleware, ...createPlanModeSubagentMiddleware(input)]
  };
}

function createPlanModeSubagentMiddleware(input: DeepAgentBuildInput) {
  const toolEffectMiddleware = createToolEffectMiddleware(input);
  return [
    createRocPlanReadOnlyMemoryMiddleware({
      backend: input.backend,
      memorySources: input.memorySources
    }),
    createRocPlanToolExposureMiddleware(),
    createRocPlanRuntimeToolGuardMiddleware(),
    createRocPlanFilesystemDefaultPathMiddleware(),
    createRocShellPathPolicyMiddleware({ workspacePath: input.workspacePath }),
    createRocFilesystemPathPolicyMiddleware(),
    createFilesystemToolErrorMiddleware(),
    createToolProtocolMiddleware(),
    ...toolEffectMiddleware,
    createToolResolutionMiddleware(),
    createToolRuntimeErrorMiddleware()
  ];
}

function createToolEffectMiddleware(input: DeepAgentBuildInput) {
  if (input.toolEffectIdempotency === undefined) {
    return [];
  }
  return [
    createToolEffectIdempotencyMiddleware({
      runId: input.toolEffectIdempotency.runId,
      threadId: input.toolEffectIdempotency.threadId,
      store: input.toolEffectIdempotency.store
    })
  ];
}

function isPlanModeInlineSubagent(subagent: RuntimeSubagent): boolean {
  return !('graphId' in subagent);
}

function isSubAgentSpec(subagent: RuntimeSubagent): subagent is SubAgent {
  return 'systemPrompt' in subagent;
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
