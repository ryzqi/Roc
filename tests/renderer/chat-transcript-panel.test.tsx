import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatTranscriptVirtualList } from '../../src/renderer/chat/chat-transcript-virtual-list';
import type { ChatTranscriptMessage } from '../../src/renderer/chat-transcript';

describe('chat transcript panel', () => {
  it('renders long transcripts through the virtual list boundary', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatTranscriptVirtualList, {
        messages: createMessages(200)
      })
    );

    expect(html).toContain('data-testid="chat-transcript-virtual-list"');
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
