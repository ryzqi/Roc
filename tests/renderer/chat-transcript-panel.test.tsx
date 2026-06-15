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
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
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
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 800, configurable: true },
      scrollTop: { value: 400, configurable: true }
    });
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

    expect(container.querySelector('[data-testid="chat-transcript"]')?.textContent).toContain('流式输出可见');
    expect(container.querySelector('[data-testid="chat-message-assistant"]')).not.toBeNull();
    expect(scrollContainer.scrollTo).toHaveBeenCalledWith({ top: 800 });
  });
});

function createMessages(): ChatTranscriptMessage[] {
  return [
    {
      key: 'assistant-visible',
      role: 'assistant',
      content: '流式输出可见',
      reasoning: null,
      blocks: [],
      approval: null,
      isStreaming: true
    }
  ];
}
