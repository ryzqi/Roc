import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { RunCapabilityExecutionScopeV1, RunCapabilityManifestV1, RunExecutionMode } from '../../../shared/types';

export const PLAN_MODE_BLOCKED_TOOL_NAMES = [
  'write_file',
  'edit_file',
  'delete_file',
  'remember',
  'research_wiki_create',
  'research_wiki_draft',
  'research_wiki_resynthesize',
  'research_wiki_update_sources',
  'research_wiki_retry_paper',
  'research_request_paper_deep_knowledge',
  'research_prepare_writing_context',
  'run_shell_command',
  'execute',
  'propose_background_task',
  'schedule_background_task',
  'update_background_task',
  'cancel_background_task'
] as const;

const PLAN_MODE_BLOCKED_TOOL_SET = new Set<string>(PLAN_MODE_BLOCKED_TOOL_NAMES);

export function buildPlanModeBlockedToolMessage(toolName: string): string {
  return `Plan Mode blocks local mutation, execution, or task-commit tool calls: ${toolName}.`;
}

export function filterPlanModeModelTools<TTool>(tools: readonly TTool[]): TTool[] {
  return tools.filter((tool) => {
    const name = readToolName(tool);
    return name !== null && isPlanModeModelVisibleToolName(name);
  });
}

export function isPlanModeModelVisibleToolName(name: string): boolean {
  return !isPlanModeBlockedToolName(name);
}

export function isPlanModeBlockedToolName(name: string): boolean {
  return PLAN_MODE_BLOCKED_TOOL_SET.has(name);
}

export function createRocPlanRuntimeToolGuardMiddleware() {
  return createMiddleware({
    name: 'RocPlanRuntimeToolGuardMiddleware',
    wrapToolCall: async (request, handler) => {
      if (isPlanModeModelVisibleToolName(request.toolCall.name)) {
        return await handler(request);
      }
      return new ToolMessage({
        tool_call_id: readToolCallId(request.toolCall.id),
        name: request.toolCall.name,
        content: buildPlanModeBlockedToolMessage(request.toolCall.name),
        status: 'error'
      });
    }
  });
}

/** One policy for the model, rescue parsing and tool listing. Execution guards remain independent. */
export function filterRocModelVisibleTools<TTool>(
  tools: readonly TTool[],
  manifest: RunCapabilityManifestV1,
  scope: RunCapabilityExecutionScopeV1,
  mode: RunExecutionMode
): TTool[] {
  const allowed = new Set(manifest.tools.filter(tool => tool.executionScopes.includes(scope)).map(tool => tool.modelVisibleName));
  return tools.filter(tool => {
    const name = readToolName(tool);
    return name !== null && allowed.has(name) && (mode !== 'plan' || isPlanModeModelVisibleToolName(name));
  });
}

/** The last model wrapper also filters tools registered by Deep Agents profiles. */
export function createRocToolExposureMiddleware(
  manifest: RunCapabilityManifestV1,
  scope: RunCapabilityExecutionScopeV1,
  mode: RunExecutionMode
) {
  return createMiddleware({
    name: 'RocToolExposureMiddleware',
    wrapModelCall: async (request, handler) => handler({
      ...request,
      tools: filterRocModelVisibleTools(request.tools ?? [], manifest, scope, mode)
    })
  });
}

function readToolName(tool: unknown): string | null {
  if (tool === null || typeof tool !== 'object') {
    return null;
  }
  const name = Reflect.get(tool, 'name');
  return typeof name === 'string' ? name : null;
}

function readToolCallId(id: string | undefined): string {
  if (id === undefined || id.length === 0) {
    return 'unknown-tool-call';
  }
  return id;
}
