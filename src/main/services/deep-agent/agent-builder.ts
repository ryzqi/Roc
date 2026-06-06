import { createDeepAgent } from 'deepagents';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ClientTool } from '@langchain/core/tools';
import type { FilesystemPermission } from 'deepagents';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import { toolRetryMiddleware } from 'langchain';
import type { ProviderType, WorkflowHint } from '../../../shared/types';
import { RTKBinaryManager, createRTKMiddleware } from '../../../rtk-integration';
import {
  createForgeTieredCompactionMiddleware,
  createForgeCleanupMiddleware,
  createErrorBudgetMiddleware,
  createRescueParsingMiddleware,
  createRespondToolInjectionMiddleware,
  createResponseValidationMiddleware,
  createStepEnforcementMiddleware,
  createFilesystemToolErrorMiddleware,
  createToolResolutionMiddleware,
  createPromptCachingMiddleware,
  ROC_PREREQUISITES
} from '../forge-guardrails';
import type { RocCompositeBackend } from './backend';
import { ensureRocHarnessProfilesRegistered } from './harness-profiles';
import { DEEP_AGENT_BUILT_IN_TOOLS, type RuntimeSubagent } from './types';

export type DeepAgentBuildInput = {
  model: BaseChatModel;
  systemPrompt: string;
  backend: RocCompositeBackend;
  store: BaseStore;
  memorySources: string[];
  skillSources: string[];
  subagents: RuntimeSubagent[];
  tools: ClientTool[];
  filesystemPermissions: FilesystemPermission[] | undefined;
  interruptOn: NonNullable<Parameters<typeof createDeepAgent>[0]>['interruptOn'];
  checkpointer: BaseCheckpointSaver | undefined;
  providerType: ProviderType;
  workflowHint: WorkflowHint;
  contextBudgetTokens: number | undefined;
};

const NETWORK_SENSITIVE_TOOLS = [
  'web_read',
  'schedule_background_task',
  'update_background_task',
  'cancel_background_task'
] as const;

export function buildDeepAgent(input: DeepAgentBuildInput): ReturnType<typeof createDeepAgent> {
  ensureRocHarnessProfilesRegistered();
  const isLocalProvider = input.providerType === 'llama_cpp';
  const rtkMiddleware = createRTKMiddleware(new RTKBinaryManager());
  const knownToolNames = (): string[] => {
    const names = [...input.tools.map((tool) => tool.name), ...DEEP_AGENT_BUILT_IN_TOOLS];
    if (isLocalProvider) {
      names.push('respond');
    }
    return names;
  };
  const guardrails = [
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
    createErrorBudgetMiddleware(),
    createStepEnforcementMiddleware({
      resolveWorkflowFromContext: () => input.workflowHint,
      prerequisitesConfig: ROC_PREREQUISITES
    }),
    createFilesystemToolErrorMiddleware(),
    createRespondToolInjectionMiddleware({ enabled: isLocalProvider }),
    createForgeTieredCompactionMiddleware({
      budgetTokens: input.contextBudgetTokens
    }),
    createRescueParsingMiddleware({ availableTools: knownToolNames }),
    createResponseValidationMiddleware({ knownToolNames }),
    createToolResolutionMiddleware(),
    createForgeCleanupMiddleware()
  ];

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
