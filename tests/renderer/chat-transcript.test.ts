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
  it('keeps persisted message object references stable while appending live output', () => {
    const persistedMessage = {
      key: 'user-current',
      role: 'user' as const,
      content: '请总结当前变更',
      reasoning: null,
      blocks: [],
      approval: null,
      isStreaming: false
    };

    const messages = appendLiveTranscriptMessages({
      chatRunState: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running',
        assistantMessage: '正在总结'
      },
      pendingUserInput: null,
      persistedMessages: [persistedMessage],
      selectedThreadId: 'thread-current'
    });

    expect(messages[0]).toBe(persistedMessage);
    expect(messages.at(-1)).toMatchObject({
      key: 'live-run-current',
      role: 'assistant',
      content: '正在总结',
      isStreaming: true
    });
  });


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
        activityBlocks: [
          {
            id: 'reasoning-run-current',
            kind: 'reasoning',
            content: '先读取当前工作区和最近提交。'
          }
        ]
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
            id: 'reasoning-run-current',
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

  it('rebuilds structured subagent blocks from persisted subagent_event records', () => {
    const snapshot = createSnapshot({
      threads: [createThread('thread-subagent', '子代理任务', '2026-05-09T08:20:00.000Z')],
      recentEvents: [
        {
          id: 'user-subagent',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'message',
          payload: { role: 'user', content: '研究文档' },
          createdAt: '2026-05-09T08:20:00.000Z'
        },
        {
          id: 'subagent-start',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'subagent_event',
          payload: {
            sequence: 1,
            identity: {
              subagentId: 'subagent-run-subagent-0',
              parentSubagentId: null,
              name: 'research',
              depth: 0,
              path: ['research#0'],
              execution: 'sync',
              taskInput: 'Search docs'
            },
            event: { kind: 'started' }
          },
          createdAt: '2026-05-09T08:20:01.000Z'
        },
        {
          id: 'subagent-text',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'subagent_event',
          payload: {
            sequence: 2,
            identity: {
              subagentId: 'subagent-run-subagent-0',
              parentSubagentId: null,
              name: 'research',
              depth: 0,
              path: ['research#0'],
              execution: 'sync',
              taskInput: 'Search docs'
            },
            event: {
              kind: 'assistant_block',
              block: {
                kind: 'text',
                blockId: 'subagent-run-subagent-0-text',
                phase: 'delta',
                text: '找到资料。'
              }
            }
          },
          createdAt: '2026-05-09T08:20:02.000Z'
        }
      ]
    });

    const messages = buildChatTranscript({
      promotedThreadIds: new Set(),
      chatRunState: createIdleRunState(),
      pendingUserInput: null,
      selectedThreadId: 'thread-subagent',
      taskSnapshot: snapshot
    });

    expect(messages[1]?.blocks[0]).toMatchObject({
      kind: 'subagent',
      identity: { subagentId: 'subagent-run-subagent-0', name: 'research' },
      status: 'running',
      blocks: [
        {
          id: 'subagent-run-subagent-0-text',
          kind: 'text',
          content: '找到资料。'
        }
      ]
    });
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
        activityBlocks: [
          {
            id: 'reasoning-run-current',
            kind: 'reasoning',
            content: '先归纳，再输出最终结论。'
          }
        ]
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
            id: 'reasoning-run-current',
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
          type: 'assistant_block',
          payload: {
            kind: 'reasoning',
            blockId: 'reasoning-run-current',
            phase: 'delta',
            text: '先确认目标文件。'
          },
          createdAt: '2026-05-09T08:20:01.000Z',
          sequence: 2
        },
        {
          id: 'tool-start',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'assistant_block',
          payload: {
            kind: 'tool_call',
            blockId: 'tool-run-current-read',
            callId: 'call-run-current-read',
            name: 'read_file',
            phase: 'start',
            input: { path: 'F:\\Code\\Roc\\README.md' }
          },
          createdAt: '2026-05-09T08:20:02.000Z',
          sequence: 3
        },
        {
          id: 'reasoning-2',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'assistant_block',
          payload: {
            kind: 'reasoning',
            blockId: 'reasoning-run-current',
            phase: 'delta',
            text: '再提炼结论。'
          },
          createdAt: '2026-05-09T08:20:03.000Z',
          sequence: 4
        },
        {
          id: 'tool-end',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'assistant_block',
          payload: {
            kind: 'tool_call',
            blockId: 'tool-run-current-read',
            callId: 'call-run-current-read',
            name: 'read_file',
            phase: 'end',
            output: { bytes: 128 }
          },
          createdAt: '2026-05-09T08:20:04.000Z',
          sequence: 5
        },
        {
          id: 'assistant-delta-1',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'assistant_block',
          payload: {
            kind: 'text',
            blockId: 'text-run-current',
            phase: 'delta',
            text: '总结'
          },
          createdAt: '2026-05-09T08:20:05.000Z',
          sequence: 6
        },
        {
          id: 'assistant-delta-2',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'assistant_block',
          payload: {
            kind: 'text',
            blockId: 'text-run-current',
            phase: 'delta',
            text: '完成。'
          },
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
            id: 'tool-run-current-read',
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

});
