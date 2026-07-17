import { describe, expect, it } from 'vitest';
import {
  collectExecutorEvents,
  createAsyncIterable,
  createCapabilities,
  createControlledAsyncStream,
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
        {
          text: createAsyncIterable(['实时回答'])
        }
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
        {
          reasoning: reasoning.iterable,
          text: text.iterable
        }
      ]),
      output: output.promise
    });
    const iterator = execution[Symbol.asyncIterator]();
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
          {
            text: createAsyncIterable(chunks)
          }
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
    let messageProducerFinalized = false;
    const toolCalls = (async function* () {
      try {
        for (let index = 0; index < 2_000; index += 1) {
          yieldedCalls += 1;
          yield {
            id: `call-${index}`,
            name: 'read_file',
            input: { path: `/workspace/${index}.txt` },
            output: { content: String(index) }
          };
        }
      } finally {
        finalized = true;
      }
    })();
    const messages = (async function* () {
      try {
        for (let index = 0; index < 2_000; index += 1) {
          yield {
            text: createAsyncIterable([`message-${index}`])
          };
        }
      } finally {
        messageProducerFinalized = true;
      }
    })();

    await expect(
      collectExecutorEvents({
        capabilities: createCapabilities([]),
        messages,
        toolCalls
      })
    ).rejects.toThrow('chat_run_event_queue_overflow');

    expect(finalized).toBe(true);
    expect(messageProducerFinalized).toBe(true);
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

