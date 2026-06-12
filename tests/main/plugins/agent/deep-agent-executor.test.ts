import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentDeepAgentExecutor } from '../../../../src/main/plugins/agent/deep-agent-executor';
import { tagForgeMessage } from '../../../../src/main/services/forge-guardrails';
import type { AgentModelHandle } from '../../../../src/main/plugins/agent/model-factory-adapter';
import type { RocCapabilityRegistry } from '../../../../src/main/kernel/types';
import type { TaskRun } from '../../../../src/shared/types';

const mocked = vi.hoisted(() => ({
  buildDeepAgent: vi.fn(),
  createBackend: vi.fn()
}));

const REMOVED_STEP_TRACKER_FIELD = ['forge', 'step', 'tracker'].join('_');

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
        type: 'assistant_block',
        runId: 'run-streaming',
        block: {
          kind: 'text',
          blockId: 'text-run-streaming',
          phase: 'delta',
          text: '实时回答'
        }
      }
    });
  });

  it('starts new DeepAgent runs without forge step tracker state', async () => {
    const streamEvents = vi.fn(async () => ({
      interrupted: false,
      messages: createAsyncIterable([]),
      output: {
        messages: []
      },
      subagents: createAsyncIterable([]),
      toolCalls: createAsyncIterable([])
    }));
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents
    });
    const executor = createAgentDeepAgentExecutor({
      capabilities: createCapabilities(),
      paths: {} as never
    });

    await collectEvents(await executor.execute({
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

    const streamEventCalls = streamEvents.mock.calls as unknown as Array<[unknown]>;
    const runInput = streamEventCalls[0]?.[0] as Record<string, unknown> | undefined;
    expect(runInput).toMatchObject({
      forge_error_tracker: {
        consecutiveRetries: 0,
        consecutiveToolErrors: 0,
        maxRetries: 3,
        maxToolErrors: 2
      }
    });
    expect(Object.keys((runInput?.forge_error_tracker ?? {}) as Record<string, unknown>).sort()).toEqual([
      'consecutiveRetries',
      'consecutiveToolErrors',
      'maxRetries',
      'maxToolErrors'
    ]);
    expect(Reflect.has(runInput ?? {}, REMOVED_STEP_TRACKER_FIELD)).toBe(false);
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
        type: 'assistant_block',
        runId: 'run-streaming',
        block: {
          kind: 'text',
          blockId: 'text-run-streaming',
          phase: 'delta',
          text: '最终回答'
        }
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
        type: 'assistant_block',
        runId: 'run-streaming',
        block: {
          kind: 'text',
          blockId: 'text-run-streaming',
          phase: 'delta',
          text: '实例回答'
        }
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
        type: 'assistant_block',
        runId: 'run-streaming',
        block: {
          kind: 'reasoning',
          blockId: 'reasoning-run-streaming',
          phase: 'delta',
          text: '已完成文件写入。'
        }
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
            callId: 'call-write',
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
      type: 'assistant_block',
      runId: 'run-streaming',
      block: {
        kind: 'tool_call',
        blockId: 'tool-call-write',
        callId: 'call-write',
        name: 'write_file',
        phase: 'end',
        input: {
          file_path: '/workspace/hello.docx'
        },
        output: 'Successfully wrote to /workspace/hello.docx'
      }
    });
    expect(events.some((event) => event.type === 'assistant_block' && event.block.kind === 'text')).toBe(false);
  });

  it('uses final ToolMessage content for tool block output when present', async () => {
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([]),
        output: {
          messages: [
            new ToolMessage({
              content: 'Successfully wrote to /workspace/hello.docx',
              name: 'write_file',
              tool_call_id: 'call-write'
            })
          ]
        },
        subagents: createAsyncIterable([]),
        toolCalls: createAsyncIterable([
          {
            callId: 'call-write',
            name: 'write_file',
            input: {
              file_path: '/workspace/hello.docx'
            },
            output: {
              command: 'internal'
            }
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
      type: 'assistant_block',
      runId: 'run-streaming',
      block: {
        kind: 'tool_call',
        blockId: 'tool-call-write',
        callId: 'call-write',
        name: 'write_file',
        phase: 'end',
        output: 'Successfully wrote to /workspace/hello.docx'
      }
    });
  });

  it('uses final non-file ToolMessage content when toolCalls projection is empty', async () => {
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([
          {
            reasoning: createAsyncIterable(['需要先搜索资料。']),
            text: null
          }
        ]),
        output: {
          messages: [
            new ToolMessage({
              content: 'Search results',
              name: 'web_search',
              tool_call_id: 'call-search'
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
        input: '搜索 Agnes 工具调用问题',
        mode: 'task'
      },
      run: createTaskRun()
    }));

    expect(events).toContainEqual({
      type: 'assistant_block',
      runId: 'run-streaming',
      block: {
        kind: 'tool_call',
        blockId: 'tool-call-search',
        callId: 'call-search',
        name: 'web_search',
        phase: 'end',
        output: 'Search results'
      }
    });
    expect(events.some((event) => event.type === 'assistant_block' && event.block.kind === 'text')).toBe(false);
  });

  it('does not emit a final tool block when ToolMessage has no name', async () => {
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([]),
        output: {
          messages: [
            new ToolMessage({
              content: 'Updated todo list.',
              tool_call_id: 'call-todos'
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
        input: '更新 todo',
        mode: 'task'
      },
      run: createTaskRun()
    }));

    expect(events.some((event) => event.type === 'assistant_block' && event.block.kind === 'tool_call')).toBe(false);
  });

  it('does not emit a final tool block for Forge tagged ToolMessage output', async () => {
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([]),
        output: {
          messages: [
            tagForgeMessage(
              new ToolMessage({
                content: '[ToolResolutionError] Missing prerequisite.',
                name: 'web_search',
                tool_call_id: 'call-search'
              }),
              'forge:tool_resolution'
            )
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
        input: '搜索 Agnes 工具调用问题',
        mode: 'task'
      },
      run: createTaskRun()
    }));

    expect(events.some((event) => event.type === 'assistant_block' && event.block.kind === 'tool_call')).toBe(false);
  });

  it('emits an error block for final file ToolMessage with error status', async () => {
    mocked.createBackend.mockReturnValue({ backend: {} });
    mocked.buildDeepAgent.mockReturnValue({
      streamEvents: vi.fn(async () => ({
        interrupted: false,
        messages: createAsyncIterable([]),
        output: {
          messages: [
            new ToolMessage({
              content: 'Permission denied.',
              name: 'write_file',
              status: 'error',
              tool_call_id: 'call-write'
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
        input: '创建 hello.txt',
        mode: 'task'
      },
      run: createTaskRun()
    }));

    expect(events).toContainEqual({
      type: 'assistant_block',
      runId: 'run-streaming',
      block: {
        kind: 'tool_call',
        blockId: 'tool-call-write',
        callId: 'call-write',
        name: 'write_file',
        phase: 'error',
        error: 'Permission denied.'
      }
    });
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
