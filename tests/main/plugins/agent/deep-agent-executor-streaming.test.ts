import { describe, expect, it } from 'vitest';
import {
  collectExecutorEvents,
  createAsyncIterable,
  createCapabilities,
  createControlledAsyncStream,
  createDeepAgents110V3MessageHandle,
  createDeepAgents110V3ToolCallHandle,
  createDeferred,
  drainIterator,
  isChatRunEventBuffer,
  readIteratorValue,
  startExecutorExecution,
  waitForPromise
} from './deep-agent-executor-test-helpers';

describe('createAgentDeepAgentExecutor', () => {
  it('emits streamed assistant message chunks', async () => {
    const events = await collectExecutorEvents({
      capabilities: createCapabilities([]),
      messages: createAsyncIterable([
        createDeepAgents110V3MessageHandle({
          text: createAsyncIterable(['实时回答'])
        })
      ]),
      output: {
        messages: []
      }
    });

    expect(events).toContainEqual({
      type: 'assistant_block',
      runId: 'run-1',
      block: {
        kind: 'text',
        blockId: 'text-run-1',
        phase: 'delta',
        text: '实时回答'
      }
    });
  });


  it('yields streamed assistant text before reasoning and final output finish', async () => {
    const reasoning = createControlledAsyncStream<string>();
    const text = createControlledAsyncStream<string>();
    const output = createDeferred<unknown>();
    const execution = await startExecutorExecution({
      capabilities: createCapabilities([]),
      messages: createAsyncIterable([
        createDeepAgents110V3MessageHandle({
          reasoning: reasoning.iterable,
          text: text.iterable
        })
      ]),
      output: output.promise
    });
    const iterator = execution.events[Symbol.asyncIterator]();
    const firstRead = iterator.next();

    try {
      await reasoning.waitForRead();
      text.push('实时回答第一段');

      const event = await readIteratorValue(firstRead, 'streamed_text_before_final_output');

      expect(event).toEqual({
        type: 'assistant_block',
        runId: 'run-1',
        block: {
          kind: 'text',
          blockId: 'text-run-1',
          phase: 'delta',
          text: '实时回答第一段'
        }
      });
    } finally {
      text.close();
      reasoning.close();
      output.resolve({ messages: [] });
      await firstRead.catch(() => undefined);
      await waitForPromise(drainIterator(iterator), 'executor_drain');
    }
  });

  it('settles the outcome when the event consumer stops early', async () => {
    const text = createControlledAsyncStream<string>();
    const output = createDeferred<unknown>();
    const execution = await startExecutorExecution({
      capabilities: createCapabilities([]),
      messages: createAsyncIterable([
        createDeepAgents110V3MessageHandle({
          text: text.iterable
        })
      ]),
      output: output.promise
    });
    const iterator = execution.events[Symbol.asyncIterator]();
    const firstRead = iterator.next();

    await text.waitForRead();
    text.push('partial');
    await readIteratorValue(firstRead, 'consumer_stopped_first_event');
    output.reject(new Error('provider stopped after consumer exit'));
    text.close();
    await iterator.return?.();

    await expect(execution.outcome).rejects.toThrow('provider stopped after consumer exit');
  });

  it('observes final output failure when a message stream also fails', async () => {
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const failureGate = createDeferred<void>();
      const output = failureGate.promise.then(() => {
        throw new Error('run output failed');
      });

      await expect(collectExecutorEvents({
        capabilities: createCapabilities([]),
        messages: createAsyncIterable([
          createDeepAgents110V3MessageHandle({
            text: (async function* () {
              failureGate.resolve(undefined);
              throw new Error('message stream failed');
            })()
          })
        ]),
        output
      })).rejects.toThrow('message stream failed');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });


  it('drains buffered assistant events without array shift reindexing while preserving the transcript', async () => {
    const chunks = Array.from({ length: 128 }, (_, index) => `实时片段${index}`);
    const originalShift = Array.prototype.shift;
    Object.defineProperty(Array.prototype, 'shift', {
      configurable: true,
      value: function <T>(this: T[]): T | undefined {
        if (isChatRunEventBuffer(this)) {
          throw new Error('chat_run_event_queue_shift_used');
        }
        return Reflect.apply(originalShift, this, []) as T | undefined;
      }
    });

    try {
      const events = await collectExecutorEvents({
        capabilities: createCapabilities([]),
        messages: createAsyncIterable([
          createDeepAgents110V3MessageHandle({
            text: createAsyncIterable(chunks)
          })
        ]),
        output: {
          messages: []
        }
      });

      const transcript = events
        .map((event) => (event.type === 'assistant_block' && event.block.kind === 'text' ? event.block.text : null))
        .join('');

      expect(transcript).toBe(chunks.join(''));
    } finally {
      Object.defineProperty(Array.prototype, 'shift', {
        configurable: true,
        value: originalShift
      });
    }
  });

  it('stops the tool-event producer when bounded queue overflow aborts the stream', async () => {
    let yieldedCalls = 0;
    let finalized = false;
    const producerFinalized = createDeferred<void>();
    const toolCalls = (async function* () {
      try {
        for (let index = 0; index < 2_000; index += 1) {
          yieldedCalls += 1;
          yield createDeepAgents110V3ToolCallHandle({
            callId: `call-${index}`,
            name: 'read_file',
            input: { path: `/workspace/${index}.txt` },
            output: Promise.resolve({ content: String(index) })
          });
        }
      } finally {
        finalized = true;
        producerFinalized.resolve(undefined);
      }
    })();
    const execution = await startExecutorExecution({
      capabilities: createCapabilities([]),
      toolCalls
    });
    const iterator = execution.events[Symbol.asyncIterator]();
    const firstEvent = await readIteratorValue(iterator.next(), 'tool_queue_first_event');

    expect(firstEvent).toMatchObject({
      type: 'assistant_block',
      block: {
        kind: 'tool_call',
        callId: 'call-0',
        phase: 'start'
      }
    });
    await producerFinalized.promise;
    await expect(drainIterator(iterator)).rejects.toThrow('chat_run_event_queue_overflow');

    expect(finalized).toBe(true);
    expect(yieldedCalls).toBeLessThan(1_000);
  });


  it('emits final assistant output when the provider does not stream message text', async () => {
    const events = await collectExecutorEvents({
      capabilities: createCapabilities([]),
      output: {
        messages: [
          {
            content: '最终回答',
            type: 'ai'
          }
        ]
      }
    });

    expect(events).toEqual([
      {
        type: 'assistant_block',
        runId: 'run-1',
        block: {
          kind: 'text',
          blockId: 'text-run-1',
          phase: 'delta',
          text: '最终回答'
        }
      }
    ]);
  });

  it('does not backfill terminal tool blocks from final output after the tool stream closes', async () => {
    const events = await collectExecutorEvents({
      capabilities: createCapabilities([]),
      output: {
        messages: [
          {
            type: 'tool',
            tool_call_id: 'call-final-tool',
            name: 'read_file',
            status: 'success',
            content: 'raw tool output'
          }
        ]
      }
    });

    expect(events).toEqual([]);
  });

});

