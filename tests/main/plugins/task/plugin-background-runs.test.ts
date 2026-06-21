import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocEventEnvelope, RocPluginContext } from '../../../../src/main/kernel/types';
import { createTaskPlugin } from '../../../../src/main/plugins/task';
import type {
  ActiveTaskItem,
  BackgroundTask,
  BackgroundTaskPreviewRequest,
  ChatStartRunRequest,
  ChatStartRunResult,
  TaskDetail,
  TaskEvent,
  TaskSnapshot,
  Workspace
} from '../../../../src/shared/types';

const taskCapabilities = [
  'task.snapshot.get',
  'task.background.preview',
  'task.background.create',
  'task.background.update',
  'task.background.runNow',
  'task.background.pause',
  'task.background.resume',
  'task.background.cancel',
  'task.background.delete',
  'task.scheduler.status',
  'task.scheduler.suspend',
  'task.scheduler.resume',
  'task.scheduler.handlePowerResume',
  'task.background.summary',
  'task.thread.messages.list',
  'task.background.list',
  'task.thread.delete',
  'task.active.list',
  'task.detail.get',
  'task.scheduledRuns.list'
];

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

});

function registerWorkspaceGetCurrent(capabilities: CapabilityRegistry): void {
  const descriptor = {
    name: 'workspace.getCurrent',
    version: '1.0.0',
    inputSchema: z.object({}),
    outputSchema: z.custom<Workspace | null>()
  };
  capabilities.declare('@roc/plugin-workspace', descriptor);
  capabilities.register('@roc/plugin-workspace', descriptor, async () => ({
    id: 'workspace_1',
    path: 'F:\\Code\\Roc',
    displayName: 'Roc',
    lastOpenedAt: '2026-06-04T00:00:00.000Z',
    trustState: 'trusted'
  }));
}

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

function readToolCallStatuses(snapshot: TaskSnapshot, name: string): string[] {
  return snapshot.recentEvents
    .filter((event) => {
      if (event.type !== 'tool_call' || event.payload === null || typeof event.payload !== 'object') {
        return false;
      }
      return Reflect.get(event.payload, 'name') === name;
    })
    .map((event) => {
      if (event.payload === null || typeof event.payload !== 'object') {
        throw new Error('task_tool_call_payload_invalid');
      }
      const status = Reflect.get(event.payload, 'status');
      if (typeof status !== 'string') {
        throw new Error('task_tool_call_status_invalid');
      }
      return status;
    });
}

function createContext(input: { capabilities: CapabilityRegistry; eventBus: RocEventBus }): RocPluginContext {
  return {
    pluginId: '@roc/plugin-task',
    eventBus: input.eventBus,
    capabilities: input.capabilities,
    database: { getConnection: () => db },
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

