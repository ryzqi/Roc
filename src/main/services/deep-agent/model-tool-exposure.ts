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

type NamedTool = {
  name: string;
};

export function filterPlanModeModelTools<TTool extends NamedTool>(tools: readonly TTool[]): TTool[] {
  return tools.filter((tool) => PLAN_MODE_MODEL_VISIBLE_TOOL_SET.has(tool.name));
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
