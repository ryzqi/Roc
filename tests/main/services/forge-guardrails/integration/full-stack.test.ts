import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { MiddlewareError } from 'langchain';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { RocCompositeBackend } from '../../../../../src/main/services/deep-agent/backend';
import type { DeepAgentBuildInput } from '../../../../../src/main/services/deep-agent/agent-builder';
import { RocDomainError } from '../../../../../src/main/services/errors';
import {
  defaultErrorTracker,
  markIterationOnMessage,
  tagForgeMessage
} from '../../../../../src/main/services/forge-guardrails';
import { createForgeTieredCompactionEdits } from '../../../../../src/main/services/forge-guardrails/middleware/forge-tiered-compaction';

const mocked = vi.hoisted(() => ({
  createDeepAgentMock: vi.fn(() => ({
    invoke: vi.fn(),
    streamEvents: vi.fn()
  }))
}));

vi.mock('deepagents', async () => {
  const actual = await vi.importActual<typeof import('deepagents')>('deepagents');
  return {
    ...actual,
    createDeepAgent: mocked.createDeepAgentMock
  };
});

type MiddlewareDescriptor = {
  afterModel?: ((state: { messages: BaseMessage[] }, runtime: unknown) => unknown | Promise<unknown>) | {
    hook: (state: { messages: BaseMessage[] }, runtime: unknown) => unknown | Promise<unknown>;
  };
  beforeAgent?: (state: unknown, runtime: unknown) => unknown;
  beforeModel?: (state: { messages: BaseMessage[] }, runtime: unknown) => unknown;
  name: string;
  wrapToolCall?: (request: unknown, handler: (request: unknown) => Promise<unknown>) => Promise<unknown>;
};

function fakeTool(name: string): ClientTool {
  return {
    name,
    description: `${name} tool`,
    schema: z.object({}),
    invoke: vi.fn()
  } as unknown as ClientTool;
}

async function buildMiddleware(input?: Partial<DeepAgentBuildInput>): Promise<MiddlewareDescriptor[]> {
  mocked.createDeepAgentMock.mockClear();
  const { buildDeepAgent } = await import('../../../../../src/main/services/deep-agent/agent-builder');
  buildDeepAgent({
    model: 'model-ready' as never,
    systemPrompt: 'system prompt',
    backend: { routePrefixes: ['/memory/'] } as RocCompositeBackend,
    store: {} as never,
    memorySources: [],
    skillSources: [],
    subagents: [],
    tools: [fakeTool('propose_background_task'), fakeTool('schedule_background_task')],
    filesystemPermissions: [],
    workspacePath: 'F:\\Code\\Roc',
    interruptOn: undefined,
    checkpointer: undefined,
    providerType: 'llama_cpp',
    workflowHint: 'propose_background_task',
    contextBudgetTokens: 4096,
    ...input
  });
  const calls = mocked.createDeepAgentMock.mock.calls as unknown as Array<[unknown]>;
  const createAgentInput = calls.at(-1)?.[0] as { middleware?: MiddlewareDescriptor[] } | undefined;
  return createAgentInput?.middleware ?? [];
}

function byName(middleware: MiddlewareDescriptor[], name: string): MiddlewareDescriptor {
  const match = middleware.find((candidate) => candidate.name === name);
  if (match === undefined) {
    throw new Error(`Missing middleware ${name}.`);
  }
  return match;
}

