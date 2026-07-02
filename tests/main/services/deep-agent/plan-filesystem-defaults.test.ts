import { describe, expect, it, vi } from 'vitest';

import { createRocPlanFilesystemDefaultPathMiddleware } from '../../../../src/main/services/deep-agent/plan-filesystem-defaults';

type ToolCallRequest = {
  toolCall: {
    args?: unknown;
    id: string;
    name: string;
  };
};

describe('plan filesystem default path middleware', () => {
  it('normalizes omitted ls path to the Roc workspace route', async () => {
    const result = await runMiddleware({
      toolCall: {
        id: 'call_ls',
        name: 'ls'
      }
    });

    expect(result).toEqual({ path: '/workspace/' });
  });

  it('normalizes root search paths to the Roc workspace route', async () => {
    await expect(runMiddleware({
      toolCall: {
        id: 'call_glob',
        name: 'glob',
        args: {
          pattern: '**/*.ts',
          path: '/'
        }
      }
    })).resolves.toEqual({
      pattern: '**/*.ts',
      path: '/workspace/'
    });

    await expect(runMiddleware({
      toolCall: {
        id: 'call_grep',
        name: 'grep',
        args: {
          pattern: 'createDeepAgent',
          path: '/'
        }
      }
    })).resolves.toEqual({
      pattern: 'createDeepAgent',
      path: '/workspace/'
    });
  });

  it('preserves explicit Roc virtual routes', async () => {
    await expect(runMiddleware({
      toolCall: {
        id: 'call_workspace',
        name: 'glob',
        args: {
          pattern: '*.md',
          path: '/workspace/docs'
        }
      }
    })).resolves.toEqual({
      pattern: '*.md',
      path: '/workspace/docs'
    });

    await expect(runMiddleware({
      toolCall: {
        id: 'call_memory',
        name: 'grep',
        args: {
          pattern: 'preference',
          path: '/memory/global/'
        }
      }
    })).resolves.toEqual({
      pattern: 'preference',
      path: '/memory/global/'
    });

    await expect(runMiddleware({
      toolCall: {
        id: 'call_skills',
        name: 'ls',
        args: {
          path: '/skills/'
        }
      }
    })).resolves.toEqual({
      path: '/skills/'
    });
  });

  it('does not rewrite non-search tools', async () => {
    await expect(runMiddleware({
      toolCall: {
        id: 'call_read',
        name: 'read_file',
        args: {
          file_path: '/workspace/README.md'
        }
      }
    })).resolves.toEqual({
      file_path: '/workspace/README.md'
    });
  });
});

async function runMiddleware(request: ToolCallRequest): Promise<unknown> {
  const middleware = createRocPlanFilesystemDefaultPathMiddleware();
  const wrapToolCall = Reflect.get(middleware as object, 'wrapToolCall');
  if (typeof wrapToolCall !== 'function') {
    throw new Error('expected_wrap_tool_call');
  }
  const handler = vi.fn(async (nextRequest: ToolCallRequest) => nextRequest.toolCall.args);

  return await wrapToolCall(request, handler);
}
