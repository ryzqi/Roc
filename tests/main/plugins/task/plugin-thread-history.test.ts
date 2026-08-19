import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocEventEnvelope, RocPluginContext } from '../../../../src/main/kernel/types';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryContract } from '../../../../src/main/plugins/agent/agent-task-history-contract';
import { createTaskPlugin } from '../../../../src/main/plugins/task';
import type { TaskMessageHistoryPage, TaskMessageHistoryRequest } from '../../../../src/shared/types';
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
  it('returns enough thread history to rebuild a tool run after many streamed deltas', async () => {
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

    const page = await capabilities.invoke<TaskMessageHistoryRequest, TaskMessageHistoryPage>(
      'task.thread.messages.list',
      { threadId: 'thread_weather_1', limit: 200, cursor: null }
    );
    const messages = page.items;
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

  it('returns bounded latest, before, and after pages in ascending sequence order', async () => {
    const capabilities = new CapabilityRegistry();
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus: createTestEventBus() }));
    seedHistoryEvents(250);

    const latest = await capabilities.invoke<TaskMessageHistoryRequest, TaskMessageHistoryPage>(
      'task.thread.messages.list',
      { threadId: 'thread-page', limit: 100, cursor: null }
    );
    expect(latest.items.map((item) => item.sequence)).toEqual(
      Array.from({ length: 100 }, (_value, index) => index + 151)
    );
    expect(latest).toMatchObject({
      oldestSequence: 151,
      newestSequence: 250,
      hasMoreBefore: true,
      hasMoreAfter: false
    });

    const before = await capabilities.invoke<TaskMessageHistoryRequest, TaskMessageHistoryPage>(
      'task.thread.messages.list',
      { threadId: 'thread-page', limit: 100, cursor: { direction: 'before', sequence: 151 } }
    );
    expect(before.items.map((item) => item.sequence)).toEqual(
      Array.from({ length: 100 }, (_value, index) => index + 51)
    );

    const after = await capabilities.invoke<TaskMessageHistoryRequest, TaskMessageHistoryPage>(
      'task.thread.messages.list',
      { threadId: 'thread-page', limit: 100, cursor: { direction: 'after', sequence: 200 } }
    );
    expect(after.items.map((item) => item.sequence)).toEqual(
      Array.from({ length: 50 }, (_value, index) => index + 201)
    );
  });

  it.each([
    { threadId: 'thread-page', limit: 0, cursor: null },
    { threadId: 'thread-page', limit: 201, cursor: null },
    { threadId: 'thread-page', limit: 100 },
    { threadId: 'thread-page', limit: 100, cursor: { direction: 'before', sequence: 0 } },
    { threadId: 'thread-page', limit: 100, cursor: null, extra: true }
  ])('rejects an invalid history page request %#', async (request) => {
    const capabilities = new CapabilityRegistry();
    const plugin = createTaskPlugin({ agentTaskHistory: new AgentTaskHistoryContract(agentDb) });
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus: createTestEventBus() }));
    seedHistoryEvents(1);

    await expect(capabilities.invoke('task.thread.messages.list', request)).rejects.toThrow();
  });

  it('uses the thread sequence index without a temporary order-by sort', () => {
    const plans = [
      `EXPLAIN QUERY PLAN
       SELECT sequence, id, thread_id, run_id, type, payload_json, created_at
       FROM agent_events
       WHERE thread_id = ?
       ORDER BY sequence DESC
       LIMIT ?`,
      `EXPLAIN QUERY PLAN
       SELECT sequence, id, thread_id, run_id, type, payload_json, created_at
       FROM agent_events
       WHERE thread_id = ? AND sequence < ?
       ORDER BY sequence DESC
       LIMIT ?`,
      `EXPLAIN QUERY PLAN
       SELECT sequence, id, thread_id, run_id, type, payload_json, created_at
       FROM agent_events
       WHERE thread_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`
    ];

    for (const [index, sql] of plans.entries()) {
      const parameters = index === 0 ? ['thread-page', 100] : ['thread-page', 151, 100];
      const detail = (agentDb.prepare(sql).all(...parameters) as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join('\n');
      expect(detail).toContain('idx_agent_events_thread_sequence');
      expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    }
  });

});

function seedHistoryEvents(count: number): void {
  agentDb
    .prepare(
      `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
       VALUES (?, 'background', ?, ?, 'running', ?, ?)`
    )
    .run('thread-page', 'Paged history', 'Paged history', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z');
  agentDb
    .prepare(
      `INSERT INTO agent_runs
       (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
        enabled_capabilities_json, workspace_path, task_source, workflow_hint)
       VALUES (?, ?, 1, ?, 'running', ?, NULL, NULL, NULL, ?, ?, 'workbench', 'background_task')`
    )
    .run(
      'run-page',
      'thread-page',
      'Paged history',
      '2026-07-10T00:00:00.000Z',
      JSON.stringify({ mcpServers: [], skills: [] }),
      'F:\\Code\\Roc'
    );
  const insert = agentDb.prepare(
    `INSERT INTO agent_events (id, thread_id, run_id, sequence, type, payload_json, created_at)
     VALUES (?, 'thread-page', 'run-page', ?, 'message', ?, ?)`
  );
  agentDb.transaction(() => {
    for (let sequence = 1; sequence <= count; sequence += 1) {
      insert.run(
        `event-page-${sequence}`,
        sequence,
        JSON.stringify({
          role: 'assistant',
          content: `message-${sequence}`,
          providerId: 'test-provider',
          modelId: 'test-model'
        }),
        `2026-07-10T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`
      );
    }
  })();
}

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