function middlewareNames(middleware: MiddlewareDescriptor[]): string[] {
  return middleware.map((item) => item.name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRequestState(request: unknown): Record<string, unknown> {
  if (!isRecord(request) || !isRecord(request.state)) {
    return {};
  }
  return request.state;
}

function requireRequestRecord(request: unknown): Record<string, unknown> {
  if (!isRecord(request)) {
    throw new Error('Expected middleware request object.');
  }
  return request;
}

function middlewareState(middleware: MiddlewareDescriptor, state: Record<string, unknown>): Record<string, unknown> {
  if (middleware.name === 'ForgeErrorBudgetMiddleware') {
    return {
      messages: Array.isArray(state.messages) ? state.messages : [],
      forge_error_tracker: state.forge_error_tracker
    };
  }
  return {
    messages: Array.isArray(state.messages) ? state.messages : []
  };
}

async function runToolThroughMiddleware(
  middleware: MiddlewareDescriptor[],
  request: unknown,
  handler: (request: unknown) => Promise<unknown>
): Promise<unknown> {
  const wrappers = middleware.filter((item) => typeof item.wrapToolCall === 'function');
  let next = handler;
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    const wrapper = wrappers[index];
    const wrapToolCall = wrapper?.wrapToolCall;
    if (wrapToolCall === undefined) {
      throw new Error('Missing wrapToolCall.');
    }
    const inner = next;
    next = async (currentRequest) => {
      const currentRequestRecord = requireRequestRecord(currentRequest);
      const originalState = readRequestState(currentRequest);
      try {
        const result = await wrapToolCall(
          {
            ...currentRequestRecord,
            state: middlewareState(wrapper, originalState)
          },
          async (passedRequest) => {
            const passedRequestRecord = requireRequestRecord(passedRequest);
            const passedState = readRequestState(passedRequest);
            return await inner({
              ...passedRequestRecord,
              state: {
                ...originalState,
                ...passedState
              }
            });
          }
        );
        if (!ToolMessage.isInstance(result) && !(result instanceof Command)) {
          throw new Error(`Invalid response from "wrapToolCall" in middleware "${wrapper.name}".`);
        }
        return result;
      } catch (error) {
        throw MiddlewareError.wrap(error, wrapper.name);
      }
    };
  }
  return await next(request);
}

describe('forge guardrails full stack', () => {
  it('wires guardrails without step enforcement and keeps iteration tracking before compaction', async () => {
    const middleware = await buildMiddleware();
    expect(middlewareNames(middleware)).toEqual([
      'RocShellPathPolicyMiddleware',
      'RTKMiddleware',
      'PromptCaching',
      'toolRetryMiddleware',
      'RocToolProtocolMiddleware',
      'ForgeErrorBudgetMiddleware',
      'ForgeIterationTrackingMiddleware',
      'RocFilesystemPathPolicyMiddleware',
      'ForgeFilesystemToolErrorMiddleware',
      'ContextEditingMiddleware',
      'ForgeRescueParsingMiddleware',
      'ForgeToolResolutionMiddleware',
      'RocToolRuntimeErrorMiddleware',
      'ForgeCleanupMiddleware'
    ]);
  });

  it('feeds Roc delete_file tool errors back through the agent error budget', async () => {
    const middleware = await buildMiddleware();
    const result = await runToolThroughMiddleware(
      middleware,
      {
        toolCall: {
          name: 'delete_file',
          args: { file_path: '/workspace/docs' },
          id: 'call-delete-dir'
        },
        state: {
          messages: [],
          forge_error_tracker: defaultErrorTracker()
        }
      },
      async () => {
        throw new RocDomainError({
          code: 'delete_file_target_not_empty',
          message: '只能删除空目录。',
          category: 'validation',
          retryable: false,
          userAction: '请先清空目录内容，或改为删除具体文件。'
        });
      }
    );

    expect(result).toBeInstanceOf(Command);
    const update = (result as Command).update as { messages?: unknown[]; forge_error_tracker?: { consecutiveToolErrors?: number } };
    const [message] = update.messages ?? [];
    expect(message).toBeInstanceOf(ToolMessage);
    expect((message as ToolMessage).status).toBe('error');
    expect((message as ToolMessage).tool_call_id).toBe('call-delete-dir');
    expect((message as ToolMessage).name).toBe('delete_file');
    expect(String((message as ToolMessage).content)).toContain('delete_file_target_not_empty');
    expect(String((message as ToolMessage).content)).toContain('只能删除空目录。');
    expect(String((message as ToolMessage).content)).toContain('请先清空目录内容，或改为删除具体文件。');
    expect(update.forge_error_tracker).toMatchObject({
      consecutiveToolErrors: 1
    });
  });

  it('TieredCompact 后 error_tracker 不丢', async () => {
    const errorTracker = {
      ...defaultErrorTracker(),
      consecutiveToolErrors: 1
    };
    const messages = [
      new HumanMessage({ id: 'user', content: 'start' }),
      tagForgeMessage(markIterationOnMessage(new HumanMessage({ id: 'old-nudge', content: 'retry' }), 1), 'forge:retry_nudge'),
      markIterationOnMessage(
        new ToolMessage({
          id: 'old-tool',
          tool_call_id: 'call-old',
          name: 'read_file',
          content: 'x'.repeat(260),
          status: 'success'
        }),
        1
      ),
      markIterationOnMessage(new AIMessage({ id: 'recent-anchor', content: '', tool_calls: [] }), 5)
    ];
    const edits = createForgeTieredCompactionEdits({
      budgetTokens: 1000,
      keepRecent: 2,
      phaseThresholds: [0.6, 0.75, 0.9]
    });

    for (const edit of edits) {
      await edit.apply({
        messages,
        countTokens: async () => 980
      });
    }

    expect(messages.map((message) => message.id)).toEqual(['user', 'recent-anchor']);
    expect(errorTracker).toEqual({
      ...defaultErrorTracker(),
      consecutiveToolErrors: 1
    });
  });

  it('网络瞬时错误不消耗 forge error budget', async () => {
    const middleware = await buildMiddleware();
    const names = middlewareNames(middleware);
    expect(names.indexOf('RTKMiddleware')).toBeLessThan(names.indexOf('toolRetryMiddleware'));
    expect(names.indexOf('toolRetryMiddleware')).toBeLessThan(names.indexOf('ForgeErrorBudgetMiddleware'));

    const errorBudget = byName(middleware, 'ForgeErrorBudgetMiddleware');
    if (typeof errorBudget.wrapToolCall !== 'function') {
      throw new Error('Expected error budget wrapToolCall hook.');
    }

    const result = await errorBudget.wrapToolCall(
      {
        toolCall: { name: 'web_read', args: {}, id: 'call-web' },
        state: {
          forge_error_tracker: {
            ...defaultErrorTracker(),
            consecutiveToolErrors: 1
          }
        }
      },
      async () =>
        new ToolMessage({
          id: 'tool-web',
          tool_call_id: 'call-web',
          name: 'web_read',
          content: 'ok',
          status: 'success'
        })
    );

    expect(result).toBeInstanceOf(Command);
    expect((result as Command).update).toMatchObject({
      forge_error_tracker: {
        consecutiveToolErrors: 0
      }
    });
  });
});
