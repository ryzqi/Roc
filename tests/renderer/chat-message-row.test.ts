import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMessageRow } from '../../src/renderer/chat/chat-message-row';
import { StreamingMarkdownView } from '../../src/renderer/chat/streaming-markdown-view';

describe('chat message row', () => {
  it('uses a streaming Markdown boundary while assistant content is flowing', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamingMarkdownView, {
        text: '**hi**',
        isStreaming: true
      })
    );

    expect(html).toContain('data-testid="streaming-markdown"');
  });

  it('renders completed reasoning as a collapsed details block without timeline or Markdown conversion', () => {
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
    expect(html).toMatch(/<details class="chat-bubble-reasoning" data-activity-id="assistant-1-reasoning" data-testid="chat-activity-reasoning">/);
    expect(html).toContain('<summary><span>已思考</span></summary>');
    expect(html).not.toContain('推理 · 3 步');
    expect(html).toContain('<p>第一段</p>');
    expect(html).toContain('<p>- 列表项</p>');
    expect(html).not.toContain('<ul>');
    expect(html).not.toContain('<code class="hljs language-ts">');
    expect(html).not.toContain('step-marker');
    expect(html).toContain('aria-label="复制回答"');
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
                name: 'run_shell_command',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'run_shell_command',
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
      /data-testid="chat-assistant-content"[\s\S]*data-testid="chat-activity-reasoning"[\s\S]*data-testid="streaming-markdown"[\s\S]*data-testid="chat-approval-card"[\s\S]*class="chat-typing-cursor"/
    );
    expect(html).not.toContain('aria-label="复制回答"');
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
    expect(html).toContain('read_file');
    expect(html).toContain('成功');
    expect(html).toContain('&quot;path&quot;');
    expect(html).toContain('F:\\\\Code\\\\Roc\\\\README.md');
    expect(html).toMatch(/data-testid="chat-activity-tool"[\s\S]*<summary/);
    expect(html).toMatch(/data-testid="chat-activity-tool"[\s\S]*<pre/);
    expect(html).toMatch(/data-testid="chat-activity-tool"[\s\S]*最终答案/);
    expect(html).toContain('<ul>');
  });

  it('renders failed subagent work cards open with status, meta, nested children, and no task summary', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-subagent',
          role: 'assistant',
          content: '',
          reasoning: null,
          approval: null,
          isStreaming: false,
          blocks: [
            {
              id: 'subagent-root',
              kind: 'subagent',
              identity: {
                subagentId: 'subagent-root',
                parentSubagentId: null,
                name: 'general-purpose',
                depth: 0,
                path: ['general-purpose#0'],
                execution: 'async',
                taskInput: 'Search docs and do not show this text',
                asyncTaskId: 'async-1'
              },
              status: 'failed',
              summary: '已完成部分调查。',
              error: 'remote failed',
              blocks: [
                {
                  id: 'subagent-root-text',
                  kind: 'text',
                  content: 'partial'
                },
                {
                  id: 'subagent-root-reasoning',
                  kind: 'reasoning',
                  content: '检查上下文',
                  isStreaming: false
                },
                {
                  id: 'subagent-root-tool',
                  kind: 'tool_call',
                  name: 'read_file',
                  status: 'end',
                  input: { path: 'F:\\Code\\Roc\\README.md' },
                  output: { bytes: 128 },
                  error: null
                }
              ],
              children: [
                {
                  id: 'subagent-child',
                  kind: 'subagent',
                  identity: {
                    subagentId: 'subagent-child',
                    parentSubagentId: 'subagent-root',
                    name: 'research',
                    depth: 1,
                    path: ['general-purpose#0', 'research#0'],
                    execution: 'sync',
                    taskInput: 'Nested task input should also stay hidden'
                  },
                  status: 'completed',
                  summary: '子任务完成。',
                  error: null,
                  blocks: [],
                  children: []
                }
              ]
            }
          ]
        }
      })
    );

    expect(html).toContain('data-testid=\"chat-activity-subagent\"');
    expect(html).toMatch(/data-testid=\"chat-activity-subagent\"[^>]*open=\"\">/);
    expect(html).toContain('Subagent · general-purpose');
    expect(html).toContain('失败');
    expect(html).toContain('async');
    expect(html).toContain('1 tool');
    expect(html).toContain('1 child');
    expect(html).toContain('reasoning');
    expect(html).toContain('remote failed');
    expect(html).toContain('已完成部分调查。');
    expect(html).toContain('partial');
    expect(html).toContain('read_file');
    expect(html).toContain('data-testid=\"chat-activity-subagent-child\"');
    expect(html).toContain('Subagent · research');
    expect(html).toContain('完成');
    expect(html).not.toContain('Search docs and do not show this text');
    expect(html).not.toContain('Nested task input should also stay hidden');
  });

  it('keeps non-failed subagent work cards collapsed by default', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-subagent-running',
          role: 'assistant',
          content: '',
          reasoning: null,
          approval: null,
          isStreaming: true,
          blocks: [
            {
              id: 'subagent-running',
              kind: 'subagent',
              identity: {
                subagentId: 'subagent-running',
                parentSubagentId: null,
                name: 'research',
                depth: 0,
                path: ['research#0'],
                execution: 'sync',
                taskInput: null
              },
              status: 'running',
              summary: null,
              error: null,
              blocks: [],
              children: []
            },
            {
              id: 'subagent-completed',
              kind: 'subagent',
              identity: {
                subagentId: 'subagent-completed',
                parentSubagentId: null,
                name: 'reviewer',
                depth: 0,
                path: ['reviewer#0'],
                execution: 'async',
                taskInput: null
              },
              status: 'completed',
              summary: '复核完成。',
              error: null,
              blocks: [],
              children: []
            }
          ]
        }
      })
    );

    expect(html).toContain('data-testid=\"chat-activity-subagent\"');
    expect(html.match(/data-testid=\"chat-activity-subagent\"/g)).toHaveLength(2);
    expect(html).toMatch(/subagent-card--running\" data-testid=\"chat-activity-subagent\"(?![^>]*open)/);
    expect(html).toMatch(/subagent-card--completed\" data-testid=\"chat-activity-subagent\"(?![^>]*open)/);
    expect(html).toContain('Subagent · research');
    expect(html).toContain('运行中');
    expect(html).toContain('sync');
    expect(html).toContain('Subagent · reviewer');
    expect(html).toContain('完成');
    expect(html).toContain('async');
  });

  it('keeps subagent styling flat without gradient decoration', () => {
    const css = readFileSync('src/renderer/styles/subagent.css', 'utf8');

    expect(css).not.toMatch(/linear-gradient|radial-gradient|gradient/);
  });

  it('opens streaming reasoning activity by default while completed tool activity stays collapsed', () => {
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

    expect(html).toContain('data-testid="chat-activity-reasoning"');
    expect(html).toMatch(/data-testid="chat-activity-reasoning" open="">/);
    expect(html).toContain('<summary><span>思考中</span></summary>');
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

    expect(html).toMatch(/tool-call-modern--end" data-testid="chat-activity-tool"(?! open)/);
    expect(html).toMatch(/tool-call-modern--error" data-testid="chat-activity-tool" open="">/);
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
                name: 'run_shell_command',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'run_shell_command',
                allowedDecisions: ['approve', 'edit', 'reject']
              }
            ]
          },
          isStreaming: false
        }
      })
    );

    expect(html).toContain('data-testid="chat-approval-card"');
    expect(html).toContain('data-testid="chat-approval-tool-name">run_shell_command<');
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
                name: 'run_shell_command',
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
                actionName: 'run_shell_command',
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
    expect(html).toContain('data-testid="chat-approval-tool-name">run_shell_command<');
    expect(html).toContain('chat-approval-count">2</span>');
  });
});
