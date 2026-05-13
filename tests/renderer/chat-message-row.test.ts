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
    expect(html).toContain('<code class="hljs language-ts">');
    expect(html).not.toContain('<p>第一段\n\n- 列表项');
  });

  it('keeps assistant content, reasoning, approval, and the streaming cursor in one assistant content block', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-streaming',
          role: 'assistant',
          content: '最终答案',
          reasoning: '先整理上下文，再输出结论。',
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
          isStreaming: true
        }
      })
    );

    expect(html).toContain('data-testid="chat-assistant-content"');
    expect(html).toMatch(
      /data-testid="chat-assistant-content"[\s\S]*<p>最终答案<\/p>[\s\S]*data-testid="chat-message-reasoning"[\s\S]*data-testid="chat-approval-card"[\s\S]*class="chat-typing-cursor"/
    );
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
