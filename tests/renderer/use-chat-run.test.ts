import { describe, expect, it } from 'vitest';
import {
  applyChatRunEventBatch,
  isTerminalChatRunEvent
} from '../../src/renderer/chat/use-chat-run';
import { createEmptyChatRunState } from '../../src/renderer/chat-run-state';
import type { ChatRunEvent } from '../../src/shared/types';

function createRunStartedEvent(): ChatRunEvent {
  return {
    type: 'run_started',
    runId: 'chat_test',
    mode: 'chat',
    threadId: 'thread_test',
    providerId: 'nvidia',
    modelId: 'moonshotai/kimi-k2.6',
    createdAt: '2026-05-09T08:00:00.000Z'
  };
}

function createDeltaEvent(delta: string): ChatRunEvent {
  return {
    type: 'message_delta',
    runId: 'chat_test',
    delta
  };
}

describe('applyChatRunEventBatch', () => {
  it('reduces a hundred message deltas into a single concatenated assistant message', () => {
    const initial = applyChatRunEventBatch(createEmptyChatRunState(), [createRunStartedEvent()]);
    const tokens = Array.from({ length: 100 }, (_, index) => `token-${index} `);
    const events = tokens.map((token) => createDeltaEvent(token));

    const next = applyChatRunEventBatch(initial, events);

    expect(next.assistantMessage).toBe(tokens.join(''));
    expect(next.runId).toBe('chat_test');
    expect(next.status).toBe('running');
  });

  it('returns the same state reference when the batch is empty', () => {
    const state = createEmptyChatRunState();
    expect(applyChatRunEventBatch(state, [])).toBe(state);
  });
});

describe('isTerminalChatRunEvent', () => {
  it('treats run_started, run_completed, and run_failed as terminal flush triggers', () => {
    expect(isTerminalChatRunEvent({ ...createRunStartedEvent() })).toBe(true);
    expect(
      isTerminalChatRunEvent({
        type: 'run_completed',
        runId: 'chat_test',
        threadId: 'thread_test',
        providerId: 'nvidia',
        modelId: 'moonshotai/kimi-k2.6',
        createdAt: '2026-05-09T08:00:01.000Z',
        durationMs: 1000,
        summary: 'ok',
        assistantMessage: 'done'
      })
    ).toBe(true);
    expect(
      isTerminalChatRunEvent({
        type: 'run_failed',
        runId: 'chat_test',
        threadId: 'thread_test',
        code: 'provider_execution_failed',
        message: 'fail',
        retryable: true
      })
    ).toBe(true);
  });

  it('treats incremental deltas as non-terminal', () => {
    expect(isTerminalChatRunEvent(createDeltaEvent('hello'))).toBe(false);
    expect(
      isTerminalChatRunEvent({
        type: 'reasoning_delta',
        runId: 'chat_test',
        delta: 'thinking'
      })
    ).toBe(false);
    expect(
      isTerminalChatRunEvent({
        type: 'tool_event',
        runId: 'chat_test',
        event: 'start',
        name: 'web_read',
        data: null
      })
    ).toBe(false);
  });
});
