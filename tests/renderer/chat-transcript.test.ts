import { describe, expect, it } from 'vitest';
import type { BackgroundTask, TaskSnapshot, TaskThread } from '../../src/shared/types';
import { buildChatTranscript } from '../../src/renderer/chat-transcript';
import type { ChatRunState } from '../../src/renderer/chat-run-state';

function createThread(id: string, title: string, updatedAt: string): TaskThread {
  return {
    id,
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

function createBackgroundTasks(): BackgroundTask[] {
  return [];
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
    reasoning: '',
    durationMs: null,
    summary: null,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    toolEvents: [],
    todos: [],
    subagents: []
  };
}

describe('chat transcript helpers', () => {
  it('shows an empty new conversation when no thread is selected and no run is active', () => {
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
      backgroundTasks: createBackgroundTasks(),
      chatRunState: createIdleRunState(),
      pendingUserInput: null,
      selectedThreadId: null,
      taskSnapshot: snapshot
    });

    expect(messages).toEqual([]);
  });

  it('renders only the active user conversation thread and appends live assistant reasoning', () => {
    const snapshot = createSnapshot({
      threads: [
        createThread('thread-current', '当前任务', '2026-05-09T08:20:00.000Z'),
        createThread('thread-older', '历史任务', '2026-05-09T08:10:00.000Z')
      ],
      recentEvents: [
        {
          id: 'assistant-older',
          threadId: 'thread-older',
          runId: 'run-older',
          type: 'message',
          payload: { role: 'assistant', content: '旧线程回复' },
          createdAt: '2026-05-09T08:10:03.000Z'
        },
        {
          id: 'user-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: { role: 'user', content: '请整理一下当前变更' },
          createdAt: '2026-05-09T08:20:00.000Z'
        }
      ]
    });

    const messages = buildChatTranscript({
      backgroundTasks: createBackgroundTasks(),
      chatRunState: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running',
        assistantMessage: '我先检查当前变更。',
        reasoning: '先读取当前工作区和最近提交。'
      },
      pendingUserInput: null,
      selectedThreadId: null,
      taskSnapshot: snapshot
    });

    expect(messages).toEqual([
      {
        key: 'user-current',
        role: 'user',
        content: '请整理一下当前变更',
        reasoning: null,
        isStreaming: false
      },
      {
        key: 'live-run-current',
        role: 'assistant',
        content: '我先检查当前变更。',
        reasoning: '先读取当前工作区和最近提交。',
        isStreaming: true
      }
    ]);
  });

  it('merges completed reasoning into the persisted assistant reply without duplicating the bubble', () => {
    const snapshot = createSnapshot({
      threads: [createThread('thread-current', '当前任务', '2026-05-09T08:20:00.000Z')],
      recentEvents: [
        {
          id: 'assistant-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: { role: 'assistant', content: '已经整理完成。' },
          createdAt: '2026-05-09T08:20:04.000Z'
        },
        {
          id: 'user-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: { role: 'user', content: '整理一下结果' },
          createdAt: '2026-05-09T08:20:00.000Z'
        }
      ]
    });

    const messages = buildChatTranscript({
      backgroundTasks: createBackgroundTasks(),
      chatRunState: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'completed',
        assistantMessage: '已经整理完成。',
        reasoning: '先归纳，再输出最终结论。'
      },
      pendingUserInput: null,
      selectedThreadId: 'thread-current',
      taskSnapshot: snapshot
    });

    expect(messages).toEqual([
      {
        key: 'user-current',
        role: 'user',
        content: '整理一下结果',
        reasoning: null,
        isStreaming: false
      },
      {
        key: 'assistant-current',
        role: 'assistant',
        content: '已经整理完成。',
        reasoning: '先归纳，再输出最终结论。',
        isStreaming: false
      }
    ]);
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
      backgroundTasks: createBackgroundTasks(),
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
      backgroundTasks: createBackgroundTasks(),
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
        isStreaming: false
      },
      {
        key: 'assistant-older',
        role: 'assistant',
        content: '历史线程回复',
        reasoning: null,
        isStreaming: false
      }
    ]);
  });

  it('does not append live assistant output from a different thread than the selected history thread', () => {
    const snapshot = createSnapshot({
      threads: [
        createThread('thread-current', '当前任务', '2026-05-09T08:30:00.000Z'),
        createThread('thread-older', '历史任务', '2026-05-09T08:20:00.000Z')
      ],
      recentEvents: [
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
      backgroundTasks: createBackgroundTasks(),
      chatRunState: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running',
        assistantMessage: '这是别的线程的实时输出',
        reasoning: '别的线程推理'
      },
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
        isStreaming: false
      },
      {
        key: 'assistant-older',
        role: 'assistant',
        content: '历史线程回复',
        reasoning: null,
        isStreaming: false
      }
    ]);
  });

  it('prefers thread persisted messages over the truncated recentEvents window', () => {
    const snapshot = createSnapshot({
      threads: [createThread('thread-current', '当前任务', '2026-05-09T08:30:00.000Z')],
      recentEvents: [
        {
          id: 'user-current-2',
          threadId: 'thread-current',
          runId: 'run-current-2',
          type: 'message',
          payload: { role: 'user', content: '第二轮输入' },
          createdAt: '2026-05-09T08:30:10.000Z'
        }
      ]
    });

    const messages = buildChatTranscript({
      backgroundTasks: createBackgroundTasks(),
      chatRunState: createIdleRunState(),
      pendingUserInput: null,
      selectedThreadId: 'thread-current',
      taskSnapshot: snapshot,
      persistedMessages: [
        {
          id: 'user-current-1',
          threadId: 'thread-current',
          runId: 'run-current-1',
          type: 'message',
          payload: { role: 'user', content: '第一轮输入' },
          createdAt: '2026-05-09T08:20:00.000Z'
        },
        {
          id: 'assistant-current-1',
          threadId: 'thread-current',
          runId: 'run-current-1',
          type: 'message',
          payload: { role: 'assistant', content: '第一轮回复' },
          createdAt: '2026-05-09T08:20:03.000Z'
        },
        {
          id: 'user-current-2',
          threadId: 'thread-current',
          runId: 'run-current-2',
          type: 'message',
          payload: { role: 'user', content: '第二轮输入' },
          createdAt: '2026-05-09T08:30:10.000Z'
        }
      ]
    });

    expect(messages).toEqual([
      {
        key: 'user-current-1',
        role: 'user',
        content: '第一轮输入',
        reasoning: null,
        isStreaming: false
      },
      {
        key: 'assistant-current-1',
        role: 'assistant',
        content: '第一轮回复',
        reasoning: null,
        isStreaming: false
      },
      {
        key: 'user-current-2',
        role: 'user',
        content: '第二轮输入',
        reasoning: null,
        isStreaming: false
      }
    ]);
  });
});
