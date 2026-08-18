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

function stripAttachments(messages: ReturnType<typeof buildChatTranscript>) {
  return messages.map((message) => {
    const { attachments, source, ...withoutAttachments } = message;
    void attachments;
    void source;
    return withoutAttachments;
  });
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
            identity: {
              subagentId: 'subagent-run-current-0',
              parentSubagentId: null,
              name: 'research',
              depth: 0,
              path: ['research#0'],
              execution: 'sync',
              taskInput: '搜索资料'
            },
            status: 'completed',
            summary: '搜索资料',
            error: null,
            blocks: [],
            children: []
          }
        ]
      },
      pendingUserInput: null,
      selectedThreadId: 'thread-current',
      taskSnapshot: snapshot
    });

    expect(messages.at(-1)).toMatchObject({
      key: 'assistant-run-current',
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
          id: 'subagent-run-current-0',
          kind: 'subagent',
          identity: {
            subagentId: 'subagent-run-current-0',
            name: 'research'
          },
          status: 'completed',
          summary: '搜索资料',
          error: null,
          blocks: [],
          children: []
        }
      ],
      isStreaming: true
    });
  });

  it('filters the live task tool wrapper when a subagent block represents the same assistant work', () => {
    const snapshot = createSnapshot({
      threads: [createThread('thread-current', '当前任务', '2026-05-09T08:20:00.000Z')],
      recentEvents: [
        {
          id: 'user-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: { role: 'user', content: '分派子代理调查' },
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
        activityBlocks: [
          {
            id: 'tool-run-current-task',
            kind: 'tool_call',
            callId: 'call-run-current-task',
            name: 'task',
            status: 'start',
            input: { description: '分派子代理调查' },
            output: null,
            error: null
          }
        ],
        subagents: [
          {
            identity: {
              subagentId: 'subagent-run-current-0',
              parentSubagentId: null,
              name: 'general-purpose',
              depth: 0,
              path: ['general-purpose#0'],
              execution: 'sync',
              taskInput: '分派子代理调查'
            },
            status: 'running',
            summary: null,
            error: null,
            blocks: [
              {
                id: 'subagent-run-current-0-text',
                kind: 'text',
                content: '正在调查'
              }
            ],
            children: []
          }
        ]
      },
      pendingUserInput: null,
      selectedThreadId: 'thread-current',
      taskSnapshot: snapshot
    });

    expect(messages.at(-1)?.blocks).toEqual([
      {
        id: 'subagent-run-current-0',
        kind: 'subagent',
        identity: {
          subagentId: 'subagent-run-current-0',
          parentSubagentId: null,
          name: 'general-purpose',
          depth: 0,
          path: ['general-purpose#0'],
          execution: 'sync',
          taskInput: '分派子代理调查'
        },
        status: 'running',
        summary: null,
        error: null,
        blocks: [
          {
            id: 'subagent-run-current-0-text',
            kind: 'text',
            content: '正在调查'
          }
        ],
        children: []
      }
    ]);
  });

  it('keeps live non-task tool calls when a subagent block is present', () => {
    const snapshot = createSnapshot({
      threads: [createThread('thread-current', '当前任务', '2026-05-09T08:20:00.000Z')],
      recentEvents: []
    });

    const messages = buildChatTranscript({
      promotedThreadIds: new Set(),
      chatRunState: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running',
        activityBlocks: [
          {
            id: 'tool-run-current-read',
            kind: 'tool_call',
            callId: 'call-run-current-read',
            name: 'read_file',
            status: 'end',
            input: { path: 'README.md' },
            output: { bytes: 128 },
            error: null
          }
        ],
        subagents: [
          {
            identity: {
              subagentId: 'subagent-run-current-0',
              parentSubagentId: null,
              name: 'general-purpose',
              depth: 0,
              path: ['general-purpose#0'],
              execution: 'sync',
              taskInput: '调查问题'
            },
            status: 'started',
            summary: null,
            error: null,
            blocks: [],
            children: []
          }
        ]
      },
      pendingUserInput: null,
      selectedThreadId: 'thread-current',
      taskSnapshot: snapshot
    });

    expect(messages.at(-1)?.blocks.map((block) => block.kind === 'tool_call' ? block.name : block.kind)).toEqual([
      'read_file',
      'subagent'
    ]);
  });

  it('filters live nested subagent task wrappers while keeping the child subagent', () => {
    const snapshot = createSnapshot({
      threads: [createThread('thread-current', '当前任务', '2026-05-09T08:20:00.000Z')],
      recentEvents: []
    });

    const messages = buildChatTranscript({
      promotedThreadIds: new Set(),
      chatRunState: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running',
        subagents: [
          {
            identity: {
              subagentId: 'subagent-run-current-0',
              parentSubagentId: null,
              name: 'general-purpose',
              depth: 0,
              path: ['general-purpose#0'],
              execution: 'sync',
              taskInput: '调查问题'
            },
            status: 'running',
            summary: null,
            error: null,
            blocks: [
              {
                id: 'subagent-run-current-0-tool-task',
                kind: 'tool_call',
                callId: 'call-task',
                name: 'task',
                status: 'start',
                input: { description: '继续调查' },
                output: null,
                error: null
              }
            ],
            children: [
              {
                identity: {
                  subagentId: 'subagent-run-current-0-0',
                  parentSubagentId: 'subagent-run-current-0',
                  name: 'research',
                  depth: 1,
                  path: ['general-purpose#0', 'research#0'],
                  execution: 'sync',
                  taskInput: '继续调查'
                },
                status: 'started',
                summary: null,
                error: null,
                blocks: [],
                children: []
              }
            ]
          }
        ]
      },
      pendingUserInput: null,
      selectedThreadId: 'thread-current',
      taskSnapshot: snapshot
    });

    expect(messages.at(-1)?.blocks[0]).toMatchObject({
      id: 'subagent-run-current-0',
      kind: 'subagent',
      blocks: [],
      children: [
        {
          id: 'subagent-run-current-0-0',
          kind: 'subagent',
          identity: { name: 'research' }
        }
      ]
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
          payload: { role: 'assistant', content: '旧线程回复', providerId: 'test-provider', modelId: 'test-model' },
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

    expect(stripAttachments(messages)).toEqual([
      {
        key: 'user-run-current',
        role: 'user',
        content: '新的用户输入',
        reasoning: null,
        blocks: [],
        interrupts: [],
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
          payload: { role: 'assistant', content: '当前线程回复', providerId: 'test-provider', modelId: 'test-model' },
          createdAt: '2026-05-09T08:30:03.000Z'
        },
        {
          id: 'assistant-older',
          threadId: 'thread-older',
          runId: 'run-older',
          type: 'message',
          payload: { role: 'assistant', content: '历史线程回复', providerId: 'test-provider', modelId: 'test-model' },
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

    expect(stripAttachments(messages)).toEqual([
      {
        key: 'user-run-older',
        role: 'user',
        content: '请继续历史会话',
        reasoning: null,
        blocks: [],
        interrupts: [],
        isStreaming: false
      },
      {
        key: 'assistant-run-older',
        role: 'assistant',
        content: '历史线程回复',
        reasoning: null,
        blocks: [],
        interrupts: [],
        isStreaming: false
      }
    ]);
  });

});
