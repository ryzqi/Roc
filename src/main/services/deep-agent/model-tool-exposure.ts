import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

export const PLAN_MODE_BLOCKED_TOOL_NAMES = [
  'write_file',
  'edit_file',
  'delete_file',
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

export function createRocPlanToolExposureMiddleware() {
  return createMiddleware({
    name: 'RocPlanToolExposureMiddleware',
    wrapModelCall: async (request, handler) => {
      if (request.tools === undefined) {
        return await handler(request);
      }
      return await handler({
        ...request,
        tools: filterPlanModeModelTools(request.tools)
      });
    }
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
