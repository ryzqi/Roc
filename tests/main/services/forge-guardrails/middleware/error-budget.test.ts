import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { RocDomainError } from '../../../../../src/main/services/errors';
import {
  defaultErrorTracker,
  FORGE_EXHAUSTED_CODES,
  tagForgeMessage
} from '../../../../../src/main/services/forge-guardrails';
import { createErrorBudgetMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/error-budget';

function getErrorBudgetMiddleware(opts?: { maxRetries?: number; maxToolErrors?: number }) {
  return createErrorBudgetMiddleware(opts);
}

function getBeforeModelHook(middleware: ReturnType<typeof createErrorBudgetMiddleware>) {
  const beforeModel = middleware.beforeModel;
  if (typeof beforeModel !== 'function') {
    throw new Error('Expected error budget middleware to expose beforeModel.');
  }
  return beforeModel;
}

function baseState(input?: { tracker?: ReturnType<typeof defaultErrorTracker>; messages?: unknown[] }) {
  return {
    messages: input?.messages === undefined ? [] : input.messages,
    forge_error_tracker: input?.tracker === undefined ? defaultErrorTracker() : input.tracker
  };
}

describe('ForgeErrorBudgetMiddleware', () => {
  it('initializes error budget state once at agent start', () => {
    const middleware = getErrorBudgetMiddleware({ maxRetries: 5, maxToolErrors: 4 });
    if (typeof middleware.beforeAgent !== 'function') {
      throw new Error('Expected error budget middleware to expose beforeAgent.');
    }

    const first = middleware.beforeAgent({ messages: [] } as never, {} as never);
    const sticky = middleware.beforeAgent(
      baseState({
        tracker: {
          ...defaultErrorTracker(),
          maxRetries: 9
        }
      }) as never,
      {} as never
    );

    expect(first).toEqual({
      forge_error_tracker: {
        consecutiveRetries: 0,
        consecutiveToolErrors: 0,
        maxRetries: 5,
        maxToolErrors: 4,
        maxPrematureAttempts: 3,
        maxPrereqViolations: 2
      }
    });
    expect(sticky).toBeUndefined();
  });

  it('increments consecutive retry nudges and exhausts after the configured budget', () => {
    const middleware = getErrorBudgetMiddleware({ maxRetries: 1 });
    const beforeModel = getBeforeModelHook(middleware);
    const nudge = tagForgeMessage(new HumanMessage('retry'), 'forge:retry_nudge');

    const first = beforeModel(
      baseState({
        tracker: {
          ...defaultErrorTracker(),
          maxRetries: 1
        },
        messages: [nudge]
      }) as never,
      {} as never
    );

    expect(first).toMatchObject({
      forge_error_tracker: {
        consecutiveRetries: 1
      }
    });
    expect(() =>
      beforeModel(
        baseState({
          tracker: {
            ...defaultErrorTracker(),
            consecutiveRetries: 1,
            maxRetries: 1
          },
          messages: [nudge]
        }) as never,
        {} as never
      )
    ).toThrow(RocDomainError);
    try {
      beforeModel(
        baseState({
          tracker: {
            ...defaultErrorTracker(),
            consecutiveRetries: 1,
            maxRetries: 1
          },
          messages: [nudge]
        }) as never,
        {} as never
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: FORGE_EXHAUSTED_CODES.retries
      });
    }
  });

  it('resets consecutive retry nudges when the last message is not transient', () => {
    const middleware = getErrorBudgetMiddleware();
    const beforeModel = getBeforeModelHook(middleware);

    const update = beforeModel(
      baseState({
        tracker: {
          ...defaultErrorTracker(),
          consecutiveRetries: 2
        },
        messages: [new HumanMessage('normal')]
      }) as never,
      {} as never
    );

    expect(update).toMatchObject({
      forge_error_tracker: {
        consecutiveRetries: 0
      }
    });
  });

  it('returns Command updates when hard tool errors consume budget', async () => {
    const middleware = getErrorBudgetMiddleware({ maxToolErrors: 2 });
    if (typeof middleware.wrapToolCall !== 'function') {
      throw new Error('Expected error budget middleware to expose wrapToolCall.');
    }
    const toolMessage = new ToolMessage({
      tool_call_id: 'call-fail',
      name: 'get_weather',
      content: 'failed',
      status: 'error'
    });

    const result = await middleware.wrapToolCall(
      {
        toolCall: { name: 'get_weather', args: {}, id: 'call-fail' },
        state: baseState({
          tracker: {
            ...defaultErrorTracker(),
            maxToolErrors: 2
          }
        })
      } as never,
      (async () => toolMessage) as never
    );

    expect(result).toBeInstanceOf(Command);
    expect((result as Command).update).toMatchObject({
      messages: [toolMessage],
      forge_error_tracker: {
        consecutiveToolErrors: 1
      }
    });
  });

  it('throws after hard tool errors exceed budget', async () => {
    const middleware = getErrorBudgetMiddleware({ maxToolErrors: 1 });
    if (typeof middleware.wrapToolCall !== 'function') {
      throw new Error('Expected error budget middleware to expose wrapToolCall.');
    }

    await expect(
      middleware.wrapToolCall(
        {
          toolCall: { name: 'get_weather', args: {}, id: 'call-fail' },
          state: baseState({
            tracker: {
              ...defaultErrorTracker(),
              consecutiveToolErrors: 1,
              maxToolErrors: 1
            }
          })
        } as never,
        (async () =>
          new ToolMessage({
            tool_call_id: 'call-fail',
            name: 'get_weather',
            content: 'failed again',
            status: 'error'
          })) as never
      )
    ).rejects.toMatchObject({
      code: FORGE_EXHAUSTED_CODES.toolErrors
    });
  });

  it('resets hard tool errors for tagged tool-resolution soft errors', async () => {
    const middleware = getErrorBudgetMiddleware();
    if (typeof middleware.wrapToolCall !== 'function') {
      throw new Error('Expected error budget middleware to expose wrapToolCall.');
    }
    const toolMessage = tagForgeMessage(
      new ToolMessage({
        tool_call_id: 'call-soft',
        name: 'read_background_task',
        content: '[ToolResolutionError] missing',
        status: 'success'
      }),
      'forge:tool_resolution'
    );

    const result = await middleware.wrapToolCall(
      {
        toolCall: { name: 'read_background_task', args: {}, id: 'call-soft' },
        state: baseState({
          tracker: {
            ...defaultErrorTracker(),
            consecutiveToolErrors: 1
          }
        })
      } as never,
      (async () => toolMessage) as never
    );

    expect(result).toBeInstanceOf(Command);
    expect((result as Command).update).toMatchObject({
      messages: [toolMessage],
      forge_error_tracker: {
        consecutiveToolErrors: 0
      }
    });
  });
});
