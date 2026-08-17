import {
  GENERAL_PURPOSE_SUBAGENT,
  createDeepAgent,
  createFilesystemMiddleware,
  createPatchToolCallsMiddleware,
  createSkillsMiddleware,
  createSubAgent,
  type CompiledSubAgent
} from 'deepagents';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ClientTool } from '@langchain/core/tools';
import type { FilesystemPermission, SubAgent } from 'deepagents';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import {
  anthropicPromptCachingMiddleware,
  createMiddleware,
  modelCallLimitMiddleware,
  todoListMiddleware,
  toolCallLimitMiddleware,
  toolRetryMiddleware
} from 'langchain';
import { SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { RunCapabilityExecutionScopeV1, RunCapabilityManifestV1, RunExecutionSnapshotV2, WorkflowHint } from '../../../shared/types';
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
  handleNetworkToolRetryFailure,
  shouldRetryNetworkToolError
} from '../forge-guardrails';
import type { RescueToolCandidate } from '../forge-guardrails';
import type { RocCompositeBackend } from './backend';
import type { ContextArtifactStore } from './context/context-artifact-store';
import type { ContextBudgetProfile, ContextTokenCounter } from './context/context-token-budget';
import {
  createRocContextCompactionMiddleware,
  type RocContextCompactionOptions
} from './context/context-compaction-pipeline';
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
import {
  createRocSubagentBudgetStateInitializationMiddleware,
  createRocSubagentStateIsolationMiddleware
} from './subagent-state-isolation';
import { createToolEffectIdempotencyMiddleware } from './tool-effect-idempotency';
import type { AgentToolEffectStore } from './tool-effect-store';
import { createToolProtocolMiddleware } from './tool-protocol';
import { DEEP_AGENT_BUILT_IN_TOOLS, type RuntimeSubagent } from './types';

export type DeepAgentBuildInput = {
  mode: RunExecutionSnapshotV2['mode'];
  model: BaseChatModel;
  systemPrompt: string;
  backend: RocCompositeBackend;
  store: BaseStore;
  memorySources: string[];
  skillSources: string[];
  subagents: RuntimeSubagent[];
  tools: ClientTool[];
  capabilityManifest: RunCapabilityManifestV1;
  filesystemPermissions: FilesystemPermission[] | undefined;
  workspacePath: string | null;
  interruptOn: NonNullable<Parameters<typeof createDeepAgent>[0]>['interruptOn'];
  checkpointer: BaseCheckpointSaver | undefined;
  workflowHint: WorkflowHint;
  contextBudgetTokens: number | undefined;
  modelCallLimit: number;
  modelThreadCallLimit: number;
  toolCallLimit: number;
  toolThreadCallLimit: number;
  hookMiddleware?: RocHookMiddlewareOptions;
  toolEffectIdempotency?: {
    runId: string;
    threadId: string;
    store: AgentToolEffectStore;
  };
  contextCompaction?: {
    artifactStore: ContextArtifactStore;
    artifactRecoveryEnabled?: boolean;
    budgetProfile: ContextBudgetProfile;
    emitEvent: RocContextCompactionOptions['emitEvent'];
    mode: RunExecutionSnapshotV2['mode'];
    runId: string;
    threadId: string;
    tokenCounter: ContextTokenCounter;
    workspaceHash: string | null;
  };
};

const NETWORK_SENSITIVE_TOOLS = ['web_read', 'web_search'] as const;
const DEEP_AGENT_RESERVED_TOOL_NAMES = new Set<string>([
  ...DEEP_AGENT_BUILT_IN_TOOLS,
  'execute'
]);
type SubagentTools = NonNullable<SubAgent['tools']>;

