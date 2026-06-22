import { describe, expect, it } from 'vitest';
import type { ChatRunState } from '../../src/renderer/chat-run-state';
import { buildChatTranscript } from '../../src/renderer/chat-transcript';
import type { TaskSnapshot, TaskThread } from '../../src/shared/types';

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
      promotedThreadIds: new Set(),
      chatRunState: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running',
        assistantMessage: '这是别的线程的实时输出',
        activityBlocks: [
          {
            id: 'reasoning-run-current',
            kind: 'reasoning',
            content: '别的线程推理'
          }
        ]
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
      promotedThreadIds: new Set(),
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
        blocks: [],
        approval: null,
        isStreaming: false
      },
      {
        key: 'assistant-current-1',
        role: 'assistant',
        content: '第一轮回复',
        reasoning: null,
        blocks: [],
        approval: null,
        isStreaming: false
      },
      {
        key: 'user-current-2',
        role: 'user',
        content: '第二轮输入',
        reasoning: null,
        blocks: [],
        approval: null,
        isStreaming: false
      }
    ]);
  });


  it('includes a waiting approval assistant bubble when the live run is interrupted before final output', () => {
    const snapshot = createSnapshot({
      threads: [createThread('thread-current', '当前任务', '2026-05-12T08:30:00.000Z')],
      recentEvents: [
        {
          id: 'user-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: { role: 'user', content: '请执行 git status' },
          createdAt: '2026-05-12T08:30:00.000Z'
        }
      ]
    });

    const messages = buildChatTranscript({
      promotedThreadIds: new Set(),
      chatRunState: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'waiting_user',
        assistantMessage: '',
        activityBlocks: [
          {
            id: 'reasoning-run-current',
            kind: 'reasoning',
            content: '先分析命令风险。'
          }
        ],
        pendingApprovals: [
          {
            interruptId: 'interrupt-1',
            actionRequests: [
              {
                name: 'run_shell_command',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'run_shell_command',
                allowedDecisions: ['approve', 'reject']
              }
            ]
          }
        ],
        resumeBusy: false
      },
      pendingUserInput: null,
      selectedThreadId: 'thread-current',
      taskSnapshot: snapshot
    });

    expect(messages).toEqual([
      {
        key: 'user-current',
        role: 'user',
        content: '请执行 git status',
        reasoning: null,
        blocks: [],
        approval: null,
        isStreaming: false
      },
      {
        key: 'live-run-current',
        role: 'assistant',
        content: '',
        reasoning: '先分析命令风险。',
        blocks: [
          {
            id: 'reasoning-run-current',
            kind: 'reasoning',
            content: '先分析命令风险。',
            isStreaming: false
          }
        ],
        approval: expect.objectContaining({
          interruptId: 'interrupt-1'
        }),
        isStreaming: false
      }
    ]);
  });


  it('rebuilds a persisted approval assistant bubble from approval_requested history events', () => {
    const snapshot = createSnapshot({
      threads: [createThread('thread-current', '当前任务', '2026-05-12T08:30:00.000Z')],
      recentEvents: [
        {
          id: 'user-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: { role: 'user', content: '请执行 git status' },
          createdAt: '2026-05-12T08:30:00.000Z',
          sequence: 1
        },
        {
          id: 'reasoning-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'assistant_block',
          payload: {
            kind: 'reasoning',
            blockId: 'reasoning-run-current',
            phase: 'delta',
            text: '先分析命令风险。'
          },
          createdAt: '2026-05-12T08:30:01.000Z',
          sequence: 2
        },
        {
          id: 'approval-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'approval_requested',
          payload: {
            interruptId: 'interrupt-1',
            actionRequests: [
              {
                name: 'run_shell_command',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'run_shell_command',
                allowedDecisions: ['approve', 'reject']
              }
            ]
          },
          createdAt: '2026-05-12T08:30:02.000Z',
          sequence: 3
        }
      ]
    });

    const messages = buildChatTranscript({
      promotedThreadIds: new Set(),
      chatRunState: createIdleRunState(),
      pendingUserInput: null,
      selectedThreadId: 'thread-current',
      taskSnapshot: snapshot
    });

    expect(messages).toEqual([
      {
        key: 'user-current',
        role: 'user',
        content: '请执行 git status',
        reasoning: null,
        blocks: [],
        approval: null,
        isStreaming: false
      },
      {
        key: 'assistant-run-current',
        role: 'assistant',
        content: '',
        reasoning: '先分析命令风险。',
        blocks: [
          {
            id: 'reasoning-run-current',
            kind: 'reasoning',
            content: '先分析命令风险。',
            isStreaming: false
          }
        ],
        approval: expect.objectContaining({
          interruptId: 'interrupt-1'
        }),
        isStreaming: false
      }
    ]);
  });
});

