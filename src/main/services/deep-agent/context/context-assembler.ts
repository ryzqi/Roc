import type { ClientTool } from '@langchain/core/tools';

import type { ChatStartRunRequest, RunExecutionSnapshotV2, WorkflowHint } from '../../../../shared/types';
import type { ExplicitSkillContext } from './explicit-skills';
import type { ContextArtifactStore } from './context-artifact-store';
import { createContextArtifactReadTool } from './context-artifact-tool';
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
  const tools = [
    ...input.baseTools,
    ...(allowedToolNames.has(sessionSearchTool.name) ? [sessionSearchTool] : []),
    ...(allowedToolNames.has(memorySearchTool.name) ? [memorySearchTool] : []),
    ...(allowedToolNames.has(rememberTool.name) ? [rememberTool] : []),
    ...(allowedToolNames.has(contextArtifactReadTool.name) ? [contextArtifactReadTool] : [])
  ];
  const promptBlocks = buildPromptBlocks({
    mode: input.mode,
    enabledCapabilities: input.enabledCapabilities,
    workspacePath: input.workspacePath,
    workflowHint: input.workflowHint,
    explicitSkillContexts: input.explicitSkillContexts,
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description
    }))
  });
  return {
    systemPrompt: serializePromptBlocks(promptBlocks),
    tools,
    memorySources: input.memorySources,
    skillSources: input.enabledCapabilities.skills.length === 0 ? [] : ['/skills/'],
    workspaceIdentity
  };
}
