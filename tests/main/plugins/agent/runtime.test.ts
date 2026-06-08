import Database from 'better-sqlite3';
import { AIMessageChunk } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import type { RocEventBus, RocEventEnvelope } from '../../../../src/main/kernel/types';
import type { ChatRunEvent, ChatStartRunRequest } from '../../../../src/shared/types';

let db: Database.Database;
let events: RocEventEnvelope[];

const modelFactory: AgentModelFactoryAdapter = {
  createDefaultModelHandle: async () => ({
    invoke: async () => 'Static agent response.',
    modelId: 'openai:gpt-4.1',
    providerId: 'openai'
  }),
  createModelHandleByModelId: async (modelId) => ({
    invoke: async () => 'Static agent response.',
    modelId,
    providerId: 'openai'
  })
};

const eventBus: RocEventBus = {
  publish: async (event) => {
    events.push(event);
  },
  subscribe: () => () => {}
};

const startRequest: ChatStartRunRequest = {
  enabledCapabilities: {
    mcpServers: [],
    skills: []
  },
  input: 'Summarize this workspace',
  mode: 'task'
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyAgentPluginSchema(db);
  events = [];
});

afterEach(() => {
  db.close();
});

describe('AgentPluginRuntime', () => {
  it('starts a task run through the plugin repository and publishes the run event', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun(startRequest);

    expect(result).toMatchObject({
      mode: 'task',
      modelId: 'openai:gpt-4.1',
      providerId: 'openai'
    });
    expect(repository.getRun(result.runId)).toMatchObject({
      id: result.runId,
      modelId: 'openai:gpt-4.1',
      threadId: result.threadId,
      userInput: 'Summarize this workspace'
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          runId: result.runId,
          threadId: result.threadId
        }),
        source: '@roc/plugin-agent',
        type: 'agent.run.started'
      })
    );
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );
  });

  it('publishes chat run events for renderer subscribers when a plugin run starts and completes', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      mode: 'chat'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    const chatEvents = events
      .filter((event) => event.type === 'agent.chat.run-event')
      .map((event) => readChatRunEvent(event.payload));

    expect(chatEvents).toEqual([
      {
        type: 'run_started',
        runId: result.runId,
        mode: 'chat',
        threadId: result.threadId,
        providerId: 'openai',
        modelId: 'openai:gpt-4.1',
        createdAt: result.createdAt
      },
      {
        type: 'run_completed',
        runId: result.runId,
        threadId: result.threadId,
        providerId: 'openai',
        modelId: 'openai:gpt-4.1',
        createdAt: result.createdAt,
        durationMs: expect.any(Number),
        summary: 'Static agent response.',
        assistantMessage: 'Static agent response.'
      }
    ]);
  });

  it('cancels only active plugin runs', async () => {
    const repository = new AgentSessionRepository(db);
    const deferred = createDeferred<string>();
    const runtime = new AgentPluginRuntime({
      eventBus,
      modelFactory: {
        createDefaultModelHandle: async () => ({
          invoke: async () => deferred.promise,
          modelId: 'openai:gpt-4.1',
          providerId: 'openai'
        }),
        createModelHandleByModelId: modelFactory.createModelHandleByModelId
      },
      repository
    });
    const result = await runtime.startRun(startRequest);

    expect(runtime.cancelRun({ runId: result.runId })).toEqual({
      cancelled: true,
      runId: result.runId
    });
    expect(runtime.cancelRun({ runId: result.runId })).toEqual({
      cancelled: false,
      runId: result.runId
    });
    deferred.resolve('Response after cancel.');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(repository.getRun(result.runId).status).toBe('cancelled');
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: expect.objectContaining({
          runId: result.runId,
          type: 'run_completed'
        })
      })
    );
  });

  it('publishes renderer failure events and marks the run failed when model invocation fails', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      eventBus,
      modelFactory: {
        createDefaultModelHandle: async () => ({
          invoke: async () => {
            throw new Error('provider_unavailable');
          },
          modelId: 'openai:gpt-4.1',
          providerId: 'openai'
        }),
        createModelHandleByModelId: modelFactory.createModelHandleByModelId
      },
      repository
    });

    const result = await runtime.startRun(startRequest);

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_failed')
    );

    expect(repository.getRun(result.runId).status).toBe('failed');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: {
          type: 'run_failed',
          runId: result.runId,
          threadId: result.threadId,
          code: 'agent_run_failed',
          message: 'provider_unavailable',
          retryable: true
        }
      })
    );
  });

  it('streams reasoning and assistant deltas through renderer and task-event channels before completion', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      eventBus,
      modelFactory: {
        createDefaultModelHandle: async () => ({
          invoke: async () => {
            throw new Error('invoke_should_not_be_used_when_stream_exists');
          },
          stream: async function* () {
            yield new AIMessageChunk({
              content: [
                {
                  type: 'reasoning',
                  reasoning: '先判断用户意图。'
                }
              ] as never
            });
            yield new AIMessageChunk({
              content: [
                {
                  type: 'text',
                  text: '可以，先从今天金价开始。'
                }
              ] as never
            });
          },
          modelId: 'nvidia:test-model',
          providerId: 'nvidia'
        }),
        createModelHandleByModelId: async (modelId) => ({
          invoke: async () => {
            throw new Error('invoke_should_not_be_used_when_stream_exists');
          },
          stream: async function* () {
            yield new AIMessageChunk({
              content: [
                {
                  type: 'reasoning',
                  reasoning: '先判断用户意图。'
                }
              ] as never
            });
            yield new AIMessageChunk({
              content: [
                {
                  type: 'text',
                  text: '可以，先从今天金价开始。'
                }
              ] as never
            });
          },
          modelId,
          providerId: 'nvidia'
        })
      },
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: '每天晚上9点搜索今日金价，并记录到当前目录下的docx文件中。先思考，再执行。',
      mode: 'chat'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    const chatEvents = events
      .filter((event) => event.type === 'agent.chat.run-event')
      .map((event) => readChatRunEvent(event.payload));
    expect(chatEvents).toContainEqual({
      type: 'reasoning_delta',
      runId: result.runId,
      delta: '先判断用户意图。'
    });
    expect(chatEvents).toContainEqual({
      type: 'message_delta',
      runId: result.runId,
      delta: '可以，先从今天金价开始。'
    });
    expect(chatEvents).toContainEqual(
      expect.objectContaining({
        type: 'run_completed',
        runId: result.runId,
        assistantMessage: '可以，先从今天金价开始。'
      })
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.task-event',
        payload: {
          runId: result.runId,
          threadId: result.threadId,
          type: 'reasoning_delta',
          payload: {
            delta: '先判断用户意图。'
          }
        }
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.task-event',
        payload: {
          runId: result.runId,
          threadId: result.threadId,
          type: 'message_delta',
          payload: {
            role: 'assistant',
            delta: '可以，先从今天金价开始。'
          }
        }
      })
    );
  });

  it('lists and searches session messages from the plugin repository', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      eventBus,
      modelFactory,
      repository
    });
    const result = await runtime.startRun(startRequest);
    if (result.threadId === null) {
      throw new Error('expected_task_thread');
    }
    repository.recordSessionMessage({
      content: 'Visible memory answer',
      role: 'assistant',
      threadId: result.threadId
    });

    expect(runtime.listSessionMessages({ threadId: result.threadId })).toMatchObject([
      {
        content: 'Visible memory answer',
        phase: 'visible',
        role: 'assistant'
      }
    ]);
    expect(runtime.searchSessionMessages({ query: 'memory', workspaceScope: 'all' })).toMatchObject({
      query: 'memory',
      total: 1
    });
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );
  });
});

async function waitForEvent(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('expected_event_not_published');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readChatRunEvent(payload: unknown): ChatRunEvent | null {
  if (payload === null || typeof payload !== 'object' || !('type' in payload)) {
    return null;
  }
  return payload as ChatRunEvent;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveValue: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolveValue === null) {
        throw new Error('deferred_not_initialized');
      }
      resolveValue(value);
    }
  };
}
