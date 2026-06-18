import { createDeepAgent } from 'deepagents';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ClientTool } from '@langchain/core/tools';
import type { FilesystemPermission } from 'deepagents';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import { toolRetryMiddleware } from 'langchain';
import { z } from 'zod';
import type { ProviderType, WorkflowHint } from '../../../shared/types';
import { RTKBinaryManager, createRTKMiddleware } from '../../../rtk-integration';
import {
  createForgeTieredCompactionMiddleware,
  createForgeCleanupMiddleware,
  createErrorBudgetMiddleware,
  createForgeIterationTrackingMiddleware,
  createRescueParsingMiddleware,
  createFilesystemToolErrorMiddleware,
  createToolResolutionMiddleware,
  createPromptCachingMiddleware
} from '../forge-guardrails';
import type { RescueToolCandidate } from '../forge-guardrails';
import type { RocCompositeBackend } from './backend';
import { createRocFilesystemPathPolicyMiddleware } from './filesystem-path-policy';
import { ensureRocHarnessProfilesRegistered } from './harness-profiles';
import { createRocShellPathPolicyMiddleware } from './shell-path-policy';
import { createToolProtocolMiddleware } from './tool-protocol';
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
  workspacePath: string | null;
  interruptOn: NonNullable<Parameters<typeof createDeepAgent>[0]>['interruptOn'];
  checkpointer: BaseCheckpointSaver | undefined;
  providerType: ProviderType;
  workflowHint: WorkflowHint;
  contextBudgetTokens: number | undefined;
};

const NETWORK_SENSITIVE_TOOLS = ['web_read'] as const;

export function buildDeepAgent(input: DeepAgentBuildInput): ReturnType<typeof createDeepAgent> {
  ensureRocHarnessProfilesRegistered();
  const rtkMiddleware = createRTKMiddleware(new RTKBinaryManager());
  const knownToolCandidates = (): RescueToolCandidate[] => {
    return [...input.tools.map((tool) => createRescueToolCandidate(tool)), ...DEEP_AGENT_BUILT_IN_TOOLS];
  };
  const guardrails = [
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
    createRocFilesystemPathPolicyMiddleware({ workspacePath: input.workspacePath }),
    createFilesystemToolErrorMiddleware(),
    createForgeTieredCompactionMiddleware({
      budgetTokens: input.contextBudgetTokens
    }),
    createRescueParsingMiddleware({ availableTools: knownToolCandidates }),
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
