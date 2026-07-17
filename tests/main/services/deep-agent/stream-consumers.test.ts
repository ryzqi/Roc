import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

import { markForgeNudgeInternal, tagForgeMessage } from '../../../../src/main/services/forge-guardrails';
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
      messages: createSingleMessageStream({
        reasoning: reasoning.iterable,
        text: text.iterable
      }),
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
      messages: createSingleMessageStream({
        reasoning: createDelayedStringStream([{ delayMs: 0, value: '只有推理内容' }]),
        text: null
      }),
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
      messages: createSingleMessageStream({
        text: createDelayedStringStream([{ delayMs: 0, value: '只有答案内容' }])
      }),
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

  it('suppresses internal retry nudges from user-visible task output', async () => {
    const outputOrder: string[] = [];
    const callbacks = createCallbacks(outputOrder);
    const nudge = markForgeNudgeInternal(
      tagForgeMessage(
        new HumanMessage({
          content: '你上一条回复没有可见文本，也没有工具调用。'
        }),
        'forge:retry_nudge'
      )
    );

    await consumeMessageStream({
      messages: createSingleMessageStream(nudge),
      context: {
        runId: 'run-internal-nudge',
        taskRun: null
      },
      assistantChunks: [],
      reasoningChunks: [],
      usageAccumulator: createUsageAccumulator(),
      callbacks
    });

    expect(outputOrder).toEqual([]);
    expect(callbacks.recordTaskEvent).not.toHaveBeenCalled();
  });
});

describe('consumeToolCallStream', () => {
  it('propagates output-projection failure instead of reporting a completed tool as failed', async () => {
    const callbacks = createCallbacks([]);
    callbacks.projectToolOutput
      .mockImplementationOnce(() => {
        throw new Error('tool_output_projection_failed');
      })
      .mockImplementation(({ output }: { output: unknown }) => output);

    await expect(
      consumeToolCallStream({
        calls: createSingleMessageStream({
          id: 'call-projection-failure',
          name: 'write_file',
          input: { path: '/workspace/result.txt' },
          output: 'write completed'
        }),
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
      calls: createSingleMessageStream({
        id: 'call-project-output',
        name: 'read_file',
        input: { path: '/workspace/secret.txt' },
        output: 'Bearer should-not-reach-the-timeline'
      }),
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
    expect(callbacks.recordSessionToolCall).toHaveBeenCalledWith('read_file', { path: '/workspace/secret.txt' }, projectedOutput);
  });

  it('does not emit a synthetic tool block when DeepAgents omits callId', async () => {
    const callbacks = createCallbacks([]);

    await consumeToolCallStream({
      calls: createSingleMessageStream({
        name: 'write_file',
        input: {
          file_path: '/workspace/hello.txt'
        },
        output: 'Successfully wrote to /workspace/hello.txt'
      }),
      context: {
        runId: 'run-missing-call-id',
        taskRun: null
      },
      callbacks
    });

    expect(callbacks.emitRuntimeEvent).not.toHaveBeenCalled();
    expect(callbacks.emitTodoEvent).not.toHaveBeenCalled();
  });
});

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
    recordSessionToolCall: vi.fn(),
    recordTaskEvent: vi.fn()
  };
}

async function* createSingleMessageStream(message: unknown): AsyncGenerator<unknown> {
  yield message;
}

async function* createDelayedStringStream(
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
