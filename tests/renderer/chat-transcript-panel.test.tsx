// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscriptVirtualList } from '../../src/renderer/chat/chat-transcript-virtual-list';
import type { ChatTranscriptMessage } from '../../src/renderer/chat-transcript';

describe('chat transcript panel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
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

  it('renders long transcripts through the virtual list boundary', async () => {
    await act(async () => {
      root.render(
        React.createElement(ChatTranscriptVirtualList, {
          messages: createMessages(200)
        })
      );
    });

    expect(container.querySelector('[data-testid="chat-transcript-virtual-list"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="virtuoso-item-list"]')).not.toBeNull();
  });
});

function createMessages(count: number): ChatTranscriptMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `assistant-${index}`,
    role: 'assistant',
    content: `msg-${index}`,
    reasoning: null,
    blocks: [],
    approval: null,
    isStreaming: false
  }));
}
