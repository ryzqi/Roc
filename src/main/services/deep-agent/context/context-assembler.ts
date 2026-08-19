import type { ClientTool } from '@langchain/core/tools';

import type { ChatStartRunRequest, RunExecutionSnapshotV2, WorkflowHint } from '../../../../shared/types';
import type { ExplicitSkillContext } from './explicit-skills';
import type { ContextArtifactStore } from './context-artifact-store';
import { createContextArtifactReadTool } from './context-artifact-tool';
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
  threadId: string;
  explicitSkillContexts: readonly ExplicitSkillContext[];
}): ContextHarness {
  const workspaceIdentity = resolveRuntimeWorkspaceIdentity(input.workspacePath);
  const sessionSearchTool = createSessionSearchTool({
    runtimeWorkspacePath: input.workspacePath,
    search: input.searchSessions
  });
  const contextArtifactReadTool = createContextArtifactReadTool({
    artifactStore: input.artifactStore,
    threadId: input.threadId,
    workspaceHash: workspaceIdentity === null ? null : workspaceIdentity.hash
  });
  const allowedToolNames = new Set(input.allowedToolNames ?? ['session_search', 'read_context_artifact']);
  const tools = [
    ...input.baseTools,
    ...(allowedToolNames.has(sessionSearchTool.name) ? [sessionSearchTool] : []),
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
