import { describe, expect, it, vi } from 'vitest';

import type { DeepAgentDomainEvent } from '../../../../src/main/services/deep-agent/deep-agents-1-10-stream-adapter';
import {
  consumeDeepAgentEventStream,
  createStreamConsumerState,
  createUsageAccumulator
} from '../../../../src/main/services/deep-agent/stream-consumers';
import type { ChatRunEvent } from '../../../../src/shared/types';

describe('consumeDeepAgentEventStream', () => {
  it('projects root domain events and retains terminal interrupt state', async () => {
    const runtimeEvents: ChatRunEvent[] = [];
    const recordSessionToolCall = vi.fn();
    const assistantChunks: string[] = [];
    const reasoningChunks: string[] = [];
    const usageAccumulator = createUsageAccumulator();
    const state = createStreamConsumerState({
      assistantChunks,
      reasoningChunks,
      usageAccumulator
    });
    const events: DeepAgentDomainEvent[] = [
      { type: 'assistant_delta', scope: null, kind: 'reasoning', text: 'reason' },
      { type: 'assistant_delta', scope: null, kind: 'text', text: 'answer' },
      {
        type: 'usage',
        usageKey: 'run/messages/0',
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          cacheReadTokens: null,
          cacheCreationTokens: null
        }
      },
      {
        type: 'tool_call_started',
        scope: null,
        callId: 'call-1',
        name: 'read_file',
        input: { path: '/workspace/a.txt' }
      },
      {
        type: 'tool_call_completed',
        scope: null,
        callId: 'call-1',
        name: 'read_file',
        input: { path: '/workspace/a.txt' },
        output: 'content'
      },
      {
        type: 'run_interrupted',
        interrupts: [{ interruptId: 'interrupt-1', payload: { kind: 'question' } }]
      }
    ];

    await consumeDeepAgentEventStream({
      events: asyncValues(events),
      runId: 'run-1',
      state,
      callbacks: {
        emitRuntimeEvent: (event) => runtimeEvents.push(event),
        recordSessionToolCall
      }
    });

    expect(assistantChunks).toEqual(['answer']);
    expect(reasoningChunks).toEqual(['reason']);
    expect(usageAccumulator).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5
    });
    expect(runtimeEvents).toEqual([
      expect.objectContaining({
        type: 'assistant_block',
        block: expect.objectContaining({ kind: 'reasoning', text: 'reason' })
      }),
      expect.objectContaining({
        type: 'assistant_block',
        block: expect.objectContaining({ kind: 'text', text: 'answer' })
      }),
      expect.objectContaining({
        type: 'assistant_block',
        block: expect.objectContaining({ kind: 'tool_call', phase: 'start' })
      }),
      expect.objectContaining({
        type: 'assistant_block',
        block: expect.objectContaining({ kind: 'tool_call', phase: 'end', output: 'content' })
      })
    ]);
    expect(recordSessionToolCall).toHaveBeenCalledWith(
      'read_file',
      { path: '/workspace/a.txt' },
      'content'
    );
    expect(state.interrupted).toEqual([
      { interruptId: 'interrupt-1', payload: { kind: 'question' } }
    ]);
  });

  it('records projected tool failures without completing the call', async () => {
    const runtimeEvents: ChatRunEvent[] = [];
    const recordSessionToolCall = vi.fn();
    const state = createStreamConsumerState({
      assistantChunks: [],
      reasoningChunks: [],
      usageAccumulator: createUsageAccumulator()
    });

    await consumeDeepAgentEventStream({
      events: asyncValues<DeepAgentDomainEvent>([{
        type: 'tool_call_failed',
        scope: null,
        callId: 'call-error',
        name: 'web_read',
        input: { url: 'https://example.com' },
        error: '[REDACTED]'
      }]),
      runId: 'run-error',
      state,
      callbacks: {
        emitRuntimeEvent: (event) => runtimeEvents.push(event),
        recordSessionToolCall
      }
    });

    expect(runtimeEvents).toEqual([
      expect.objectContaining({
        block: expect.objectContaining({ phase: 'error', error: '[REDACTED]' })
      })
    ]);
    expect(recordSessionToolCall).toHaveBeenCalledWith(
      'web_read',
      { url: 'https://example.com' },
      { error: '[REDACTED]' }
    );
  });
});

async function* asyncValues<T>(values: readonly T[]): AsyncGenerator<T> {
  yield* values;
}
