import { AIMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentDeepAgentExecutor } from '../../../../src/main/plugins/agent/deep-agent-executor';
import type { AgentModelHandle } from '../../../../src/main/plugins/agent/model-factory-adapter';
import type { RocCapabilityRegistry } from '../../../../src/main/kernel/types';
import type { TaskRun } from '../../../../src/shared/types';

const mocked = vi.hoisted(() => ({
  buildDeepAgent: vi.fn(),
  createBackend: vi.fn()
}));

vi.mock('../../../../src/main/services/deep-agent/agent-builder', () => ({
  buildDeepAgent: mocked.buildDeepAgent
}));

vi.mock('../../../../src/main/services/deep-agent/backend', () => ({
  createBackend: mocked.createBackend
}));

describe('createAgentDeepAgentExecutor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocked.buildDeepAgent.mockReset();
    mocked.createBackend.mockReset();
  });

  it('yields message chunks before the DeepAgent final output resolves', async () => {
    let resolveOutput!: (value: string) => void;
    const output = new Promise<string>((resolve) => {
      resolveOutput = resolve;
    });
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([
          {
            contentBlocks: [
              {
                type: 'text',
                text: '实时回答'
              }
            ]
          }
        ]),
        output,
        subagents: createAsyncIterable([]),
        toolCalls: createAsyncIterable([])
      }))
    });
    const executor = createAgentDeepAgentExecutor({
      capabilities: createCapabilities(),
      paths: {} as never
    });
    const events = await executor.execute({
      abortSignal: new AbortController().signal,
      modelHandle: createModelHandle(),
      request: {
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        },
        input: '解释流式输出',
        mode: 'task'
      },
      run: createTaskRun()
    });
    const iterator = events[Symbol.asyncIterator]();

    const firstEventPromise = iterator.next();
    const firstEvent = await Promise.race([
      firstEventPromise,
      wait(25).then(() => 'timeout' as const)
    ]);
    resolveOutput('final output');
    if (firstEvent === 'timeout') {
      await firstEventPromise;
    } else {
      await iterator.return?.(undefined);
    }

    expect(firstEvent).toEqual({
      done: false,
      value: {
        type: 'message_delta',
        runId: 'run-streaming',
        delta: '实时回答'
      }
    });
  });

  it('yields the final assistant output when the provider does not stream message text', async () => {
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([]),
        output: {
          messages: [
            {
              content: '最终回答',
              type: 'ai'
            }
          ]
        },
        subagents: createAsyncIterable([]),
        toolCalls: createAsyncIterable([])
      }))
    });
    const executor = createAgentDeepAgentExecutor({
      capabilities: createCapabilities(),
      paths: {} as never
    });

    const events = await collectEvents(await executor.execute({
      abortSignal: new AbortController().signal,
      modelHandle: createModelHandle(),
      request: {
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        },
        input: '解释 Agnes 响应',
        mode: 'task'
      },
      run: createTaskRun()
    }));

    expect(events).toEqual([
      {
        type: 'message_delta',
        runId: 'run-streaming',
        delta: '最终回答'
      }
    ]);
  });

  it('reads final assistant output from LangChain AIMessage instances', async () => {
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([]),
        output: {
          messages: [
            new AIMessage({
              content: [
                {
                  type: 'text',
                  text: '实例回答'
                }
              ]
            })
          ]
        },
        subagents: createAsyncIterable([]),
        toolCalls: createAsyncIterable([])
      }))
    });
    const executor = createAgentDeepAgentExecutor({
      capabilities: createCapabilities(),
      paths: {} as never
    });

    const events = await collectEvents(await executor.execute({
      abortSignal: new AbortController().signal,
      modelHandle: createModelHandle(),
      request: {
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        },
        input: '解释 Agnes 响应',
        mode: 'task'
      },
      run: createTaskRun()
    }));

    expect(events).toEqual([
      {
        type: 'message_delta',
        runId: 'run-streaming',
        delta: '实例回答'
      }
    ]);
  });

  it('does not emit earlier assistant output when the final message is not assistant text', async () => {
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([]),
        output: {
          messages: [
            {
              content: '历史回答',
              type: 'ai'
            },
            {
              content: '新的用户输入',
              type: 'human'
            }
          ]
        },
        subagents: createAsyncIterable([]),
        toolCalls: createAsyncIterable([])
      }))
    });
    const executor = createAgentDeepAgentExecutor({
      capabilities: createCapabilities(),
      paths: {} as never
    });

    const events = await collectEvents(await executor.execute({
      abortSignal: new AbortController().signal,
      modelHandle: createModelHandle(),
      request: {
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        },
        input: '解释 Agnes 响应',
        mode: 'task'
      },
      run: createTaskRun()
    }));

    expect(events).toEqual([]);
  });

  it('does not emit hosted search payloads from final assistant output', async () => {
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([]),
        output: {
          messages: [
            {
              content: [
                {
                  type: 'text',
                  text: 'Title: Search result\nURL: https://example.test\nPublished: 2026-06-10\nAuthor: example\nHighlights:\n- raw result'
                }
              ],
              type: 'ai'
            }
          ]
        },
        subagents: createAsyncIterable([]),
        toolCalls: createAsyncIterable([])
      }))
    });
    const executor = createAgentDeepAgentExecutor({
      capabilities: createCapabilities(),
      paths: {} as never
    });

    const events = await collectEvents(await executor.execute({
      abortSignal: new AbortController().signal,
      modelHandle: createModelHandle(),
      request: {
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        },
        input: '解释 Agnes 响应',
        mode: 'task'
      },
      run: createTaskRun()
    }));

    expect(events).toEqual([]);
  });

  it('does not synthesize assistant text when a run finishes with reasoning only', async () => {
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([
          {
            reasoning: createAsyncIterable(['已完成文件写入。']),
            text: null
          }
        ]),
        output: {
          messages: []
        },
        subagents: createAsyncIterable([]),
        toolCalls: createAsyncIterable([])
      }))
    });
    const executor = createAgentDeepAgentExecutor({
      capabilities: createCapabilities(),
      paths: {} as never
    });

    const events = await collectEvents(await executor.execute({
      abortSignal: new AbortController().signal,
      modelHandle: createModelHandle(),
      request: {
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        },
        input: '创建一个 docx 文件，里面写你好世界',
        mode: 'task'
      },
      run: createTaskRun()
    }));

    expect(events).toEqual([
      {
        type: 'reasoning_delta',
        runId: 'run-streaming',
        delta: '已完成文件写入。'
      }
    ]);
  });

  it('does not synthesize assistant text when a file task only produces tool activity', async () => {
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([]),
        output: {
          messages: []
        },
        subagents: createAsyncIterable([]),
        toolCalls: createAsyncIterable([
          {
            name: 'write_file',
            input: {
              file_path: '/workspace/hello.docx'
            },
            output: 'Successfully wrote to /workspace/hello.docx'
          }
        ])
      }))
    });
    const executor = createAgentDeepAgentExecutor({
      capabilities: createCapabilities(),
      paths: {} as never
    });

    const events = await collectEvents(await executor.execute({
      abortSignal: new AbortController().signal,
      modelHandle: createModelHandle(),
      request: {
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        },
        input: '创建一个 docx 文件，里面写你好世界',
        mode: 'task'
      },
      run: createTaskRun()
    }));

    expect(events).toContainEqual({
      type: 'tool_event',
      runId: 'run-streaming',
      event: 'end',
      name: 'write_file',
      data: 'Successfully wrote to /workspace/hello.docx'
    });
    expect(events.some((event) => event.type === 'message_delta')).toBe(false);
  });
});

