import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocEventEnvelope, RocPluginContext } from '../../../../src/main/kernel/types';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryContract } from '../../../../src/main/plugins/agent/agent-task-history-contract';
import { createTaskPlugin } from '../../../../src/main/plugins/task';
import type {
  TaskSnapshot
} from '../../../../src/shared/types';
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
  it('mirrors agent task tool-call events into the task snapshot contract', async () => {
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


  it('mirrors streamed reasoning and message deltas into the task snapshot contract', async () => {
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
        runId: 'run_stream_1',
        threadId: 'thread_stream_1',
        mode: 'chat',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        createdAt: '2026-06-04T00:00:00.000Z',
        userInput: '先思考，再回答',
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
        runId: 'run_stream_1',
        threadId: 'thread_stream_1',
        type: 'assistant_block',
        payload: {
          kind: 'reasoning',
          blockId: 'reasoning-run_stream_1',
          phase: 'delta',
          text: '先列出约束。'
        }
      }
    });
    await eventBus.publish({
      type: 'agent.run.task-event',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:02.000Z',
      payload: {
        runId: 'run_stream_1',
        threadId: 'thread_stream_1',
        type: 'assistant_block',
        payload: {
          kind: 'text',
          blockId: 'text-run_stream_1',
          phase: 'delta',
          text: '这里是最终回答。'
        }
      }
    });

    const snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});

    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_stream_1',
        threadId: 'thread_stream_1',
        type: 'assistant_block',
        payload: {
          kind: 'reasoning',
          blockId: 'reasoning-run_stream_1',
          phase: 'delta',
          text: '先列出约束。'
        }
      })
    );
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_stream_1',
        threadId: 'thread_stream_1',
        type: 'assistant_block',
        payload: {
          kind: 'text',
          blockId: 'text-run_stream_1',
          phase: 'delta',
          text: '这里是最终回答。'
        }
      })
    );
  });

  it('mirrors hook run events into the task snapshot contract', async () => {
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
        runId: 'run_hook_1',
        threadId: 'thread_hook_1',
        mode: 'chat',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        createdAt: '2026-06-04T00:00:00.000Z',
        userInput: 'Run a guarded command',
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
        runId: 'run_hook_1',
        threadId: 'thread_hook_1',
        type: 'hook_completed',
        payload: {
          runId: 'hook-run-1',
          handlerId: 'PreToolUse:0:0',
          event: 'PreToolUse',
          status: 'completed',
          durationMs: 12,
          message: 'Hook completed',
          additionalContext: null,
          requestContinue: null,
          commandDisplay: 'node hook.js'
        }
      }
    });

    const snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});

    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_hook_1',
        threadId: 'thread_hook_1',
        type: 'hook_completed',
        payload: {
          runId: 'hook-run-1',
          handlerId: 'PreToolUse:0:0',
          event: 'PreToolUse',
          status: 'completed',
          durationMs: 12,
          message: 'Hook completed',
          additionalContext: null,
          requestContinue: null,
          commandDisplay: 'node hook.js'
        }
      })
    );
  });

  it('mirrors plan mode run events into the task snapshot contract', async () => {
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
      createdAt: '2026-06-25T00:00:00.000Z',
      payload: {
        runId: 'run_plan_1',
        threadId: 'thread_plan_1',
        mode: 'plan',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        createdAt: '2026-06-25T00:00:00.000Z',
        userInput: 'Plan this change',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      }
    });
    await eventBus.publish({
      type: 'agent.run.task-event',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-25T00:00:01.000Z',
      payload: {
        runId: 'run_plan_1',
        threadId: 'thread_plan_1',
        type: 'assistant_block',
        payload: {
          kind: 'text',
          blockId: 'text-run_plan_1',
          phase: 'delta',
          text: '<proposed_plan>Plan</proposed_plan>'
        }
      }
    });

    const snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});

    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_plan_1',
        threadId: 'thread_plan_1',
        type: 'assistant_block',
        payload: {
          kind: 'text',
          blockId: 'text-run_plan_1',
          phase: 'delta',
          text: '<proposed_plan>Plan</proposed_plan>'
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

