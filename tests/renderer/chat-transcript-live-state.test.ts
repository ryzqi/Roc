import { describe, expect, it } from 'vitest';
import type { TaskSnapshot, TaskThread } from '../../src/shared/types';
import { appendLiveTranscriptMessages, buildChatTranscript } from '../../src/renderer/chat-transcript';
import type { ChatRunState } from '../../src/renderer/chat-run-state';

function createThread(id: string, title: string, updatedAt: string): TaskThread {
  return {
    id,
    kind: 'chat',
    title,
    goal: title,
    status: 'completed',
    createdAt: '2026-05-09T08:00:00.000Z',
    updatedAt
  };
}

function createSnapshot(input: { threads: TaskThread[]; recentEvents: TaskSnapshot['recentEvents'] }): TaskSnapshot {
  return {
    generatedAt: '2026-05-09T08:30:00.000Z',
    counts: {
      total: input.threads.length,
      running: 0,
      failed: 0,
      pendingConfirmation: 0
    },
    threads: input.threads,
    recentEvents: input.recentEvents
  };
}

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
    retryable: false,
    pendingApprovals: [],
    resumeBusy: false,
    todos: [],
    subagents: []
  };
}


describe('chat transcript helpers', () => {
  it('projects live tool and subagent state into assistant activity blocks while keeping final content separate', () => {
    const snapshot = createSnapshot({
      threads: [createThread('thread-current', '当前任务', '2026-05-09T08:20:00.000Z')],
      recentEvents: [
        {
          id: 'user-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: { role: 'user', content: '搜索后总结' },
          createdAt: '2026-05-09T08:20:00.000Z'
        }
      ]
    });

    const messages = buildChatTranscript({
      promotedThreadIds: new Set(),
      chatRunState: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running',
        assistantMessage: '最终回答正文。',
        activityBlocks: [
          {
            id: 'reasoning-run-current',
            kind: 'reasoning',
            content: '先搜索资料。'
          },
          {
            id: 'tool-run-current-search',
            kind: 'tool_call',
            callId: 'call-run-current-search',
            name: 'web_search',
            status: 'end',
            input: { query: 'Roc chat activity' },
            output: { count: 3 },
            error: null
          }
        ],
        subagents: [
          {
            subagent: 'research',
            status: 'completed',
            summary: '搜索资料'
          }
        ]
      },
      pendingUserInput: null,
      selectedThreadId: 'thread-current',
      taskSnapshot: snapshot
    });

    expect(messages.at(-1)).toMatchObject({
      key: 'live-run-current',
      role: 'assistant',
      content: '最终回答正文。',
      reasoning: '先搜索资料。',
      blocks: [
        {
          id: 'reasoning-run-current',
          kind: 'reasoning',
          content: '先搜索资料。',
          isStreaming: true
        },
        {
          id: 'tool-run-current-search',
          kind: 'tool_call',
          name: 'web_search',
          status: 'end',
          input: { query: 'Roc chat activity' },
          output: { count: 3 },
          error: null
        },
        {
          id: 'live-run-current-subagent-0',
          kind: 'subagent',
          name: 'research',
          status: 'completed',
          summary: '搜索资料'
        }
      ],
      isStreaming: true
    });
  });


  it('keeps the just-submitted user message visible before task snapshot refreshes', () => {
    const snapshot = createSnapshot({
      threads: [createThread('thread-older', '历史任务', '2026-05-09T08:10:00.000Z')],
      recentEvents: [
        {
          id: 'assistant-older',
          threadId: 'thread-older',
          runId: 'run-older',
          type: 'message',
          payload: { role: 'assistant', content: '旧线程回复' },
          createdAt: '2026-05-09T08:10:03.000Z'
        }
      ]
    });

    const messages = buildChatTranscript({
      promotedThreadIds: new Set(),
      chatRunState: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running'
      },
      pendingUserInput: '新的用户输入',
      selectedThreadId: null,
      taskSnapshot: snapshot
    });

    expect(messages).toEqual([
      {
        key: 'pending-user-message',
        role: 'user',
        content: '新的用户输入',
        reasoning: null,
        blocks: [],
        approval: null,
        isStreaming: false
      }
    ]);
  });


  it('renders only the explicitly selected history thread', () => {
    const snapshot = createSnapshot({
      threads: [
        createThread('thread-current', '当前任务', '2026-05-09T08:30:00.000Z'),
        createThread('thread-older', '历史任务', '2026-05-09T08:20:00.000Z')
      ],
      recentEvents: [
        {
          id: 'assistant-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: { role: 'assistant', content: '当前线程回复' },
          createdAt: '2026-05-09T08:30:03.000Z'
        },
        {
          id: 'assistant-older',
          threadId: 'thread-older',
          runId: 'run-older',
          type: 'message',
          payload: { role: 'assistant', content: '历史线程回复' },
          createdAt: '2026-05-09T08:20:03.000Z'
        },
        {
          id: 'user-older',
          threadId: 'thread-older',
          runId: 'run-older',
          type: 'message',
          payload: { role: 'user', content: '请继续历史会话' },
          createdAt: '2026-05-09T08:20:00.000Z'
        }
      ]
    });

    const messages = buildChatTranscript({
      promotedThreadIds: new Set(),
      chatRunState: createIdleRunState(),
      pendingUserInput: null,
      selectedThreadId: 'thread-older',
      taskSnapshot: snapshot
    });

    expect(messages).toEqual([
      {
        key: 'user-older',
        role: 'user',
        content: '请继续历史会话',
        reasoning: null,
        blocks: [],
        approval: null,
        isStreaming: false
      },
      {
        key: 'assistant-older',
        role: 'assistant',
        content: '历史线程回复',
        reasoning: null,
        blocks: [],
        approval: null,
        isStreaming: false
      }
    ]);
  });

});

