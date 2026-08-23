// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '../../src/renderer/chat/chat-composer';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../src/shared/ipc';
import type { LoadedState } from '../../src/renderer/loaded-state';
import { createLoadedState } from './view-test-helpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 不实现 scrollIntoView，这里补桩并记录调用，供“高亮同步滚动”的断言使用。
const scrollIntoViewCalls: { testId: string | undefined; block: string | undefined }[] = [];
Element.prototype.scrollIntoView = function scrollIntoViewStub(
  this: Element,
  arg?: boolean | ScrollIntoViewOptions
): void {
  scrollIntoViewCalls.push({
    testId: this.getAttribute('data-testid') ?? undefined,
    block: typeof arg === 'object' && arg !== null ? arg.block : undefined
  });
};

const workspaceState: Partial<LoadedState> = {
  workspace: {
    id: 'workspace_1',
    path: 'F:\\Code\\Roc',
    displayName: 'Roc',
    lastOpenedAt: '2026-08-23T00:00:00.000Z',
    trustState: 'trusted'
  },
  skills: [
    {
      id: 'python-expert',
      name: 'Python 专家',
      enabled: true,
      path: 'F:\\Code\\Roc\\skills\\python-expert',
      description: 'Python 代码审查与优化',
      status: 'ready'
    },
    {
      id: 'tdd',
      name: 'TDD 流程',
      enabled: true,
      path: 'F:\\Code\\Roc\\skills\\tdd',
      description: '红绿重构',
      status: 'ready'
    }
  ]
};

const workspaceFiles = [
  { name: 'chat-composer.tsx', relativePath: 'src/renderer/chat/chat-composer.tsx' },
  { name: 'chat-view.tsx', relativePath: 'src/renderer/chat/chat-view.tsx' },
  { name: 'view-test-helpers.ts', relativePath: 'tests/renderer/view-test-helpers.ts' }
];

