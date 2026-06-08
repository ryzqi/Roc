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
          blocks: [],
          approval: null,
          isStreaming: false
        }
      })
    );

    expect(html).toContain('data-testid="chat-activity-reasoning"');
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
          blocks: [],
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
      /data-testid="chat-assistant-content"[\s\S]*data-testid="chat-activity-reasoning"[\s\S]*<p>最终答案<\/p>[\s\S]*data-testid="chat-approval-card"[\s\S]*class="chat-typing-cursor"/
    );
  });

  it('renders reasoning and tool activity blocks separately from assistant Markdown content', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-activity',
          role: 'assistant',
          content: '最终答案\n\n- 保持 Markdown',
          reasoning: '先整理上下文。',
          blocks: [
            {
              id: 'reasoning-1',
              kind: 'reasoning',
              content: '先整理上下文。',
              isStreaming: false
            },
            {
              id: 'tool-1',
              kind: 'tool_call',
              name: 'read_file',
              status: 'end',
              input: { path: 'F:\\Code\\Roc\\README.md' },
              output: { bytes: 128 },
              error: null
            }
          ],
          approval: null,
          isStreaming: false
        }
      })
    );

    expect(html).toContain('data-testid="chat-activity-reasoning"');
    expect(html).toContain('data-testid="chat-activity-tool"');
    expect(html).toContain('工具 · read_file · end');
    expect(html).toContain('&quot;path&quot;');
    expect(html).toContain('F:\\\\Code\\\\Roc\\\\README.md');
    expect(html).toMatch(/data-testid="chat-activity-tool"[\s\S]*<summary>[\s\S]*工具 · read_file · end[\s\S]*<\/summary>/);
    expect(html).toMatch(/data-testid="chat-activity-tool"[\s\S]*<pre/);
    expect(html).toMatch(/data-testid="chat-activity-tool"[\s\S]*最终答案/);
    expect(html).toContain('<ul>');
  });

  it('opens streaming reasoning activity by default and keeps completed tool activity collapsed', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-live-activity',
          role: 'assistant',
          content: '',
          reasoning: '正在分析。',
          blocks: [
            {
              id: 'reasoning-live',
              kind: 'reasoning',
              content: '正在分析。',
              isStreaming: true
            },
            {
              id: 'tool-live',
              kind: 'tool_call',
              name: 'web_search',
              status: 'start',
              input: { query: 'Roc' },
              output: null,
              error: null
            }
          ],
          approval: null,
          isStreaming: true
        }
      })
    );

    expect(html).toMatch(/data-testid="chat-activity-reasoning" open="">/);
    expect(html).toMatch(/data-testid="chat-activity-tool"(?! open)/);
  });

  it('opens tool errors by default while completed tool output stays collapsed', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-tool-error',
          role: 'assistant',
          content: '',
          reasoning: null,
          blocks: [
            {
              id: 'tool-complete',
              kind: 'tool_call',
              name: 'read_file',
              status: 'end',
              input: { path: 'README.md' },
              output: 'file body',
              error: null
            },
            {
              id: 'tool-error',
              kind: 'tool_call',
              name: 'write_file',
              status: 'error',
              input: { path: 'blocked.txt' },
              output: null,
              error: 'permission denied'
            }
          ],
          approval: null,
          isStreaming: false
        }
      })
    );

    expect(html).toMatch(/tool-call-card--end" data-testid="chat-activity-tool"(?! open)/);
    expect(html).toMatch(/tool-call-card--error" data-testid="chat-activity-tool" open="">/);
  });

  it('renders an approval card with tool details and allowed decisions', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-approval',
          role: 'assistant',
          content: '',
          reasoning: '需要你确认这一步。',
          blocks: [],
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

  it('renders the task approval card for background task updates', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-task-approval',
          role: 'assistant',
          content: '',
          reasoning: null,
          blocks: [],
          approval: {
            interruptId: 'interrupt-task-1',
            actionRequests: [
              {
                name: 'update_background_task',
                args: {
                  taskId: 'background-1',
                  patch: {
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
                  },
                  reason: '调整调度'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'update_background_task',
                allowedDecisions: ['approve', 'edit', 'reject']
              }
            ]
          },
          isStreaming: false
        }
      })
    );

    expect(html).toContain('data-testid="task-approval-card"');
    expect(html).toContain('修改任务');
    expect(html).toContain('批准修改');
    expect(html).toContain('编辑后批准');
    expect(html).toContain('每天检查测试状态');
  });

  it('uses the generic approval card when a direct creation payload appears in an approval bundle', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-mixed-task-approval',
          role: 'assistant',
          content: '',
          reasoning: null,
          blocks: [],
          approval: {
            interruptId: 'interrupt-mixed-task',
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
              },
              {
                name: 'execute',
                args: {
                  command: 'pnpm test'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'propose_background_task',
                allowedDecisions: ['approve', 'edit', 'reject']
              },
              {
                actionName: 'execute',
                allowedDecisions: ['approve', 'reject']
              }
            ]
          },
          isStreaming: false
        }
      })
    );

    expect(html).toContain('data-testid="chat-approval-card"');
    expect(html).not.toContain('data-testid="task-approval-card"');
    expect(html).toContain('data-testid="chat-approval-tool-name">propose_background_task<');
    expect(html).toContain('data-testid="chat-approval-tool-name">execute<');
    expect(html).toContain('chat-approval-count">2</span>');
  });
});
