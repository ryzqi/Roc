import { GENERAL_PURPOSE_SUBAGENT, createDeepAgent } from 'deepagents';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ClientTool } from '@langchain/core/tools';
import type { FilesystemPermission, SubAgent } from 'deepagents';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import { modelCallLimitMiddleware, toolCallLimitMiddleware, toolRetryMiddleware } from 'langchain';
import { z } from 'zod';
import type { ChatStartRunRequest, RunCapabilityExecutionScopeV1, RunCapabilityManifestV1, WorkflowHint } from '../../../shared/types';
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
  createToolRuntimeErrorMiddleware
} from '../forge-guardrails';
import type { RescueToolCandidate } from '../forge-guardrails';
import type { RocCompositeBackend } from './backend';
import type { ContextArtifactStore } from './context/context-artifact-store';
import {
  createRocContextCompactionMiddleware,
  type ContextCompactionMode,
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
    emitEvent: RocContextCompactionOptions['emitEvent'];
    mode: ContextCompactionMode;
    runId: string;
    threadId: string;
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
    ...createExecutionErrorEnvelopeMiddleware(knownToolCandidates),
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
  assertDeclarativeSubagents(input.subagents);
  if (input.mode === 'plan') {
    return createPlanModeSubagents(input, tools);
  }
  return createRunModeSubagents(input, tools);
}

function assertDeclarativeSubagents(subagents: RuntimeSubagent[]): void {
  for (const subagent of subagents) {
    if (!isSubAgentSpec(subagent)) {
      throw new Error(`agent_subagent_safety_contract_unsupported:${subagent.name}`);
    }
  }
}

function createRunModeSubagents(input: DeepAgentBuildInput, tools: ClientTool[]): RuntimeSubagent[] {
  const scopedTools = filterToolsForExecutionScope(tools, input.capabilityManifest, 'subagent');
  const generalPurposeSubagent: SubAgent = {
    ...GENERAL_PURPOSE_SUBAGENT,
    tools: scopedTools as unknown as SubagentTools,
    skills: [...input.skillSources],
    middleware: createRunModeSubagentMiddleware(input),
    ...(input.interruptOn === undefined ? {} : { interruptOn: input.interruptOn })
  };
  return [
    generalPurposeSubagent,
    ...input.subagents.map((subagent) => applyRunModeSubagentMiddleware(input, subagent, scopedTools))
  ];
}

function createPlanModeSubagents(input: DeepAgentBuildInput, planTools: ClientTool[]): RuntimeSubagent[] {
  const scopedTools = filterToolsForExecutionScope(planTools, input.capabilityManifest, 'subagent');
  const generalPurposeSubagent: SubAgent = {
    ...GENERAL_PURPOSE_SUBAGENT,
    tools: scopedTools as unknown as SubagentTools,
    skills: [...input.skillSources],
    middleware: createPlanModeSubagentMiddleware(input),
    ...(input.interruptOn === undefined ? {} : { interruptOn: input.interruptOn })
  };
  return [
    generalPurposeSubagent,
    ...input.subagents
      .filter(isPlanModeInlineSubagent)
      .map((subagent) => applyPlanModeSubagentMiddleware(input, subagent, scopedTools))
  ];
}

function applyPlanModeSubagentMiddleware(
  input: DeepAgentBuildInput,
  subagent: RuntimeSubagent,
  defaultTools: ClientTool[]
): RuntimeSubagent {
  if (!isSubAgentSpec(subagent)) {
    return subagent;
  }
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
  subagent: RuntimeSubagent,
  defaultTools: ClientTool[]
): RuntimeSubagent {
  if (!isSubAgentSpec(subagent)) {
    return subagent;
  }
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
    ...createExecutionErrorEnvelopeMiddleware(),
  ];
}

function createRunModeSubagentMiddleware(input: DeepAgentBuildInput) {
  return [
    ...createHookToolScopeMiddleware(input),
    ...createExecutionSafetyMiddleware(input, 'subagent'),
    ...createExecutionErrorEnvelopeMiddleware()
  ];
}

function createExecutionSafetyMiddleware(input: DeepAgentBuildInput, executionScope: RunCapabilityExecutionScopeV1) {
  const budgetMiddleware = createNativeBudgetMiddleware(input);
  return [
    createRocShellPathPolicyMiddleware({ workspacePath: input.workspacePath }),
    createRTKMiddleware(new RTKBinaryManager()),
    toolRetryMiddleware({
      maxRetries: 2,
      tools: [...NETWORK_SENSITIVE_TOOLS],
      backoffFactor: 1.5
    }),
    createToolProtocolMiddleware({
      capabilityManifest: input.capabilityManifest,
      executionScope
    }),
    ...budgetMiddleware,
    ...createToolEffectMiddleware(input),
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

function createExecutionErrorEnvelopeMiddleware(knownToolCandidates?: () => RescueToolCandidate[]) {
  const rescueMiddleware = knownToolCandidates === undefined
    ? []
    : [createRescueParsingMiddleware({ availableTools: knownToolCandidates })];
  return [
    ...rescueMiddleware,
    createToolResolutionMiddleware(),
    createToolRuntimeErrorMiddleware()
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
      store: input.toolEffectIdempotency.store
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
      budgetTokens: input.contextBudgetTokens === undefined ? 7168 : input.contextBudgetTokens,
      emitEvent: input.contextCompaction.emitEvent,
      mode: input.contextCompaction.mode,
      model: input.model,
      runId: input.contextCompaction.runId,
      threadId: input.contextCompaction.threadId,
      workspaceHash: input.contextCompaction.workspaceHash,
      workspacePath: input.workspacePath
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
