import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createRocHookMiddleware } from '../../../../src/main/services/hooks/middleware';
import type { HookRuntimeOutcome } from '../../../../src/main/services/hooks/runtime';
import type { ChatRunEvent, RocHookCommandInput, RocHookRunEvent } from '../../../../src/shared/types';

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

function createTestMiddleware(input: {
  runEvent: (hookInput: RocHookCommandInput) => Promise<HookRuntimeOutcome>;
  emitHookEvent?: (event: ChatRunEvent) => void;
  initialContexts?: string[];
}) {
  const emitHookEvent: (event: ChatRunEvent) => void = input.emitHookEvent === undefined ? () => undefined : input.emitHookEvent;
  return createRocHookMiddleware({
    hookRuntime: {
      runEvent: vi.fn(input.runEvent)
    },
    runContext: {
      runId: 'run_1',
      threadId: 'thread_1',
      workspacePath: 'F:\\Code\\Roc',
      cwd: 'F:\\Code\\Roc',
      source: 'chat',
      modelId: 'model_1',
      workflowHint: null
    },
    emitHookEvent,
    initialContexts: input.initialContexts
  });
}

type TestMiddleware = ReturnType<typeof createTestMiddleware>;

function contentOf(value: unknown): unknown {
  return Reflect.get(value as object, 'content');
}

async function invokeBeforeModel(middleware: TestMiddleware, state: unknown): Promise<unknown> {
  const beforeModel = middleware.beforeModel;
  if (typeof beforeModel !== 'function') {
    throw new Error('expected beforeModel hook');
  }
  return await beforeModel(state as never, {} as never);
}

async function invokeAfterModel(middleware: TestMiddleware, state: unknown): Promise<unknown> {
  const afterModel = middleware.afterModel;
  if (typeof afterModel !== 'function') {
    throw new Error('expected afterModel hook');
  }
  return await afterModel(state as never, {} as never);
}

describe('createRocHookMiddleware', () => {
  it('installs beforeModel, wrapToolCall, and afterModel hooks', () => {
    const middleware = createTestMiddleware({ runEvent: async () => baseOutcome() });

    expect(typeof middleware.beforeModel).toBe('function');
    expect(typeof middleware.wrapToolCall).toBe('function');
    expect(typeof middleware.afterModel).toBe('function');
  });

  it('submits UserPromptSubmit once before the first model call', async () => {
    const seenEvents: RocHookCommandInput['event'][] = [];
    const middleware = createTestMiddleware({
      runEvent: async (hookInput) => {
        seenEvents.push(hookInput.event);
        return baseOutcome();
      }
    });

    await invokeBeforeModel(middleware, { messages: [new HumanMessage('hello')] });
    await invokeBeforeModel(middleware, { messages: [new HumanMessage('again')] });

    expect(seenEvents).toEqual(['UserPromptSubmit']);
  });

  it('injects initial and UserPromptSubmit contexts on the first model call', async () => {
    const middleware = createTestMiddleware({
      initialContexts: ['SessionStart context.'],
      runEvent: async () => baseOutcome({ additionalContexts: ['Prompt context.'] })
    });

    const update = await invokeBeforeModel(middleware, { messages: [new HumanMessage('hello')] });

    expect((update as { messages: unknown[] }).messages.map(contentOf)).toEqual(['SessionStart context.', 'Prompt context.']);
  });

  it('injects delayed PostToolUse add_context on the next beforeModel call', async () => {
    const middleware = createTestMiddleware({
      runEvent: async (hookInput) => {
        if (hookInput.event === 'PostToolUse') {
          return baseOutcome({ additionalContexts: ['Use the sanitized file path.'] });
        }
        return baseOutcome();
      }
    });

    await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call_1',
          name: 'read_file',
          args: { path: 'README.md' }
        }
      } as never,
      async () => new ToolMessage({ tool_call_id: 'call_1', content: 'ok' })
    );
    const update = await invokeBeforeModel(middleware, { messages: [new HumanMessage('continue')] });

    expect((update as { messages: unknown[] }).messages.map(contentOf)).toEqual(['Use the sanitized file path.']);
  });

  it('blocks PreToolUse with a ToolMessage error', async () => {
    const middleware = createTestMiddleware({
      runEvent: async () => baseOutcome({ blocked: true, blockReason: 'blocked by hook' })
    });

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call_1',
          name: 'run_shell_command',
          args: { command: 'dir' }
        }
      } as never,
      async () => new ToolMessage({ tool_call_id: 'call_1', content: 'should not run' })
    );

    expect(ToolMessage.isInstance(result)).toBe(true);
    expect(contentOf(result)).toContain('blocked by hook');
  });

  it('replaces tool input before handler runs', async () => {
    const handler = vi.fn(async (request: unknown) => Reflect.get(Reflect.get(request as object, 'toolCall'), 'args'));
    const middleware = createTestMiddleware({
      runEvent: async (hookInput) => {
        if (hookInput.event === 'PreToolUse') {
          return baseOutcome({ updatedInput: { command: 'Get-Location' } });
        }
        return baseOutcome();
      }
    });

    await expect(
      middleware.wrapToolCall!(
        {
          toolCall: {
            id: 'call_1',
            name: 'run_shell_command',
            args: { command: 'dir' }
          }
        } as never,
        handler
      )
    ).resolves.toEqual({ command: 'Get-Location' });
  });

  it('caps Stop request_continue at three consecutive continuations', async () => {
    const middleware = createTestMiddleware({
      runEvent: async () => baseOutcome({ requestContinue: 'continue once more' })
    });
    const state = { messages: [new AIMessage('done')] } as never;

    const first = await invokeAfterModel(middleware, state);
    const second = await invokeAfterModel(middleware, state);
    const third = await invokeAfterModel(middleware, state);
    const fourth = await invokeAfterModel(middleware, state);

    expect(Reflect.get(first as object, 'jumpTo')).toBe('model');
    expect(Reflect.get(second as object, 'jumpTo')).toBe('model');
    expect(Reflect.get(third as object, 'jumpTo')).toBe('model');
    expect(fourth).toBeUndefined();
  });

  it('forwards hook_started and hook_completed runtime events', async () => {
    const emitted: RocHookRunEvent[] = [];
    const started: RocHookRunEvent = {
      type: 'hook_started',
      runId: 'run_1',
      hook: {
        runId: 'run_1:hook:PreToolUse:0:0',
        handlerId: 'PreToolUse:0:0',
        event: 'PreToolUse',
        status: 'running',
        durationMs: null,
        message: null
      }
    };
    const completed: RocHookRunEvent = {
      type: 'hook_completed',
      runId: 'run_1',
      hook: {
        runId: 'run_1:hook:PreToolUse:0:0',
        handlerId: 'PreToolUse:0:0',
        event: 'PreToolUse',
        status: 'completed',
        durationMs: 3,
        message: null
      }
    };
    const middleware = createTestMiddleware({
      emitHookEvent: (event) => {
        if (event.type === 'hook_started' || event.type === 'hook_completed') {
          emitted.push(event);
        }
      },
      runEvent: async (hookInput) => (hookInput.event === 'PreToolUse' ? baseOutcome({ events: [started, completed] }) : baseOutcome())
    });

    await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call_1',
          name: 'run_shell_command',
          args: { command: 'dir' }
        }
      } as never,
      async () => new ToolMessage({ tool_call_id: 'call_1', content: 'ok' })
    );

    expect(emitted.map((event) => event.type)).toEqual(['hook_started', 'hook_completed']);
  });
});
