import { describe, expect, it } from 'vitest';
import { applyChatRunEvent, createEmptyChatRunState } from '../../src/renderer/chat-run-state';
import type { ChatRunEvent } from '../../src/shared/types';

describe('chat run state', () => {
  it('builds a streamed assistant transcript with reasoning and completion metadata', () => {
    let state = createEmptyChatRunState();

    state = applyChatRunEvent(state, runStarted('chat_1'));
    state = applyChatRunEvent(state, textBlock('chat_1', 'Hello'));
    state = applyChatRunEvent(state, reasoningBlock('chat_1', 'reasoning'));
    state = applyChatRunEvent(state, textBlock('chat_1', ' world'));
    state = applyChatRunEvent(state, runCompleted('chat_1', 'Hello world'));

    expect(state.status).toBe('completed');
    expect(state.runId).toBe('chat_1');
    expect(state.mode).toBe('task');
    expect(state.assistantMessage).toBe('Hello world');
    expect(state.activityBlocks).toEqual([
      {
        id: 'reasoning-chat_1',
        kind: 'reasoning',
        content: 'reasoning'
      }
    ]);
    expect(state.durationMs).toBe(1280);
    expect(state.summary).toBe('nvidia:moonshotai/kimi-k2.6:deepagents');
  });

  it('stores streamed failure state without dropping partial content', () => {
    let state = createEmptyChatRunState();

    state = applyChatRunEvent(state, runStarted('chat_2', 'chat'));
    state = applyChatRunEvent(state, textBlock('chat_2', 'partial'));
    state = applyChatRunEvent(state, {
      type: 'run_failed',
      runId: 'chat_2',
      threadId: 'thread_chat_2',
      code: 'provider_network_error',
      message: 'Provider 网络请求失败。',
      retryable: true
    });

    expect(state.status).toBe('failed');
    expect(state.assistantMessage).toBe('partial');
    expect(state.errorMessage).toBe('Provider 网络请求失败。');
    expect(state.errorCode).toBe('provider_network_error');
  });

  it('enters waiting_user on interrupt and keeps reasoning updates through resume completion', () => {
    let state = createEmptyChatRunState();

    state = applyChatRunEvent(state, runStarted('chat_approval'));
    state = applyChatRunEvent(state, reasoningBlock('chat_approval', '先分析命令风险。\n'));
    state = applyChatRunEvent(state, {
      type: 'run_interrupted',
      runId: 'chat_approval',
      threadId: 'thread_chat_approval',
      interruptId: 'interrupt-1',
      payload: approvalPayload()
    });

    expect(state.status).toBe('waiting_user');
    expect(state.pendingApprovals).toEqual([
      expect.objectContaining({
        interruptId: 'interrupt-1'
      })
    ]);
    expect(state.activityBlocks).toEqual([
      {
        id: 'reasoning-chat_approval',
        kind: 'reasoning',
        content: '先分析命令风险。\n'
      }
    ]);

    state = applyChatRunEvent(state, {
      type: 'run_resumed',
      runId: 'chat_approval',
      threadId: 'thread_chat_approval',
      interruptId: 'interrupt-1'
    });
    state = applyChatRunEvent(state, reasoningBlock('chat_approval', '审批通过，继续执行。'));
    state = applyChatRunEvent(state, runCompleted('chat_approval', '命令已执行。'));

    expect(state.status).toBe('completed');
    expect(state.pendingApprovals).toEqual([]);
    expect(state.activityBlocks).toEqual([
      {
        id: 'reasoning-chat_approval',
        kind: 'reasoning',
        content: '先分析命令风险。\n审批通过，继续执行。'
      }
    ]);
  });

  it('keeps multiple action requests in approval order until the matching interrupt resumes', () => {
    let state = createEmptyChatRunState();

    state = applyChatRunEvent(state, runStarted('chat_multi_approval'));
    state = applyChatRunEvent(state, {
      type: 'run_interrupted',
      runId: 'chat_multi_approval',
      threadId: 'thread_chat_multi_approval',
      interruptId: 'interrupt-multi',
      payload: {
        actionRequests: [
          {
            name: 'run_shell_command',
            args: {
              command: 'git status'
            }
          },
          {
            name: 'web_search',
            args: {
              query: 'roc phase 6'
            }
          }
        ],
        reviewConfigs: [
          {
            actionName: 'run_shell_command',
            allowedDecisions: ['approve', 'edit', 'reject']
          },
          {
            actionName: 'web_search',
            allowedDecisions: ['approve', 'reject']
          }
        ]
      }
    });

    expect(state.status).toBe('waiting_user');
    expect(state.pendingApprovals[0]?.actionRequests).toEqual([
      {
        name: 'run_shell_command',
        args: {
          command: 'git status'
        }
      },
      {
        name: 'web_search',
        args: {
          query: 'roc phase 6'
        }
      }
    ]);

    state = applyChatRunEvent(state, {
      type: 'run_resumed',
      runId: 'chat_multi_approval',
      threadId: 'thread_chat_multi_approval',
      interruptId: 'interrupt-multi'
    });

    expect(state.pendingApprovals).toEqual([]);
    expect(state.status).toBe('running');
  });

  it('keeps interleaved tool and subagent events stable while assistant and reasoning blocks continue streaming', () => {
    let state = createEmptyChatRunState();

    state = applyChatRunEvent(state, runStarted('chat_stream_mix'));
    state = applyChatRunEvent(state, {
      type: 'subagent_event',
      runId: 'chat_stream_mix',
      sequence: 1,
      identity: {
        subagentId: 'subagent-chat_stream_mix-0',
        parentSubagentId: null,
        name: 'research',
        depth: 0,
        path: ['research#0'],
        execution: 'sync',
        taskInput: 'Search docs'
      },
      event: {
        kind: 'started'
      }
    });
    state = applyChatRunEvent(state, textBlock('chat_stream_mix', '正在整理'));
    state = applyChatRunEvent(state, toolBlock('chat_stream_mix', 'start', { query: 'roc phase 7' }));
    state = applyChatRunEvent(state, reasoningBlock('chat_stream_mix', '先检索。'));
    state = applyChatRunEvent(state, toolBlock('chat_stream_mix', 'error', '[REDACTED]'));
    state = applyChatRunEvent(state, {
      type: 'subagent_event',
      runId: 'chat_stream_mix',
      sequence: 2,
      identity: {
        subagentId: 'subagent-chat_stream_mix-0',
        parentSubagentId: null,
        name: 'research',
        depth: 0,
        path: ['research#0'],
        execution: 'sync',
        taskInput: 'Search docs'
      },
      event: {
        kind: 'completed',
        summary: 'Search docs'
      }
    });
    state = applyChatRunEvent(state, textBlock('chat_stream_mix', '完成。'));

    expect(state.status).toBe('running');
    expect(state.assistantMessage).toBe('正在整理完成。');
    expect(state.activityBlocks).toEqual([
      {
        id: 'tool-web-search',
        kind: 'tool_call',
        callId: 'call-web-search',
        name: 'web_search',
        status: 'error',
        input: { query: 'roc phase 7' },
        output: null,
        error: '[REDACTED]'
      },
      {
        id: 'reasoning-chat_stream_mix',
        kind: 'reasoning',
        content: '先检索。'
      }
    ]);
    expect(state.subagents).toEqual([
      {
        identity: {
          subagentId: 'subagent-chat_stream_mix-0',
          parentSubagentId: null,
          name: 'research',
          depth: 0,
          path: ['research#0'],
          execution: 'sync',
          taskInput: 'Search docs'
        },
        status: 'completed',
        summary: 'Search docs',
        error: null,
        blocks: [],
        children: []
      }
    ]);
  });
});

