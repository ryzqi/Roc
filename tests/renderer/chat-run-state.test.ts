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

  it('enters waiting_user on interrupt and keeps reasoning updates through resume completion', () => {
    let state = createEmptyChatRunState();

    state = applyChatRunEvent(state, {
      type: 'run_started',
      runId: 'chat_approval',
      mode: 'task',
      threadId: 'thread_approval',
      providerId: 'nvidia',
      modelId: 'moonshotai/kimi-k2.6',
      createdAt: '2026-05-12T00:00:00.000Z'
    });
    state = applyChatRunEvent(state, {
      type: 'reasoning_delta',
      runId: 'chat_approval',
      delta: '先分析命令风险。\n'
    });
    state = applyChatRunEvent(state, {
      type: 'run_interrupted',
      runId: 'chat_approval',
      threadId: 'thread_approval',
      interruptId: 'interrupt-1',
      payload: {
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
    });

    expect(state.status).toBe('waiting_user');
    expect(state.pendingApprovals).toEqual([
      expect.objectContaining({
        interruptId: 'interrupt-1'
      })
    ]);
    expect(state.reasoning).toBe('先分析命令风险。\n');

    state = applyChatRunEvent(state, {
      type: 'run_resumed',
      runId: 'chat_approval',
      threadId: 'thread_approval',
      interruptId: 'interrupt-1'
    });
    state = applyChatRunEvent(state, {
      type: 'reasoning_delta',
      runId: 'chat_approval',
      delta: '审批通过，继续执行。'
    });
    state = applyChatRunEvent(state, {
      type: 'run_completed',
      runId: 'chat_approval',
      threadId: 'thread_approval',
      providerId: 'nvidia',
      modelId: 'moonshotai/kimi-k2.6',
      createdAt: '2026-05-12T00:00:00.000Z',
      durationMs: 640,
      summary: 'nvidia:moonshotai/kimi-k2.6:deepagents',
      assistantMessage: '命令已执行。'
    });

    expect(state.status).toBe('completed');
    expect(state.pendingApprovals).toEqual([]);
    expect(state.reasoning).toBe('先分析命令风险。\n审批通过，继续执行。');
  });

  it('keeps multiple action requests in approval order until the matching interrupt resumes', () => {
    let state = createEmptyChatRunState();

    state = applyChatRunEvent(state, {
      type: 'run_started',
      runId: 'chat_multi_approval',
      mode: 'task',
      threadId: 'thread_multi_approval',
      providerId: 'nvidia',
      modelId: 'moonshotai/kimi-k2.6',
      createdAt: '2026-05-21T00:00:00.000Z'
    });
    state = applyChatRunEvent(state, {
      type: 'run_interrupted',
      runId: 'chat_multi_approval',
      threadId: 'thread_multi_approval',
      interruptId: 'interrupt-multi',
      payload: {
        actionRequests: [
          {
            name: 'execute',
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
            actionName: 'execute',
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
        name: 'execute',
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
      threadId: 'thread_multi_approval',
      interruptId: 'interrupt-multi'
    });

    expect(state.pendingApprovals).toEqual([]);
    expect(state.status).toBe('running');
  });
});
