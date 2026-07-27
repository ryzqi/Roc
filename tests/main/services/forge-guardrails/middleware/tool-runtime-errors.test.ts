import { ToolMessage } from '@langchain/core/messages';
import { GraphInterrupt } from '@langchain/langgraph';
import { MiddlewareError } from 'langchain';
import { describe, expect, it } from 'vitest';
import { RocDomainError } from '../../../../../src/main/services/errors';
import { unwrapMiddlewareError } from '../../../../../src/main/services/forge-guardrails/middleware/middleware-error';
import { createToolRuntimeErrorMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/tool-runtime-errors';

async function runWrapToolCall(input: { toolName: string; handler: () => Promise<unknown> | unknown }) {
  const middleware = createToolRuntimeErrorMiddleware();
  if (typeof middleware.wrapToolCall !== 'function') {
    throw new Error('Expected tool runtime error middleware to expose wrapToolCall.');
  }
  return await middleware.wrapToolCall(
    {
      toolCall: {
        name: input.toolName,
        args: { file_path: '/workspace/docs' },
        id: `call-${input.toolName}`
      }
    } as never,
    input.handler as never
  );
}

describe('RocToolRuntimeErrorMiddleware', () => {
  it('terminates cyclic branded middleware error chains', () => {
    const selfCycle = brandedMiddlewareError('self cycle');
    selfCycle.cause = selfCycle;
    const first = brandedMiddlewareError('first cycle');
    const second = brandedMiddlewareError('second cycle');
    first.cause = second;
    second.cause = first;

    expect(unwrapMiddlewareError(selfCycle)).toBe(selfCycle);
    expect(unwrapMiddlewareError(first)).toBe(first);
  });

  it('turns delete_file RocDomainError into a hard ToolMessage for agent recovery', async () => {
    const result = await runWrapToolCall({
      toolName: 'delete_file',
      handler: async () => {
        throw new RocDomainError({
          code: 'delete_file_target_not_empty',
          message: '只能删除空目录。',
          category: 'validation',
          retryable: false,
          userAction: '请先清空目录内容，或改为删除具体文件。'
        });
      }
    });

    expect(result).toBeInstanceOf(ToolMessage);
    const message = result as ToolMessage;
    expect(message.tool_call_id).toBe('call-delete_file');
    expect(message.name).toBe('delete_file');
    expect(message.status).toBe('error');
    expect(String(message.content)).toContain('delete_file_target_not_empty');
    expect(String(message.content)).toContain('只能删除空目录。');
    expect(String(message.content)).toContain('请先清空目录内容，或改为删除具体文件。');
  });

  it('preserves RocDomainError fields through nested middleware error wrappers', async () => {
    const domainError = new RocDomainError({
      code: 'delete_file_target_not_empty',
      message: '只能删除空目录。',
      category: 'validation',
      retryable: false,
      userAction: '请先清空目录内容。'
    });
    const result = await runWrapToolCall({
      toolName: 'delete_file',
      handler: async () => {
        throw MiddlewareError.wrap(
          MiddlewareError.wrap(domainError, 'RocToolEffectIdempotencyMiddleware'),
          'ForgeToolResolutionMiddleware'
        );
      }
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).content).toBe(
      '[RocToolError] delete_file_target_not_empty: 只能删除空目录。\n请先清空目录内容。'
    );
  });

  it('lets web_read errors bubble to the network retry middleware', async () => {
    await expect(
      runWrapToolCall({
        toolName: 'web_read',
        handler: async () => {
          throw new RocDomainError({
            code: 'web_read_failed',
            message: '网络读取失败。',
            category: 'external',
            retryable: true,
            userAction: '请稍后重试。'
          });
        }
      })
    ).rejects.toMatchObject({
      code: 'web_read_failed'
    });
  });

  it('lets web_search errors bubble to the network retry middleware', async () => {
    await expect(
      runWrapToolCall({
        toolName: 'web_search',
        handler: async () => {
          throw new Error('fetch failed');
        }
      })
    ).rejects.toThrow('fetch failed');
  });

  it('turns generic non-network tool failures into a hard ToolMessage for agent recovery', async () => {
    const result = await runWrapToolCall({
      toolName: 'run_shell_command',
      handler: async () => {
        throw new Error('database unavailable');
      }
    });

    expect(result).toBeInstanceOf(ToolMessage);
    const message = result as ToolMessage;
    expect(message.tool_call_id).toBe('call-run_shell_command');
    expect(message.name).toBe('run_shell_command');
    expect(message.status).toBe('error');
    expect(String(message.content)).toContain('[ToolRuntimeError] Error: database unavailable');
  });

  it('rethrows abort errors so cancellation still stops execution', async () => {
    await expect(
      runWrapToolCall({
        toolName: 'run_shell_command',
        handler: async () => {
          const error = new Error('AbortError: run aborted');
          error.name = 'AbortError';
          throw error;
        }
      })
    ).rejects.toThrow('AbortError: run aborted');
  });

  it('rethrows GraphBubbleUp errors so interrupts still pause the graph', async () => {
    await expect(
      runWrapToolCall({
        toolName: 'delete_file',
        handler: async () => {
          throw new GraphInterrupt([]);
        }
      })
    ).rejects.toBeInstanceOf(GraphInterrupt);
  });
});

function brandedMiddlewareError(message: string): Error & { cause?: unknown } {
  const error = new Error(message) as Error & { cause?: unknown };
  Reflect.set(error, '~brand', 'MiddlewareError');
  return error;
}
