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
import type { SubAgent } from 'deepagents';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import {
  anthropicPromptCachingMiddleware,
  createMiddleware,
  todoListMiddleware,
  toolRetryMiddleware
} from 'langchain';
import { SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { RunCapabilityExecutionScopeV1, RunCapabilityManifestV1, RunExecutionSnapshotV2 } from '../../../shared/types';
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
import {
  createRocFilesystemPermissions,
  createRocReadOnlyFilesystemPermissions
} from './filesystem-tool-contract';
import { ensureRocHarnessProfilesRegistered } from './harness-profiles';
import {
  createRocPlanRuntimeToolGuardMiddleware,
  createRocPlanToolExposureMiddleware,
  isPlanModeModelVisibleToolName
} from './model-tool-exposure';
import { createRocPlanFilesystemDefaultPathMiddleware } from './plan-filesystem-defaults';
import { createRocPlanReadOnlyMemoryMiddleware } from './plan-readonly-tools';
import { createRocShellPolicyMiddleware } from './shell-policy';
import { createToolEffectIdempotencyMiddleware } from './tool-effect-idempotency';
import type { AgentToolEffectStore } from './tool-effect-store';
import { createToolProtocolMiddleware } from './tool-protocol';
import { DEEP_AGENT_BUILT_IN_TOOLS, type RuntimeSubagent } from './types';

export type DeepAgentBuildInput = {
  snapshot: RunExecutionSnapshotV2;
  model: BaseChatModel;
  systemPrompt: string;
  backend: RocCompositeBackend;
  store: BaseStore;
  memorySources: string[];
  skillSources: string[];
  subagents: RuntimeSubagent[];
  tools: ClientTool[];
  checkpointer: BaseCheckpointSaver | undefined;
  hookMiddleware?: RocHookMiddlewareOptions;
  toolEffectStore?: AgentToolEffectStore;
  contextCompaction?: {
    artifactStore: ContextArtifactStore;
    artifactRecoveryEnabled?: boolean;
    budgetProfile: ContextBudgetProfile;
    emitEvent: RocContextCompactionOptions['emitEvent'];
    tokenCounter: ContextTokenCounter;
  };
};

const NETWORK_SENSITIVE_TOOLS = ['web_read', 'web_search'] as const;
const DEEP_AGENT_RESERVED_TOOL_NAMES = new Set<string>([
  ...DEEP_AGENT_BUILT_IN_TOOLS,
  'execute'
]);
type SubagentTools = NonNullable<SubAgent['tools']>;

type DeepAgentBuildPolicy = {
  runId: string;
  threadId: string;
  mode: RunExecutionSnapshotV2['mode'];
  capabilityManifest: RunCapabilityManifestV1;
  filesystemPermissions: ReturnType<typeof createRocFilesystemPermissions>;
  interruptOn: NonNullable<Parameters<typeof createDeepAgent>[0]>['interruptOn'];
  workspacePath: string | null;
  contextBudgetTokens: number | undefined;
};

function compileDeepAgentBuildPolicy(input: DeepAgentBuildInput): DeepAgentBuildPolicy {
  const { snapshot } = input;
  return {
    runId: snapshot.runId,
    threadId: snapshot.threadId,
    mode: snapshot.mode,
    capabilityManifest: snapshot.capabilityManifest,
    filesystemPermissions: snapshot.mode === 'plan'
      ? createRocReadOnlyFilesystemPermissions()
      : createRocFilesystemPermissions(),
    interruptOn: compileInterruptPolicy(snapshot),
    workspacePath: snapshot.workspace === null ? null : snapshot.workspace.path,
    contextBudgetTokens: snapshot.budget.contextBudgetTokens === null
      ? undefined
      : snapshot.budget.contextBudgetTokens
  };
}

function compileInterruptPolicy(
  snapshot: RunExecutionSnapshotV2
): DeepAgentBuildPolicy['interruptOn'] {
  const interruptOn: NonNullable<DeepAgentBuildPolicy['interruptOn']> = {};
  for (const tool of snapshot.capabilityManifest.tools) {
    if (tool.approvalPolicy.kind === 'required') {
      interruptOn[tool.modelVisibleName] = {
        allowedDecisions: tool.approvalPolicy.allowedDecisions
      };
    }
  }
  if (
    snapshot.runOrigin === 'workbench_creation' &&
    (snapshot.workflowHint === 'propose_background_task' || snapshot.workflowHint === 'background_task_change')
  ) {
    interruptOn.update_background_task = {
      allowedDecisions: ['approve', 'edit', 'reject']
    };
    interruptOn.cancel_background_task = {
      allowedDecisions: ['approve', 'edit', 'reject']
    };
  }
  return Object.keys(interruptOn).length === 0 ? undefined : interruptOn;
}

export function buildDeepAgent(input: DeepAgentBuildInput): ReturnType<typeof createDeepAgent> {
  ensureRocHarnessProfilesRegistered();
  const policy = compileDeepAgentBuildPolicy(input);
  const knownToolCandidates = (): RescueToolCandidate[] => {
    const candidates = [...input.tools.map((tool) => createRescueToolCandidate(tool)), ...DEEP_AGENT_BUILT_IN_TOOLS];
    if (policy.mode !== 'plan') {
      return candidates;
    }
    return candidates.filter((candidate) =>
      isPlanModeModelVisibleToolName(typeof candidate === 'string' ? candidate : candidate.name)
    );
  };
  const tools = policy.mode === 'plan' ? createPlanModeCustomTools(input) : input.tools;
  const subagents = createDeepAgentSubagents(input, policy, tools);
  const hookMiddleware = createRunHookMiddleware(input);
  const planModeMiddleware =
    policy.mode === 'plan'
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
    todoListMiddleware(),
    ...hookMiddleware,
    ...planModeMiddleware,
    ...createExecutionSafetyMiddleware(policy, 'main'),
    ...createContextCompactionMiddleware(input, policy),
    ...createExecutionErrorEnvelopeMiddleware(policy, input.toolEffectStore, knownToolCandidates),
    createForgeCleanupMiddleware()
  ];

  return createDeepAgent({
    model: input.model,
    systemPrompt: input.systemPrompt,
    backend: input.backend,
    store: input.store,
    memory: policy.mode === 'plan' ? [] : input.memorySources,
    skills: input.skillSources,
    subagents,
    tools,
    permissions: policy.filesystemPermissions,
    interruptOn: policy.interruptOn,
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

function createDeepAgentSubagents(input: DeepAgentBuildInput, policy: DeepAgentBuildPolicy, tools: ClientTool[]): RuntimeSubagent[] {
  const declarativeSubagents = requireDeclarativeSubagents(input.subagents);
  if (policy.mode === 'plan') {
    return createPlanModeSubagents(input, policy, tools, declarativeSubagents);
  }
  return createRunModeSubagents(input, policy, tools, declarativeSubagents);
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
  policy: DeepAgentBuildPolicy,
  tools: ClientTool[],
  subagents: SubAgent[]
): RuntimeSubagent[] {
  const scopedTools = filterToolsForExecutionScope(tools, policy.capabilityManifest, 'subagent');
  const generalPurposeSubagent: SubAgent = {
    ...GENERAL_PURPOSE_SUBAGENT,
    tools: scopedTools as unknown as SubagentTools,
    skills: [...input.skillSources],
    middleware: createRunModeSubagentMiddleware(input, policy),
    ...(policy.interruptOn === undefined ? {} : { interruptOn: policy.interruptOn })
  };
  return [
    compileRocSubagent(input, policy, generalPurposeSubagent),
    ...subagents.map((subagent) =>
      compileRocSubagent(input, policy, applyRunModeSubagentMiddleware(input, policy, subagent, scopedTools))
    )
  ];
}

function createPlanModeSubagents(
  input: DeepAgentBuildInput,
  policy: DeepAgentBuildPolicy,
  planTools: ClientTool[],
  subagents: SubAgent[]
): RuntimeSubagent[] {
  const scopedTools = filterToolsForExecutionScope(planTools, policy.capabilityManifest, 'subagent');
  const generalPurposeSubagent: SubAgent = {
    ...GENERAL_PURPOSE_SUBAGENT,
    tools: scopedTools as unknown as SubagentTools,
    skills: [...input.skillSources],
    middleware: createPlanModeSubagentMiddleware(input, policy),
    ...(policy.interruptOn === undefined ? {} : { interruptOn: policy.interruptOn })
  };
  return [
    compileRocSubagent(input, policy, generalPurposeSubagent),
    ...subagents
      .map((subagent) => compileRocSubagent(input, policy, applyPlanModeSubagentMiddleware(input, policy, subagent, scopedTools)))
  ];
}

function compileRocSubagent(input: DeepAgentBuildInput, policy: DeepAgentBuildPolicy, spec: SubAgent): CompiledSubAgent {
  const tools = spec.tools === undefined ? [] : spec.tools;
  const model = spec.model === undefined ? input.model : spec.model;
  const middleware = [
    todoListMiddleware(),
    createFilesystemMiddleware({
      backend: input.backend,
      permissions: spec.permissions === undefined ? policy.filesystemPermissions : spec.permissions
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
  policy: DeepAgentBuildPolicy,
  subagent: SubAgent,
  defaultTools: ClientTool[]
): SubAgent {
  const middleware = subagent.middleware === undefined ? [] : [...subagent.middleware];
  const tools = subagent.tools === undefined
    ? defaultTools
    : filterToolsForExecutionScope(subagent.tools, policy.capabilityManifest, 'subagent');
  return {
    ...subagent,
    tools: tools as unknown as SubagentTools,
    ...(policy.interruptOn === undefined ? {} : { interruptOn: policy.interruptOn }),
    middleware: [...middleware, ...createPlanModeSubagentMiddleware(input, policy)]
  };
}

function applyRunModeSubagentMiddleware(
  input: DeepAgentBuildInput,
  policy: DeepAgentBuildPolicy,
  subagent: SubAgent,
  defaultTools: ClientTool[]
): SubAgent {
  const middleware = subagent.middleware === undefined ? [] : [...subagent.middleware];
  const tools = subagent.tools === undefined
    ? defaultTools
    : filterToolsForExecutionScope(subagent.tools, policy.capabilityManifest, 'subagent');
  return {
    ...subagent,
    tools: tools as unknown as SubagentTools,
    ...(policy.interruptOn === undefined ? {} : { interruptOn: policy.interruptOn }),
    middleware: [...middleware, ...createRunModeSubagentMiddleware(input, policy)]
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

function createPlanModeSubagentMiddleware(input: DeepAgentBuildInput, policy: DeepAgentBuildPolicy) {
  return [
    ...createHookToolScopeMiddleware(input),
    createRocPlanReadOnlyMemoryMiddleware({
      backend: input.backend,
      memorySources: input.memorySources
    }),
    createRocPlanToolExposureMiddleware(),
    createRocPlanRuntimeToolGuardMiddleware(),
    createRocPlanFilesystemDefaultPathMiddleware(),
    ...createExecutionSafetyMiddleware(policy, 'subagent'),
    ...createContextCompactionMiddleware(input, policy),
    ...createExecutionErrorEnvelopeMiddleware(policy, input.toolEffectStore)
  ];
}

function createRunModeSubagentMiddleware(input: DeepAgentBuildInput, policy: DeepAgentBuildPolicy) {
  return [
    ...createHookToolScopeMiddleware(input),
    ...createExecutionSafetyMiddleware(policy, 'subagent'),
    ...createContextCompactionMiddleware(input, policy),
    ...createExecutionErrorEnvelopeMiddleware(policy, input.toolEffectStore)
  ];
}

function createExecutionSafetyMiddleware(
  policy: DeepAgentBuildPolicy,
  executionScope: RunCapabilityExecutionScopeV1
) {
  return [
    createRocShellPolicyMiddleware({ workspacePath: policy.workspacePath }),
    createRTKMiddleware(new RTKBinaryManager()),
    createToolProtocolMiddleware({
      capabilityManifest: policy.capabilityManifest,
      executionScope
    }),
    createErrorBudgetMiddleware(),
    createForgeIterationTrackingMiddleware(),
    createRocFilesystemPathPolicyMiddleware(),
    createFilesystemToolErrorMiddleware()
  ];
}

function createExecutionErrorEnvelopeMiddleware(
  policy: DeepAgentBuildPolicy,
  toolEffectStore: AgentToolEffectStore | undefined,
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
    ...createToolEffectMiddleware(policy, toolEffectStore)
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

function createToolEffectMiddleware(policy: DeepAgentBuildPolicy, toolEffectStore: AgentToolEffectStore | undefined) {
  if (toolEffectStore === undefined) {
    return [];
  }
  return [
    createToolEffectIdempotencyMiddleware({
      runId: policy.runId,
      threadId: policy.threadId,
      store: toolEffectStore,
      capabilityManifest: policy.capabilityManifest
    })
  ];
}

function createContextCompactionMiddleware(input: DeepAgentBuildInput, policy: DeepAgentBuildPolicy) {
  if (input.contextCompaction === undefined) {
    return [
      createForgeTieredCompactionMiddleware({
        budgetTokens: policy.contextBudgetTokens
      })
    ];
  }
  return [
    createRocContextCompactionMiddleware({
      artifactStore: input.contextCompaction.artifactStore,
      artifactRecoveryEnabled: input.contextCompaction.artifactRecoveryEnabled,
      budgetProfile: input.contextCompaction.budgetProfile,
      emitEvent: input.contextCompaction.emitEvent,
      mode: input.snapshot.mode,
      model: input.model,
      runId: input.snapshot.runId,
      threadId: input.snapshot.threadId,
      tokenCounter: input.contextCompaction.tokenCounter,
      workspaceHash: input.snapshot.workspace === null ? null : input.snapshot.workspace.hash,
      workspacePath: policy.workspacePath
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