describe('chat composer suggest popover', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let chatInput: string;
  let submitCount: number;
  let searchCalls: { query: string; maxResults?: number }[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    chatInput = '';
    submitCount = 0;
    searchCalls = [];
    scrollIntoViewCalls.length = 0;
    vi.useFakeTimers();
    window.roc = {
      files: {
        selectFromDialog: async () => ({ ok: true, data: null }),
        searchByName: async (request: { query: string; maxResults?: number }) => {
          searchCalls.push(request);
          return {
            ok: true,
            data: {
              query: request.query,
              matches: workspaceFiles.filter((file) => file.relativePath.includes(request.query)),
              truncated: false
            }
          };
        }
      }
    } as unknown as RocPreloadApi;
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.useRealTimers();
  });

  async function renderComposer(): Promise<void> {
    await act(async () => {
      root.render(React.createElement(ComposerHarness));
    });
  }

  function ComposerHarness(): React.JSX.Element {
    const [value, setValue] = React.useState(chatInput);
    React.useEffect(() => {
      chatInput = value;
    }, [value]);
    return React.createElement(ChatComposer, {
      client: { api: window.roc } as RocClient,
      chatInput: value,
      onChatInputChange: setValue,
      selectedAttachments: [],
      onSelectedAttachmentsChange: () => {},
      imageInputSupported: true,
      activeComposerPopover: null,
      onActiveComposerPopoverChange: () => {},
      composerMode: 'chat',
      onComposerModeChange: () => {},
      submitting: false,
      state: createLoadedState(workspaceState),
      updateLoadedState: () => {},
      onSubmit: async () => {
        submitCount += 1;
      }
    });
  }

  function requireInput(): HTMLTextAreaElement {
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
    if (input === null) {
      throw new Error('chat_input_missing');
    }
    return input;
  }

  async function typeWithoutFlush(input: HTMLTextAreaElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter === undefined) {
      throw new Error('textarea_value_setter_missing');
    }
    await act(async () => {
      setter.call(input, value);
      input.setSelectionRange(value.length, value.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function typeInto(input: HTMLTextAreaElement, value: string): Promise<void> {
    await typeWithoutFlush(input, value);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
  }

  async function pressKey(input: HTMLTextAreaElement, key: string): Promise<void> {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
    });
  }

  function popoverOptions(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid^="chat-suggest-option-"]'));
  }

  it('opens the file popover for an @ trigger and inserts the relative path', async () => {
    await renderComposer();
    const input = requireInput();

    await typeInto(input, '解释 @ch');

    expect(searchCalls).toEqual([{ query: 'ch', maxResults: 12 }]);
    expect(container.querySelector('[data-testid="chat-suggest-popover"]')).not.toBeNull();
    expect(popoverOptions().map((option) => option.textContent)).toEqual([
      'chat-composer.tsxsrc/renderer/chat/chat-composer.tsx',
      'chat-view.tsxsrc/renderer/chat/chat-view.tsx'
    ]);
    expect(popoverOptions()[0]?.getAttribute('aria-selected')).toBe('true');

    await pressKey(input, 'ArrowDown');
    expect(popoverOptions()[1]?.getAttribute('aria-selected')).toBe('true');

    await pressKey(input, 'Enter');

    expect(chatInput).toBe('解释 @src/renderer/chat/chat-view.tsx ');
    expect(submitCount).toBe(0);
    expect(container.querySelector('[data-testid="chat-suggest-popover"]')).toBeNull();
  });

  it('closes the popover on Escape and restores Enter as send', async () => {
    await renderComposer();
    const input = requireInput();

    await typeInto(input, '解释 @ch');
    expect(container.querySelector('[data-testid="chat-suggest-popover"]')).not.toBeNull();

    await pressKey(input, 'Escape');
    expect(container.querySelector('[data-testid="chat-suggest-popover"]')).toBeNull();

    await pressKey(input, 'Enter');
    expect(submitCount).toBe(1);
    expect(chatInput).toBe('解释 @ch');
  });

  it('lists ready skills for a / trigger without hitting IPC', async () => {
    await renderComposer();
    const input = requireInput();

    await typeInto(input, '/py');

    expect(searchCalls).toEqual([]);
    expect(popoverOptions().map((option) => option.dataset.testid)).toEqual([
      'chat-suggest-option-python-expert'
    ]);

    await pressKey(input, 'Tab');

    expect(chatInput).toBe('/python-expert ');
  });

  it('does not intercept keys while an IME composition is active', async () => {
    await renderComposer();
    const input = requireInput();

    await typeInto(input, '解释 @ch');

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', isComposing: true })
      );
    });

    expect(chatInput).toBe('解释 @ch');
    expect(submitCount).toBe(0);
    expect(container.querySelector('[data-testid="chat-suggest-popover"]')).not.toBeNull();
  });

  it('wires the listbox and the active option back to the textarea', async () => {
    await renderComposer();
    const input = requireInput();

    await typeInto(input, '解释 @ch');

    const listbox = container.querySelector('#chat-composer-suggest-listbox');
    if (listbox === null) {
      throw new Error('suggest_listbox_missing');
    }
    // role=option 必须是 role=listbox 的直接子元素，否则辅助技术读不到候选。
    expect(listbox.getAttribute('role')).toBe('listbox');
    expect(listbox.classList.contains('composer-popover-list')).toBe(true);
    expect(popoverOptions().map((option) => option.parentElement)).toEqual([listbox, listbox]);

    expect(input.getAttribute('aria-controls')).toBe('chat-composer-suggest-listbox');
    expect(input.getAttribute('aria-activedescendant')).toBe(popoverOptions()[0]?.id);

    await pressKey(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(popoverOptions()[1]?.id);

    await pressKey(input, 'Escape');
    expect(input.getAttribute('aria-controls')).toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('scrolls the active option into view while navigating with the keyboard', async () => {
    await renderComposer();
    const input = requireInput();

    await typeInto(input, '解释 @ch');
    scrollIntoViewCalls.length = 0;

    // 列表可滚动，键盘下移必须把新高亮项滚进可视区，否则高亮会停在视口外。
    await pressKey(input, 'ArrowDown');
    expect(scrollIntoViewCalls).toEqual([{ testId: popoverOptions()[1]?.dataset.testid, block: 'nearest' }]);

    await pressKey(input, 'ArrowUp');
    expect(scrollIntoViewCalls[1]).toEqual({ testId: popoverOptions()[0]?.dataset.testid, block: 'nearest' });
  });

  it('reopens the popover after editing away from the dismissed token', async () => {
    await renderComposer();
    const input = requireInput();

    await typeInto(input, '解释 @ch');
    await pressKey(input, 'Escape');
    expect(container.querySelector('[data-testid="chat-suggest-popover"]')).toBeNull();

    await typeInto(input, '解释 @c');
    expect(container.querySelector('[data-testid="chat-suggest-popover"]')).not.toBeNull();

    await typeInto(input, '解释 @ch');
    expect(container.querySelector('[data-testid="chat-suggest-popover"]')).not.toBeNull();
  });

  it('drops the previous token matches before the new query resolves', async () => {
    await renderComposer();
    const input = requireInput();

    await typeInto(input, '解释 @ch');
    expect(popoverOptions()).toHaveLength(2);

    // 换到另一个 @ token：防抖窗口内不能把上一个 token 的候选留在新位置上。
    await typeWithoutFlush(input, '解释 @src/renderer/chat/chat-view.tsx @view-test');
    expect(container.querySelector('[data-testid="chat-suggest-popover"]')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(popoverOptions().map((option) => option.dataset.testid)).toEqual([
      'chat-suggest-option-tests-renderer-view-test-helpers.ts'
    ]);
  });
});
