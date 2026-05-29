import { createDeepAgent } from 'deepagents';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ClientTool } from '@langchain/core/tools';
import type { FilesystemPermission } from 'deepagents';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import type { ProviderType } from '../../../shared/types';
import { createRescueParsingMiddleware, createRespondToolInjectionMiddleware } from '../forge-guardrails';
import type { RocCompositeBackend } from './backend';
import type { RuntimeSubagent } from './types';

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
};

const DEEPAGENTS_BUILT_IN_TOOL_NAMES = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute',
  'write_todos',
  'task'
] as const;

export function buildDeepAgent(input: DeepAgentBuildInput): ReturnType<typeof createDeepAgent> {
  const isLocalProvider = input.providerType === 'llama_cpp';
  const knownToolNames = (): string[] => {
    const names = [...input.tools.map((tool) => tool.name), ...DEEPAGENTS_BUILT_IN_TOOL_NAMES];
    if (isLocalProvider) {
      names.push('respond');
    }
    return names;
  };
  const guardrails = [
    createRespondToolInjectionMiddleware({ enabled: isLocalProvider }),
    createRescueParsingMiddleware({ availableTools: knownToolNames })
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
