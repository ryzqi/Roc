import { describe, expect, it } from 'vitest';
import type { TaskSnapshot, TaskThread } from '../../src/shared/types';
import { buildChatTranscript } from '../../src/renderer/chat-transcript';
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
    reasoning: '',
    durationMs: null,
    summary: null,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    pendingApprovals: [],
    resumeBusy: false,
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
      promotedThreadIds: new Set(),
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
      promotedThreadIds: new Set(),
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
        blocks: [],
        approval: null,
        isStreaming: false
      },
      {
        key: 'live-run-current',
        role: 'assistant',
        content: '我先检查当前变更。',
        reasoning: '先读取当前工作区和最近提交。',
        blocks: [
          {
            id: 'live-run-current-reasoning',
            kind: 'reasoning',
            content: '先读取当前工作区和最近提交。',
            isStreaming: true
          }
        ],
        approval: null,
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
      promotedThreadIds: new Set(),
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
        blocks: [],
        approval: null,
        isStreaming: false
      },
      {
        key: 'assistant-current',
        role: 'assistant',
        content: '已经整理完成。',
        reasoning: '先归纳，再输出最终结论。',
        blocks: [
          {
            id: 'live-run-current-reasoning',
            kind: 'reasoning',
            content: '先归纳，再输出最终结论。',
            isStreaming: false
          }
        ],
        approval: null,
        isStreaming: false
      }
    ]);
  });

  it('rebuilds persisted assistant activity blocks from delta and tool events in event order', () => {
    const snapshot = createSnapshot({
      threads: [createThread('thread-current', '当前任务', '2026-05-09T08:20:00.000Z')],
      recentEvents: []
    });

    const messages = buildChatTranscript({
      promotedThreadIds: new Set(),
      chatRunState: createIdleRunState(),
      pendingUserInput: null,
      selectedThreadId: 'thread-current',
      taskSnapshot: snapshot,
      persistedMessages: [
        {
          id: 'user-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: { role: 'user', content: '请读取文件并总结' },
          createdAt: '2026-05-09T08:20:00.000Z',
          sequence: 1
        },
        {
          id: 'reasoning-1',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'reasoning_delta',
          payload: { delta: '先确认目标文件。' },
          createdAt: '2026-05-09T08:20:01.000Z',
          sequence: 2
        },
        {
          id: 'tool-start',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'tool_call',
          payload: {
            name: 'read_file',
            status: 'start',
            input: { path: 'F:\\Code\\Roc\\README.md' }
          },
          createdAt: '2026-05-09T08:20:02.000Z',
          sequence: 3
        },
        {
          id: 'reasoning-2',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'reasoning_delta',
          payload: { delta: '再提炼结论。' },
          createdAt: '2026-05-09T08:20:03.000Z',
          sequence: 4
        },
        {
          id: 'tool-end',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'tool_call',
          payload: {
            name: 'read_file',
            status: 'end',
            output: { bytes: 128 }
          },
          createdAt: '2026-05-09T08:20:04.000Z',
          sequence: 5
        },
        {
          id: 'assistant-delta-1',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message_delta',
          payload: { role: 'assistant', delta: '总结' },
          createdAt: '2026-05-09T08:20:05.000Z',
          sequence: 6
        },
        {
          id: 'assistant-delta-2',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message_delta',
          payload: { role: 'assistant', delta: '完成。' },
          createdAt: '2026-05-09T08:20:06.000Z',
          sequence: 7
        }
      ]
    });

    expect(messages).toEqual([
      {
        key: 'user-current',
        role: 'user',
        content: '请读取文件并总结',
        reasoning: null,
        blocks: [],
        approval: null,
        isStreaming: false
      },
      {
        key: 'assistant-run-current',
        role: 'assistant',
        content: '总结完成。',
        reasoning: '先确认目标文件。再提炼结论。',
        blocks: [
          {
            id: 'reasoning-run-current',
            kind: 'reasoning',
            content: '先确认目标文件。再提炼结论。',
            isStreaming: false
          },
          {
            id: 'tool-run-current-0',
            kind: 'tool_call',
            name: 'read_file',
            status: 'end',
            input: { path: 'F:\\Code\\Roc\\README.md' },
            output: { bytes: 128 },
            error: null
          }
        ],
        approval: null,
        isStreaming: false
      }
    ]);
  });

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
        reasoning: '先搜索资料。',
        toolEvents: [
          {
            name: 'web_search',
            event: 'start',
            data: { query: 'Roc chat activity' }
          },
          {
            name: 'web_search',
            event: 'end',
            data: { count: 3 }
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
          id: 'live-run-current-reasoning',
          kind: 'reasoning',
          content: '先搜索资料。',
          isStreaming: true
        },
        {
          id: 'live-run-current-tool-0',
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
        reasoning: '先分析命令风险。',
        pendingApprovals: [
          {
            interruptId: 'interrupt-1',
            actionRequests: [
              {
                name: 'execute',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'execute',
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
            id: 'live-run-current-reasoning',
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
          type: 'reasoning_delta',
          payload: { delta: '先分析命令风险。' },
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
                name: 'execute',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'execute',
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
