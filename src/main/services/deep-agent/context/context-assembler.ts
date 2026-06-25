import type { ClientTool } from '@langchain/core/tools';

import type { ChatStartRunRequest, WorkflowHint } from '../../../../shared/types';
import type { ExplicitSkillContext } from './explicit-skills';
import type { SessionSearchAdapter } from './session-search-tool';
import type { RuntimeWorkspaceIdentity } from './workspace-scope';
import { buildPromptBlocks } from './prompt-blocks';
import { serializePromptBlocks } from './prompt-serialization';
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
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  workflowHint: WorkflowHint;
  workspacePath: string | null;
  memorySources: string[];
  baseTools: ClientTool[];
  searchSessions: SessionSearchAdapter;
  explicitSkillContexts: readonly ExplicitSkillContext[];
}): ContextHarness {
  const sessionSearchTool = createSessionSearchTool({
    runtimeWorkspacePath: input.workspacePath,
    search: input.searchSessions
  });
  const tools = [...input.baseTools, sessionSearchTool];
  const promptBlocks = buildPromptBlocks({
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
    workspaceIdentity: resolveRuntimeWorkspaceIdentity(input.workspacePath)
  };
}
