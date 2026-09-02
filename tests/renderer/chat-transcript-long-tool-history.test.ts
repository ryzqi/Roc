import { describe, expect, it } from 'vitest';
import type { ChatRunState } from '../../src/renderer/chat-run-state';
import { projectChatTranscript } from '../../src/renderer/chat-transcript';
import type { TaskSnapshot } from '../../src/shared/types';

function createIdleRunState(): ChatRunState {
  return {
    runId: null,
    mode: null,
    threadId: null,
    providerId: null,
    modelId: null,
    createdAt: null,
    status: 'idle',
    assistantMessage: '',
    activityBlocks: [],
    durationMs: null,
    summary: null,
    errorCode: null,
    errorMessage: null,
    recoveryAttempt: null,
    retryable: false,
    pendingInterrupts: [],
    resumeBusy: false,
    todos: [],
    subagents: []
  };
}

function stripAttachments(messages: ReturnType<typeof projectChatTranscript>) {
  return messages.map((message) => {
    const { attachments, source, ...withoutAttachments } = message;
    void attachments;
    void source;
    return withoutAttachments;
  });
}


describe('chat transcript helpers', () => {
  it('rebuilds complete persisted history after a long streamed tool run', () => {
    const streamedDeltas: TaskSnapshot['recentEvents'] = Array.from({ length: 110 }, (_, index) => ({
      id: `assistant-delta-${index}`,
      threadId: 'thread-current',
      runId: 'run-current',
      type: 'assistant_block',
      payload: {
        kind: 'text',
        blockId: 'text-run-current',
        phase: 'delta',
        text: `天气回答分片 ${index}。`
      },
      createdAt: `2026-05-09T08:20:03.${String(index).padStart(3, '0')}Z`,
      sequence: 4 + index
    }));

    const messages = projectChatTranscript({
      liveRun: createIdleRunState(),
      pendingUserInput: null,
      threadId: 'thread-current',
      events: [
        {
          id: 'user-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: {
            role: 'user',
            content: '搜索今日成都天气？'
          },
          createdAt: '2026-05-09T08:20:00.000Z',
          sequence: 1
        },
        {
          id: 'tool-start',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'assistant_block',
          payload: {
            kind: 'tool_call',
            blockId: 'tool-web-search',
            callId: 'web-search-1',
            name: 'web_search',
            phase: 'start',
            input: { query: '成都 今日 天气' }
          },
          createdAt: '2026-05-09T08:20:01.000Z',
          sequence: 2
        },
        {
          id: 'tool-end',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'assistant_block',
          payload: {
            kind: 'tool_call',
            blockId: 'tool-web-search',
            callId: 'web-search-1',
            name: 'web_search',
            phase: 'end',
            output: '成都今日多云，气温 22-28°C。'
          },
          createdAt: '2026-05-09T08:20:02.000Z',
          sequence: 3
        },
        ...streamedDeltas,
        {
          id: 'assistant-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: {
            role: 'assistant',
            content: '成都今日多云，气温 22-28°C。',
            providerId: 'test-provider',
            modelId: 'test-model'
          },
          createdAt: '2026-05-09T08:20:04.000Z',
          sequence: 200
        }
      ]
    });

    expect(stripAttachments(messages)).toEqual([
      {
        key: 'user-run-current',
        role: 'user',
        content: '搜索今日成都天气？',
        reasoning: null,
        blocks: [],
        interrupts: [],
        isStreaming: false
      },
      {
        key: 'assistant-run-current',
        role: 'assistant',
        content: '成都今日多云，气温 22-28°C。',
        reasoning: null,
        blocks: [
          {
            id: 'tool-web-search',
            kind: 'tool_call',
            name: 'web_search',
            status: 'end',
            input: { query: '成都 今日 天气' },
            output: '成都今日多云，气温 22-28°C。',
            error: null
          }
        ],
        interrupts: [],
        isStreaming: false
      }
    ]);
  });

});
