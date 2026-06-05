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
  'task.scheduledRuns.list',
  'task.background.openInChat'
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
  it('declares the Phase 2 critical task plugin contract', () => {
    const plugin = createTaskPlugin();

    expect(plugin.manifest.id).toBe('@roc/plugin-task');
    expect(plugin.manifest.dependencies).toEqual(['@roc/plugin-agent', '@roc/plugin-workspace']);
    expect(plugin.manifest.loadPhase).toBe('critical');
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(taskCapabilities);
  });

  it('binds handlers and publishes task.updated after mutations', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus }));

    const preview = await capabilities.invoke<BackgroundTaskPreviewRequest, unknown>('task.background.preview', previewRequest);
    const task = await capabilities.invoke<unknown, { id: string }>('task.background.create', preview);
    await expect(capabilities.invoke('task.active.list', {})).resolves.toContainEqual(expect.objectContaining({ taskId: task.id }));
    await capabilities.invoke('task.background.pause', { id: task.id });
    await capabilities.invoke('task.background.resume', { id: task.id });
    await capabilities.invoke('task.background.cancel', { id: task.id });
    await capabilities.invoke('task.background.delete', { id: task.id });

    expect(eventBus.published.map((event) => event.type)).toEqual([
      'task.updated',
      'task.updated',
      'task.updated',
      'task.updated',
      'task.updated'
    ]);
    await expect(capabilities.invoke('task.scheduler.status', {})).resolves.toMatchObject({
      running: true,
      registeredTaskCount: 0
    });
    await expect(capabilities.invoke('task.scheduler.suspend', {})).resolves.toEqual({ suspended: true });
    await expect(capabilities.invoke('task.scheduler.status', {})).resolves.toMatchObject({
      running: false,
      registeredTaskCount: 0
    });
    await expect(capabilities.invoke('task.scheduler.resume', {})).resolves.toEqual({ resumed: true });
    await expect(capabilities.invoke('task.scheduler.handlePowerResume', {})).resolves.toEqual({ handled: true });
  });

  it('mirrors agent chat run events into the task snapshot contract', async () => {
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
        runId: 'run_chat_1',
        threadId: 'thread_chat_1',
        mode: 'chat',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        createdAt: '2026-06-04T00:00:00.000Z',
        userInput: 'Smoke typed user prompt',
        enabledCapabilities: {
          mcpServers: ['smoke-mcp'],
          skills: ['smoke-skill']
        },
        capabilityPreview: {
          requestedCapabilities: {
            mcpServers: ['smoke-mcp', 'missing-mcp'],
            skills: ['smoke-skill']
          },
          selectedCapabilities: {
            mcpServers: ['smoke-mcp'],
            skills: ['smoke-skill']
          },
          skippedCapabilities: [{ id: 'missing-mcp', type: 'mcp_server', reason: 'not_found' }],
          toolCards: [
            {
              id: 'mcp:smoke-mcp:smoke_tool',
              name: 'smoke_tool',
              capabilityType: 'mcp_tool',
              riskLevel: 'low',
              scope: 'external',
              requiresApproval: false
            }
          ],
          skillCards: [],
          untrustedContextPolicy: 'external_content_reference_only'
        }
      }
    });

    let snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});
    expect(snapshot.threads).toContainEqual(
      expect.objectContaining({
        id: 'thread_chat_1',
        goal: 'Smoke typed user prompt',
        status: 'running',
        title: 'Smoke typed user prompt'
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_chat_1',
        threadId: 'thread_chat_1',
        type: 'message',
        payload: {
          role: 'user',
          content: 'Smoke typed user prompt',
          enabledCapabilities: {
            mcpServers: ['smoke-mcp'],
            skills: ['smoke-skill']
          }
        }
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_chat_1',
        threadId: 'thread_chat_1',
        type: 'context_manifest',
        payload: expect.objectContaining({
          requestedCapabilities: {
            mcpServers: ['smoke-mcp', 'missing-mcp'],
            skills: ['smoke-skill']
          },
          resolvedCapabilities: {
            mcpServers: ['smoke-mcp'],
            skills: ['smoke-skill']
          },
          skippedCapabilities: [{ id: 'missing-mcp', type: 'mcp_server', reason: 'not_found' }],
          toolCards: [
            {
              id: 'mcp:smoke-mcp:smoke_tool',
              name: 'smoke_tool',
              capabilityType: 'mcp_tool',
              riskLevel: 'low',
              scope: 'external',
              requiresApproval: false
            }
          ],
          untrustedContextPolicy: 'external_content_reference_only'
        })
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_chat_1',
        threadId: 'thread_chat_1',
        type: 'agent_update',
        payload: { status: 'running' }
      })
    );

    await eventBus.publish({
      type: 'agent.run.completed',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:02.000Z',
      payload: {
        runId: 'run_chat_1',
        threadId: 'thread_chat_1',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        finishReason: 'stop',
        durationMs: 42,
        summary: 'Smoke Provider 已生成首轮回复。',
        assistantMessage: 'Smoke Provider 已生成首轮回复。'
      }
    });

    snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});
    expect(snapshot.threads).toContainEqual(
      expect.objectContaining({
        id: 'thread_chat_1',
        status: 'completed'
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_chat_1',
        threadId: 'thread_chat_1',
        type: 'message',
        payload: {
          role: 'assistant',
          content: 'Smoke Provider 已生成首轮回复。',
          providerId: 'smoke-provider',
          modelId: 'smoke-model'
        }
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_chat_1',
        threadId: 'thread_chat_1',
        type: 'agent_update',
        payload: expect.objectContaining({
          providerId: 'smoke-provider',
          modelId: 'smoke-model',
          finishReason: 'stop',
          durationMs: 42,
          summary: 'Smoke Provider 已生成首轮回复。'
        })
      })
    );
  });

  it('mirrors agent task tool-call events into the task snapshot contract', async () => {
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
        runId: 'run_task_1',
        threadId: 'thread_task_1',
        mode: 'task',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        createdAt: '2026-06-04T00:00:00.000Z',
        userInput: '每天 09:00 检查测试失败',
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
        runId: 'run_task_1',
        threadId: 'thread_task_1',
        type: 'tool_call',
        payload: {
          name: 'resolve_background_task_time',
          status: 'start',
          input: {
            text: '每天 09:00 检查测试失败'
          }
        }
      }
    });

    const snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});

    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_task_1',
        threadId: 'thread_task_1',
        type: 'tool_call',
        payload: {
          name: 'resolve_background_task_time',
          status: 'start',
          input: {
            text: '每天 09:00 检查测试失败'
          }
        }
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

    expect(startRequests).toContainEqual(expect.objectContaining({ threadId: task.threadId }));
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

  it('creates a proposal background task from agent task workflow events', async () => {
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
        userInput: '每天 09:00 检查测试失败，使用当前工作区。',
        workflowHint: 'propose_background_task',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      }
    });

    const { activeTasks, snapshot } = await waitForProposalSnapshot(capabilities, '每天 09:00 检查测试失败');

    expect(activeTasks).toContainEqual(
      expect.objectContaining({
        goal: '每天 09:00 检查测试失败',
        trigger: expect.objectContaining({
          type: 'cron',
          cronExpression: '0 9 * * *'
        })
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        type: 'background_task_created',
        payload: expect.objectContaining({
          goal: '每天 09:00 检查测试失败'
        })
      })
    );
    expect(new Set(readToolCallStatuses(snapshot, 'resolve_background_task_time'))).toEqual(new Set(['start', 'end']));
    expect(new Set(readToolCallStatuses(snapshot, 'propose_background_task'))).toEqual(new Set(['start', 'end']));
    expect(new Set(readToolCallStatuses(snapshot, 'schedule_background_task'))).toEqual(new Set(['start', 'end']));
    expect(new Set(readToolCallStatuses(snapshot, 'confirm_with_user'))).toEqual(new Set(['start', 'end']));
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

