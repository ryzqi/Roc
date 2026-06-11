import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

import { markForgeNudgeInternal, tagForgeMessage } from '../../../../src/main/services/forge-guardrails';
import {
  consumeMessageStream,
  createUsageAccumulator
} from '../../../../src/main/services/deep-agent/stream-consumers';

describe('consumeMessageStream', () => {
  it('streams all reasoning before answer text even when answer chunks are ready earlier', async () => {
    const outputOrder: string[] = [];

    await consumeMessageStream({
      messages: createSingleMessageStream({
        reasoning: createDelayedStringStream([
          { delayMs: 10, value: '推理第一段' },
          { delayMs: 10, value: '推理第二段' }
        ]),
        text: createDelayedStringStream([
          { delayMs: 0, value: '答案第一段' },
          { delayMs: 0, value: '答案第二段' }
        ])
      }),
      context: {
        runId: 'run-serial-order',
        taskRun: null
      },
      assistantChunks: [],
      reasoningChunks: [],
      usageAccumulator: createUsageAccumulator(),
      callbacks: createCallbacks(outputOrder)
    });

    expect(outputOrder).toEqual([
      'reasoning:推理第一段',
      'reasoning:推理第二段',
      'message:答案第一段',
      'message:答案第二段'
    ]);
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

function createCallbacks(outputOrder: string[]) {
  return {
    emitRuntimeEvent: vi.fn((event: { type: string; delta?: string }) => {
      if (event.type === 'reasoning_delta' && typeof event.delta === 'string') {
        outputOrder.push(`reasoning:${event.delta}`);
      }
      if (event.type === 'message_delta' && typeof event.delta === 'string') {
        outputOrder.push(`message:${event.delta}`);
      }
    }),
    emitTodoEvent: vi.fn(),
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
