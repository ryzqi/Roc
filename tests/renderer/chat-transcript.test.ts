import { describe, expect, it } from 'vitest';
import type { TaskEvent, TaskSnapshot, TaskThread } from '../../src/shared/types';
import { projectChatTranscript, readChatTranscriptMemoKey } from '../../src/renderer/chat-transcript';
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

function projectPersistedTranscript(events: TaskEvent[], threadId: string) {
  return projectChatTranscript({
    events,
    liveRun: null,
    pendingUserInput: null,
    threadId
  });
}


describe('chat transcript helpers', () => {
  it('keeps run-based keys stable when live messages become persisted', () => {
    const persisted = projectPersistedTranscript(
      [
        {
          id: 'message-user-event',
          threadId: 'thread-stable',
          runId: 'run-stable',
          type: 'message',
          payload: { role: 'user', content: 'hello' },
          createdAt: '2026-07-11T00:00:00.000Z',
          sequence: 1
        },
        {
          id: 'message-assistant-event',
          threadId: 'thread-stable',
          runId: 'run-stable',
          type: 'message',
          payload: { role: 'assistant', content: 'world', providerId: 'test-provider', modelId: 'test-model' },
          createdAt: '2026-07-11T00:00:01.000Z',
          sequence: 2
        }
      ],
      'thread-stable'
    );
    const live = projectChatTranscript({
      events: [],
      liveRun: {
        ...createIdleRunState(),
        runId: 'run-stable',
        threadId: 'thread-stable',
        status: 'running',
        assistantMessage: 'world'
      },
      pendingUserInput: 'hello',
      threadId: 'thread-stable'
    });

    expect(persisted).toEqual([
      expect.objectContaining({ key: 'user-run-stable', source: 'persisted' }),
      expect.objectContaining({ key: 'assistant-run-stable', source: 'persisted' })
    ]);
    expect(live).toEqual([
      expect.objectContaining({ key: 'user-run-stable', source: 'live' }),
      expect.objectContaining({ key: 'assistant-run-stable', source: 'live' })
    ]);
  });

  it('projects persisted user image attachment metadata into transcript messages', () => {
    const messages = projectPersistedTranscript(
      [
        {
          id: 'event-1',
          threadId: 'thread-1',
          runId: 'run-1',
          type: 'message',
          payload: {
            role: 'user',
            content: '描述图片',
            attachments: [
              {
                kind: 'image',
                name: 'chart.png',
                mediaType: 'image/png',
                sizeBytes: 123
              }
            ]
          },
          createdAt: '2026-06-24T00:00:00.000Z'
        }
      ],
      'thread-1'
    );

    expect(messages[0]).toMatchObject({
      role: 'user',
      content: '描述图片',
      attachments: [
        {
          kind: 'image',
          name: 'chart.png',
          mediaType: 'image/png',
          sizeBytes: 123
        }
      ]
    });
  });

  it('adds persisted human question requests to the assistant transcript', () => {
    const messages = projectPersistedTranscript(
      [
        {
          id: 'event-question',
          threadId: 'thread-1',
          runId: 'run-1',
          type: 'human_question_requested',
          payload: {
            interruptId: 'interrupt-question',
            question: 'Which branch should I use?',
            context: 'Current branch is main.',
            suggestedResponses: ['main']
          },
          createdAt: '2026-06-25T00:00:00.000Z'
        }
      ],
      'thread-1'
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.interrupts).toEqual([
      {
        kind: 'question',
        interruptId: 'interrupt-question',
        question: 'Which branch should I use?',
        context: 'Current branch is main.',
        suggestedResponses: ['main']
      }
    ]);
  });

  it('keeps persisted messages while appending live output', () => {
    const messages = projectChatTranscript({
      events: [
        {
          id: 'user-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: { role: 'user', content: '请总结当前变更' },
          createdAt: '2026-08-20T00:00:00.000Z'
        }
      ],
      liveRun: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running',
        assistantMessage: '正在总结'
      },
      pendingUserInput: null,
      threadId: 'thread-current'
    });

    expect(messages[0]).toMatchObject({
      key: 'user-run-current',
      source: 'persisted',
      content: '请总结当前变更'
    });
    expect(messages.at(-1)).toMatchObject({
      key: 'assistant-run-current',
      role: 'assistant',
      content: '正在总结',
      isStreaming: true
    });
  });

  it('keeps identical user content from different runs as separate messages', () => {
    const messages = projectChatTranscript({
      events: [
        {
          id: 'user-previous',
          threadId: 'thread-current',
          runId: 'run-previous',
          type: 'message',
          payload: { role: 'user', content: '重复问题' },
          createdAt: '2026-08-20T00:00:00.000Z'
        }
      ],
      liveRun: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running'
      },
      pendingUserInput: '重复问题',
      threadId: 'thread-current'
    });

    expect(messages.map((message) => message.key)).toEqual([
      'user-run-previous',
      'user-run-current'
    ]);
  });

  it('updates the persisted assistant row from live state for the same run', () => {
    const messages = projectChatTranscript({
      events: [
        {
          id: 'user-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: { role: 'user', content: '问题' },
          createdAt: '2026-08-20T00:00:00.000Z',
          sequence: 1
        },
        {
          id: 'assistant-current',
          threadId: 'thread-current',
          runId: 'run-current',
          type: 'message',
          payload: {
            role: 'assistant',
            content: '部分回复',
            providerId: 'test-provider',
            modelId: 'test-model'
          },
          createdAt: '2026-08-20T00:00:01.000Z',
          sequence: 2
        }
      ],
      liveRun: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running',
        assistantMessage: '完整的流式回复',
        activityBlocks: [
          {
            id: 'reasoning-run-current',
            kind: 'reasoning',
            content: '继续分析'
          }
        ]
      },
      pendingUserInput: null,
      threadId: 'thread-current'
    });

    expect(messages.map((message) => message.key)).toEqual([
      'user-run-current',
      'assistant-run-current'
    ]);
    expect(messages[1]).toMatchObject({
      source: 'persisted',
      content: '完整的流式回复',
      reasoning: '继续分析',
      blocks: [
        {
          id: 'reasoning-run-current',
          kind: 'reasoning',
          content: '继续分析',
          isStreaming: true
        }
      ],
      isStreaming: true
    });
  });

  it('does not project pending input from another thread into the selected history', () => {
    const messages = projectChatTranscript({
      events: [
        {
          id: 'assistant-history',
          threadId: 'thread-history',
          runId: 'run-history',
          type: 'message',
          payload: {
            role: 'assistant',
            content: '历史线程内容',
            providerId: 'test-provider',
            modelId: 'test-model'
          },
          createdAt: '2026-08-20T00:00:00.000Z'
        }
      ],
      liveRun: {
        ...createIdleRunState(),
        runId: 'run-current',
        threadId: 'thread-current',
        status: 'running',
        assistantMessage: '当前线程流式内容'
      },
      pendingUserInput: '当前线程问题',
      threadId: 'thread-history'
    });

    expect(messages.map((message) => message.key)).toEqual(['assistant-run-history']);
  });

  it('keys multiple user messages inside one run by occurrence', () => {
    const messages = projectPersistedTranscript([
      {
        id: 'user-duplicate-1',
        threadId: 'thread-current',
        runId: 'run-duplicate',
        type: 'message',
        payload: { role: 'user', content: '第一次' },
        createdAt: '2026-08-20T00:00:00.000Z',
        sequence: 1
      },
      {
        id: 'user-duplicate-2',
        threadId: 'thread-current',
        runId: 'run-duplicate',
        type: 'message',
        payload: { role: 'user', content: '第二次' },
        createdAt: '2026-08-20T00:00:01.000Z',
        sequence: 2
      }
    ], 'thread-current');

    expect(messages.map((message) => message.key)).toEqual(['user-run-duplicate', 'user-run-duplicate#2']);
    expect(messages.map((message) => message.content)).toEqual(['第一次', '第二次']);
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
          payload: { role: 'assistant', content: '旧线程回复', providerId: 'test-provider', modelId: 'test-model' },
          createdAt: '2026-05-09T08:10:03.000Z'
        }
      ]
    });

    const messages = projectChatTranscript({
      events: snapshot.recentEvents,
      liveRun: createIdleRunState(),
      pendingUserInput: null,
      threadId: null
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
          payload: { role: 'assistant', content: '旧线程回复', providerId: 'test-provider', modelId: 'test-model' },
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

    const messages = projectChatTranscript({
      events: snapshot.recentEvents,
      liveRun: {
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
      threadId: null
    });

    expect(messages).toEqual([
      {
        key: 'user-run-current',
        source: 'persisted',
        role: 'user',
        content: '请整理一下当前变更',
        attachments: [],
        reasoning: null,
        blocks: [],
        interrupts: [],
        isStreaming: false
      },
      {
        key: 'assistant-run-current',
        source: 'live',
        role: 'assistant',
        content: '我先检查当前变更。',
        attachments: [],
        reasoning: '先读取当前工作区和最近提交。',
        blocks: [
          {
            id: 'reasoning-run-current',
            kind: 'reasoning',
            content: '先读取当前工作区和最近提交。',
            isStreaming: true
          }
        ],
        interrupts: [],
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

    const messages = projectChatTranscript({
      events: snapshot.recentEvents,
      liveRun: createIdleRunState(),
      pendingUserInput: null,
      threadId: 'thread-subagent'
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

  it('filters the persisted task tool wrapper when a structured subagent block represents the same assistant work', () => {
    const messages = projectPersistedTranscript(
      [
        {
          id: 'user-subagent',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'message',
          payload: { role: 'user', content: '调查问题' },
          createdAt: '2026-05-09T08:20:00.000Z',
          sequence: 1
        },
        {
          id: 'tool-task-start',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'assistant_block',
          payload: {
            kind: 'tool_call',
            blockId: 'tool-run-subagent-task',
            callId: 'call-run-subagent-task',
            name: 'task',
            phase: 'start',
            input: { description: '调查问题' }
          },
          createdAt: '2026-05-09T08:20:01.000Z',
          sequence: 2
        },
        {
          id: 'subagent-start',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'subagent_event',
          payload: {
            sequence: 3,
            identity: {
              subagentId: 'subagent-run-subagent-0',
              parentSubagentId: null,
              name: 'general-purpose',
              depth: 0,
              path: ['general-purpose#0'],
              execution: 'sync',
              taskInput: '调查问题'
            },
            event: { kind: 'started' }
          },
          createdAt: '2026-05-09T08:20:02.000Z',
          sequence: 3
        },
        {
          id: 'subagent-text',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'subagent_event',
          payload: {
            sequence: 4,
            identity: {
              subagentId: 'subagent-run-subagent-0',
              parentSubagentId: null,
              name: 'general-purpose',
              depth: 0,
              path: ['general-purpose#0'],
              execution: 'sync',
              taskInput: '调查问题'
            },
            event: {
              kind: 'assistant_block',
              block: {
                kind: 'text',
                blockId: 'subagent-run-subagent-0-text',
                phase: 'delta',
                text: '实时调查中'
              }
            }
          },
          createdAt: '2026-05-09T08:20:03.000Z',
          sequence: 4
        }
      ],
      'thread-subagent'
    );

    expect(messages[1]?.blocks).toEqual([
      {
        id: 'subagent-run-subagent-0',
        kind: 'subagent',
        identity: {
          subagentId: 'subagent-run-subagent-0',
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
            id: 'subagent-run-subagent-0-text',
            kind: 'text',
            content: '实时调查中'
          }
        ],
        children: []
      }
    ]);
  });

  it('keeps persisted non-task tool calls when structured subagent blocks are present', () => {
    const messages = projectPersistedTranscript(
      [
        {
          id: 'tool-shell',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'assistant_block',
          payload: {
            kind: 'tool_call',
            blockId: 'tool-run-subagent-read',
            callId: 'call-run-subagent-read',
            name: 'read_file',
            phase: 'end',
            input: { path: 'README.md' },
            output: { bytes: 128 }
          },
          createdAt: '2026-05-09T08:20:01.000Z',
          sequence: 1
        },
        {
          id: 'subagent-start',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'subagent_event',
          payload: {
            sequence: 2,
            identity: {
              subagentId: 'subagent-run-subagent-0',
              parentSubagentId: null,
              name: 'general-purpose',
              depth: 0,
              path: ['general-purpose#0'],
              execution: 'sync',
              taskInput: '调查问题'
            },
            event: { kind: 'started' }
          },
          createdAt: '2026-05-09T08:20:02.000Z',
          sequence: 2
        }
      ],
      'thread-subagent'
    );

    expect(messages[0]?.blocks.map((block) => block.kind === 'tool_call' ? block.name : block.kind)).toEqual([
      'read_file',
      'subagent'
    ]);
  });

  it('filters persisted nested subagent task wrappers while keeping the child subagent', () => {
    const rootIdentity = {
      subagentId: 'subagent-run-subagent-0',
      parentSubagentId: null,
      name: 'general-purpose',
      depth: 0,
      path: ['general-purpose#0'],
      execution: 'sync' as const,
      taskInput: '调查问题'
    };
    const childIdentity = {
      subagentId: 'subagent-run-subagent-0-0',
      parentSubagentId: 'subagent-run-subagent-0',
      name: 'research',
      depth: 1,
      path: ['general-purpose#0', 'research#0'],
      execution: 'sync' as const,
      taskInput: '继续调查'
    };

    const messages = projectPersistedTranscript(
      [
        {
          id: 'subagent-start',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'subagent_event',
          payload: {
            sequence: 1,
            identity: rootIdentity,
            event: { kind: 'started' }
          },
          createdAt: '2026-05-09T08:20:00.000Z',
          sequence: 1
        },
        {
          id: 'subagent-task-tool',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'subagent_event',
          payload: {
            sequence: 2,
            identity: rootIdentity,
            event: {
              kind: 'tool_call',
              block: {
                kind: 'tool_call',
                blockId: 'subagent-run-subagent-0-tool-task',
                callId: 'call-task',
                name: 'task',
                phase: 'start',
                input: { description: '继续调查' }
              }
            }
          },
          createdAt: '2026-05-09T08:20:01.000Z',
          sequence: 2
        },
        {
          id: 'nested-subagent-start',
          threadId: 'thread-subagent',
          runId: 'run-subagent',
          type: 'subagent_event',
          payload: {
            sequence: 3,
            identity: childIdentity,
            event: { kind: 'started' }
          },
          createdAt: '2026-05-09T08:20:02.000Z',
          sequence: 3
        }
      ],
      'thread-subagent'
    );

    expect(messages[0]?.blocks[0]).toMatchObject({
      id: 'subagent-run-subagent-0',
      kind: 'subagent',
      blocks: [],
      children: [
        {
          id: 'subagent-run-subagent-0-0',
          kind: 'subagent',
          identity: { name: 'research' }
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
          payload: { role: 'assistant', content: '已经整理完成。', providerId: 'test-provider', modelId: 'test-model' },
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

    const messages = projectChatTranscript({
      events: snapshot.recentEvents,
      liveRun: {
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
      threadId: 'thread-current'
    });

    expect(messages).toEqual([
      {
        key: 'user-run-current',
        source: 'persisted',
        role: 'user',
        content: '整理一下结果',
        attachments: [],
        reasoning: null,
        blocks: [],
        interrupts: [],
        isStreaming: false
      },
      {
        key: 'assistant-run-current',
        source: 'persisted',
        role: 'assistant',
        content: '已经整理完成。',
        attachments: [],
        reasoning: '先归纳，再输出最终结论。',
        blocks: [
          {
            id: 'reasoning-run-current',
            kind: 'reasoning',
            content: '先归纳，再输出最终结论。',
            isStreaming: false
          }
        ],
        interrupts: [],
        isStreaming: false
      }
    ]);
  });


  it('rebuilds persisted assistant activity blocks from delta and tool events in event order', () => {
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
        key: 'user-run-current',
        source: 'persisted',
        role: 'user',
        content: '请读取文件并总结',
        attachments: [],
        reasoning: null,
        blocks: [],
        interrupts: [],
        isStreaming: false
      },
      {
        key: 'assistant-run-current',
        source: 'persisted',
        role: 'assistant',
        content: '总结完成。',
        attachments: [],
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
        interrupts: [],
        isStreaming: false
      }
    ]);
  });

  it('rebuilds persisted hook activity blocks without merging hook messages into the assistant answer', () => {
    const messages = projectPersistedTranscript(
      [
        {
          id: 'hook-start',
          threadId: 'thread-hook',
          runId: 'run-hook',
          type: 'hook_started',
          payload: {
            runId: 'hook-run-1',
            handlerId: 'PreToolUse:0:0',
            event: 'PreToolUse',
            status: 'running',
            durationMs: null,
            message: 'Checking shell command',
            additionalContext: null,
            requestContinue: null,
            commandDisplay: 'node hook.js'
          },
          createdAt: '2026-06-24T00:00:01.000Z',
          sequence: 1
        },
        {
          id: 'assistant-delta',
          threadId: 'thread-hook',
          runId: 'run-hook',
          type: 'assistant_block',
          payload: {
            kind: 'text',
            blockId: 'text-run-hook',
            phase: 'delta',
            text: 'Visible answer'
          },
          createdAt: '2026-06-24T00:00:02.000Z',
          sequence: 2
        },
        {
          id: 'hook-completed',
          threadId: 'thread-hook',
          runId: 'run-hook',
          type: 'hook_completed',
          payload: {
            runId: 'hook-run-1',
            handlerId: 'PreToolUse:0:0',
            event: 'PreToolUse',
            status: 'completed',
            durationMs: 12,
            message: 'Hook completed',
            additionalContext: null,
            requestContinue: null,
            commandDisplay: 'node hook.js'
          },
          createdAt: '2026-06-24T00:00:03.000Z',
          sequence: 3
        }
      ],
      'thread-hook'
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Visible answer',
      blocks: [
        {
          id: 'hook-run-1',
          kind: 'hook_call',
          event: 'PreToolUse',
          handlerId: 'PreToolUse:0:0',
          status: 'completed',
          durationMs: 12,
          message: 'Hook completed',
          additionalContext: null,
          requestContinue: null,
          commandDisplay: 'node hook.js'
        }
      ]
    });
    expect(messages[0]?.content).not.toContain('Hook completed');
  });

  it('moves echoed SessionStart add_context text into the hook block instead of assistant content', () => {
    const sessionStartContext =
      '<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\nBelow is the full content of your skill.\n</EXTREMELY_IMPORTANT>';
    const messages = projectPersistedTranscript(
      [
        {
          id: 'hook-start',
          threadId: 'thread-session-start',
          runId: 'run-session-start',
          type: 'hook_started',
          payload: {
            runId: 'hook-run-session-start',
            handlerId: 'SessionStart:0:0',
            event: 'SessionStart',
            status: 'running',
            durationMs: null,
            message: 'Loading superpowers',
            commandDisplay: 'node session-start.js',
            additionalContext: null,
            requestContinue: null
          },
          createdAt: '2026-06-24T00:00:01.000Z',
          sequence: 1
        },
        {
          id: 'assistant-delta',
          threadId: 'thread-session-start',
          runId: 'run-session-start',
          type: 'assistant_block',
          payload: {
            kind: 'text',
            blockId: 'text-run-session-start',
            phase: 'delta',
            text: `${sessionStartContext}\n\n你好！有什么我可以帮你的吗？`
          },
          createdAt: '2026-06-24T00:00:02.000Z',
          sequence: 2
        },
        {
          id: 'hook-completed',
          threadId: 'thread-session-start',
          runId: 'run-session-start',
          type: 'hook_completed',
          payload: {
            runId: 'hook-run-session-start',
            handlerId: 'SessionStart:0:0',
            event: 'SessionStart',
            status: 'completed',
            durationMs: 8,
            message: 'Superpowers loaded',
            commandDisplay: 'node session-start.js',
            additionalContext: sessionStartContext,
            requestContinue: null
          },
          createdAt: '2026-06-24T00:00:03.000Z',
          sequence: 3
        }
      ],
      'thread-session-start'
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: '你好！有什么我可以帮你的吗？',
      blocks: [
        {
          id: 'hook-run-session-start',
          kind: 'hook_call',
          event: 'SessionStart',
          handlerId: 'SessionStart:0:0',
          status: 'completed',
          durationMs: 8,
          message: 'Superpowers loaded',
          commandDisplay: 'node session-start.js',
          additionalContext: sessionStartContext,
          requestContinue: null
        }
      ]
    });
    expect(messages[0]?.content).not.toContain('<EXTREMELY_IMPORTANT>');
  });

  it('keeps hook-only assistant rows when echoed hook context is stripped', () => {
    const sessionStartContext = '<EXTREMELY_IMPORTANT>Use superpowers.</EXTREMELY_IMPORTANT>';
    const messages = projectPersistedTranscript(
      [
        {
          id: 'assistant-delta',
          threadId: 'thread-hook-only',
          runId: 'run-hook-only',
          type: 'assistant_block',
          payload: {
            kind: 'text',
            blockId: 'text-hook-only',
            phase: 'delta',
            text: sessionStartContext
          },
          createdAt: '2026-06-24T00:00:01.000Z',
          sequence: 1
        },
        {
          id: 'hook-completed',
          threadId: 'thread-hook-only',
          runId: 'run-hook-only',
          type: 'hook_completed',
          payload: {
            runId: 'hook-run-only',
            handlerId: 'SessionStart:0:0',
            event: 'SessionStart',
            status: 'completed',
            durationMs: 8,
            message: 'Superpowers loaded',
            commandDisplay: 'node session-start.js',
            additionalContext: sessionStartContext,
            requestContinue: null
          },
          createdAt: '2026-06-24T00:00:02.000Z',
          sequence: 2
        }
      ],
      'thread-hook-only'
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: '',
      blocks: [
        {
          id: 'hook-run-only',
          kind: 'hook_call',
          event: 'SessionStart',
          additionalContext: sessionStartContext
        }
      ]
    });
  });

  it('memo 键只含投影真正读取的字段，不含 mode/summary 等无关字段', () => {
    const events: TaskEvent[] = [];
    const liveRun = createIdleRunState();
    const baseline = readChatTranscriptMemoKey({
      events,
      liveRun,
      pendingUserInput: null,
      threadId: 'thread-current'
    });

    // 投影不读这些字段，改它们不该让 memo 失效。
    const unrelated = readChatTranscriptMemoKey({
      events,
      liveRun: {
        ...liveRun,
        mode: 'plan',
        summary: '换了摘要',
        durationMs: 42,
        retryable: true,
        resumeBusy: true,
        todos: [{ content: '写测试', status: 'pending' }]
      },
      pendingUserInput: null,
      threadId: 'thread-current'
    });

    expect(unrelated).toEqual(baseline);
  });

  it('投影读取的字段一变，memo 键就变', () => {
    const events: TaskEvent[] = [];
    const liveRun = createIdleRunState();
    const readKey = (state: ChatRunState): readonly unknown[] =>
      readChatTranscriptMemoKey({ events, liveRun: state, pendingUserInput: null, threadId: 'thread-current' });
    const baseline = readKey(liveRun);

    expect(readKey({ ...liveRun, assistantMessage: '新增输出' })).not.toEqual(baseline);
    expect(readKey({ ...liveRun, status: 'running' })).not.toEqual(baseline);
    expect(readKey({ ...liveRun, runId: 'run-1' })).not.toEqual(baseline);
    expect(readKey({ ...liveRun, threadId: 'thread-other' })).not.toEqual(baseline);
    expect(readKey({ ...liveRun, activityBlocks: [{ id: 'r-1', kind: 'reasoning', content: '推理' }] })).not.toEqual(baseline);
  });

  it('没有实时运行时 memo 键长度不变，否则 React 依赖数组长度会跨渲染变化', () => {
    const events: TaskEvent[] = [];
    const withLiveRun = readChatTranscriptMemoKey({
      events,
      liveRun: createIdleRunState(),
      pendingUserInput: null,
      threadId: 'thread-current'
    });
    const withoutLiveRun = readChatTranscriptMemoKey({
      events,
      liveRun: null,
      pendingUserInput: null,
      threadId: 'thread-current'
    });

    expect(withoutLiveRun).toHaveLength(withLiveRun.length);
  });
});