export function buildDeepAgent(input: DeepAgentBuildInput): ReturnType<typeof createDeepAgent> {
  ensureRocHarnessProfilesRegistered();
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
  const subagents = createDeepAgentSubagents(input, tools);
  const hookMiddleware = createRunHookMiddleware(input);
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
    ...createExecutionSafetyMiddleware(input, 'main'),
    ...createContextCompactionMiddleware(input),
    ...createExecutionErrorEnvelopeMiddleware(input, knownToolCandidates),
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

function createDeepAgentSubagents(input: DeepAgentBuildInput, tools: ClientTool[]): RuntimeSubagent[] {
  const declarativeSubagents = requireDeclarativeSubagents(input.subagents);
  if (input.mode === 'plan') {
    return createPlanModeSubagents(input, tools, declarativeSubagents);
  }
  return createRunModeSubagents(input, tools, declarativeSubagents);
}

function requireDeclarativeSubagents(subagents: RuntimeSubagent[]): SubAgent[] {
  const declarativeSubagents: SubAgent[] = [];
  for (const subagent of subagents) {
    if (!isSubAgentSpec(subagent)) {
      throw new Error(`agent_subagent_safety_contract_unsupported:${subagent.name}`);
    }
    declarativeSubagents.push(subagent);
  }
  return declarativeSubagents;
}

function createRunModeSubagents(
  input: DeepAgentBuildInput,
  tools: ClientTool[],
  subagents: SubAgent[]
): RuntimeSubagent[] {
  const scopedTools = filterToolsForExecutionScope(tools, input.capabilityManifest, 'subagent');
  const generalPurposeSubagent: SubAgent = {
    ...GENERAL_PURPOSE_SUBAGENT,
    tools: scopedTools as unknown as SubagentTools,
    skills: [...input.skillSources],
    middleware: createRunModeSubagentMiddleware(input),
    ...(input.interruptOn === undefined ? {} : { interruptOn: input.interruptOn })
  };
  return [
    compileRocSubagent(input, generalPurposeSubagent),
    ...subagents.map((subagent) =>
      compileRocSubagent(input, applyRunModeSubagentMiddleware(input, subagent, scopedTools))
    )
  ];
}

function createPlanModeSubagents(
  input: DeepAgentBuildInput,
  planTools: ClientTool[],
  subagents: SubAgent[]
): RuntimeSubagent[] {
  const scopedTools = filterToolsForExecutionScope(planTools, input.capabilityManifest, 'subagent');
  const generalPurposeSubagent: SubAgent = {
    ...GENERAL_PURPOSE_SUBAGENT,
    tools: scopedTools as unknown as SubagentTools,
    skills: [...input.skillSources],
    middleware: createPlanModeSubagentMiddleware(input),
    ...(input.interruptOn === undefined ? {} : { interruptOn: input.interruptOn })
  };
  return [
    compileRocSubagent(input, generalPurposeSubagent),
    ...subagents
      .map((subagent) => compileRocSubagent(input, applyPlanModeSubagentMiddleware(input, subagent, scopedTools)))
  ];
}

function compileRocSubagent(input: DeepAgentBuildInput, spec: SubAgent): CompiledSubAgent {
  const tools = spec.tools === undefined ? [] : spec.tools;
  const model = spec.model === undefined ? input.model : spec.model;
  const middleware = [
    todoListMiddleware(),
    createFilesystemMiddleware({
      backend: input.backend,
      permissions: spec.permissions === undefined ? input.filesystemPermissions : spec.permissions
    }),
    createPatchToolCallsMiddleware(),
    ...(spec.skills === undefined || spec.skills.length === 0
      ? []
      : [createSkillsMiddleware({ backend: input.backend, sources: [...spec.skills] })]),
    ...(spec.middleware === undefined ? [] : spec.middleware),
    ...createRocSubagentCacheMiddleware(model)
  ];
  const runnable = createSubAgent({
    ...spec,
    model,
    tools,
    middleware
  });
  return {
    name: spec.name,
    description: spec.description,
    runnable
  };
}

function createRocSubagentCacheMiddleware(model: NonNullable<SubAgent['model']>) {
  if (!isAnthropicModel(model)) {
    return [];
  }
  return [
    anthropicPromptCachingMiddleware({ unsupportedModelBehavior: 'ignore', minMessagesToCache: 1 }),
    createRocCacheBreakpointMiddleware()
  ];
}

function createRocCacheBreakpointMiddleware() {
  return createMiddleware({
    name: 'RocCacheBreakpointMiddleware',
    wrapModelCall: (request, handler) => {
      if (!isAnthropicModel(request.model)) {
        return handler(request);
      }
      const content = request.systemMessage.content;
      const blocks = typeof content === 'string'
        ? [{ type: 'text' as const, text: content }]
        : Array.isArray(content)
          ? [...content]
          : [];
      if (blocks.length === 0) {
        return handler(request);
      }
      blocks[blocks.length - 1] = {
        ...blocks[blocks.length - 1],
        cache_control: { type: 'ephemeral' }
      };
      return handler({
        ...request,
        systemMessage: new SystemMessage({ content: blocks })
      });
    }
  });
}

function isAnthropicModel(model: unknown): boolean {
  if (typeof model === 'string') {
    if (model.includes(':')) {
      return model.split(':')[0] === 'anthropic';
    }
    return model.startsWith('claude');
  }
  if (model === null || typeof model !== 'object') {
    return false;
  }
  const getName = Reflect.get(model, 'getName');
  if (typeof getName !== 'function') {
    return false;
  }
  const modelName = getName.call(model);
  if (modelName === 'ConfigurableModel') {
    const defaultConfig = Reflect.get(model, '_defaultConfig');
    if (defaultConfig === null || typeof defaultConfig !== 'object') {
      return false;
    }
    return Reflect.get(defaultConfig, 'modelProvider') === 'anthropic';
  }
  return modelName === 'ChatAnthropic';
}

function applyPlanModeSubagentMiddleware(
  input: DeepAgentBuildInput,
  subagent: SubAgent,
  defaultTools: ClientTool[]
): SubAgent {
  const middleware = subagent.middleware === undefined ? [] : [...subagent.middleware];
  const tools = subagent.tools === undefined
    ? defaultTools
    : filterToolsForExecutionScope(subagent.tools, input.capabilityManifest, 'subagent');
  return {
    ...subagent,
    tools: tools as unknown as SubagentTools,
    ...(input.interruptOn === undefined ? {} : { interruptOn: input.interruptOn }),
    middleware: [...middleware, ...createPlanModeSubagentMiddleware(input)]
  };
}

function applyRunModeSubagentMiddleware(
  input: DeepAgentBuildInput,
  subagent: SubAgent,
  defaultTools: ClientTool[]
): SubAgent {
  const middleware = subagent.middleware === undefined ? [] : [...subagent.middleware];
  const tools = subagent.tools === undefined
    ? defaultTools
    : filterToolsForExecutionScope(subagent.tools, input.capabilityManifest, 'subagent');
  return {
    ...subagent,
    tools: tools as unknown as SubagentTools,
    ...(input.interruptOn === undefined ? {} : { interruptOn: input.interruptOn }),
    middleware: [...middleware, ...createRunModeSubagentMiddleware(input)]
  };
}

function filterToolsForExecutionScope<T extends { name: string }>(
  tools: readonly T[],
  manifest: RunCapabilityManifestV1,
  executionScope: RunCapabilityExecutionScopeV1
): T[] {
  const allowedToolNames = new Set(
    manifest.tools
      .filter((tool) => tool.executionScopes.includes(executionScope))
      .map((tool) => tool.modelVisibleName)
  );
  return tools.filter((tool) => allowedToolNames.has(tool.name));
}

function createPlanModeSubagentMiddleware(input: DeepAgentBuildInput) {
  return [
    ...createHookToolScopeMiddleware(input),
    createRocPlanReadOnlyMemoryMiddleware({
      backend: input.backend,
      memorySources: input.memorySources
    }),
    createRocPlanToolExposureMiddleware(),
    createRocPlanRuntimeToolGuardMiddleware(),
    createRocPlanFilesystemDefaultPathMiddleware(),
    ...createExecutionSafetyMiddleware(input, 'subagent'),
    ...createContextCompactionMiddleware(input),
    ...createExecutionErrorEnvelopeMiddleware(input)
  ];
}

function createRunModeSubagentMiddleware(input: DeepAgentBuildInput) {
  return [
    ...createHookToolScopeMiddleware(input),
    ...createExecutionSafetyMiddleware(input, 'subagent'),
    ...createContextCompactionMiddleware(input),
    ...createExecutionErrorEnvelopeMiddleware(input)
  ];
}

function createExecutionSafetyMiddleware(input: DeepAgentBuildInput, executionScope: RunCapabilityExecutionScopeV1) {
  const budgetMiddleware = createNativeBudgetMiddleware(input);
  return [
    createRocShellPathPolicyMiddleware({ workspacePath: input.workspacePath }),
    createRTKMiddleware(new RTKBinaryManager()),
    createToolProtocolMiddleware({
      capabilityManifest: input.capabilityManifest,
      executionScope
    }),
    ...(executionScope === 'subagent'
      ? [createRocSubagentBudgetStateInitializationMiddleware()]
      : []),
    createRocSubagentStateIsolationMiddleware(),
    ...budgetMiddleware,
    createErrorBudgetMiddleware(),
    createForgeIterationTrackingMiddleware(),
    createRocFilesystemPathPolicyMiddleware(),
    createFilesystemToolErrorMiddleware()
  ];
}

function createNativeBudgetMiddleware(input: DeepAgentBuildInput) {
  return [
    modelCallLimitMiddleware({
      runLimit: input.modelCallLimit,
      threadLimit: input.modelThreadCallLimit,
      exitBehavior: 'error'
    }),
    toolCallLimitMiddleware({
      runLimit: input.toolCallLimit,
      threadLimit: input.toolThreadCallLimit,
      exitBehavior: 'error'
    })
  ];
}

function createExecutionErrorEnvelopeMiddleware(
  input: DeepAgentBuildInput,
  knownToolCandidates?: () => RescueToolCandidate[]
) {
  const rescueMiddleware = knownToolCandidates === undefined
    ? []
    : [createRescueParsingMiddleware({ availableTools: knownToolCandidates })];
  return [
    ...rescueMiddleware,
    toolRetryMiddleware({
      maxRetries: 2,
      tools: [...NETWORK_SENSITIVE_TOOLS],
      onFailure: handleNetworkToolRetryFailure,
      retryOn: shouldRetryNetworkToolError,
      backoffFactor: 1.5
    }),
    createToolRuntimeErrorMiddleware(),
    createToolResolutionMiddleware(),
    ...createToolEffectMiddleware(input)
  ];
}

function createRunHookMiddleware(input: DeepAgentBuildInput) {
  if (input.hookMiddleware === undefined) {
    return [];
  }
  return [
    createRocHookMiddleware({
      ...input.hookMiddleware,
      scope: 'run'
    })
  ];
}

function createHookToolScopeMiddleware(input: DeepAgentBuildInput) {
  if (input.hookMiddleware === undefined) {
    return [];
  }
  return [
    createRocHookMiddleware({
      ...input.hookMiddleware,
      scope: 'tool'
    })
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
      store: input.toolEffectIdempotency.store,
      capabilityManifest: input.capabilityManifest
    })
  ];
}

function createContextCompactionMiddleware(input: DeepAgentBuildInput) {
  if (input.contextCompaction === undefined) {
    return [
      createForgeTieredCompactionMiddleware({
        budgetTokens: input.contextBudgetTokens
      })
    ];
  }
  return [
    createRocContextCompactionMiddleware({
      artifactStore: input.contextCompaction.artifactStore,
      artifactRecoveryEnabled: input.contextCompaction.artifactRecoveryEnabled,
      budgetProfile: input.contextCompaction.budgetProfile,
      emitEvent: input.contextCompaction.emitEvent,
      mode: input.contextCompaction.mode,
      model: input.model,
      runId: input.contextCompaction.runId,
      threadId: input.contextCompaction.threadId,
      tokenCounter: input.contextCompaction.tokenCounter,
      workspaceHash: input.contextCompaction.workspaceHash,
      workspacePath: input.workspacePath
    })
  ];
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
