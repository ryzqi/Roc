import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { RocCompositeBackend } from '../../../../../src/main/services/deep-agent/backend';
import type { DeepAgentBuildInput } from '../../../../../src/main/services/deep-agent/agent-builder';
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
    filesystemPermissions: undefined,
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

describe('forge guardrails full stack', () => {
  it('wires guardrails without step enforcement and keeps iteration tracking before compaction', async () => {
    const middleware = await buildMiddleware();
    expect(middlewareNames(middleware)).toEqual([
      'RTKMiddleware',
      'PromptCaching',
      'toolRetryMiddleware',
      'ForgeErrorBudgetMiddleware',
      'ForgeIterationTrackingMiddleware',
      'ForgeFilesystemToolErrorMiddleware',
      'ContextEditingMiddleware',
      'ForgeRescueParsingMiddleware',
      'ForgeToolResolutionMiddleware',
      'ForgeCleanupMiddleware'
    ]);
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