function runStarted(runId: string, mode: 'chat' | 'task' = 'task'): ChatRunEvent {
  return {
    type: 'run_started',
    runId,
    mode,
    threadId: `thread_${runId}`,
    providerId: 'nvidia',
    modelId: 'moonshotai/kimi-k2.6',
    createdAt: '2026-05-09T00:00:00.000Z'
  };
}

function runCompleted(runId: string, assistantMessage: string): ChatRunEvent {
  return {
    type: 'run_completed',
    runId,
    threadId: `thread_${runId}`,
    providerId: 'nvidia',
    modelId: 'moonshotai/kimi-k2.6',
    createdAt: '2026-05-09T00:00:00.000Z',
    durationMs: 1280,
    summary: 'nvidia:moonshotai/kimi-k2.6:deepagents',
    assistantMessage
  };
}

function textBlock(runId: string, text: string): ChatRunEvent {
  return {
    type: 'assistant_block',
    runId,
    block: {
      kind: 'text',
      blockId: `text-${runId}`,
      phase: 'delta',
      text
    }
  };
}

function reasoningBlock(runId: string, text: string): ChatRunEvent {
  return {
    type: 'assistant_block',
    runId,
    block: {
      kind: 'reasoning',
      blockId: `reasoning-${runId}`,
      phase: 'delta',
      text
    }
  };
}

function toolBlock(runId: string, phase: 'start' | 'error', data: unknown): ChatRunEvent {
  return {
    type: 'assistant_block',
    runId,
    block: {
      kind: 'tool_call',
      blockId: 'tool-web-search',
      callId: 'call-web-search',
      name: 'web_search',
      phase,
      ...(phase === 'start' ? { input: data } : { error: data })
    }
  };
}

function approvalPayload(): Extract<ChatRunEvent, { type: 'run_interrupted' }>['payload'] {
  return {
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
  };
}
