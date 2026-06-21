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
  it('returns enough thread history to rebuild a tool run after many streamed deltas', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus }));

    await eventBus.publish({
      type: 'agent.run.started',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:00.000Z',
      payload: {
        runId: 'run_weather_1',
        threadId: 'thread_weather_1',
        mode: 'chat',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        createdAt: '2026-06-04T00:00:00.000Z',
        userInput: '搜索今日成都天气？',
        enabledCapabilities: {
          mcpServers: ['web-search'],
          skills: []
        }
      }
    });
    await eventBus.publish({
      type: 'agent.run.task-event',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:01.000Z',
      payload: {
        runId: 'run_weather_1',
        threadId: 'thread_weather_1',
        type: 'assistant_block',
        payload: {
          kind: 'tool_call',
          blockId: 'tool-web_search_1',
          callId: 'web_search_1',
          name: 'web_search',
          phase: 'start'
        }
      }
    });
    await eventBus.publish({
      type: 'agent.run.task-event',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:02.000Z',
      payload: {
        runId: 'run_weather_1',
        threadId: 'thread_weather_1',
        type: 'assistant_block',
        payload: {
          kind: 'tool_call',
          blockId: 'tool-web_search_1',
          callId: 'web_search_1',
          name: 'web_search',
          output: '成都今日多云，气温 22-28°C。',
          phase: 'end'
        }
      }
    });
    for (let index = 0; index < 110; index += 1) {
      await eventBus.publish({
        type: 'agent.run.task-event',
        source: '@roc/plugin-agent',
        createdAt: `2026-06-04T00:00:03.${String(index).padStart(3, '0')}Z`,
        payload: {
          runId: 'run_weather_1',
          threadId: 'thread_weather_1',
          type: 'assistant_block',
          payload: {
            kind: 'text',
            blockId: 'text-run_weather_1',
            phase: 'delta',
            text: `天气回答分片 ${index}。`
          }
        }
      });
    }
    await eventBus.publish({
      type: 'agent.run.completed',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:04.000Z',
      payload: {
        runId: 'run_weather_1',
        threadId: 'thread_weather_1',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        finishReason: 'stop',
        durationMs: 4200,
        summary: '成都今日天气回答。',
        assistantMessage: '成都今日多云，气温 22-28°C。'
      }
    });

    const messages = await capabilities.invoke<{ threadId: string }, TaskEvent[]>('task.thread.messages.list', {
      threadId: 'thread_weather_1'
    });
    const historyMilestones = messages.flatMap((event) => {
      if (event.payload === null || typeof event.payload !== 'object') {
        return [];
      }
      if (
        event.type === 'message' &&
        Reflect.get(event.payload, 'role') === 'user' &&
        Reflect.get(event.payload, 'content') === '搜索今日成都天气？'
      ) {
        return ['user-message'];
      }
      if (
        event.type === 'assistant_block' &&
        Reflect.get(event.payload, 'kind') === 'tool_call' &&
        Reflect.get(event.payload, 'phase') === 'start'
      ) {
        return ['tool-call-start'];
      }
      if (
        event.type === 'assistant_block' &&
        Reflect.get(event.payload, 'kind') === 'text' &&
        Reflect.get(event.payload, 'phase') === 'delta' &&
        Reflect.get(event.payload, 'text') === '天气回答分片 0。'
      ) {
        return ['first-text-delta'];
      }
      if (
        event.type === 'message' &&
        Reflect.get(event.payload, 'role') === 'assistant' &&
        Reflect.get(event.payload, 'content') === '成都今日多云，气温 22-28°C。'
      ) {
        return ['assistant-message'];
      }
      return [];
    });

    expect(historyMilestones).toEqual(['user-message', 'tool-call-start', 'first-text-delta', 'assistant-message']);
    const userMessage = messages.find(
      (event) =>
        event.type === 'message' &&
        event.payload !== null &&
        typeof event.payload === 'object' &&
        Reflect.get(event.payload, 'role') === 'user'
    );
    if (userMessage === undefined) {
      throw new Error('expected_user_message_in_thread_history');
    }
    expect(userMessage).toMatchObject({
      runId: 'run_weather_1',
      threadId: 'thread_weather_1',
      payload: {
        role: 'user',
        content: '搜索今日成都天气？',
        enabledCapabilities: {
          mcpServers: ['web-search'],
          skills: []
        }
      }
    });
    const toolStart = messages.find(
      (event) =>
        event.type === 'assistant_block' &&
        event.payload !== null &&
        typeof event.payload === 'object' &&
        Reflect.get(event.payload, 'kind') === 'tool_call' &&
        Reflect.get(event.payload, 'phase') === 'start'
    );
    if (toolStart === undefined) {
      throw new Error('expected_tool_start_in_thread_history');
    }
    expect(toolStart.payload).toEqual({
      kind: 'tool_call',
      blockId: 'tool-web_search_1',
      callId: 'web_search_1',
      name: 'web_search',
      phase: 'start'
    });
    expect(messages).toContainEqual(
      expect.objectContaining({
        runId: 'run_weather_1',
        threadId: 'thread_weather_1',
        type: 'message',
        payload: {
          role: 'assistant',
          content: '成都今日多云，气温 22-28°C。',
          providerId: 'smoke-provider',
          modelId: 'smoke-model'
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

