import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../../../src/main/services/app-service';
import { createReadBackgroundTaskTool } from '../../../../src/main/services/deep-agent/tools';
import { RocToolResolutionError } from '../../../../src/main/services/forge-guardrails';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-read-background-task-tool-'));
  services = createAppServices(root);
  services.appService.initializeCritical();
});

afterEach(() => {
  services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('read_background_task tool', () => {
  it('返回完整 task JSON', async () => {
    const preview = services.taskService.createBackgroundTaskPreview({
      goal: '读取任务定义',
      trigger: {
        type: 'manual',
        description: '手动触发'
      },
      workspacePath: root,
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = services.taskService.createBackgroundTask(preview);
    const tool = createReadBackgroundTaskTool(services.taskService);

    const result = JSON.parse(await tool.invoke({ taskId: task.id }));

    expect(result).toEqual(task);
  });

  it('找不到 taskId 抛 RocToolResolutionError', async () => {
    const tool = createReadBackgroundTaskTool(services.taskService);

    await expect(tool.invoke({ taskId: 'background_missing' })).rejects.toThrow(RocToolResolutionError);
  });
});
