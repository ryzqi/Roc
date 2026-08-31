import type { ClientTool } from '@langchain/core/tools';

import type { ChatStartRunRequest, RunExecutionSnapshotV2, WorkflowHint } from '../../../../shared/types';
import type { ExplicitSkillContext } from './explicit-skills';
import type { ReferencedFileContext } from './referenced-files';
import type { ContextArtifactStore } from './context-artifact-store';
import { createContextArtifactReadTool } from './context-artifact-tool';
import { filterPlanModeModelTools } from '../model-tool-exposure';
import type { MemoryRememberAdapter, MemorySearchAdapter } from './memory-tools';
import { createMemorySearchTool, createRememberTool } from './memory-tools';
import type { SessionSearchAdapter } from './session-search-tool';
import type { RuntimeWorkspaceIdentity } from './workspace-scope';
import { buildPromptBlocks, serializePromptBlocks } from './prompt-blocks';
import { createSessionSearchTool } from './session-search-tool';
import { resolveRuntimeWorkspaceIdentity } from './workspace-scope';

export type ContextHarness = {
  systemPrompt: string;
  tools: ClientTool[];
  memorySources: string[];
  skillSources: string[];
  workspaceIdentity: RuntimeWorkspaceIdentity | null;
};

export function assembleContextHarness(input: {
  artifactStore: ContextArtifactStore;
  mode: RunExecutionSnapshotV2['mode'];
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  workflowHint: WorkflowHint;
  workspacePath: string | null;
  memorySources: string[];
  baseTools: ClientTool[];
  allowedToolNames?: readonly string[];
  searchSessions: SessionSearchAdapter;
  searchMemory: MemorySearchAdapter;
  remember: MemoryRememberAdapter;
  runId: string;
  threadId: string;
  explicitSkillContexts: readonly ExplicitSkillContext[];
  referencedFileContexts: readonly ReferencedFileContext[];
}): ContextHarness {
  const workspaceIdentity = resolveRuntimeWorkspaceIdentity(input.workspacePath);
  const sessionSearchTool = createSessionSearchTool({
    runtimeWorkspacePath: input.workspacePath,
    search: input.searchSessions
  });
  const memorySearchTool = createMemorySearchTool({ search: input.searchMemory });
  const rememberTool = createRememberTool({
    remember: input.remember,
    runId: input.runId,
    threadId: input.threadId,
    workspacePath: input.workspacePath
  });
  const contextArtifactReadTool = createContextArtifactReadTool({
    artifactStore: input.artifactStore,
    threadId: input.threadId,
    workspaceHash: workspaceIdentity === null ? null : workspaceIdentity.hash
  });
  const allowedToolNames = new Set(
    input.allowedToolNames ?? ['session_search', 'memory_search', 'remember', 'read_context_artifact']
  );
  const manifestAuthorizedTools = [
    ...input.baseTools,
    ...(allowedToolNames.has(sessionSearchTool.name) ? [sessionSearchTool] : []),
    ...(allowedToolNames.has(memorySearchTool.name) ? [memorySearchTool] : []),
    ...(allowedToolNames.has(rememberTool.name) ? [rememberTool] : []),
    ...(allowedToolNames.has(contextArtifactReadTool.name) ? [contextArtifactReadTool] : [])
  ];
  // Plan Mode 的 manifest 仍授权 remember 等写入工具，但 buildDeepAgent 不会把它们绑定给模型。
  // 在此收口，使提示词的 Available Tools、上下文预算估算与实际绑定集合三者一致。
  const tools = input.mode === 'plan' ? filterPlanModeModelTools(manifestAuthorizedTools) : manifestAuthorizedTools;
  const promptBlocks = buildPromptBlocks({
    mode: input.mode,
    enabledCapabilities: input.enabledCapabilities,
    workspacePath: input.workspacePath,
    workflowHint: input.workflowHint,
    explicitSkillContexts: input.explicitSkillContexts,
    referencedFileContexts: input.referencedFileContexts,
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description
    }))
  });
  return {
    systemPrompt: serializePromptBlocks(promptBlocks),
    tools,
    memorySources: input.memorySources,
    skillSources:
      input.enabledCapabilities.skills.length === 0 && input.explicitSkillContexts.length === 0 ? [] : ['/skills/'],
    workspaceIdentity
  };
}
