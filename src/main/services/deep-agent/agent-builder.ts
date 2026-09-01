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
  todoListMiddleware
} from 'langchain';
import { SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { RunCapabilityExecutionScopeV1, RunCapabilityManifestV1, RunExecutionSnapshotV2 } from '../../../shared/types';
import type { RocHookMiddlewareOptions } from '../hooks';
import type { RescueToolCandidate } from '../forge-guardrails';
import type { RocCompositeBackend } from './backend';
import {
  createRocFilesystemPermissions,
  createRocReadOnlyFilesystemPermissions
} from './filesystem-tool-contract';
import { ensureRocHarnessProfilesRegistered } from './harness-profiles';
import {
  type ContextCompactionWiring,
  type DeepAgentMiddleware,
  type MiddlewareStackContext,
  resolveMiddlewareStack
} from './middleware-stack';
import { isPlanModeModelVisibleToolName } from './model-tool-exposure';
import type { AgentToolEffectStore } from './tool-effect-store';
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
  contextCompaction?: ContextCompactionWiring;
};

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
  /**
   * 运行时注册进 ToolNode 的工具名全集：自定义工具 ∪ deepagents 内置工具。
   * Plan Mode 的工具过滤只作用于模型可见性（wrapModelCall），不影响 ToolNode 注册，
   * 因此内置工具在两种模式下都属于绑定集合。
   */
  boundToolNames: readonly string[];
  filesystemPermissions: ReturnType<typeof createRocFilesystemPermissions>;
  interruptOn: NonNullable<Parameters<typeof createDeepAgent>[0]>['interruptOn'];
  workspaceHash: string | null;
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
    boundToolNames: [
      ...new Set([...input.tools.map((tool) => tool.name), ...DEEP_AGENT_BUILT_IN_TOOLS])
    ],
    filesystemPermissions: snapshot.mode === 'plan'
      ? createRocReadOnlyFilesystemPermissions()
      : createRocFilesystemPermissions(),
    interruptOn: compileInterruptPolicy(snapshot),
    workspaceHash: snapshot.workspace === null ? null : snapshot.workspace.hash,
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
    middleware: resolveMiddlewareStack(createMiddlewareStackContext(input, policy, 'main', knownToolCandidates))
  });
}

function createMiddlewareStackContext(
  input: DeepAgentBuildInput,
  policy: DeepAgentBuildPolicy,
  executionScope: RunCapabilityExecutionScopeV1,
  knownToolCandidates: () => RescueToolCandidate[]
): MiddlewareStackContext {
  return {
    backend: input.backend,
    contextCompaction: input.contextCompaction,
    executionScope,
    hookMiddleware: input.hookMiddleware,
    knownToolCandidates,
    memorySources: input.memorySources,
    model: input.model,
    policy,
    toolEffectStore: input.toolEffectStore
  };
}

/**
 * 子代理拿不到主 agent 的工具全集，所以 rescue 不装在 subagent scope；spec 已经按 scope 把它挡掉，
 * 这里只需给出一个永不被调用的候选集来源，用抛错替代空数组，免得将来 spec 改了却静默拿到空候选。
 */
function subagentToolCandidates(): () => RescueToolCandidate[] {
  return () => {
    throw new Error('agent_subagent_rescue_candidates_unavailable');
  };
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
  const scopedTools = filterToolsForExecutionScope(tools, policy.capabilityManifest, 'subagent');
  // 每个子代理各解一份栈实例：hook middleware 持有排队上下文等可变闭包状态，共享实例会跨子代理泄漏。
  const resolveSubagentGuardrails = (): DeepAgentMiddleware[] => resolveMiddlewareStack(
    createMiddlewareStackContext(input, policy, 'subagent', subagentToolCandidates())
  );
  const generalPurposeSubagent: SubAgent = {
    ...GENERAL_PURPOSE_SUBAGENT,
    tools: scopedTools as unknown as SubagentTools,
    skills: [...input.skillSources],
    middleware: resolveSubagentGuardrails(),
    ...(policy.interruptOn === undefined ? {} : { interruptOn: policy.interruptOn })
  };
  return [
    compileRocSubagent(input, policy, generalPurposeSubagent),
    ...declarativeSubagents.map((subagent) =>
      compileRocSubagent(input, policy, applySubagentMiddleware(policy, subagent, scopedTools, resolveSubagentGuardrails()))
    )
  ];
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

/** 声明式子代理自带的 middleware 排在 Roc guardrail 栈之前：它先声明，Roc 的安全契约后追加。 */
function applySubagentMiddleware(
  policy: DeepAgentBuildPolicy,
  subagent: SubAgent,
  defaultTools: ClientTool[],
  guardrails: readonly DeepAgentMiddleware[]
): SubAgent {
  const declared = subagent.middleware === undefined ? [] : [...subagent.middleware];
  const tools = subagent.tools === undefined
    ? defaultTools
    : filterToolsForExecutionScope(subagent.tools, policy.capabilityManifest, 'subagent');
  return {
    ...subagent,
    tools: tools as unknown as SubagentTools,
    ...(policy.interruptOn === undefined ? {} : { interruptOn: policy.interruptOn }),
    middleware: [...declared, ...guardrails]
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
