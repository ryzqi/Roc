import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMessageRow } from '../../src/renderer/chat/chat-message-row';

describe('chat message row', () => {
  it('renders reasoning with Markdown structure instead of a single raw paragraph', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-1',
          role: 'assistant',
          content: '最终答案',
          reasoning: '第一段\n\n- 列表项\n\n```ts\nconst ok = true;\n```',
          approval: null,
          isStreaming: false
        }
      })
    );

    expect(html).toContain('data-testid="chat-message-reasoning"');
    expect(html).toContain('<ul>');
    expect(html).toContain('<code class="language-ts">');
    expect(html).not.toContain('<p>第一段\n\n- 列表项');
  });

  it('renders an approval card with tool details and allowed decisions', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-approval',
          role: 'assistant',
          content: '',
          reasoning: '需要你确认这一步。',
          approval: {
            interruptId: 'interrupt-1',
            actionRequests: [
              {
                name: 'execute',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'execute',
                allowedDecisions: ['approve', 'edit', 'reject']
              }
            ]
          },
          isStreaming: false
        }
      })
    );

    expect(html).toContain('data-testid="chat-approval-card"');
    expect(html).toContain('data-testid="chat-approval-tool-name">execute<');
    expect(html).toContain('git status');
    expect(html).toContain('approve / edit / reject');
  });
});
