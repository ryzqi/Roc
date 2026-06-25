// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessageRow } from '../../src/renderer/chat/chat-message-row';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

describe('reasoning block behavior', () => {
beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('auto-collapses completed reasoning after streaming ends without changing tool error expansion', async () => {
    vi.useFakeTimers();

    await act(async () => {
      root.render(
        <ChatMessageRow
          message={{
            key: 'assistant-live-activity',
            role: 'assistant',
            content: '',
            reasoning: null,
            blocks: [
              {
                id: 'reasoning-live',
                kind: 'reasoning',
                content: '正在分析。\n\n继续整理。',
                isStreaming: true
              },
              {
                id: 'tool-error',
                kind: 'tool_call',
                name: 'read_file',
                status: 'error',
                input: { path: 'README.md' },
                output: null,
                error: 'permission denied'
              }
            ],
            interrupt: null,
            isStreaming: true
          }}
        />
      );
    });

    const reasoningBlock = queryDetails('chat-activity-reasoning');
    const toolBlock = queryDetails('chat-activity-tool');
    expect(reasoningBlock.open).toBe(true);
    expect(toolBlock.open).toBe(true);

    await act(async () => {
      root.render(
        <ChatMessageRow
          message={{
            key: 'assistant-live-activity',
            role: 'assistant',
            content: '',
            reasoning: null,
            blocks: [
              {
                id: 'reasoning-live',
                kind: 'reasoning',
                content: '正在分析。\n\n继续整理。',
                isStreaming: false
              },
              {
                id: 'tool-error',
                kind: 'tool_call',
                name: 'read_file',
                status: 'error',
                input: { path: 'README.md' },
                output: null,
                error: 'permission denied'
              }
            ],
            interrupt: null,
            isStreaming: false
          }}
        />
      );
    });

    expect(queryDetails('chat-activity-reasoning').open).toBe(true);
    expect(queryDetails('chat-activity-tool').open).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(queryDetails('chat-activity-reasoning').open).toBe(false);
    expect(queryDetails('chat-activity-reasoning').textContent).toContain('正在分析。');
    expect(queryDetails('chat-activity-reasoning').textContent).toContain('继续整理。');
    expect(queryDetails('chat-activity-tool').open).toBe(true);
  });

  it('forces streaming reasoning open after a manual close attempt', async () => {
    await act(async () => {
      root.render(
        <ChatMessageRow
          message={{
            key: 'assistant-force-open',
            role: 'assistant',
            content: '',
            reasoning: null,
            blocks: [
              {
                id: 'reasoning-force-open',
                kind: 'reasoning',
                content: '继续思考。',
                isStreaming: true
              }
            ],
            interrupt: null,
            isStreaming: true
          }}
        />
      );
    });

    const reasoningBlock = queryDetails('chat-activity-reasoning');
    expect(reasoningBlock.open).toBe(true);

    await act(async () => {
      reasoningBlock.open = false;
      reasoningBlock.dispatchEvent(new Event('toggle', { bubbles: true }));
    });

    expect(queryDetails('chat-activity-reasoning').open).toBe(true);
  });

  it('copies only the final assistant answer and updates button aria label after copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    });

    await act(async () => {
      root.render(
        <ChatMessageRow
          message={{
            key: 'assistant-copy',
            role: 'assistant',
            content: '正式回答',
            reasoning: '内部推理',
            blocks: [],
            interrupt: null,
            isStreaming: false
          }}
        />
      );
    });

    const button = queryButtonByLabel('复制回答');
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('正式回答');
    expect(button?.getAttribute('aria-label')).toBe('已复制回答');
  });
});

function queryDetails(testId: string): HTMLDetailsElement {
  const element = queryElementByTestId(testId);
  if (!(element instanceof HTMLDetailsElement)) {
    throw new Error(`Missing details element for ${testId}`);
  }
  return element;
}

function queryButtonByLabel(label: string): HTMLButtonElement | null {
  const buttons = Array.from(containerRef().querySelectorAll('button'));
  const match = buttons.find((button) => button.getAttribute('aria-label') === label);
  return match instanceof HTMLButtonElement ? match : null;
}

function queryElementByTestId(testId: string): HTMLElement {
  const element = containerRef().querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing element for ${testId}`);
  }
  return element;
}

function containerRef(): HTMLDivElement {
  if (!(container instanceof HTMLDivElement)) {
    throw new Error('Missing test container');
  }
  return container;
}
