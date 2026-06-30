import { createMiddleware } from 'langchain';

export const PLAN_MODE_MODEL_VISIBLE_TOOL_NAMES = [
  'ls',
  'read_file',
  'glob',
  'grep',
  'web_read',
  'ask_user',
  'session_search'
] as const;

const PLAN_MODE_MODEL_VISIBLE_TOOL_SET = new Set<string>(PLAN_MODE_MODEL_VISIBLE_TOOL_NAMES);

export function filterPlanModeModelTools<TTool>(tools: readonly TTool[]): TTool[] {
  return tools.filter((tool) => {
    const name = readToolName(tool);
    return name !== null && PLAN_MODE_MODEL_VISIBLE_TOOL_SET.has(name);
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
