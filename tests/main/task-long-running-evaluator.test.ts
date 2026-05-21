import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { ConfigService } from '../../src/main/services/config-service';
import type { EnabledCapabilities, TaskRun, TaskThread } from '../../src/shared/types';

type TaskPromotionApi = AppServices['taskService'] & {
  createTaskRun(input: {
    userInput: string;
    modelId: string;
    enabledCapabilities: EnabledCapabilities;
    threadId?: string;
  }): TaskRun;
  evaluateLongRunningPromotion: (threadId: string) => TaskThread;
};

const emptyCapabilities: EnabledCapabilities = {
  mcpServers: [],
  skills: []
};

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-task-long-running-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('TaskService long-running promotion', () => {
  it('promotes a chat thread after tool calls exceed the configured threshold', () => {
    const taskService = services.taskService as TaskPromotionApi;
    const run = taskService.createTaskRun({
      userInput: '持续执行一组工具调用',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });

    for (let index = 0; index < 9; index += 1) {
      taskService.recordEvent({
        threadId: run.threadId,
        runId: run.id,
        type: 'tool_call',
        payload: {
          toolName: `tool-${index}`
        }
      });
    }

    const promoted = taskService.evaluateLongRunningPromotion(run.threadId);
    const threadRow = services.databaseService.db
      .prepare('SELECT kind FROM task_threads WHERE id = ?')
      .get(run.threadId) as { kind: TaskThread['kind'] };
    const promotionEvent = services.databaseService.db
      .prepare(
        `SELECT payload_json
         FROM task_events
         WHERE thread_id = ? AND type = 'long_running_promoted'
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(run.threadId) as { payload_json: string } | undefined;

    expect(promoted.kind).toBe('long_running');
    expect(threadRow.kind).toBe('long_running');
    expect(promotionEvent).toBeDefined();
    expect(JSON.parse(promotionEvent?.payload_json ?? '{}')).toEqual({
      reason: 'tool_calls_exceeded',
      threshold: 8,
      observedValue: 9
    });
  });

  it('uses live task thresholds from ConfigService instead of hardcoded defaults', () => {
    const taskService = services.taskService as TaskPromotionApi;
    const configSpy = vi
      .spyOn(
        services.configService as ConfigService & {
          getTaskSettings: () => {
            longRunningThresholds: { runningSeconds: number; toolCallCount: number; subagentCount: number };
            scheduler: { catchUpOnStartup: boolean; maxRegisteredTasks: number };
          };
        },
        'getTaskSettings'
      )
      .mockReturnValue({
        longRunningThresholds: {
          runningSeconds: 90,
          toolCallCount: 1,
          subagentCount: 1
        },
        scheduler: {
          catchUpOnStartup: true,
          maxRegisteredTasks: 256
        }
      });
    const run = taskService.createTaskRun({
      userInput: '按配置阈值晋升',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });
    taskService.recordEvent({
      threadId: run.threadId,
      runId: run.id,
      type: 'tool_call',
      payload: {
        toolName: 'single-tool'
      }
    });
    taskService.recordEvent({
      threadId: run.threadId,
      runId: run.id,
      type: 'tool_call',
      payload: {
        toolName: 'second-tool'
      }
    });

    const promoted = taskService.evaluateLongRunningPromotion(run.threadId);

    expect(configSpy).toHaveBeenCalled();
    expect(promoted.kind).toBe('long_running');
  });

  it('promotes immediately when a subagent is spawned', () => {
    const taskService = services.taskService as TaskPromotionApi;
    const run = taskService.createTaskRun({
      userInput: '派生子代理',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });
    taskService.recordEvent({
      threadId: run.threadId,
      runId: run.id,
      type: 'subagent_started',
      payload: {
        subagentId: 'research'
      }
    });

    const promoted = taskService.evaluateLongRunningPromotion(run.threadId);

    expect(promoted.kind).toBe('long_running');
    expect(lastPromotionPayload(run.threadId)).toEqual({
      reason: 'subagent_spawned',
      threshold: 1,
      observedValue: 1
    });
  });

  it('promotes immediately when a run waits for user approval', () => {
    const taskService = services.taskService as TaskPromotionApi;
    const run = taskService.createTaskRun({
      userInput: '等待审批',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });
    taskService.markRunWaitingUser(run.id);

    const promoted = taskService.evaluateLongRunningPromotion(run.threadId);

    expect(promoted.kind).toBe('long_running');
    expect(lastPromotionPayload(run.threadId)).toEqual({
      reason: 'approval_waiting',
      threshold: null,
      observedValue: null
    });
  });

  it('promotes after a run stays running beyond the configured seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T00:00:00.000Z'));
    const taskService = services.taskService as TaskPromotionApi;
    const run = taskService.createTaskRun({
      userInput: '长时间运行',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });
    taskService.markRunRunning(run.id);

    vi.setSystemTime(new Date('2026-05-21T00:01:31.000Z'));
    const promoted = taskService.evaluateLongRunningPromotion(run.threadId);

    expect(promoted.kind).toBe('long_running');
    expect(lastPromotionPayload(run.threadId)).toEqual({
      reason: 'running_over_90s',
      threshold: 90,
      observedValue: 91
    });
    vi.useRealTimers();
  });

  it('does not write duplicate promotion events after a thread is already promoted', () => {
    const taskService = services.taskService as TaskPromotionApi;
    const run = taskService.createTaskRun({
      userInput: '幂等晋升',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });
    for (let index = 0; index < 9; index += 1) {
      taskService.recordEvent({
        threadId: run.threadId,
        runId: run.id,
        type: 'tool_call',
        payload: {
          toolName: `tool-${index}`
        }
      });
    }

    taskService.evaluateLongRunningPromotion(run.threadId);
    taskService.evaluateLongRunningPromotion(run.threadId);

    expect(countPromotionEvents(run.threadId)).toBe(1);
  });

  it('does not promote a completed chat thread', () => {
    const taskService = services.taskService as TaskPromotionApi;
    const run = taskService.createTaskRun({
      userInput: '已经完成',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });
    for (let index = 0; index < 9; index += 1) {
      taskService.recordEvent({
        threadId: run.threadId,
        runId: run.id,
        type: 'tool_call',
        payload: {
          toolName: `tool-${index}`
        }
      });
    }
    taskService.completeRunWithProviderResult({
      runId: run.id,
      result: {
        providerId: 'provider-alpha',
        modelId: 'model-alpha',
        createdAt: '2026-05-21T00:00:00.000Z',
        durationMs: 10,
        assistantMessage: '完成',
        summary: '完成',
        finishReason: 'stop',
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          cacheReadTokens: 0,
          promptCharacters: 4,
          completionCharacters: 2
        }
      }
    });

    const thread = taskService.evaluateLongRunningPromotion(run.threadId);

    expect(thread.kind).toBe('chat');
    expect(countPromotionEvents(run.threadId)).toBe(0);
  });
});

function lastPromotionPayload(threadId: string): unknown {
  const row = services.databaseService.db
    .prepare(
      `SELECT payload_json
       FROM task_events
       WHERE thread_id = ? AND type = 'long_running_promoted'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(threadId) as { payload_json: string } | undefined;
  return JSON.parse(row?.payload_json ?? '{}') as unknown;
}

function countPromotionEvents(threadId: string): number {
  const row = services.databaseService.db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM task_events
       WHERE thread_id = ? AND type = 'long_running_promoted'`
    )
    .get(threadId) as { count: number };
  return row.count;
}
