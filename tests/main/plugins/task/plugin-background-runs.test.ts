import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocEventEnvelope, RocPluginContext } from '../../../../src/main/kernel/types';
import { createTaskPlugin } from '../../../../src/main/plugins/task';
import type {
  BackgroundTask,
  BackgroundTaskPreviewRequest,
  ChatStartRunRequest,
  ChatStartRunResult,
  TaskDetail
} from '../../../../src/shared/types';

let db: Database.Database;

const previewRequest: BackgroundTaskPreviewRequest = {
  goal: 'Review plugin state',
  trigger: {
    type: 'manual',
    description: 'Manual'
  },
  workspacePath: 'F:\\Code\\Roc',
  allowedActions: [],
  forbiddenActions: [],
  failurePolicy: 'pause_and_report',
  notificationPolicy: 'failures_and_confirmations'
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});


describe('task plugin', () => {
  it('runs background tasks in their existing thread and waits for completion before marking success', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    const startRequests: ChatStartRunRequest[] = [];
    registerAgentRunStart(capabilities, eventBus, startRequests);
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus }));
    const preview = await capabilities.invoke<BackgroundTaskPreviewRequest, unknown>('task.background.preview', previewRequest);
    const task = await capabilities.invoke<unknown, BackgroundTask>('task.background.create', preview);

    const runNow = await capabilities.invoke<{ id: string }, { taskId: string; runId: string }>('task.background.runNow', {
      id: task.id
    });
    const detailWhileRunning = await capabilities.invoke<{ taskId: string }, TaskDetail>('task.detail.get', { taskId: task.id });
    if (detailWhileRunning.backgroundTask === null) {
      throw new Error('expected_background_task_detail');
    }

    expect(startRequests).toContainEqual(expect.objectContaining({ taskSource: 'workbench', threadId: task.threadId }));
    expect(detailWhileRunning.backgroundTask.lastRunStatus).toBeNull();
    expect(detailWhileRunning.runHistory[0]).toMatchObject({
      id: runNow.runId,
      threadId: task.threadId,
      status: 'running'
    });

    await eventBus.publish({
      type: 'agent.run.completed',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:02.000Z',
      payload: {
        runId: runNow.runId,
        threadId: task.threadId,
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        finishReason: 'stop',
        durationMs: 42,
        summary: 'Manual run completed.',
        assistantMessage: 'Manual run completed.'
      }
    });

    const detailAfterCompletion = await capabilities.invoke<{ taskId: string }, TaskDetail>('task.detail.get', { taskId: task.id });
    if (detailAfterCompletion.backgroundTask === null) {
      throw new Error('expected_background_task_detail');
    }
    expect(detailAfterCompletion.backgroundTask.lastRunStatus).toBe('success');
    expect(detailAfterCompletion.runHistory[0]).toMatchObject({
      id: runNow.runId,
      threadId: task.threadId,
      status: 'completed'
    });
  });


  it('pauses background tasks after failed agent runs and records the failure status', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    const startRequests: ChatStartRunRequest[] = [];
    registerAgentRunStart(capabilities, eventBus, startRequests);
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus }));
    const preview = await capabilities.invoke<BackgroundTaskPreviewRequest, unknown>('task.background.preview', previewRequest);
    const task = await capabilities.invoke<unknown, BackgroundTask>('task.background.create', preview);

    const runNow = await capabilities.invoke<{ id: string }, { taskId: string; runId: string }>('task.background.runNow', {
      id: task.id
    });
    await eventBus.publish({
      type: 'agent.run.failed',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:02.000Z',
      payload: {
        runId: runNow.runId,
        threadId: task.threadId,
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        error: 'provider_unavailable',
        code: 'agent_run_failed',
        retryable: true
      }
    });

    const detailAfterFailure = await capabilities.invoke<{ taskId: string }, TaskDetail>('task.detail.get', { taskId: task.id });
    if (detailAfterFailure.backgroundTask === null) {
      throw new Error('expected_background_task_detail');
    }

    expect(startRequests).toContainEqual(expect.objectContaining({ taskSource: 'workbench', threadId: task.threadId }));
    expect(detailAfterFailure.backgroundTask.status).toBe('paused');
    expect(detailAfterFailure.backgroundTask.lastRunStatus).toBe('failed');
    expect(detailAfterFailure.runHistory[0]).toMatchObject({
      id: runNow.runId,
      threadId: task.threadId,
      status: 'failed'
    });
    expect(detailAfterFailure.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: runNow.runId,
        threadId: task.threadId,
        type: 'background_task_paused',
        payload: {
          taskId: task.id,
          status: 'paused'
        }
      })
    );
  });

  it('keeps background runs active during agent recovery and preserves saved run context', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    const startRequests: ChatStartRunRequest[] = [];
    registerAgentRunStart(capabilities, eventBus, startRequests);
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus }));
    const preview = await capabilities.invoke<BackgroundTaskPreviewRequest, unknown>('task.background.preview', {
      ...previewRequest,
      enabledCapabilities: {
        mcpServers: ['filesystem'],
        skills: ['typescript']
      }
    });
    const task = await capabilities.invoke<unknown, BackgroundTask>('task.background.create', preview);

    const runNow = await capabilities.invoke<{ id: string }, { taskId: string; runId: string }>('task.background.runNow', {
      id: task.id
    });
    await eventBus.publish({
      type: 'agent.chat.run-event',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:02.000Z',
      payload: {
        type: 'run_recovering',
        runId: runNow.runId,
        threadId: task.threadId,
        code: 'provider_network_error',
        message: 'Connection error.',
        attempt: 1,
        nextRetryAt: '2026-06-04T00:00:03.000Z'
      }
    });
    await eventBus.publish({
      type: 'agent.chat.run-event',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:03.000Z',
      payload: {
        type: 'run_recovered',
        runId: runNow.runId,
        threadId: task.threadId,
        attempt: 1,
        recoveredAt: '2026-06-04T00:00:04.000Z'
      }
    });

    const detailDuringRecovery = await capabilities.invoke<{ taskId: string }, TaskDetail>('task.detail.get', { taskId: task.id });
    if (detailDuringRecovery.backgroundTask === null) {
      throw new Error('expected_background_task_detail');
    }

    expect(startRequests[0]).toMatchObject({
      enabledCapabilities: {
        mcpServers: ['filesystem'],
        skills: ['typescript']
      },
      taskSource: 'workbench',
      threadId: task.threadId,
      workspacePath: 'F:\\Code\\Roc'
    });
    expect(detailDuringRecovery.backgroundTask.lastRunStatus).toBeNull();
    expect(detailDuringRecovery.runHistory[0]).toMatchObject({
      id: runNow.runId,
      status: 'running'
    });

    await eventBus.publish({
      type: 'agent.run.completed',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:05.000Z',
      payload: {
        runId: runNow.runId,
        threadId: task.threadId,
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        finishReason: 'stop',
        durationMs: 42,
        summary: 'Recovered run completed.',
        assistantMessage: 'Recovered run completed.'
      }
    });

    const detailAfterCompletion = await capabilities.invoke<{ taskId: string }, TaskDetail>('task.detail.get', { taskId: task.id });
    if (detailAfterCompletion.backgroundTask === null) {
      throw new Error('expected_background_task_detail');
    }

    expect(detailAfterCompletion.backgroundTask.lastRunStatus).toBe('success');
    expect(detailAfterCompletion.runHistory[0]).toMatchObject({
      id: runNow.runId,
      status: 'completed'
    });
  });

});

