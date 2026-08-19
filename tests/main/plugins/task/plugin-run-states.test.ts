import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocEventEnvelope, RocPluginContext } from '../../../../src/main/kernel/types';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryContract } from '../../../../src/main/plugins/agent/agent-task-history-contract';
import { createTaskPlugin } from '../../../../src/main/plugins/task';
import type { TaskSnapshot } from '../../../../src/shared/types';
import { createTaskPluginTestDatabaseFacade, createTaskPluginTestEventBus } from './task-plugin-test-harness';

let db: Database.Database;
let agentDb: Database.Database;

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
  it('mirrors subagent lifecycle events into the task snapshot contract', async () => {
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
        type: 'subagent_event',
        payload: {
          sequence: 1,
          identity: {
            subagentId: 'subagent-run_subagent_1-0',
            parentSubagentId: null,
            name: 'research',
            depth: 0,
            path: ['research#0'],
            execution: 'sync',
            taskInput: 'Search docs'
          },
          event: {
            kind: 'started'
          }
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
        type: 'subagent_event',
        payload: {
          sequence: 2,
          identity: {
            subagentId: 'subagent-run_subagent_1-0',
            parentSubagentId: null,
            name: 'research',
            depth: 0,
            path: ['research#0'],
            execution: 'sync',
            taskInput: 'Search docs'
          },
          event: {
            kind: 'completed',
            summary: 'Search docs'
          }
        }
      }
    });

    const snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});

    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_subagent_1',
        threadId: 'thread_subagent_1',
        type: 'subagent_event',
        payload: {
          sequence: 1,
          identity: {
            subagentId: 'subagent-run_subagent_1-0',
            parentSubagentId: null,
            name: 'research',
            depth: 0,
            path: ['research#0'],
            execution: 'sync',
            taskInput: 'Search docs'
          },
          event: {
            kind: 'started'
          }
        }
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_subagent_1',
        threadId: 'thread_subagent_1',
        type: 'subagent_event',
        payload: {
          sequence: 2,
          identity: {
            subagentId: 'subagent-run_subagent_1-0',
            parentSubagentId: null,
            name: 'research',
            depth: 0,
            path: ['research#0'],
            execution: 'sync',
            taskInput: 'Search docs'
          },
          event: {
            kind: 'completed',
            summary: 'Search docs'
          }
        }
      })
    );
  });


  it('mirrors approval requests into the task snapshot contract and marks the thread waiting_user', async () => {
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
        type: 'error',
        payload: {
          code: 'agent_run_failed',
          error: 'provider_unavailable',
          retryable: true
        }
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

