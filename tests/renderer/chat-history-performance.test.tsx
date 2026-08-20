// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatTranscriptMessage } from '../../src/renderer/chat-transcript';
import { ChatTranscriptPanel, useTranscriptFirstItemIndex } from '../../src/renderer/chat/chat-transcript-panel';

describe('chat history performance', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let scrollContainer: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
    container = document.createElement('div');
    document.body.appendChild(container);
    scrollContainer = document.createElement('div');
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 600, configurable: true },
      clientWidth: { value: 800, configurable: true }
    });
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps a 10k transcript below the DOM row cap', async () => {
    const messages = createMessages(10_000);
    const startedAt = performance.now();

    await act(async () => {
      root.render(
        <ChatTranscriptPanel
          threadId="thread-10k"
          messages={messages}
          prependRevision={0}
          hasMoreBefore={false}
          loadingOlder={false}
          loadOlder={async () => {}}
          scrollContainerRef={{ current: scrollContainer }}
        />
      );
    });

    const interactiveMs = performance.now() - startedAt;
    const domRows = container.querySelectorAll('[data-testid^="chat-message-"]').length;
    expect(domRows, `10k DOM rows: ${domRows}`).toBeLessThan(300);
    expect(interactiveMs, `10k interactive ms: ${interactiveMs}`).toBeLessThanOrEqual(1000);
  });

  it('preserves the virtual anchor through 20 page prepends', async () => {
    const durations: number[] = [];
    let messageCount = 100;
    let revision = 0;
    await renderIndex(messageCount, revision);

    for (let page = 0; page < 20; page += 1) {
      messageCount += 100;
      revision += 1;
      const startedAt = performance.now();
      await renderIndex(messageCount, revision);
      durations.push(performance.now() - startedAt);
    }

    expect(container.querySelector('[data-index]')?.getAttribute('data-index')).toBe(String(1_000_000 - 2_000));
    const p95 = percentile95(durations);
    expect(p95, `prepend p95 ms: ${p95}`).toBeLessThanOrEqual(250);
  });

  async function renderIndex(messageCount: number, prependRevision: number): Promise<void> {
    await act(async () => {
      root.render(
        <FirstIndexProbe
          threadId="thread-anchor"
          messageCount={messageCount}
          prependRevision={prependRevision}
        />
      );
    });
  }
});

function FirstIndexProbe(input: {
  threadId: string;
  messageCount: number;
  prependRevision: number;
}): React.JSX.Element {
  const index = useTranscriptFirstItemIndex(input);
  return <div data-index={index} />;
}

function createMessages(count: number): ChatTranscriptMessage[] {
  return Array.from({ length: count }, (_value, index) => ({
    key: `message-${index}`,
    source: 'persisted',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    attachments: [],
    reasoning: null,
    blocks: [],
    interrupts: [],
    isStreaming: false
  }));
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  const value = sorted[index];
  if (value === undefined) {
    throw new Error('percentile_input_empty');
  }
  return value;
}