function createCapabilities(): RocCapabilityRegistry {
  return {
    invoke: vi.fn(async (name: string) => {
      if (name === 'workspace.getCurrent') {
        return null;
      }
      throw new Error(`unexpected capability: ${name}`);
    }),
    list: vi.fn(() => []),
    register: vi.fn(),
    subscribe: vi.fn(() => () => {})
  } as unknown as RocCapabilityRegistry;
}

function createModelHandle(): AgentModelHandle {
  return {
    langChainHandle: {
      model: {} as never,
      modelId: 'openai:gpt-4.1',
      provider: {} as never,
      runtime: {
        baseUrl: null,
        contextBudgetTokens: 4096,
        modelKwargs: {},
        providerType: 'openai_compatible',
        streaming: true
      }
    },
    modelId: 'openai:gpt-4.1',
    providerId: 'openai'
  };
}

function createTaskRun(): TaskRun {
  return {
    enabledCapabilities: {
      mcpServers: [],
      skills: []
    },
    endedAt: null,
    id: 'run-streaming',
    modelId: 'openai:gpt-4.1',
    runNumber: 1,
    startedAt: '2026-06-09T00:00:00.000Z',
    status: 'running',
    threadId: 'thread-streaming',
    userInput: '解释流式输出'
  };
}

async function* createAsyncIterable(values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) {
    yield value;
  }
}

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
