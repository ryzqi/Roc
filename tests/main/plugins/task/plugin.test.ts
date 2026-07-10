import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocEventEnvelope, RocPluginContext } from '../../../../src/main/kernel/types';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { createTaskPlugin } from '../../../../src/main/plugins/task';
import type {
  BackgroundTaskPreviewRequest,
  TaskSnapshot
} from '../../../../src/shared/types';
import { createTaskPluginTestDatabaseFacade, createTaskPluginTestEventBus } from './task-plugin-test-harness';

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
let agentDb: Database.Database;

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
  agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  applyAgentDatabaseSchema(agentDb);
});

afterEach(() => {
  agentDb.close();
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


  it('creates task projection tables without duplicating agent history tables', async () => {
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus: createTestEventBus() }));

    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
    const indexColumns = db
      .prepare("PRAGMA index_xinfo('idx_task_plugin_background_tasks_status_updated')")
      .all() as Array<{ name: string | null; desc: 0 | 1; key: 0 | 1 }>;
    const indexedColumns = indexColumns
      .filter((column) => column.key === 1)
      .map((column) => ({ name: column.name, desc: column.desc }));

    expect(tableRows.map((row) => row.name)).not.toContain('task_events');
    expect(tableRows.map((row) => row.name)).not.toContain('task_runs');
    expect(tableRows.map((row) => row.name)).not.toContain('task_threads');
    expect(indexedColumns).toEqual([
      { name: 'status', desc: 0 },
      { name: 'updated_at', desc: 1 }
    ]);
  });


  it('binds handlers and publishes task.updated after mutations', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus }));

    await expect(capabilities.invoke<BackgroundTaskPreviewRequest, unknown>('task.background.preview', previewRequest)).resolves.toMatchObject({
      goal: previewRequest.goal,
      riskLevel: 'low'
    });
    const task = await capabilities.invoke<BackgroundTaskPreviewRequest, { id: string }>('task.background.create', previewRequest);
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

});

function createContext(input: { capabilities: CapabilityRegistry; eventBus: RocEventBus }): RocPluginContext {
  return {
    pluginId: '@roc/plugin-task',
    eventBus: input.eventBus,
    capabilities: input.capabilities,
    database: createTaskPluginTestDatabaseFacade(db, agentDb),
    config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  };
}

function createTestEventBus(): RocEventBus & { published: RocEventEnvelope[] } {
  return createTaskPluginTestEventBus(agentDb);
}
