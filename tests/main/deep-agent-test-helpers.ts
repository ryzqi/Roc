import type { SubAgent } from 'deepagents';

export type BuiltSubagent = SubAgent | { name: string; description: string; runnable: unknown };

export function isBuiltSubagent(value: unknown): value is BuiltSubagent {
  return value !== null && typeof value === 'object' && (Reflect.has(value, 'systemPrompt') || Reflect.has(value, 'runnable'));
}

export function getSubagentMiddleware(value: BuiltSubagent): readonly unknown[] {
  const direct = Reflect.get(value, 'middleware');
  if (Array.isArray(direct)) {
    return direct;
  }
  const options = readRunnableOptions(value);
  const middleware = Reflect.get(options, 'middleware');
  if (!Array.isArray(middleware)) {
    throw new Error('compiled_subagent_middleware_missing');
  }
  return middleware;
}

export function getSubagentTools(value: BuiltSubagent): readonly { name: string }[] {
  const direct = Reflect.get(value, 'tools');
  if (Array.isArray(direct)) {
    return direct as readonly { name: string }[];
  }
  const options = readRunnableOptions(value);
  const tools = Reflect.get(options, 'tools');
  if (!Array.isArray(tools)) {
    throw new Error('compiled_subagent_tools_missing');
  }
  return tools as readonly { name: string }[];
}

function readRunnableOptions(value: BuiltSubagent): object {
  const runnable = Reflect.get(value, 'runnable');
  if (runnable === null || typeof runnable !== 'object') {
    throw new Error('compiled_subagent_runnable_missing');
  }
  const options = Reflect.get(runnable, 'options');
  if (options === null || typeof options !== 'object') {
    throw new Error('compiled_subagent_options_missing');
  }
  return options;
}
