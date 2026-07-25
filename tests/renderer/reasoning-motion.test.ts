import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChatMessageRow } from '../../src/renderer/chat/chat-message-row';

describe('reasoning motion', () => {
  it('contains no moving reasoning gradient', () => {
    const css = readFileSync(new URL('../../src/renderer/styles/chat.css', import.meta.url), 'utf8');
    expect(css).not.toContain('.reasoning-shimmer');
    expect(css).not.toContain('@keyframes reasoning-shimmer');
  });

  it('keeps streaming reasoning text and the fixed-size typing indicator visible', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-run-reasoning',
          source: 'live',
          role: 'assistant',
          content: '',
          attachments: [],
          reasoning: '正在检查执行路径。',
          blocks: [],
          interrupts: [],
          isStreaming: true
        }
      })
    );
    expect(html).toContain('正在检查执行路径。');
    expect(html).toContain('chat-typing-cursor');
    expect(html).not.toContain('reasoning-shimmer');
  });
});
