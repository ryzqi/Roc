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
    expect(html).toContain('推理');
    expect(html).not.toContain('思考过程');
    expect(html).toContain('<ul>');
    expect(html).toContain('<code class="hljs language-ts">');
    expect(html).not.toContain('<p>第一段\n\n- 列表项');
  });

  it('keeps assistant reasoning, content, approval, and the streaming cursor in one assistant content block', () => {
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
      /data-testid="chat-assistant-content"[\s\S]*data-testid="chat-message-reasoning"[\s\S]*<p>最终答案<\/p>[\s\S]*data-testid="chat-approval-card"[\s\S]*class="chat-typing-cursor"/
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
    expect(html).not.toContain('chat-approval-dot');
  });

  it('renders the task approval card for background task proposals', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-task-approval',
          role: 'assistant',
          content: '',
          reasoning: null,
          approval: {
            interruptId: 'interrupt-task-1',
            actionRequests: [
              {
                name: 'propose_background_task',
                args: {
                  goal: '每天检查测试状态',
                  trigger: {
                    type: 'cron',
                    description: '每天 09:00',
                    cronExpression: '0 9 * * *',
                    nextRunAt: '2026-05-22T01:00:00.000Z'
                  },
                  workspacePath: 'F:\\Code\\Roc',
                  allowedActions: ['pnpm test'],
                  forbiddenActions: ['git push']
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'propose_background_task',
                allowedDecisions: ['approve', 'edit', 'reject']
              }
            ]
          },
          isStreaming: false
        }
      })
    );

    expect(html).toContain('data-testid="task-approval-card"');
    expect(html).toContain('创建定时任务');
    expect(html).toContain('编辑后批准');
    expect(html).toContain('每天检查测试状态');
  });
});
