import { describe, expect, it } from 'vitest';
import {
  buildBackgroundTaskPreviewRequest,
  buildTaskApprovalEditDecision,
  createTaskFormDraft
} from '../../src/renderer/views/tasks/task-form-model';

describe('task form model', () => {
  it('builds an approval edit preview request from the draft fields', () => {
    const request = buildBackgroundTaskPreviewRequest({
      goal: '每天检查测试',
      triggerType: 'cron',
      triggerDescription: '每天 09:00',
      nextRunAt: '2026-05-22T09:00',
      cronExpression: '0 9 * * *',
      workspacePath: 'F:\\Code\\Roc',
      allowedActionsText: 'pnpm test\npnpm lint',
      forbiddenActionsText: 'git push',
      reason: ''
    });

    expect(request).toEqual({
      goal: '每天检查测试',
      trigger: {
        type: 'cron',
        description: '每天 09:00',
        cronExpression: '0 9 * * *',
        nextRunAt: expect.stringContaining('2026-05-22T01:00:00.000Z')
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: ['pnpm test', 'pnpm lint'],
      forbiddenActions: ['git push'],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
  });

  it('builds an edited update_background_task decision with the same tool name', () => {
    const draft = createTaskFormDraft({
      goal: '编辑后的任务',
      trigger: {
        type: 'manual',
        description: '手动'
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: ['pnpm test'],
      forbiddenActions: [],
      reason: '改目标'
    });

    const decision = buildTaskApprovalEditDecision({
      approval: {
        kind: 'approval',
        interruptId: 'interrupt-1',
        actionRequests: [
          {
            name: 'update_background_task',
            args: {
              taskId: 'task-1',
              patch: {},
              reason: '原始原因'
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
      draft
    });

    expect(decision).toEqual({
      type: 'edit',
      editedAction: {
        name: 'update_background_task',
        args: {
          taskId: 'task-1',
          patch: {
            goal: '编辑后的任务',
            trigger: {
              type: 'manual',
              description: '手动'
            },
            workspacePath: 'F:\\Code\\Roc',
            allowedActions: ['pnpm test'],
            forbiddenActions: [],
            failurePolicy: 'pause_and_report',
            notificationPolicy: 'failures_and_confirmations'
          },
          reason: '改目标'
        }
      }
    });
  });
});
