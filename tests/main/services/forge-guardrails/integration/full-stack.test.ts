import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { RocCompositeBackend } from '../../../../../src/main/services/deep-agent/backend';
import type { DeepAgentBuildInput } from '../../../../../src/main/services/deep-agent/agent-builder';
import {
  defaultErrorTracker,
  defaultStepTracker,
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
    tools: [fakeTool('propose_background_task'), fakeTool('schedule_background_task'), fakeTool('confirm_with_user')],
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
  it('跨护栏 rescue 后的工具调用会进入 step tracker 累加', async () => {
    const middleware = await buildMiddleware();
    expect(middlewareNames(middleware)).toEqual([
      'RTKMiddleware',
      'toolRetryMiddleware',
      'ForgeErrorBudgetMiddleware',
      'ForgeStepEnforcement',
      'ForgeRespondToolInjection',
      'ContextEditingMiddleware',
      'ForgeRescueParsingMiddleware',
      'ForgeResponseValidation',
      'ForgeToolResolutionMiddleware',
      'ForgeCleanupMiddleware'
    ]);

    const step = byName(middleware, 'ForgeStepEnforcement');
    const rescue = byName(middleware, 'ForgeRescueParsingMiddleware');
    if (typeof step.beforeAgent !== 'function' || typeof step.wrapToolCall !== 'function') {
      throw new Error('Expected step enforcement middleware hooks.');
    }
    if (typeof rescue.afterModel !== 'function') {
      throw new Error('Expected rescue parsing afterModel hook.');
    }

    const initialized = step.beforeAgent({ messages: [] }, {}) as { forge_step_tracker: ReturnType<typeof defaultStepTracker> };
    const rescued = (await rescue.afterModel(
      {
        messages: [
          new HumanMessage('创建后台任务'),
          new AIMessage({
            id: 'ai-mistral',
            content:
              '[TOOL_CALLS]propose_background_task{"goal":"每天抓新闻","trigger":{"type":"manual","description":"手动"},"workspacePath":"F:\\\\Code\\\\Roc"}'
          })
        ]
      },
      {}
    )) as { messages: BaseMessage[] };
    const rebuilt = rescued.messages[1] as AIMessage;
    const toolCall = rebuilt.tool_calls?.[0];
    if (toolCall === undefined) {
      throw new Error('Expected rescue parsing to rebuild a tool call.');
    }

    const result = await step.wrapToolCall(
      {
        toolCall,
        state: {
          forge_step_tracker: initialized.forge_step_tracker
        }
      },
      async () =>
        new ToolMessage({
          id: 'tool-propose',
          tool_call_id: toolCall.id ?? 'call-propose',
          name: toolCall.name,
          content: '{"previewId":"preview-1"}',
          status: 'success'
        })
    );

    expect(result).toBeInstanceOf(Command);
    expect((result as Command).update).toMatchObject({
      forge_step_tracker: {
        executedTools: {
          propose_background_task: [
            {
              goal: '每天抓新闻',
              workspacePath: 'F:\\Code\\Roc'
            }
          ]
        }
      }
    });
  });

  it('TieredCompact 后 step_tracker 与 error_tracker 不丢', async () => {
    const stepTracker = {
      ...defaultStepTracker(),
      executedTools: {
        propose_background_task: [{ goal: 'X' }]
      },
      iterationIndex: 5
    };
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
    expect(stepTracker).toEqual({
      ...defaultStepTracker(),
      executedTools: {
        propose_background_task: [{ goal: 'X' }]
      },
      iterationIndex: 5
    });
    expect(errorTracker).toEqual({
      ...defaultErrorTracker(),
      consecutiveToolErrors: 1
    });
  });

  it('HITL resume 后 workflow sticky 续跑', async () => {
    const middleware = await buildMiddleware({ workflowHint: null });
    const step = byName(middleware, 'ForgeStepEnforcement');
    if (typeof step.beforeAgent !== 'function') {
      throw new Error('Expected step enforcement beforeAgent hook.');
    }

    const update = step.beforeAgent(
      {
        messages: [],
        forge_step_tracker: {
          ...defaultStepTracker(),
          executedTools: {
            propose_background_task: [{ goal: 'X' }]
          },
          requiredSteps: ['propose_background_task', 'schedule_background_task'],
          terminalTools: ['confirm_with_user'],
          iterationIndex: 4
        }
      },
      {}
    );

    expect(update).toBeUndefined();
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