function registerAgentRunStart(
  capabilities: CapabilityRegistry,
  eventBus: RocEventBus,
  requests: ChatStartRunRequest[]
): void {
  const descriptor = {
    name: 'agent.run.start',
    version: '1.0.0',
    inputSchema: z.custom<ChatStartRunRequest>(),
    outputSchema: z.custom<ChatStartRunResult>()
  };
  capabilities.declare('@roc/plugin-agent', descriptor);
  capabilities.register('@roc/plugin-agent', descriptor, async (requestInput) => {
    const request = requestInput as ChatStartRunRequest;
    requests.push(request);
    const result = {
      runId: 'run_manual_now_1',
      mode: 'task',
      threadId: request.threadId ?? null,
      providerId: 'smoke-provider',
      modelId: 'smoke-model',
      createdAt: '2026-06-04T00:00:01.000Z'
    } satisfies ChatStartRunResult;
    await eventBus.publish({
      type: 'agent.run.started',
      source: '@roc/plugin-agent',
      createdAt: result.createdAt,
      payload: {
        ...result,
        userInput: request.input,
        enabledCapabilities: request.enabledCapabilities,
        workflowHint: request.workflowHint ?? null
      }
    });
    return {
      ...result
    };
  });
}

function createContext(input: { capabilities: CapabilityRegistry; eventBus: RocEventBus }): RocPluginContext {
  return {
    pluginId: '@roc/plugin-task',
    eventBus: input.eventBus,
    capabilities: input.capabilities,
    database: { getConnection: () => db, getCoreConnection: () => db },
    config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  };
}

function createTestEventBus(): RocEventBus & { published: RocEventEnvelope[] } {
  const subscriptions: Array<{
    type: string;
    handler: (event: RocEventEnvelope) => void | Promise<void>;
  }> = [];
  return {
    published: [],
    publish: async function publish(event) {
      this.published.push(event);
      for (const subscription of subscriptions.filter((item) => item.type === event.type)) {
        await subscription.handler(event);
      }
    },
    subscribe: (type, handler) => {
      const subscription = {
        type,
        handler: handler as (event: RocEventEnvelope) => void | Promise<void>
      };
      subscriptions.push(subscription);
      return () => {
        const index = subscriptions.indexOf(subscription);
        if (index !== -1) {
          subscriptions.splice(index, 1);
        }
      };
    }
  };
}

