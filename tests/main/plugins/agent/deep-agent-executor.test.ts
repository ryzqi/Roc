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

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
