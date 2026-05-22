// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../../src/renderer/chat/chat-view';
import type { RocPreloadApi } from '../../src/shared/ipc';
import { createLoadedState } from './view-test-helpers';

describe('ChatView queued task prompt', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
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
    window.roc = createMockPreloadApi();
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
          queuedTaskPrompt: '请调用 propose_background_task 创建任务',
          onQueuedTaskPromptHandled,
          selectedThreadId: null,
          state: createLoadedState({}),
          updateLoadedState: () => {},
          onSubmitChatTask
        })
      );
    });
    await flushPromises();

    expect(onSubmitChatTask).toHaveBeenCalledWith('请调用 propose_background_task 创建任务');
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
          queuedTaskPrompt: '重复任务提议',
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
          queuedTaskPrompt: '重复任务提议',
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
          queuedTaskPrompt: '失败的任务提议',
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
});

function createMockPreloadApi(): RocPreloadApi {
  return {
    chat: {
      onRunEvent: vi.fn().mockReturnValue(() => {}),
      resumeRun: vi.fn(),
      startRun: vi.fn(),
      cancelRun: vi.fn()
    },
    tasks: {
      getThreadMessages: vi.fn().mockResolvedValue({ ok: true as const, data: [] })
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
