import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskApprovalCard } from '../../src/renderer/views/tasks/TaskApprovalCard';

describe('TaskApprovalCard', () => {
  it('renders the task update approval summary card', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskApprovalCard, {
        approval: {
          interruptId: 'interrupt-1',
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
        onApprovalDecision: () => {}
      })
    );

    expect(html).toContain('data-testid="task-approval-card"');
    expect(html).toContain('修改任务');
    expect(html).toContain('批准修改');
    expect(html).toContain('编辑后批准');
    expect(html).toContain('每天检查测试状态');
  });
});
