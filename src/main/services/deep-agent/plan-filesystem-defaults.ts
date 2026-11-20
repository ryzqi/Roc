import { createMiddleware } from 'langchain';

const PLAN_DEFAULT_FILESYSTEM_PATH = '/workspace/';
const PLAN_DEFAULT_PATH_TOOL_NAMES = new Set(['ls', 'glob', 'grep']);

type ToolCallRequest = {
  toolCall: {
    args?: unknown;
    name: string;
  };
};

export function createRocPlanFilesystemDefaultPathMiddleware() {
  return createMiddleware({
    name: 'RocPlanFilesystemDefaultPathMiddleware',
    wrapToolCall: async (request, handler) => {
      return await handler(normalizePlanFilesystemDefaultPath(request));
    }
  });
}

function normalizePlanFilesystemDefaultPath<TRequest extends ToolCallRequest>(request: TRequest): TRequest {
  if (!PLAN_DEFAULT_PATH_TOOL_NAMES.has(request.toolCall.name)) {
    return request;
  }

  const args = request.toolCall.args;
  if (args === undefined) {
    if (request.toolCall.name !== 'ls') {
      return request;
    }
    return withToolCallArgs(request, { path: PLAN_DEFAULT_FILESYSTEM_PATH });
  }

  if (!isRecord(args)) {
    return request;
  }

  const path = args.path;
  if (path !== undefined && path !== '/') {
    return request;
  }

  return withToolCallArgs(request, {
    ...args,
    path: PLAN_DEFAULT_FILESYSTEM_PATH
  });
}

function withToolCallArgs<TRequest extends ToolCallRequest>(
  request: TRequest,
  args: Record<string, unknown>
): TRequest {
  return {
    ...request,
    toolCall: {
      ...request.toolCall,
      args
    }
  } as TRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
