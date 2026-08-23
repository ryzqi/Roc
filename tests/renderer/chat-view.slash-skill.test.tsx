// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../../src/renderer/chat/chat-view';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../src/shared/ipc';
import { createLoadedState } from './view-test-helpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('chat view slash skill command', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false
      })
    });
    Element.prototype.scrollTo = vi.fn();
    window.roc = {
      chat: {
        onRunEvent: () => () => {},
        resumeRun: async () => ({ ok: true })
      },
      tasks: {
        getThreadMessages: async () => ({ ok: true, data: [] })
      },
      files: {
        selectFromDialog: async () => ({ ok: true, data: null })
      }
    } as unknown as RocPreloadApi;
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('submits slash skill command as cleaned input plus explicit skill ids', async () => {
    const submissions: unknown[] = [];
    await act(async () => {
      root.render(
        React.createElement(ChatView, {
          chatSelectionVersion: 1,
          client: createChatClient(),
          selectedThreadId: null,
          state: createLoadedState({
            selectedSkills: ['existing-skill'],
            skills: [
              {
                id: 'python-expert',
                name: 'Python 专家',
                enabled: true,
                path: 'F:\\Code\\Roc\\skills\\python-expert',
                description: 'Python 代码审查与优化',
                status: 'ready'
              }
            ]
          }),
          updateLoadedState: () => {},
          onSubmitChatTask: async (payload) => {
            submissions.push(payload);
            return { ok: true as const };
          }
        })
      );
    });

    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
    if (input === null) {
      throw new Error('chat_input_missing');
    }
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter === undefined) {
        throw new Error('textarea_value_setter_missing');
      }
      setter.call(input, '/python-expert 优化这段代码');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submit = container.querySelector<HTMLButtonElement>('[data-testid="chat-task-submit"]');
    if (submit === null) {
      throw new Error('chat_submit_missing');
    }
    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(submissions).toEqual([
      {
        input: '优化这段代码',
        explicitSkillIds: ['python-expert']
      }
    ]);
  });

  function createChatClient(): RocClient {
    return { api: window.roc };
  }
});
