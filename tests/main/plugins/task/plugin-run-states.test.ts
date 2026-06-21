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
  it('mirrors subagent lifecycle events into the task snapshot contract', async () => {
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
        runId: 'run_subagent_1',
        threadId: 'thread_subagent_1',
        mode: 'task',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        createdAt: '2026-06-04T00:00:00.000Z',
        userInput: '先研究再总结',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      }
    });
    await eventBus.publish({
      type: 'agent.run.task-event',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:01.000Z',
      payload: {
        runId: 'run_subagent_1',
        threadId: 'thread_subagent_1',
        type: 'subagent_started',
        payload: {
          name: 'research',
          summary: 'Search docs'
        }
      }
    });
    await eventBus.publish({
      type: 'agent.run.task-event',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:02.000Z',
      payload: {
        runId: 'run_subagent_1',
        threadId: 'thread_subagent_1',
        type: 'subagent_completed',
        payload: {
          name: 'research',
          summary: 'Search docs'
        }
      }
    });

    const snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});

    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_subagent_1',
        threadId: 'thread_subagent_1',
        type: 'subagent_started',
        payload: {
          name: 'research',
          summary: 'Search docs'
        }
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_subagent_1',
        threadId: 'thread_subagent_1',
        type: 'subagent_completed',
        payload: {
          name: 'research',
          summary: 'Search docs'
        }
      })
    );
  });


  it('mirrors approval requests into the task snapshot contract and marks the thread waiting_user', async () => {
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
        runId: 'run_approval_1',
        threadId: 'thread_approval_1',
        mode: 'task',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        createdAt: '2026-06-04T00:00:00.000Z',
        userInput: '执行 git status',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      }
    });
    await eventBus.publish({
      type: 'agent.run.task-event',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:01.000Z',
      payload: {
        runId: 'run_approval_1',
        threadId: 'thread_approval_1',
        type: 'approval_requested',
        payload: {
          interruptId: 'interrupt-1',
          actionRequests: [
            {
              name: 'run_shell_command',
              args: {
                command: 'git status'
              }
            }
          ],
          reviewConfigs: [
            {
              actionName: 'run_shell_command',
              allowedDecisions: ['approve', 'reject']
            }
          ]
        }
      }
    });

    const snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});

    expect(snapshot.threads).toContainEqual(
      expect.objectContaining({
        id: 'thread_approval_1',
        status: 'waiting_user'
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_approval_1',
        threadId: 'thread_approval_1',
        type: 'approval_requested',
        payload: expect.objectContaining({
          interruptId: 'interrupt-1',
          actionRequests: [
            expect.objectContaining({
              name: 'run_shell_command',
              args: {
                command: 'git status'
              }
            })
          ]
        })
      })
    );
  });


  it('mirrors agent run failures into the task snapshot contract', async () => {
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
        runId: 'run_failed_1',
        threadId: 'thread_failed_1',
        mode: 'chat',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        createdAt: '2026-06-04T00:00:00.000Z',
        userInput: 'Call a failing provider',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      }
    });
    await eventBus.publish({
      type: 'agent.run.failed',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:01.000Z',
      payload: {
        runId: 'run_failed_1',
        threadId: 'thread_failed_1',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        error: 'provider_unavailable',
        code: 'agent_run_failed',
        retryable: true
      }
    });

    const snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});

    expect(snapshot.threads).toContainEqual(
      expect.objectContaining({
        id: 'thread_failed_1',
        status: 'failed'
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_failed_1',
        threadId: 'thread_failed_1',
        type: 'agent_update',
        payload: {
          status: 'failed',
          providerId: 'smoke-provider',
          modelId: 'smoke-model',
          code: 'agent_run_failed',
          error: 'provider_unavailable',
          retryable: true
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

