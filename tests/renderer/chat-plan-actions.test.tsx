// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/renderer/app/AppShell';
import type { ChatRunEvent } from '../../src/shared/types';
import {
  createBootstrap,
  createShellClient,
  flushPromises,
  queryButton,
  setTextareaValue
} from './app-shell-test-helpers';

const PLAN_BODY = '# Plan\n- implement';

describe('plan 模式操作按钮', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeAll(async () => {
    await import('../../src/renderer/features/tasks');
  });

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, '', '/');
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
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function renderPlanCompleted(): Promise<{
    client: ReturnType<typeof createShellClient>;
    emit: (event: ChatRunEvent) => Promise<void>;
  }> {
    const client = createShellClient();
    const listeners: Array<(event: ChatRunEvent) => void> = [];
    vi.mocked(client.api.chat.onRunEvent).mockImplementation((listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      };
    });
    vi.mocked(client.api.chat.startRun).mockImplementation(async (request) => ({
      ok: true,
      data: {
        runId: request.mode === 'plan' ? 'run-plan' : 'run-execute',
        mode: request.mode,
        threadId: request.mode === 'plan' ? 'thread-plan' : 'thread-execute',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-05-21T00:00:00.000Z'
      }
    }));
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    const planToggle = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Plan'
    );
    await act(async () => {
      planToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    setTextareaValue('chat-input', 'Plan this');
    await act(async () => {
      queryButton('chat-task-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    const emit = async (event: ChatRunEvent): Promise<void> => {
      await act(async () => {
        for (const listener of listeners) {
          listener(event);
        }
      });
      await flushPromises();
    };

    await emit({
      type: 'run_started',
      runId: 'run-plan',
      mode: 'plan',
      threadId: 'thread-plan',
      providerId: 'provider-openai',
      modelId: 'gpt-test',
      createdAt: '2026-05-21T00:00:00.000Z'
    });
    await emit({
      type: 'run_completed',
      runId: 'run-plan',
      threadId: 'thread-plan',
      providerId: 'provider-openai',
      modelId: 'gpt-test',
      createdAt: '2026-05-21T00:00:01.000Z',
      durationMs: 100,
      summary: '完成计划。',
      assistantMessage: `notes\n<proposed_plan>\n${PLAN_BODY}\n</proposed_plan>`
    });

    return { client, emit };
  }

  function chatViewText(): string {
    return container.querySelector('[data-testid="chat-view"]')?.textContent ?? '';
  }

  function selectedComposerMode(): string | null {
    const selected = container.querySelector('[data-testid="chat-composer-mode"] .composer-mode-option.is-selected');
    return selected === null ? null : (selected.textContent?.trim() ?? null);
  }

  it('"继续规划"收起计划操作区并把 composer 留在 Plan 模式', async () => {
    await renderPlanCompleted();

    expect(container.querySelector('[data-testid="chat-plan-actions"]')).not.toBeNull();

    await act(async () => {
      queryButton('chat-plan-continue').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(container.querySelector('[data-testid="chat-plan-actions"]')).toBeNull();
    expect(selectedComposerMode()).toBe('Plan');
  });

  it('"执行计划"立即收起操作区，并在新运行事件到达后展示新会话', async () => {
    const { client, emit } = await renderPlanCompleted();

    await act(async () => {
      queryButton('chat-plan-execute').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(vi.mocked(client.api.chat.startRun).mock.calls[1]?.[0]).toMatchObject({
      input: PLAN_BODY,
      mode: 'chat',
      threadId: null
    });
    expect(container.querySelector('[data-testid="chat-plan-actions"]')).toBeNull();
    expect(selectedComposerMode()).toBe('Chat');

    await emit({
      type: 'run_started',
      runId: 'run-execute',
      mode: 'run',
      threadId: 'thread-execute',
      providerId: 'provider-openai',
      modelId: 'gpt-test',
      createdAt: '2026-05-21T00:00:02.000Z'
    });
    // 新运行接管后，计划正文仍以待发用户消息呈现（旧行为下这里会整体空白）
    const transcript = chatViewText();
    expect(transcript).toContain('implement');
    expect(container.querySelector('[data-testid="chat-plan-actions"]')).toBeNull();
  });

  it('"执行计划"提交失败时恢复操作区并回到 Plan 模式', async () => {
    const { client } = await renderPlanCompleted();
    vi.mocked(client.api.chat.startRun).mockResolvedValueOnce({
      ok: false,
      error: { code: 'chat_start_failed', message: '启动失败', category: 'internal', retryable: false }
    });

    await act(async () => {
      queryButton('chat-plan-execute').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(container.querySelector('[data-testid="chat-plan-actions"]')).not.toBeNull();
    expect(selectedComposerMode()).toBe('Plan');
    expect(container.querySelector('[data-testid="chat-error"]')?.textContent).toContain('启动失败');
  });
});
