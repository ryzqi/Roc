import { createDeepAgent } from 'deepagents';
import { toolRetryMiddleware, todoListMiddleware } from 'langchain';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunCapabilityExecutionScopeV1, RunCapabilityManifestV1, RunExecutionMode } from '../../../shared/types';
import { RTKBinaryManager, createRTKMiddleware } from '../../../rtk-integration';
import { createRocHookMiddleware } from '../hooks';
import type { RocHookMiddlewareOptions } from '../hooks';
import {
  createErrorBudgetMiddleware,
  createFilesystemToolErrorMiddleware,
  createForgeCleanupMiddleware,
  createForgeIterationTrackingMiddleware,
  createForgeTieredCompactionMiddleware,
  createRescueParsingMiddleware,
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
  type PreCompactionFlushRecorder,
  type RocContextCompactionOptions
} from './context/context-compaction-pipeline';
import { createRocFilesystemPathPolicyMiddleware } from './filesystem-path-policy';
import {
  createRocPlanRuntimeToolGuardMiddleware,
  createRocPlanToolExposureMiddleware
} from './model-tool-exposure';
import { createRocPlanFilesystemDefaultPathMiddleware } from './plan-filesystem-defaults';
import { createRocPlanReadOnlyMemoryMiddleware } from './plan-readonly-tools';
import { createRocShellPolicyMiddleware } from './shell-policy';
import { createToolEffectIdempotencyMiddleware } from './tool-effect-idempotency';
import type { AgentToolEffectStore } from './tool-effect-store';
import { createToolProtocolMiddleware } from './tool-protocol';

const NETWORK_SENSITIVE_TOOLS = ['web_read', 'web_search'] as const;

export type DeepAgentMiddleware = NonNullable<NonNullable<Parameters<typeof createDeepAgent>[0]>['middleware']>[number];

export type ContextCompactionWiring = {
  artifactStore: ContextArtifactStore;
  artifactRecoveryEnabled?: boolean;
  budgetProfile: ContextBudgetProfile;
  emitEvent: RocContextCompactionOptions['emitEvent'];
  sessionHistory: PreCompactionFlushRecorder;
  tokenCounter: ContextTokenCounter;
};

/** 一次构建里所有 middleware 共用的决定：谁在哪个 scope、哪种 mode 下装配，以及各自要的依赖。 */
export type MiddlewareStackPolicy = {
  boundToolNames: readonly string[];
  capabilityManifest: RunCapabilityManifestV1;
  contextBudgetTokens: number | undefined;
  mode: RunExecutionMode;
  runId: string;
  threadId: string;
  workspaceHash: string | null;
  workspacePath: string | null;
};

export type MiddlewareStackContext = {
  backend: RocCompositeBackend;
  contextCompaction: ContextCompactionWiring | undefined;
  executionScope: RunCapabilityExecutionScopeV1;
  hookMiddleware: RocHookMiddlewareOptions | undefined;
  /**
   * 供 rescue 解析用的工具候选集。惰性求值：只有 main scope 真的装 rescue 时才会调用，
   * 而候选集在 plan mode 下要按模型可见性过滤，算它并不便宜。
   */
  knownToolCandidates: () => RescueToolCandidate[];
  memorySources: readonly string[];
  model: BaseChatModel;
  policy: MiddlewareStackPolicy;
  toolEffectStore: AgentToolEffectStore | undefined;
};

type MiddlewareStackEntry = {
  /** 必须与 `create` 造出来的 middleware 自报的 name 一致；由 spec 一致性测试守住。 */
  name: string;
  scopes: readonly RunCapabilityExecutionScopeV1[];
  modes: readonly RunExecutionMode[];
  /** 返回 null = 这次构建不装它（依赖缺失或条件不满足）。 */
  create: (context: MiddlewareStackContext) => DeepAgentMiddleware | null;
};

const ALL_SCOPES: readonly RunCapabilityExecutionScopeV1[] = ['main', 'subagent'];
const ALL_MODES: readonly RunExecutionMode[] = ['plan', 'run', 'task'];

/**
 * Roc guardrail 栈的唯一顺序来源。
 *
 * 顺序即语义：langchain 的 before hook 按声明序执行、after hook 反序执行，wrap hook 以第一个为最外层。
 * 所以"谁在谁前面"是 interface 事实，不是排版偏好 —— 从前它散在 main / plan subagent / run subagent
 * 三个手写数组里，读者要同时对齐三处才能回答一个顺序问题。现在改一格顺序只有一处可改。
 *
 * 这个数组只描述 Roc 追加的部分。deepagents 会把它整体接在内部 PatchToolCallsMiddleware 之后，
 * 那个相对位置由 createDeepAgent 拥有，不在这里表达。
 */
