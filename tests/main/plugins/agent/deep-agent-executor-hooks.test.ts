import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookRuntimeOutcome } from '../../../../src/main/services/hooks';
import { collectExecutorEvents, createCapabilities, readBuildInput, workspacePath } from './deep-agent-executor-test-helpers';

function baseOutcome(input: Partial<HookRuntimeOutcome> = {}): HookRuntimeOutcome {
  return {
    blocked: false,
    blockReason: null,
    updatedInput: undefined,
    additionalContexts: [],
    requestContinue: null,
    runs: [],
    events: [],
    ...input
  };
}

describe('createAgentDeepAgentExecutor hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs SessionStart before building the DeepAgent', async () => {
    const hookRuntime = {
      runEvent: vi.fn(async () => baseOutcome())
    };

    await collectExecutorEvents({
      capabilities: createCapabilities([]),
      hookRuntime,
      output: {
        messages: [
          {
            role: 'assistant',
            content: 'ok'
          }
        ]
      },
      requestOverride: {
        input: 'hello',
        mode: 'chat',
        threadId: 'thread_1',
        workspacePath
      }
    });

    expect(hookRuntime.runEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'SessionStart',
        payload: expect.objectContaining({
          source: 'chat'
        })
      }),
      {
        signal: expect.any(AbortSignal)
      }
    );
  });

  it('passes SessionStart add_context into the first model context queue', async () => {
    const hookRuntime = {
      runEvent: vi.fn(async () => baseOutcome({ additionalContexts: ['Use the project conventions.'] }))
    };

    await collectExecutorEvents({
      capabilities: createCapabilities([]),
      hookRuntime,
      output: {
        messages: [
          {
            role: 'assistant',
            content: 'ok'
          }
        ]
      },
      requestOverride: {
        input: 'hello',
        mode: 'chat',
        workspacePath
      }
    });

    expect(readBuildInput().hookMiddleware?.initialContexts).toEqual(['Use the project conventions.']);
  });

  it('blocks the run before DeepAgent streaming when SessionStart blocks', async () => {
    const hookRuntime = {
      runEvent: vi.fn(async () => baseOutcome({ blocked: true, blockReason: 'blocked start' }))
    };

    await expect(
      collectExecutorEvents({
        capabilities: createCapabilities([]),
        hookRuntime,
        output: {
          messages: [
            {
              role: 'assistant',
              content: 'ok'
            }
          ]
        },
        requestOverride: {
          input: 'hello',
          mode: 'chat',
          workspacePath
        }
      })
    ).rejects.toThrow('blocked start');
  });
});
