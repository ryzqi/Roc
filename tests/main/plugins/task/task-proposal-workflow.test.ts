import { describe, expect, it } from 'vitest';

import {
  createTaskProposalWorkflow,
  normalizeBackgroundTaskProposalGoal
} from '../../../../src/main/plugins/task/task-proposal-workflow';
import type { RocPluginContext } from '../../../../src/main/kernel/types';
import type { BackgroundTask, BackgroundTaskPreview, BackgroundTaskPreviewRequest, TaskEvent } from '../../../../src/shared/types';

describe('task proposal workflow', () => {
  it('creates a scheduled background task through task capabilities and records tool calls', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const events: Array<{ type: TaskEvent['type']; payload: Record<string, unknown> }> = [];
    const workflow = createTaskProposalWorkflow(createContext(calls));

    const result = await workflow({
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      input: '每天 09:00 检查测试失败，使用当前工作区。',
      recordTaskEvent: async (type, payload) => {
        events.push({ type, payload });
      },
      runId: 'run_1',
      threadId: 'thread_1'
    });

    expect(calls.map((call) => call.name)).toEqual([
      'workspace.getCurrent',
      'task.background.preview',
      'task.background.create'
    ]);
    expect(calls[1]?.input).toMatchObject({
      goal: '每天 09:00 检查测试失败',
      trigger: {
        type: 'cron',
        description: '每天 09:00',
        cronExpression: '0 9 * * *'
      },
      workspacePath: 'F:\\Code\\Roc'
    });
    expect(events.map((event) => [event.payload.name, event.payload.status])).toEqual([
      ['resolve_background_task_time', 'start'],
      ['resolve_background_task_time', 'end'],
      ['propose_background_task', 'start'],
      ['propose_background_task', 'end'],
      ['schedule_background_task', 'start'],
      ['schedule_background_task', 'end']
    ]);
    expect(result).toEqual({
      assistantMessage: '后台任务已创建：每天 09:00 检查测试失败',
      summary: '后台任务已创建：每天 09:00 检查测试失败'
    });
  });

  it('normalizes the current-workspace suffix without changing the task goal', () => {
    expect(normalizeBackgroundTaskProposalGoal('每天 09:00 检查测试失败，使用当前工作区。')).toBe('每天 09:00 检查测试失败');
    expect(normalizeBackgroundTaskProposalGoal('每周一 10:00 汇总周报')).toBe('每周一 10:00 汇总周报');
  });
});

function createContext(calls: Array<{ name: string; input: unknown }>): RocPluginContext {
  return {
    pluginId: '@roc/plugin-agent',
    eventBus: {
      publish: async () => {},
      subscribe: () => () => {}
    },
    capabilities: {
      invoke: async <TInput, TOutput>(name: string, input: TInput): Promise<TOutput> => {
        calls.push({ name, input });
        let result: unknown;
        if (name === 'workspace.getCurrent') {
          result = {
            id: 'workspace_1',
            path: 'F:\\Code\\Roc',
            displayName: 'Roc',
            lastOpenedAt: '2026-06-04T00:00:00.000Z',
            trustState: 'trusted'
          };
          return result as TOutput;
        }
        if (name === 'task.background.preview') {
          const request = input as BackgroundTaskPreviewRequest;
          result = {
            ...request,
            scheduled: request.trigger.type !== 'manual',
            nextRunAt: request.trigger.type === 'cron' || request.trigger.type === 'once' ? request.trigger.nextRunAt : null,
            cronExpression: request.trigger.type === 'cron' ? request.trigger.cronExpression : null,
            riskLevel: 'low',
            requiresConfirmation: false,
            enabledCapabilities: request.enabledCapabilities === undefined ? null : request.enabledCapabilities
          } satisfies BackgroundTaskPreview;
          return result as TOutput;
        }
        if (name === 'task.background.create') {
          const preview = input as BackgroundTaskPreview;
          result = {
            id: 'background_1',
            threadId: 'thread_background_1',
            runId: 'run_background_1',
            goal: preview.goal,
            status: 'running',
            scheduled: preview.scheduled,
            triggerType: preview.trigger.type,
            triggerDescription: preview.trigger.description,
            nextRunAt: preview.nextRunAt,
            cronExpression: preview.cronExpression,
            workspacePath: preview.workspacePath,
            allowedActions: preview.allowedActions,
            forbiddenActions: preview.forbiddenActions,
            failurePolicy: preview.failurePolicy,
            notificationPolicy: preview.notificationPolicy,
            riskLevel: preview.riskLevel,
            requiresConfirmation: preview.requiresConfirmation,
            lastRunAt: null,
            lastRunStatus: null,
            runCount: 0,
            createdAt: '2026-06-04T00:00:00.000Z',
            updatedAt: '2026-06-04T00:00:00.000Z',
            enabledCapabilities: preview.enabledCapabilities
          } satisfies BackgroundTask;
          return result as TOutput;
        }
        throw new Error(`unexpected_capability:${name}`);
      },
      declare: () => {},
      list: () => [],
      register: () => {}
    },
    config: { get: () => null, set: () => {} },
    database: { getConnection: () => null as never },
    logger: { error: () => {}, info: () => {}, warn: () => {} },
    secrets: { clear: () => {}, get: () => null, set: () => {} }
  };
}
