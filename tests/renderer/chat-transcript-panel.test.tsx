// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscriptPanel } from '../../src/renderer/chat/chat-transcript-panel';
import type { ChatTranscriptMessage } from '../../src/renderer/chat-transcript';

const virtuosoHarness = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  scrollToIndex: vi.fn()
}));

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  const Virtuoso = ReactModule.forwardRef(function TestVirtuoso(props: Record<string, unknown>, ref) {
    const elementRef = ReactModule.useRef<HTMLDivElement | null>(null);
    virtuosoHarness.props = props;
    ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: virtuosoHarness.scrollToIndex }));
    ReactModule.useEffect(() => {
      if (typeof ResizeObserver !== 'function' || elementRef.current === null) {
        return;
      }
      const observer = new ResizeObserver(() => {});
      observer.observe(elementRef.current);
      return () => observer.disconnect();
    }, []);
    const data = props.data as ChatTranscriptMessage[];
    const itemContent = props.itemContent as (index: number, message: ChatTranscriptMessage) => React.ReactNode;
    return ReactModule.createElement(
      'div',
      {
        ref: elementRef,
        className: props.className,
        'data-testid': props['data-testid'],
        'data-message-count': props['data-message-count']
      },
      data.map((message, index) => ReactModule.createElement(ReactModule.Fragment, { key: message.key }, itemContent(index, message)))
    );
  });
  return { Virtuoso };
});

