// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../../src/renderer/chat/chat-view';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../src/shared/ipc';
import type { ChatRunEvent, TaskEvent } from '../../src/shared/types';
import { createLoadedState } from './view-test-helpers';

describe('ChatView queued task prompt', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let runEventHandler: ((event: ChatRunEvent) => void) | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    runEventHandler = null;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Element.prototype.scrollTo = vi.fn();
    window.roc = createMockPreloadApi((handler) => {
      runEventHandler = handler;
      return () => {
        if (runEventHandler === handler) {
          runEventHandler = null;
        }
      };
    });
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('submits the queued task prompt after the chat run subscription is mounted', async () => {
    const onSubmitChatTask = vi.fn().mockResolvedValue({ ok: true as const });
    const onQueuedTaskPromptHandled = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(ChatView, {
          chatSelectionVersion: 1,
          client: createChatClient(),
          queuedTaskPrompt: {
            input: '请调用 propose_background_task 创建任务',
            workflowHint: 'propose_background_task',
            taskSource: 'workbench'
          },
          onQueuedTaskPromptHandled,
          selectedThreadId: null,
          state: createLoadedState({}),
          updateLoadedState: () => {},
          onSubmitChatTask
        })
      );
    });
    await flushPromises();

    expect(onSubmitChatTask).toHaveBeenCalledWith({
      input: '请调用 propose_background_task 创建任务',
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });
    expect(onQueuedTaskPromptHandled).toHaveBeenCalledTimes(1);
  });

  it('submits the same queued prompt again after it has been handled', async () => {
    const onSubmitChatTask = vi.fn().mockResolvedValue({ ok: true as const });
    const onQueuedTaskPromptHandled = vi.fn();
    const state = createLoadedState({});

    await act(async () => {
      root.render(
        React.createElement(ChatView, {
          chatSelectionVersion: 1,
          client: createChatClient(),
          queuedTaskPrompt: {
            input: '重复任务提议',
            workflowHint: 'propose_background_task'
          },
          onQueuedTaskPromptHandled,
          selectedThreadId: null,
          state,
          updateLoadedState: () => {},
          onSubmitChatTask
        })
      );
    });
    await flushPromises();

    await act(async () => {
      root.render(
        React.createElement(ChatView, {
          chatSelectionVersion: 1,
          client: createChatClient(),
          queuedTaskPrompt: null,
          onQueuedTaskPromptHandled,
          selectedThreadId: null,
          state,
          updateLoadedState: () => {},
          onSubmitChatTask
        })
      );
    });

    await act(async () => {
      root.render(
        React.createElement(ChatView, {
          chatSelectionVersion: 2,
          client: createChatClient(),
          queuedTaskPrompt: {
            input: '重复任务提议',
            workflowHint: 'propose_background_task'
          },
          onQueuedTaskPromptHandled,
          selectedThreadId: null,
          state,
          updateLoadedState: () => {},
          onSubmitChatTask
        })
      );
    });
    await flushPromises();

    expect(onSubmitChatTask).toHaveBeenCalledTimes(2);
    expect(onQueuedTaskPromptHandled).toHaveBeenCalledTimes(2);
  });

  it('marks a failed queued prompt as handled after surfacing the error', async () => {
    const onSubmitChatTask = vi.fn().mockResolvedValue({ ok: false as const, error: '默认模型未配置。' });
    const onQueuedTaskPromptHandled = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(ChatView, {
          chatSelectionVersion: 1,
          client: createChatClient(),
          queuedTaskPrompt: {
            input: '失败的任务提议',
            workflowHint: 'propose_background_task'
          },
          onQueuedTaskPromptHandled,
          selectedThreadId: null,
          state: createLoadedState({}),
          updateLoadedState: () => {},
          onSubmitChatTask
        })
      );
    });
    await flushPromises();

    expect(onSubmitChatTask).toHaveBeenCalledTimes(1);
    expect(onQueuedTaskPromptHandled).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="chat-error"]')?.textContent).toBe('默认模型未配置。');
  });

  it('shows only the thinking spinner immediately while awaiting the first response byte', async () => {
    await act(async () => {
      root.render(
        React.createElement(ChatView, {
          chatSelectionVersion: 1,
          client: createChatClient(),
          queuedTaskPrompt: null,
          onQueuedTaskPromptHandled: () => {},
          selectedThreadId: null,
          state: createLoadedState({}),
          updateLoadedState: () => {},
          onSubmitChatTask: async () => ({ ok: true as const })
        })
      );
    });

    await act(async () => {
      emitRunEvent({
        type: 'run_started',
        runId: 'run_waiting_first_byte',
        mode: 'chat',
        threadId: null,
        providerId: 'nvidia',
        modelId: 'nvidia-model',
        createdAt: new Date().toISOString()
      });
    });

    const indicator = container.querySelector('[data-testid="chat-wait-indicator"]');
    expect(indicator?.textContent).toBe('正在思考');
    expect(indicator?.querySelector('.chat-wait-indicator-spinner')).not.toBeNull();
    expect(container.textContent).not.toContain('上游响应等待中');
    expect(container.textContent).not.toContain('NVIDIA');
    expect(container.textContent).not.toContain('P95');
    expect(container.textContent).not.toContain('Provider');

    await act(async () => {
      emitRunEvent({
        type: 'assistant_block',
        runId: 'run_waiting_first_byte',
        block: {
          kind: 'text',
          blockId: 'text-run_waiting_first_byte',
          phase: 'delta',
          text: '首字节'
        }
      });
    });

    expect(container.querySelector('[data-testid="chat-wait-indicator"]')).toBeNull();
  });

  it('loads persisted thread messages for the selected thread even when recentEvents does not include that thread', async () => {
    const persistedMessages: TaskEvent[] = [
      {
        id: 'persisted-user',
        threadId: 'thread-historical-nvidia',
        runId: 'run-historical-nvidia',
        type: 'message',
        payload: {
          role: 'user',
          content: '请先思考，再回答。'
        },
        createdAt: '2026-06-02T12:21:56.000Z'
      },
      {
        id: 'persisted-reasoning',
        threadId: 'thread-historical-nvidia',
        runId: 'run-historical-nvidia',
        type: 'assistant_block',
        payload: {
          kind: 'reasoning',
          blockId: 'reasoning-run-historical-nvidia',
          phase: 'delta',
          text: '先检查 NVIDIA thinking 输出。'
        },
        createdAt: '2026-06-02T12:21:57.000Z'
      },
      {
        id: 'persisted-answer',
        threadId: 'thread-historical-nvidia',
        runId: 'run-historical-nvidia',
        type: 'assistant_block',
        payload: {
          kind: 'text',
          blockId: 'text-run-historical-nvidia',
          phase: 'delta',
          text: '最终答案'
        },
        createdAt: '2026-06-02T12:21:58.000Z'
      }
    ];
    const getThreadMessages = vi.fn().mockResolvedValue({
      ok: true as const,
      data: persistedMessages
    });

    window.roc = createMockPreloadApi(
      (handler) => {
        runEventHandler = handler;
        return () => {
          if (runEventHandler === handler) {
            runEventHandler = null;
          }
        };
      },
      {
        getThreadMessages
      }
    );

    await act(async () => {
      root.render(
        React.createElement(ChatView, {
          chatSelectionVersion: 1,
          client: createChatClient(),
          queuedTaskPrompt: null,
          onQueuedTaskPromptHandled: () => {},
          selectedThreadId: 'thread-historical-nvidia',
          state: createLoadedState({
            taskSnapshot: {
              generatedAt: '2026-06-08T00:00:00.000Z',
              recentEvents: [],
              counts: {
                total: 1,
                running: 0,
                failed: 0,
                pendingConfirmation: 0
              },
              threads: [
                {
                  id: 'thread-other',
                  kind: 'chat',
                  title: '其他线程',
                  goal: '其他线程',
                  status: 'completed',
                  createdAt: '2026-06-08T00:00:00.000Z',
                  updatedAt: '2026-06-08T00:00:00.000Z'
                }
              ]
            }
          }),
          updateLoadedState: () => {},
          onSubmitChatTask: async () => ({ ok: true as const })
        })
      );
    });
    await flushPromises();

    expect(getThreadMessages).toHaveBeenCalledWith({ threadId: 'thread-historical-nvidia' });
    expect(container.querySelector('[data-testid="chat-activity-reasoning"]')?.textContent).toContain(
      '先检查 NVIDIA thinking 输出。'
    );
    expect(container.textContent).toContain('最终答案');
  });

  function emitRunEvent(event: ChatRunEvent): void {
    if (runEventHandler === null) {
      throw new Error('Chat run event handler was not registered.');
    }
    runEventHandler(event);
  }
});

function createMockPreloadApi(
  onRunEvent: (handler: (event: ChatRunEvent) => void) => () => void,
  overrides: {
    getThreadMessages?: RocPreloadApi['tasks']['getThreadMessages'];
  } = {}
): RocPreloadApi {
  return {
    chat: {
      onRunEvent: vi.fn().mockImplementation(onRunEvent),
      resumeRun: vi.fn(),
      startRun: vi.fn(),
      cancelRun: vi.fn()
    },
    tasks: {
      getThreadMessages: overrides.getThreadMessages ?? vi.fn().mockResolvedValue({ ok: true as const, data: [] })
    },
    files: {
      selectFromDialog: vi.fn()
    }
  } as unknown as RocPreloadApi;
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function createChatClient(): RocClient {
  return { api: window.roc };
}
