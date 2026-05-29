import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-open-background-task-chat-'));
  services = createAppServices(root);
  services.appService.initializeCritical();
});

afterEach(() => {
  services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('TaskService.openBackgroundTaskInChat', () => {
  it('不再向 pendingThreadContexts 预注入 task JSON', () => {
    const preview = services.taskService.createBackgroundTaskPreview({
      goal: '修改每天检查项目测试状态',
      trigger: {
        type: 'manual',
        description: '手动触发'
      },
      workspacePath: root,
      allowedActions: ['pnpm test'],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = services.taskService.createBackgroundTask(preview);

    const opened = services.taskService.openBackgroundTaskInChat(task.id);
    const messages = services.taskService.listThreadMessages(task.threadId);

    expect(opened).toEqual({
      threadId: task.threadId
    });
    expect(services.taskService.takePendingThreadContext(task.threadId)).toBeNull();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          payload: {
            role: 'system',
            content: `[系统] 用户准备修改后台任务 ${task.id}。`
          }
        })
      ])
    );
    expect(JSON.stringify(messages)).not.toContain('"goal":');
  });
});
