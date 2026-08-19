import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { CapabilityDescriptor, RocEventBus, RocEventEnvelope, RocPluginContext } from '../../../../src/main/kernel/types';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryContract } from '../../../../src/main/plugins/agent/agent-task-history-contract';
import { createTaskPlugin } from '../../../../src/main/plugins/task';
import { applyTaskDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';
import { ThreadDeletionJournal } from '../../../../src/main/plugins/task/thread-deletion-journal';
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
  'task.scheduledRuns.list',
  'task.outbox.replay'
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
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });

    expect(plugin.manifest.id).toBe('@roc/plugin-task');
    expect(plugin.manifest.dependencies).toEqual(['@roc/plugin-agent', '@roc/plugin-workspace']);
    expect(plugin.manifest.loadPhase).toBe('critical');
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(taskCapabilities);
  });

  it('binds task handlers by capability name instead of descriptor position', async () => {
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
    const descriptors = plugin.manifest.capabilities as CapabilityDescriptor[];
    const firstDescriptor = descriptors[0];
    const secondDescriptor = descriptors[1];
    if (firstDescriptor === undefined || secondDescriptor === undefined) {
      throw new Error('task_capability_fixture_incomplete');
    }
    descriptors[0] = secondDescriptor;
    descriptors[1] = firstDescriptor;
    const capabilities = declarePluginCapabilities(plugin);
    try {
      await plugin.initialize(createContext({ capabilities, eventBus: createTestEventBus() }));

      await expect(capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {})).resolves.toMatchObject({
        counts: expect.any(Object),
        recentEvents: expect.any(Array),
        threads: expect.any(Array)
      });
    } finally {
      await plugin.shutdown();
      descriptors[0] = firstDescriptor;
      descriptors[1] = secondDescriptor;
    }
  });


  it('creates task projection tables without duplicating agent history tables', async () => {
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
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
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
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
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
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
          manifest: {
            requestedCapabilities: {
              mcpServers: ['smoke-mcp', 'missing-mcp'],
              skills: ['smoke-skill']
            },
            resolvedCapabilities: {
              mcpServers: ['smoke-mcp'],
              skills: ['smoke-skill']
            },
            skippedCapabilities: [{ id: 'missing-mcp', type: 'mcp_server', reason: 'not_found' }],
            untrustedContextPolicy: 'external_content_reference_only'
          },
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
          skillCards: []
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

  it('isolates outbox projection failure and lets a manual replay recover without a new agent event', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
    const capabilities = declarePluginCapabilities(plugin);
    await plugin.initialize(createContext({ capabilities, eventBus }));
    const task = await capabilities.invoke<BackgroundTaskPreviewRequest, { id: string; runId: string; threadId: string }>(
      'task.background.create',
      previewRequest
    );
    db.exec(`
      CREATE TRIGGER fail_outbox_projection
      BEFORE UPDATE ON background_tasks
      BEGIN
        SELECT RAISE(ABORT, 'outbox_projection_injected');
      END;
    `);

    await expect(
      eventBus.publish({
        type: 'agent.run.completed',
        source: '@roc/plugin-agent',
        createdAt: '2026-07-17T00:00:00.000Z',
        payload: {
          runId: task.runId,
          threadId: task.threadId,
          assistantMessage: 'Completed after projection retry.',
          durationMs: 12,
          finishReason: 'stop',
          modelId: 'test-model',
          providerId: 'test-provider',
          summary: 'Outbox recovery test'
        }
      })
    ).resolves.toBeUndefined();
    expect(db.prepare("SELECT last_sequence FROM task_agent_outbox_cursors WHERE projector_name = 'task_background_status'").get()).toBeUndefined();

    db.exec('DROP TRIGGER fail_outbox_projection');

    await expect(capabilities.invoke('task.outbox.replay', {})).resolves.toEqual({ appliedCount: 1, lastSequence: 1 });
    await expect(capabilities.invoke('task.detail.get', { taskId: task.id })).resolves.toMatchObject({
      backgroundTask: {
        lastRunStatus: 'success'
      }
    });
  });

  it('recovers pending thread deletions before the scheduler starts', async () => {
    const { journal, repository } = createSeededRepository();
    const task = repository.createBackgroundTask(previewRequest);
    journal.ensurePending(task.threadId);
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
    const capabilities = declarePluginCapabilities(plugin);

    await plugin.initialize(createContext({ capabilities, eventBus: createTestEventBus() }));

    expect(countRows(db, 'background_tasks')).toBe(0);
    expect(countRows(agentDb, 'agent_threads')).toBe(0);
    expect(journal.require(task.threadId).state).toBe('complete');
    await expect(capabilities.invoke('task.scheduler.status', {})).resolves.toMatchObject({ registeredTaskCount: 0 });
  });

  it('recovers task projection deletion from an agent-deleted journal state', async () => {
    const { agentHistory, journal, repository } = createSeededRepository();
    const task = repository.createBackgroundTask(previewRequest);
    journal.ensurePending(task.threadId);
    agentHistory.deleteThread(task.threadId);
    journal.markAgentDeleted(task.threadId);
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
    const capabilities = declarePluginCapabilities(plugin);

    await plugin.initialize(createContext({ capabilities, eventBus: createTestEventBus() }));

    expect(countRows(db, 'background_tasks')).toBe(0);
    expect(journal.require(task.threadId).state).toBe('complete');
  });

  it('continues startup after one recovery failure while keeping the target hidden', async () => {
    const { journal, repository } = createSeededRepository();
    const task = repository.createBackgroundTask({
      ...previewRequest,
      trigger: {
        type: 'once',
        description: 'Run later',
        nextRunAt: '2026-07-11T00:00:00.000Z'
      }
    });
    journal.ensurePending(task.threadId);
    agentDb.exec(`
      CREATE TRIGGER fail_recovery_agent_delete
      BEFORE DELETE ON agent_threads
      BEGIN
        SELECT RAISE(ABORT, 'recovery_agent_delete_injected');
      END;
    `);
    const warn = vi.fn<(message: string, metadata?: Record<string, unknown>) => void>();
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
    const capabilities = declarePluginCapabilities(plugin);

    await expect(
      plugin.initialize(createContext({ capabilities, eventBus: createTestEventBus(), warn }))
    ).resolves.toBeUndefined();

    expect(journal.require(task.threadId)).toMatchObject({
      state: 'pending',
      attemptCount: 1
    });
    expect(journal.require(task.threadId).lastError).toContain('recovery_agent_delete_injected');
    expect(warn).toHaveBeenCalledWith('Task thread deletion recovery failed.', {
      component: 'task.initialize',
      threadId: task.threadId,
      state: 'pending',
      error: expect.stringContaining('recovery_agent_delete_injected')
    });
    await expect(capabilities.invoke('task.background.list', {})).resolves.toEqual([]);
    await expect(capabilities.invoke('task.scheduler.status', {})).resolves.toMatchObject({ registeredTaskCount: 0 });
  });

  it('logs the advanced journal state when projection recovery fails after agent deletion', async () => {
    const { journal, repository } = createSeededRepository();
    const task = repository.createBackgroundTask(previewRequest);
    journal.ensurePending(task.threadId);
    db.exec(`
      CREATE TRIGGER fail_recovery_projection_delete
      BEFORE DELETE ON background_tasks
      BEGIN
        SELECT RAISE(ABORT, 'recovery_projection_delete_injected');
      END;
    `);
    const warn = vi.fn<(message: string, metadata?: Record<string, unknown>) => void>();
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
    const capabilities = declarePluginCapabilities(plugin);

    await expect(
      plugin.initialize(createContext({ capabilities, eventBus: createTestEventBus(), warn }))
    ).resolves.toBeUndefined();

    expect(journal.require(task.threadId)).toMatchObject({
      state: 'agent_deleted',
      attemptCount: 1
    });
    expect(warn).toHaveBeenCalledWith('Task thread deletion recovery failed.', {
      component: 'task.initialize',
      threadId: task.threadId,
      state: 'agent_deleted',
      error: expect.stringContaining('recovery_projection_delete_injected')
    });
    await expect(capabilities.invoke('task.scheduler.status', {})).resolves.toMatchObject({ registeredTaskCount: 0 });
  });

  it('unregisters a live task immediately when deletion becomes journaled but fails', async () => {
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
    const capabilities = declarePluginCapabilities(plugin);
    const eventBus = createTestEventBus();
    await plugin.initialize(createContext({ capabilities, eventBus }));
    const task = await capabilities.invoke<BackgroundTaskPreviewRequest, { id: string; threadId: string }>(
      'task.background.create',
      {
        ...previewRequest,
        trigger: {
          type: 'once',
          description: 'Run later',
          nextRunAt: '2026-07-11T00:00:00.000Z'
        }
      }
    );
    agentDb.exec(`
      CREATE TRIGGER fail_live_agent_delete
      BEFORE DELETE ON agent_threads
      BEGIN
        SELECT RAISE(ABORT, 'live_agent_delete_injected');
      END;
    `);

    await expect(capabilities.invoke('task.thread.delete', { threadId: task.threadId })).rejects.toThrow(
      'live_agent_delete_injected'
    );

    await expect(capabilities.invoke('task.scheduler.status', {})).resolves.toMatchObject({ registeredTaskCount: 0 });
    await expect(capabilities.invoke('task.background.list', {})).resolves.toEqual([]);
    expect(eventBus.published.at(-1)).toMatchObject({
      type: 'task.updated',
      payload: {
        kind: 'thread_deletion_started',
        threadId: task.threadId
      }
    });
    expect(new ThreadDeletionJournal({ agentHistory: new AgentTaskHistoryContract(agentDb), db }).require(task.threadId)).toMatchObject({
      state: 'pending',
      attemptCount: 1
    });
  });

  it('publishes a refresh event when a chat-only thread deletion becomes journaled but fails', async () => {
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
    const capabilities = declarePluginCapabilities(plugin);
    const eventBus = createTestEventBus();
    await plugin.initialize(createContext({ capabilities, eventBus }));
    agentDb
      .prepare(
        `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'thread-chat-delete',
        'chat',
        'Chat delete',
        'Chat delete',
        'completed',
        '2026-07-10T00:00:00.000Z',
        '2026-07-10T00:00:00.000Z'
      );
    agentDb.exec(`
      CREATE TRIGGER fail_chat_agent_delete
      BEFORE DELETE ON agent_threads
      BEGIN
        SELECT RAISE(ABORT, 'chat_agent_delete_injected');
      END;
    `);

    await expect(capabilities.invoke('task.thread.delete', { threadId: 'thread-chat-delete' })).rejects.toThrow(
      'chat_agent_delete_injected'
    );

    expect(eventBus.published.at(-1)).toMatchObject({
      type: 'task.updated',
      payload: {
        kind: 'thread_deletion_started',
        threadId: 'thread-chat-delete'
      }
    });
    await expect(capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {})).resolves.toMatchObject({
      threads: []
    });
  });

});

function createContext(input: {
  capabilities: CapabilityRegistry;
  eventBus: RocEventBus;
  warn?: (message: string, metadata?: Record<string, unknown>) => void;
}): RocPluginContext {
  return {
    pluginId: '@roc/plugin-task',
    eventBus: input.eventBus,
    capabilities: input.capabilities,
    database: createTaskPluginTestDatabaseFacade(db, agentDb),
    config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: input.warn === undefined ? () => {} : input.warn, error: () => {} }
  };
}

function createTestEventBus(): RocEventBus & { published: RocEventEnvelope[] } {
  return createTaskPluginTestEventBus(agentDb);
}

function createSeededRepository(): {
  agentHistory: AgentTaskHistoryContract;
  journal: ThreadDeletionJournal;
  repository: TaskRepository;
} {
  applyTaskDatabaseSchema(db);
  const agentHistory = new AgentTaskHistoryContract(agentDb);
  const journal = new ThreadDeletionJournal({ agentHistory, db });
  return {
    agentHistory,
    journal,
    repository: new TaskRepository(db, agentHistory, journal)
  };
}

function declarePluginCapabilities(plugin: ReturnType<typeof createTaskPlugin>): CapabilityRegistry {
  const capabilities = new CapabilityRegistry();
  for (const descriptor of plugin.manifest.capabilities) {
    capabilities.declare(plugin.manifest.id, descriptor);
  }
  return capabilities;
}

function countRows(connection: Database.Database, tableName: string): number {
  return connection.prepare(`SELECT COUNT(*) FROM ${tableName}`).pluck().get() as number;
}
