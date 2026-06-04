import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-promotion-removed-'));
  services = createAppServices(root);
  services.appService.initializeCritical();
});

afterEach(async () => {
  await services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('task-service 自动促升已移除', () => {
  it('TaskService 不暴露 evaluateLongRunningPromotion / promoteThread', () => {
    expect((services.taskService as unknown as Record<string, unknown>).evaluateLongRunningPromotion).toBeUndefined();
    expect((services.taskService as unknown as Record<string, unknown>).promoteThread).toBeUndefined();
  });

  it('普通 chat thread 写入大量 tool_call 事件后 kind 仍为 chat', () => {
    const run = services.taskService.createTaskRun({
      userInput: '帮我搜索 LangGraph 文档',
      modelId: 'opus-4-7',
      enabledCapabilities: { mcpServers: [], skills: [] }
    });
    services.taskService.markRunRunning(run.id);
    for (let index = 0; index < 100; index += 1) {
      services.taskService.recordEvents([
        {
          threadId: run.threadId,
          runId: run.id,
          type: 'tool_call',
          payload: { toolName: 'web_read', index }
        }
      ]);
    }
    const thread = services.databaseService.db
      .prepare('SELECT kind FROM task_threads WHERE id = ?')
      .get(run.threadId) as { kind: string };
    expect(thread.kind).toBe('chat');
  });
});