describe('chat transcript panel', () => {
  let container: HTMLDivElement;
  let scrollContainer: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    virtuosoHarness.props = null;
    virtuosoHarness.scrollToIndex.mockReset();
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
    scrollContainer = document.createElement('div');
    setScrollGeometry(scrollContainer, { clientHeight: 400, scrollHeight: 800, scrollTop: 400 });
    scrollContainer.scrollTo = vi.fn();
    container = document.createElement('div');
    scrollContainer.appendChild(container);
    document.body.appendChild(scrollContainer);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    scrollContainer.remove();
    vi.unstubAllGlobals();
  });

  it('renders assistant text in the existing transcript scroll surface', async () => {
    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptPanel, {
          messages: createMessages(),
          threadId: 'thread-test',
          prependRevision: 0,
          hasMoreBefore: false,
          loadingOlder: false,
          loadOlder: async () => {},
          scrollContainerRef: { current: scrollContainer }
        })
      );
    });
    await waitForText(container, '流式输出可见');

    expect(container.querySelector('[data-testid="chat-transcript"]')?.textContent).toContain('流式输出可见');
    expect(container.querySelector('[data-testid="chat-message-assistant"]')).not.toBeNull();
    expect(scrollContainer.scrollTo).not.toHaveBeenCalled();
  });

  it('updates the visible virtualized message during streaming', async () => {
    const messages = createMessages();

    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptPanel, {
          messages,
          threadId: 'thread-test',
          prependRevision: 0,
          hasMoreBefore: false,
          loadingOlder: false,
          loadOlder: async () => {},
          scrollContainerRef: { current: scrollContainer }
        })
      );
    });
    await waitForText(container, '流式输出可见');
    vi.mocked(scrollContainer.scrollTo).mockClear();
    setScrollGeometry(scrollContainer, { clientHeight: 400, scrollHeight: 1000, scrollTop: 400 });

    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptPanel, {
          messages: [createMessage('assistant-visible', '流式输出可见，新增回复')],
          threadId: 'thread-test',
          prependRevision: 0,
          hasMoreBefore: false,
          loadingOlder: false,
          loadOlder: async () => {},
          scrollContainerRef: { current: scrollContainer }
        })
      );
    });
    await waitForText(container, '新增回复');

    expect(container.textContent).toContain('新增回复');
    expect(readVirtuosoProps().followOutput).toBe('auto');
    expect(virtuosoHarness.scrollToIndex).not.toHaveBeenCalled();
  });

  it('does not change position during streaming after the user leaves the bottom', async () => {
    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptPanel, {
          messages: createMessages(),
          threadId: 'thread-test',
          prependRevision: 0,
          hasMoreBefore: false,
          loadingOlder: false,
          loadOlder: async () => {},
          scrollContainerRef: { current: scrollContainer }
        })
      );
    });
    await setVirtuosoAtBottom(false);
    virtuosoHarness.scrollToIndex.mockClear();
    const previousScrollTop = scrollContainer.scrollTop;

    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptPanel, {
          messages: [createMessage('assistant-visible', '流式输出可见，离底更新')],
          threadId: 'thread-test',
          prependRevision: 0,
          hasMoreBefore: false,
          loadingOlder: false,
          loadOlder: async () => {},
          scrollContainerRef: { current: scrollContainer }
        })
      );
    });
    await waitForText(container, '离底更新');

    expect(readVirtuosoProps().followOutput).toBe(false);
    expect(scrollContainer.scrollTop).toBe(previousScrollTop);
    expect(virtuosoHarness.scrollToIndex).not.toHaveBeenCalled();
  });

  it('scrolls to the latest message when the manual button is clicked', async () => {
    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptPanel, {
          messages: createMessages(),
          threadId: 'thread-test',
          prependRevision: 0,
          hasMoreBefore: false,
          loadingOlder: false,
          loadOlder: async () => {},
          scrollContainerRef: { current: scrollContainer }
        })
      );
    });
    await setVirtuosoAtBottom(false);
    virtuosoHarness.scrollToIndex.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-scroll-bottom"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(virtuosoHarness.scrollToIndex).toHaveBeenCalledWith({
      index: 'LAST',
      behavior: 'smooth'
    });
  });

  it('does not attach a whole-transcript ResizeObserver', async () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe(): void {}

      unobserve(): void {}

      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptPanel, {
          messages: createMessages(),
          threadId: 'thread-test',
          prependRevision: 0,
          hasMoreBefore: false,
          loadingOlder: false,
          loadOlder: async () => {},
          scrollContainerRef: { current: scrollContainer }
        })
      );
    });
    await flushAnimationFrame();
    vi.mocked(scrollContainer.scrollTo).mockClear();
    setScrollGeometry(scrollContainer, { clientHeight: 400, scrollHeight: 1000, scrollTop: 400 });

    expect(resizeCallback).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-transcript"]')).not.toBeNull();
    expect(scrollContainer.scrollTo).not.toHaveBeenCalled();
  });

  it('renders user image attachment metadata', async () => {
    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptPanel, {
          messages: [
            {
              ...createMessage('user-image', '描述图片'),
              role: 'user',
              isStreaming: false,
              attachments: [
                {
                  kind: 'image',
                  name: 'chart.png',
                  mediaType: 'image/png',
                  sizeBytes: 123
                }
              ]
            }
          ],
          threadId: 'thread-test',
          prependRevision: 0,
          hasMoreBefore: false,
          loadingOlder: false,
          loadOlder: async () => {},
          scrollContainerRef: { current: scrollContainer }
        })
      );
    });
    await flushAnimationFrame();

    expect(container.querySelector('[data-testid="chat-message-attachments"]')?.textContent).toContain('chart.png');
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
    source: 'persisted',
    role: 'assistant',
    content,
    attachments: [],
    reasoning: null,
    blocks: [],
    interrupts: [],
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

async function waitForText(element: HTMLElement, text: string): Promise<void> {
  const startedAt = Date.now();
  while (!element.textContent?.includes(text)) {
    if (Date.now() - startedAt > 5000) {
      throw new Error(`Timed out waiting for text: ${text}`);
    }
    await flushAnimationFrame();
  }
}

function readVirtuosoProps(): Record<string, unknown> {
  if (virtuosoHarness.props === null) {
    throw new Error('Virtuoso props are unavailable');
  }
  return virtuosoHarness.props;
}

async function setVirtuosoAtBottom(value: boolean): Promise<void> {
  const callback = readVirtuosoProps().atBottomStateChange;
  if (typeof callback !== 'function') {
    throw new Error('Virtuoso atBottomStateChange callback is unavailable');
  }
  await act(async () => {
    callback(value);
  });
}
