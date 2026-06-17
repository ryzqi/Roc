// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscriptPanel } from '../../src/renderer/chat/chat-transcript-panel';
import type { ChatTranscriptMessage } from '../../src/renderer/chat-transcript';

describe('chat transcript panel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    let rafId = 0;
    const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafId += 1;
      const id = rafId;
      const timer = setTimeout(() => {
        rafTimers.delete(id);
        callback(0);
      }, 0);
      rafTimers.set(id, timer);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      const timer = rafTimers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        rafTimers.delete(id);
      }
    });
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders assistant text in the existing transcript scroll surface', async () => {
    const scrollContainer = document.createElement('div');
    setScrollGeometry(scrollContainer, { clientHeight: 400, scrollHeight: 800, scrollTop: 400 });
    scrollContainer.scrollTo = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptPanel, {
          messages: createMessages(),
          liveSignal: 'run_1|18|0',
          scrollContainerRef: { current: scrollContainer }
        })
      );
    });
    await flushAnimationFrame();

    expect(container.querySelector('[data-testid="chat-transcript"]')?.textContent).toContain('流式输出可见');
    expect(container.querySelector('[data-testid="chat-message-assistant"]')).not.toBeNull();
    expect(scrollContainer.scrollTo).toHaveBeenCalledWith({ top: 800 });
  });

  it('keeps following the bottom when new messages increase transcript height', async () => {
    const scrollContainer = document.createElement('div');
    setScrollGeometry(scrollContainer, { clientHeight: 400, scrollHeight: 800, scrollTop: 400 });
    scrollContainer.scrollTo = vi.fn();
    const messages = createMessages();

    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptPanel, {
          messages,
          liveSignal: 'run_1|18|0',
          scrollContainerRef: { current: scrollContainer }
        })
      );
    });
    await flushAnimationFrame();
    vi.mocked(scrollContainer.scrollTo).mockClear();
    setScrollGeometry(scrollContainer, { clientHeight: 400, scrollHeight: 1000, scrollTop: 400 });

    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptPanel, {
          messages: [...messages, createMessage('assistant-next', '新增回复')],
          liveSignal: 'run_1|22|0',
          scrollContainerRef: { current: scrollContainer }
        })
      );
    });
    await flushAnimationFrame();

    expect(scrollContainer.scrollTo).toHaveBeenCalledWith({ top: 1000 });
  });
});

function createMessages(): ChatTranscriptMessage[] {
  return [
    createMessage('assistant-visible', '流式输出可见')
  ];
}

function createMessage(key: string, content: string): ChatTranscriptMessage {
  return {
    key,
    role: 'assistant',
    content,
    reasoning: null,
    blocks: [],
    approval: null,
    isStreaming: true
  };
}

function setScrollGeometry(
  element: HTMLElement,
  geometry: { clientHeight: number; scrollHeight: number; scrollTop: number }
): void {
  Object.defineProperties(element, {
    clientHeight: { value: geometry.clientHeight, configurable: true },
    scrollHeight: { value: geometry.scrollHeight, configurable: true },
    scrollTop: { value: geometry.scrollTop, configurable: true }
  });
}

async function flushAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