const MIDDLEWARE_STACK_SPEC: readonly MiddlewareStackEntry[] = [
  {
    name: 'todoListMiddleware',
    scopes: ['main'],
    modes: ALL_MODES,
    create: () => todoListMiddleware()
  },
  {
    // main scope 收 run 级 hook 事件，subagent scope 只收 tool 级：子代理不产生 run 生命周期。
    name: 'RocHookMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: (context) => context.hookMiddleware === undefined
      ? null
      : createRocHookMiddleware({
          ...context.hookMiddleware,
          scope: context.executionScope === 'main' ? 'run' : 'tool'
        })
  },
  {
    name: 'RocPlanReadOnlyMemoryMiddleware',
    scopes: ALL_SCOPES,
    modes: ['plan'],
    create: (context) => createRocPlanReadOnlyMemoryMiddleware({
      backend: context.backend,
      memorySources: [...context.memorySources]
    })
  },
  {
    name: 'RocPlanToolExposureMiddleware',
    scopes: ALL_SCOPES,
    modes: ['plan'],
    create: () => createRocPlanToolExposureMiddleware()
  },
  {
    name: 'RocPlanRuntimeToolGuardMiddleware',
    scopes: ALL_SCOPES,
    modes: ['plan'],
    create: () => createRocPlanRuntimeToolGuardMiddleware()
  },
  {
    name: 'RocPlanFilesystemDefaultPathMiddleware',
    scopes: ALL_SCOPES,
    modes: ['plan'],
    create: () => createRocPlanFilesystemDefaultPathMiddleware()
  },
  {
    // shell 路径策略必须在 RTK 改写命令之前：RTK 改写后的命令不再是用户写的那条。
    name: 'RocShellPolicyMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: (context) => createRocShellPolicyMiddleware({ workspacePath: context.policy.workspacePath })
  },
  {
    name: 'RTKMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: () => createRTKMiddleware(new RTKBinaryManager())
  },
  {
    name: 'RocToolProtocolMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: (context) => createToolProtocolMiddleware({
      capabilityManifest: context.policy.capabilityManifest,
      executionScope: context.executionScope,
      boundToolNames: context.policy.boundToolNames
    })
  },
  {
    name: 'ForgeErrorBudgetMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: () => createErrorBudgetMiddleware()
  },
  {
    name: 'ForgeIterationTrackingMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: () => createForgeIterationTrackingMiddleware()
  },
  {
    // 路径策略先判越界，再由 filesystem 错误分类去解释失败原因。
    name: 'RocFilesystemPathPolicyMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: () => createRocFilesystemPathPolicyMiddleware()
  },
  {
    name: 'ForgeFilesystemToolErrorMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: () => createFilesystemToolErrorMiddleware()
  },
  {
    // 下面两格互斥：接了 Roc 压缩就用它，没接才退回 Forge 分层压缩。
    name: 'RocContextCompactionPipeline',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: (context) => context.contextCompaction === undefined
      ? null
      : createRocContextCompactionMiddleware({
          artifactStore: context.contextCompaction.artifactStore,
          artifactRecoveryEnabled: context.contextCompaction.artifactRecoveryEnabled,
          budgetProfile: context.contextCompaction.budgetProfile,
          emitEvent: context.contextCompaction.emitEvent,
          mode: context.policy.mode,
          model: context.model,
          runId: context.policy.runId,
          sessionHistory: context.contextCompaction.sessionHistory,
          threadId: context.policy.threadId,
          tokenCounter: context.contextCompaction.tokenCounter,
          workspaceHash: context.policy.workspaceHash,
          workspacePath: context.policy.workspacePath
        })
  },
  {
    name: 'ContextEditingMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: (context) => context.contextCompaction === undefined
      ? createForgeTieredCompactionMiddleware({ budgetTokens: context.policy.contextBudgetTokens })
      : null
  },
  {
    // rescue 只装在 main：候选集来自主 agent 的工具全集，子代理拿不到完整视图。
    name: 'ForgeRescueParsingMiddleware',
    scopes: ['main'],
    modes: ALL_MODES,
    create: (context) => createRescueParsingMiddleware({ availableTools: context.knownToolCandidates })
  },
  {
    name: 'toolRetryMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: () => toolRetryMiddleware({
      maxRetries: 2,
      tools: [...NETWORK_SENSITIVE_TOOLS],
      onFailure: handleNetworkToolRetryFailure,
      retryOn: shouldRetryNetworkToolError,
      backoffFactor: 1.5
    })
  },
  {
    name: 'RocToolRuntimeErrorMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: () => createToolRuntimeErrorMiddleware()
  },
  {
    name: 'ForgeToolResolutionMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: () => createToolResolutionMiddleware()
  },
  {
    // 幂等记账要包在产品错误映射之内、工具处理器之外，才能看到最终 outcome。
    name: 'RocToolEffectIdempotencyMiddleware',
    scopes: ALL_SCOPES,
    modes: ALL_MODES,
    create: (context) => context.toolEffectStore === undefined
      ? null
      : createToolEffectIdempotencyMiddleware({
          runId: context.policy.runId,
          threadId: context.policy.threadId,
          store: context.toolEffectStore,
          capabilityManifest: context.policy.capabilityManifest
        })
  },
  {
    name: 'ForgeCleanupMiddleware',
    scopes: ['main'],
    modes: ALL_MODES,
    create: () => createForgeCleanupMiddleware()
  }
];

/** 按 scope 与 mode 解出这次构建实际要装的 Roc guardrail 栈，顺序由 spec 决定。 */
export function resolveMiddlewareStack(context: MiddlewareStackContext): DeepAgentMiddleware[] {
  const stack: DeepAgentMiddleware[] = [];
  for (const entry of MIDDLEWARE_STACK_SPEC) {
    if (!entry.scopes.includes(context.executionScope) || !entry.modes.includes(context.policy.mode)) {
      continue;
    }
    const middleware = entry.create(context);
    if (middleware !== null) {
      stack.push(middleware);
    }
  }
  return stack;
}

/**
 * spec 里每格声明的 name 必须与它造出来的 middleware 自报的 name 一致，否则 spec 就只是注释。
 * 一致性由 `resolveMiddlewareStack` 的返回值守住：它装出来的 middleware 自报什么名字，
 * 测试就拿到什么名字，与 spec 声明对不上时断言会失败。
 */
export function readMiddlewareName(middleware: DeepAgentMiddleware): string {
  const name = Reflect.get(middleware as object, 'name');
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('middleware_stack_entry_name_missing');
  }
  return name;
}