async function waitForProposalSnapshot(
  capabilities: CapabilityRegistry,
  expectedGoal: string
): Promise<{ activeTasks: ActiveTaskItem[]; snapshot: TaskSnapshot }> {
  const deadline = Date.now() + 500;
  while (true) {
    const activeTasks = await capabilities.invoke<{}, ActiveTaskItem[]>('task.active.list', {});
    const snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});
    const taskCreated = activeTasks.some((item) => item.kind === 'background' && item.goal === expectedGoal);
    const toolCallsRecorded =
      hasToolCallStatuses(snapshot, 'resolve_background_task_time') &&
      hasToolCallStatuses(snapshot, 'propose_background_task') &&
      hasToolCallStatuses(snapshot, 'schedule_background_task') &&
      hasToolCallStatuses(snapshot, 'confirm_with_user');
    if (taskCreated && toolCallsRecorded) {
      return { activeTasks, snapshot };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `expected_task_proposal_workflow_not_recorded:${JSON.stringify({
          activeTaskGoals: activeTasks.map((item) => item.goal),
          events: snapshot.recentEvents.map((event) => ({
            type: event.type,
            payload: event.payload
          }))
        })}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function hasToolCallStatuses(snapshot: TaskSnapshot, name: string): boolean {
  const statuses = new Set(readToolCallStatuses(snapshot, name));
  return statuses.has('start') && statuses.has('end');
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
