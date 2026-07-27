import { describe, expect, it, vi } from 'vitest';

import {
  DeepAgents110V3ContractError,
  type DeepAgents110V3Message,
  type DeepAgents110V3ToolCall
} from '../../../../src/main/services/deep-agent/deep-agents-1-10-stream-adapter';
import {
  consumeMessageStream,
  consumeToolCallStream,
  createUsageAccumulator
} from '../../../../src/main/services/deep-agent/stream-consumers';

describe('consumeMessageStream', () => {
  it('streams answer text while reasoning remains open', async () => {
    const outputOrder: string[] = [];
    const reasoning = createControlledAsyncStream<string>();
    const text = createControlledAsyncStream<string>();

    const consume = consumeMessageStream({
      messages: single(createMessage({
        reasoning: reasoning.iterable,
        text: text.iterable
      })),
      context: {
        runId: 'run-concurrent-text',
        taskRun: null
      },
      assistantChunks: [],
      reasoningChunks: [],
      usageAccumulator: createUsageAccumulator(),
      callbacks: createCallbacks(outputOrder)
    });

    try {
      await reasoning.waitForRead();
      text.push('答案第一段');
      await waitForOutput(outputOrder, 'message:答案第一段');

      expect(outputOrder).toEqual(['message:答案第一段']);

      reasoning.push('推理第一段');
      await waitForOutput(outputOrder, 'reasoning:推理第一段');

      expect(outputOrder).toEqual(['message:答案第一段', 'reasoning:推理第一段']);
    } finally {
      text.close();
      reasoning.close();
      await consume;
    }
  });

  it('streams reasoning-only messages without requiring assistant text', async () => {
    const outputOrder: string[] = [];

    await consumeMessageStream({
      messages: single(createMessage({
        reasoning: delayedStrings([{ delayMs: 0, value: '只有推理内容' }])
      })),
      context: {
        runId: 'run-reasoning-only',
        taskRun: null
      },
      assistantChunks: [],
      reasoningChunks: [],
      usageAccumulator: createUsageAccumulator(),
      callbacks: createCallbacks(outputOrder)
    });

    expect(outputOrder).toEqual(['reasoning:只有推理内容']);
  });

  it('streams answer-only messages unchanged when no reasoning is present', async () => {
    const outputOrder: string[] = [];

    await consumeMessageStream({
      messages: single(createMessage({
        text: delayedStrings([{ delayMs: 0, value: '只有答案内容' }])
      })),
      context: {
        runId: 'run-answer-only',
        taskRun: null
      },
      assistantChunks: [],
      reasoningChunks: [],
      usageAccumulator: createUsageAccumulator(),
      callbacks: createCallbacks(outputOrder)
    });

    expect(outputOrder).toEqual(['message:只有答案内容']);
  });

  it('uses adapter-projected trailing reasoning when the stream is empty', async () => {
    const outputOrder: string[] = [];
    const message = {
      ...createMessage(),
      trailingReasoning: Promise.resolve('末尾推理')
    };

    await consumeMessageStream({
      messages: single(message),
      context: {
        runId: 'run-trailing-reasoning',
        taskRun: null
      },
      assistantChunks: [],
      reasoningChunks: [],
      usageAccumulator: createUsageAccumulator(),
      callbacks: createCallbacks(outputOrder)
    });

    expect(outputOrder).toEqual(['reasoning:末尾推理']);
  });

  it('observes trailing reasoning failure when the text stream also fails', async () => {
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const message = createMessage({
        text: (async function* () {
          throw new Error('text stream failed');
        })(),
        trailingReasoning: Promise.reject(new Error('message output failed'))
      });

      await expect(consumeMessageStream({
        messages: single(message),
        context: {
          runId: 'run-concurrent-message-failure',
          taskRun: null
        },
        assistantChunks: [],
        reasoningChunks: [],
        usageAccumulator: createUsageAccumulator(),
        callbacks: createCallbacks([])
      })).rejects.toThrow();
      await wait(0);

      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

describe('consumeToolCallStream', () => {
  it('observes tool outcome failure when start projection also fails', async () => {
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const callbacks = createCallbacks([]);
      callbacks.emitRuntimeEvent.mockImplementation(() => {
        throw new Error('tool start projection failed');
      });

      await expect(consumeToolCallStream({
        calls: single(createToolCall({
          outcome: Promise.reject(new Error('tool outcome failed'))
        })),
        context: {
          runId: 'run-concurrent-tool-failure',
          taskRun: null
        },
        callbacks
      })).rejects.toThrow('tool start projection failed');
      await wait(0);

      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('propagates output-projection failure instead of reporting a completed tool as failed', async () => {
    const callbacks = createCallbacks([]);
    callbacks.projectToolOutput
      .mockImplementationOnce(() => {
        throw new Error('tool_output_projection_failed');
      })
      .mockImplementation(({ output }: { output: unknown }) => output);

    await expect(
      consumeToolCallStream({
        calls: single(createToolCall({
          callId: 'call-projection-failure',
          name: 'write_file',
          input: { path: '/workspace/result.txt' },
          outcome: Promise.resolve({ status: 'finished', output: 'write completed' })
        })),
        context: {
          runId: 'run-projection-failure',
          taskRun: null
        },
        callbacks
      })
    ).rejects.toThrow('tool_output_projection_failed');

    expect(callbacks.emitRuntimeEvent).not.toHaveBeenLastCalledWith(
      expect.objectContaining({
        block: expect.objectContaining({ phase: 'error' })
      })
    );
  });

  it('uses the output projector before exposing tool output to runtime callbacks', async () => {
    const callbacks = createCallbacks([]);
    const projectedOutput = {
      kind: 'tool_result_artifact',
      preview: '[REDACTED]',
      truncated: true
    };
    callbacks.projectToolOutput.mockReturnValue(projectedOutput);

    await consumeToolCallStream({
      calls: single(createToolCall({
        callId: 'call-project-output',
        name: 'read_file',
        input: { path: '/workspace/secret.txt' },
        outcome: Promise.resolve({
          status: 'finished',
          output: 'Bearer should-not-reach-the-timeline'
        })
      })),
      context: {
        runId: 'run-project-output',
        taskRun: null
      },
      callbacks
    });

    expect(callbacks.projectToolOutput).toHaveBeenCalledWith({
      callId: 'call-project-output',
      name: 'read_file',
      output: 'Bearer should-not-reach-the-timeline'
    });
    expect(callbacks.emitRuntimeEvent).toHaveBeenLastCalledWith({
      type: 'assistant_block',
      runId: 'run-project-output',
      block: {
        kind: 'tool_call',
        blockId: 'tool-call-project-output',
        callId: 'call-project-output',
        name: 'read_file',
        phase: 'end',
        input: { path: '/workspace/secret.txt' },
        output: projectedOutput
      }
    });
    expect(callbacks.recordSessionToolCall).toHaveBeenCalledWith(
      'read_file',
      { path: '/workspace/secret.txt' },
      projectedOutput
    );
  });

  it('emits a redacted error block when the tool output rejects', async () => {
    const callbacks = createCallbacks([]);

    await consumeToolCallStream({
      calls: single(createToolCall({
        callId: 'call-rejected-output',
        outcome: Promise.reject(new Error('Bearer secret-token'))
      })),
      context: {
        runId: 'run-rejected-output',
        taskRun: null
      },
      callbacks
    });

    expect(callbacks.emitRuntimeEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        block: expect.objectContaining({
          callId: 'call-rejected-output',
          phase: 'error',
          error: '[REDACTED]'
        })
      })
    );
  });

  it('uses terminal tool error without waiting for output', async () => {
    const callbacks = createCallbacks([]);
    const consumption = consumeToolCallStream({
      calls: single(createToolCall({
        callId: 'call-terminal-error',
        outcome: Promise.resolve({ status: 'error', error: 'Bearer secret-token' })
      })),
      context: {
        runId: 'run-terminal-error',
        taskRun: null
      },
      callbacks
    });

    await waitForCondition(
      () => callbacks.projectToolOutput.mock.calls.length === 1,
      'terminal_tool_error_not_projected'
    );
    await consumption;

    expect(callbacks.projectToolOutput).toHaveBeenCalledWith({
      callId: 'call-terminal-error',
      name: 'read_file',
      output: '[REDACTED]'
    });
    expect(callbacks.emitRuntimeEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        block: expect.objectContaining({
          callId: 'call-terminal-error',
          phase: 'error',
          error: '[REDACTED]'
        })
      })
    );
    expect(callbacks.recordSessionToolCall).toHaveBeenCalledWith(
      'read_file',
      { path: '/workspace/fixture.txt' },
      { error: '[REDACTED]' }
    );
  });

  it('propagates adapter contract errors instead of projecting them as tool failures', async () => {
    const callbacks = createCallbacks([]);
    const outcome = Promise.reject(
      new DeepAgents110V3ContractError('deep_agents_1_10_v3_tool_call_status_invalid')
    );
    void outcome.catch(() => undefined);

    await expect(
      consumeToolCallStream({
        calls: single(createToolCall({ outcome })),
        context: {
          runId: 'run-contract-failure',
          taskRun: null
        },
        callbacks
      })
    ).rejects.toThrow('deep_agents_1_10_v3_tool_call_status_invalid');

    expect(callbacks.emitRuntimeEvent).not.toHaveBeenLastCalledWith(
      expect.objectContaining({
        block: expect.objectContaining({ phase: 'error' })
      })
    );
  });
});

function createMessage(overrides: Partial<DeepAgents110V3Message> = {}): DeepAgents110V3Message {
  return {
    usageKey: 'run/messages/0',
    namespace: ['model_request:fixture'],
    node: 'model_request',
    text: empty<string>(),
    reasoning: empty<string>(),
    trailingReasoning: Promise.resolve(null),
    usage: empty(),
    ...overrides
  };
}

function createToolCall(overrides: Partial<DeepAgents110V3ToolCall> = {}): DeepAgents110V3ToolCall {
  return {
    name: 'read_file',
    callId: 'call-fixture',
    input: { path: '/workspace/fixture.txt' },
    outcome: Promise.resolve({ status: 'finished', output: 'fixture output' }),
    ...overrides
  };
}

function createCallbacks(outputOrder: string[]) {
  return {
    emitRuntimeEvent: vi.fn((event: { type: string; block?: { kind: string; text?: string } }) => {
      if (event.type !== 'assistant_block' || event.block === undefined || typeof event.block.text !== 'string') {
        return;
      }
      if (event.block.kind === 'reasoning') {
        outputOrder.push(`reasoning:${event.block.text}`);
      }
      if (event.block.kind === 'text') {
        outputOrder.push(`message:${event.block.text}`);
      }
    }),
    emitTodoEvent: vi.fn(),
    projectToolOutput: vi.fn(({ output }: { output: unknown }) => output),
    recordSessionToolCall: vi.fn()
  };
}

async function* single<T>(value: T): AsyncGenerator<T> {
  yield value;
}

async function* empty<T>(): AsyncGenerator<T> {}

async function* delayedStrings(
  chunks: ReadonlyArray<{ delayMs: number; value: string }>
): AsyncGenerator<string> {
  for (const chunk of chunks) {
    if (chunk.delayMs > 0) {
      await wait(chunk.delayMs);
    }
    yield chunk.value;
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function waitForOutput(outputOrder: readonly string[], expected: string): Promise<void> {
  return waitForCondition(() => outputOrder.includes(expected), `expected_output:${expected}`);
}

async function waitForCondition(predicate: () => boolean, failureMessage: string): Promise<void> {
  const deadline = Date.now() + 100;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(failureMessage);
    }
    await wait(1);
  }
}

type ControlledAsyncStream<T> = {
  close: () => void;
  iterable: AsyncIterable<T>;
  push: (value: T) => void;
  waitForRead: () => Promise<void>;
};

function createControlledAsyncStream<T>(): ControlledAsyncStream<T> {
  const values: T[] = [];
  const pendingReads: Array<(result: IteratorResult<T>) => void> = [];
  const readWaiters: Array<() => void> = [];
  let closed = false;
  let readCount = 0;
  let observedReadCount = 0;

  const notifyRead = () => {
    readCount += 1;
    const waiters = readWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  };

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      const reads = pendingReads.splice(0);
      reads.forEach((resolve) => resolve({ done: true, value: undefined }));
    },
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          notifyRead();
          if (values.length > 0) {
            return Promise.resolve({ done: false, value: values.shift() as T });
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<T>>((resolve) => {
            pendingReads.push(resolve);
          });
        }
      })
    },
    push: (value) => {
      if (closed) {
        throw new Error('controlled_stream_closed');
      }
      const read = pendingReads.shift();
      if (read === undefined) {
        values.push(value);
        return;
      }
      read({ done: false, value });
    },
    waitForRead: async () => {
      if (readCount > observedReadCount) {
        observedReadCount = readCount;
        return;
      }
      await new Promise<void>((resolve) => {
        readWaiters.push(() => {
          observedReadCount = readCount;
          resolve();
        });
      });
    }
  };
}
