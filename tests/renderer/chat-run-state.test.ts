import { describe, expect, it } from 'vitest';
import { applyChatRunEvent, createEmptyChatRunState } from '../../src/renderer/chat-run-state';

describe('chat run state', () => {
  it('builds a streamed assistant transcript with reasoning and completion metadata', () => {
    let state = createEmptyChatRunState();

    state = applyChatRunEvent(state, {
      type: 'run_started',
      runId: 'chat_1',
      mode: 'task',
      threadId: 'thread_1',
      providerId: 'nvidia',
      modelId: 'moonshotai/kimi-k2.6',
      createdAt: '2026-05-09T00:00:00.000Z'
    });
    state = applyChatRunEvent(state, {
      type: 'message_delta',
      runId: 'chat_1',
      delta: 'Hello'
    });
    state = applyChatRunEvent(state, {
      type: 'reasoning_delta',
      runId: 'chat_1',
      delta: 'reasoning'
    });
    state = applyChatRunEvent(state, {
      type: 'message_delta',
      runId: 'chat_1',
      delta: ' world'
    });
    state = applyChatRunEvent(state, {
      type: 'run_completed',
      runId: 'chat_1',
      threadId: 'thread_1',
      providerId: 'nvidia',
      modelId: 'moonshotai/kimi-k2.6',
      createdAt: '2026-05-09T00:00:00.000Z',
      durationMs: 1280,
      summary: 'nvidia:moonshotai/kimi-k2.6:deepagents',
      assistantMessage: 'Hello world'
    });

    expect(state.status).toBe('completed');
    expect(state.runId).toBe('chat_1');
    expect(state.mode).toBe('task');
    expect(state.assistantMessage).toBe('Hello world');
    expect(state.reasoning).toBe('reasoning');
    expect(state.durationMs).toBe(1280);
    expect(state.summary).toBe('nvidia:moonshotai/kimi-k2.6:deepagents');
  });

  it('stores streamed failure state without dropping partial content', () => {
    let state = createEmptyChatRunState();

    state = applyChatRunEvent(state, {
      type: 'run_started',
      runId: 'chat_2',
      mode: 'chat',
      threadId: 'thread_2',
      providerId: 'nvidia',
      modelId: 'moonshotai/kimi-k2.6',
      createdAt: '2026-05-09T00:00:00.000Z'
    });
    state = applyChatRunEvent(state, {
      type: 'message_delta',
      runId: 'chat_2',
      delta: 'partial'
    });
    state = applyChatRunEvent(state, {
      type: 'run_failed',
      runId: 'chat_2',
      threadId: 'thread_2',
      code: 'provider_network_error',
      message: 'Provider 网络请求失败。',
      retryable: true
    });

    expect(state.status).toBe('failed');
    expect(state.assistantMessage).toBe('partial');
    expect(state.errorMessage).toBe('Provider 网络请求失败。');
    expect(state.errorCode).toBe('provider_network_error');
  });
});
