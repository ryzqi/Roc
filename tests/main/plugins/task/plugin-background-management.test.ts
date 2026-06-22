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
  it('records proposal run starts without creating background tasks deterministically', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    registerWorkspaceGetCurrent(capabilities);
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus }));

    await eventBus.publish({
      type: 'agent.run.started',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:00.000Z',
      payload: {
        runId: 'run_task_proposal',
        threadId: 'thread_task_proposal',
        mode: 'task',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        createdAt: '2026-06-04T00:00:00.000Z',
        userInput: '每天晚上9点创建 docx 文件，里面写你好世界。',
        workflowHint: 'propose_background_task',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      }
    });

    const activeTasks = await capabilities.invoke<{}, ActiveTaskItem[]>('task.active.list', {});
    const snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});

    expect(activeTasks).toEqual([]);
    expect(snapshot.threads).toContainEqual(
      expect.objectContaining({
        id: 'thread_task_proposal',
        kind: 'background'
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_task_proposal',
        threadId: 'thread_task_proposal',
        type: 'message',
        payload: expect.objectContaining({
          role: 'user',
          content: '每天晚上9点创建 docx 文件，里面写你好世界。'
        })
      })
    );
    expect(readToolCallStatuses(snapshot, 'resolve_background_task_time')).toEqual([]);
    expect(readToolCallStatuses(snapshot, 'propose_background_task')).toEqual([]);
    expect(readToolCallStatuses(snapshot, 'schedule_background_task')).toEqual([]);
  });


  it('excludes background tasks whose thread was archived from the active list', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus }));

    const healthyPreview = await capabilities.invoke<BackgroundTaskPreviewRequest, unknown>('task.background.preview', previewRequest);
    const healthy = await capabilities.invoke<unknown, BackgroundTask>('task.background.create', healthyPreview);
    const ghostPreview = await capabilities.invoke<BackgroundTaskPreviewRequest, unknown>('task.background.preview', previewRequest);
    const ghost = await capabilities.invoke<unknown, BackgroundTask>('task.background.create', ghostPreview);

    // 模拟历史脏数据：thread 已归档（6/1 旧 archiveThread 只归档 thread），但 background_tasks.status 仍为 running。
    db.prepare("UPDATE task_threads SET status = 'archived', archived_at = ? WHERE id = ?").run(
      '2026-06-01T14:10:00.000Z',
      ghost.threadId
    );

    const activeTasks = await capabilities.invoke<{}, ActiveTaskItem[]>('task.active.list', {});

    expect(activeTasks).toContainEqual(expect.objectContaining({ taskId: healthy.id }));
    expect(activeTasks).not.toContainEqual(expect.objectContaining({ taskId: ghost.id }));
  });


  it('returns a not_found domain error from task.detail.get when the task thread was archived', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus }));

    const preview = await capabilities.invoke<BackgroundTaskPreviewRequest, unknown>('task.background.preview', previewRequest);
    const task = await capabilities.invoke<unknown, BackgroundTask>('task.background.create', preview);

    db.prepare("UPDATE task_threads SET status = 'archived', archived_at = ? WHERE id = ?").run(
      '2026-06-01T14:10:00.000Z',
      task.threadId
    );

    await expect(capabilities.invoke('task.detail.get', { taskId: task.id })).rejects.toMatchObject({
      code: 'task_thread_not_found',
      category: 'not_found'
    });
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

